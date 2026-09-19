import { cmd } from "./cmd"
import { parseTargets, toCursorRule, isGenerated, upsertAgentsBlock, type SyncTarget } from "../lib/playbook-targets"
import { PlaybookContentsCommands } from "./platform-playbook-contents"
import * as prompts from "./clack"
// Aliased: `Tier` is already taken in this file by the e2e runner's own unrelated enum.
import { confirmWiden, type Tier as ExposureTier } from "./exposure-gate"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, printKV, irisFetch, requireAuth, handleApiError, writeJson, IRIS_API } from "./iris-api"
import { Skill } from "../../skill/skill"
import { lintPlaybook, blockingFindings, PLAYBOOK_RULES } from "../../skill/playbook-lint"
import { Instance } from "../../project/instance"
import {
  parsePlan,
  parseSteps,
  executeSkill,
  resolveArgs,
  splitPlaybookArgv,
  unknownPlaybookFlags,
  validatePlan,
  listRuns,
  getRun,
  pruneRuns,
  playbookPaths,
  type SkillPlan,
  type StepDef,
  type StepResult,
  type ExecuteOptions,
} from "../../skill/executor"
import { existsSync, mkdirSync, readdirSync, readFileSync } from "fs"
import {
  resolveInstallRoot,
  playbookFile,
  installHome,
  skillsDirForPlaybook,
  shadowingCopies,
  writeFileAtomic,
  decideSkillWrite,
  readInstalled,
  writeInstalled,
  assessInstalled,
  sha256,
  type InstallMode,
} from "../../skill/install-location"
import { join as pathJoin } from "path"
import { runE2ESuite, probeServices, type E2ESuiteResult, type Tier, type ModeCoverage } from "../../skill/e2e/runner"
import { PlaybookDraftCommand } from "./playbook-draft"
import { PlaybookSopDraftCommand } from "./sop-draft"
import { firstArray } from "../../util/array"

// Wrap callback in Instance.provide so Skill.all()/get() can find .claude/skills/
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: process.cwd(), fn })
}

/**
 * Can we actually ask a human a question right now?
 * False for --json and for non-interactive stdin (pipes, CI, scheduled jobs) —
 * those runs pause at human steps instead of blocking on a prompt nobody sees.
 */
/**
 * A step asked for confirmation and nobody is at a terminal (#186184). `run` used to call
 * prompts.confirm anyway and spin at ~99% CPU forever; `resume` silently returned true — a
 * confirmation that approves itself. Both now decline and say how to approve: --yes.
 */
export function declineUnattendedConfirm(stepId: string): false {
  console.error(`  Step "${stepId}" needs confirmation and no one is at a terminal — not run. Re-run with --yes to approve it.`)
  return false
}

function canPromptHuman(json: boolean): boolean {
  return !json && Boolean(process.stdin.isTTY)
}

// ============================================================================
// iris skill list
// ============================================================================

const SkillSearchCommand = cmd({
  command: "search [query]",
  aliases: ["find"],
  describe: "search playbooks by tag, name, description or trigger",
  builder: (yargs) =>
    yargs
      .positional("query", { type: "string", describe: "free text; matched against name, description, tags and triggers" })
      .option("tag", { type: "array", describe: "require this tag (repeatable; ALL must match)" })
      .option("local", { type: "boolean", default: false, describe: "search this machine only — skip the marketplace" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    await withInstance(async () => {
      const q = String(args.query ?? "").trim().toLowerCase()
      const need = ((args.tag as string[]) ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean)

      if (!q && !need.length) {
        console.log("Give a query or at least one --tag. `iris playbook list` shows everything.")
        process.exitCode = 1
        return
      }

      const skills = await Skill.all()
      const hits: Array<{ name: string; description: string; tags: string[]; why: string }> = []

      for (const info of skills) {
        let plan: any = null
        try {
          plan = await parsePlan(info)
        } catch {
          plan = null
        }
        const name = plan?.name ?? info.name ?? ""
        const description = plan?.description ?? info.description ?? ""
        const tags: string[] = firstArray(plan?.tags)
        const triggers: string[] = firstArray(plan?.triggers)

        // --tag is a FILTER, not a ranking signal: every requested tag must be present.
        // Anything looser turns "show me one product" back into "show me everything".
        if (need.length && !need.every((t) => tags.includes(t))) continue

        if (!q) {
          hits.push({ name, description, tags, why: "tag" })
          continue
        }

        // Say WHICH field matched. A search that cannot explain itself gets distrusted
        // the first time it returns something surprising.
        let why = ""
        if (name.toLowerCase().includes(q)) why = "name"
        else if (tags.some((t) => t.includes(q))) why = "tag"
        else if (description.toLowerCase().includes(q)) why = "description"
        else if (triggers.some((t) => t.toLowerCase().includes(q))) why = "trigger"
        if (!why) continue
        hits.push({ name, description, tags, why })
      }

      // name, then tag, then description, then trigger — most specific signal first.
      const rank: Record<string, number> = { name: 0, tag: 1, description: 2, trigger: 3 }
      hits.sort((a, b) => (rank[a.why] ?? 9) - (rank[b.why] ?? 9) || a.name.localeCompare(b.name))

      // Search used to read only this machine, so a playbook published to the marketplace
      // that the caller had not installed answered "No playbook matches" — which reads as
      // "it does not exist". List what is published and not installed, as its own group, so
      // an installed hit is never confused with one that needs `install` first.
      const installed = new Set(skills.map((s) => s.name))
      const registry = args.local ? [] : await fetchRegistryRows()
      const published: Array<{ name: string; description: string; scope: string }> = []
      for (const row of registry ?? []) {
        const name = String(row?.name ?? "")
        if (!name || installed.has(name)) continue
        const description = String(row?.description ?? "")
        const tags: string[] = Array.isArray(row?.tags) ? row.tags.map((x: unknown) => String(x).toLowerCase()) : []
        if (need.length && !need.every((t) => tags.includes(t))) continue
        if (q && !name.toLowerCase().includes(q) && !description.toLowerCase().includes(q)) continue
        published.push({ name, description, scope: String(row?.scope ?? "unknown") })
      }
      published.sort((a, b) => a.name.localeCompare(b.name))

      if (args.json) {
        // Additive: every row keeps its old fields; `installed` says which command comes next.
        const out = [
          ...hits.map((h) => ({ ...h, installed: true })),
          ...published.map((p) => ({ ...p, tags: [], why: "marketplace", installed: false })),
        ]
        console.log(JSON.stringify(out, null, 2))
        return
      }

      // `null` means the marketplace could not be asked. Say so — a quiet "no match" there
      // is the exact ambiguity this search was fixed to remove.
      const unchecked = !args.local && registry === null
      const printPublished = () => {
        if (!published.length) return
        console.log(bold(`${published.length} published, not installed here`))
        printDivider()
        for (const p of published) {
          console.log(`  ${bold(p.name)}  ${dim("(" + p.scope + ")")}`)
          const d = p.description.length > 96 ? p.description.slice(0, 96) + "…" : p.description
          if (d) console.log(dim(`    ${d}`))
        }
        printDivider()
        console.log(dim("  Install one, then run it:  iris playbook install <name>"))
      }

      if (!hits.length) {
        if (published.length) {
          printPublished()
          return
        }
        console.log(`No playbook matches${q ? ` "${q}"` : ""}${need.length ? ` with tag(s): ${need.join(", ")}` : ""}.`)
        console.log(dim("  Most playbooks carry no tags yet — try a word from the description, or `iris playbook list`."))
        if (unchecked) console.log(dim("  The marketplace could not be reached, so only this machine was searched."))
        return
      }

      console.log(bold(`${hits.length} playbook(s)`))
      printDivider()
      for (const h of hits) {
        console.log(`  ${bold(h.name)}  ${dim("(matched " + h.why + ")")}`)
        if (h.tags.length) console.log(dim(`    tags: ${h.tags.join(", ")}`))
        const d = h.description.length > 96 ? h.description.slice(0, 96) + "…" : h.description
        if (d) console.log(dim(`    ${d}`))
      }
      printDivider()
      console.log(dim("  Run one:  iris playbook run <name>"))
      if (published.length) {
        console.log()
        printPublished()
      }
      if (unchecked) console.log(dim("  The marketplace could not be reached, so only this machine was searched."))
    })
  },
})

const SkillListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all discovered skills (v1 + v2)",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false, describe: "JSON output" })
      .option("v2", { type: "boolean", default: false, describe: "show only v2 skills" })
      // #183406 defect 2. Opt-in, not default: `list` has never touched the network and is the
      // command everything else shells out to. ONE request for the whole registry, not one per
      // playbook — 94 lookups to decorate a list is not a trade worth making.
      .option("scope", {
        type: "boolean",
        default: false,
        describe: "also show each playbook's publish scope (one registry lookup)",
      }),
  async handler(args) {
    await withInstance(async () => {
      const skills = await Skill.all()
      const plans: Array<{ info: Skill.Info; plan: SkillPlan }> = []

      for (const info of skills) {
        try {
          const plan = await parsePlan(info)
          if (args.v2 && plan.version !== 2) continue
          plans.push({ info, plan })
        } catch {
          if (args.v2) continue
          plans.push({
            info,
            plan: {
              name: info.name, version: 1, description: info.description,
              args: {}, steps: [], includes: [], confirm: [], onError: "ask",
              timeout: 300, integrations: [], location: info.location,
            },
          })
        }
      }

      // name -> scope, from a single registry call. null when we could not measure, which is
      // rendered as "?" rather than as "not published" (see fetchPublishState).
      let scopes: Map<string, string> | null = null
      if (args.scope) {
        scopes = await fetchRegistryScopes()
      }
      const scopeOf = (name: string): string | null =>
        scopes === null ? null : (scopes.get(name) ?? "unpublished")

      if (args.json) {
        await writeJson(plans.map((p) => ({
          name: p.plan.name,
          version: p.plan.version,
          description: p.plan.description,
          steps: p.plan.steps.length,
          location: p.plan.location,
          ...(args.scope ? { scope: scopeOf(String(p.plan.name)) ?? "unknown" } : {}),
        })))
        return
      }

      UI.empty()
      prompts.intro("◈  Skills")

      if (plans.length === 0) {
        console.log(dim("  No skills found."))
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const { plan } of plans) {
        const version = plan.version === 2 ? highlight(" v2") : dim(" v1")
        const steps = plan.version === 2 ? dim(` (${plan.steps.length} steps)`) : ""
        const sc = scopeOf(String(plan.name))
        const scopeTag =
          !args.scope ? ""
          : sc === null ? dim("  [scope ?]")
          : sc === "unpublished" ? dim("  [local — not published]")
          : `  ${highlight(`[${sc}]`)}`
        console.log(`  ${bold(plan.name)}${version}${steps}${scopeTag}`)
        console.log(`    ${dim(plan.description)}`)
      }
      printDivider()
      console.log(dim(`  ${plans.length} skill(s) found`))
      if (!args.scope) {
        console.log(dim(`  Published or local? ${"iris playbook list --scope"}`))
      } else if (scopes === null) {
        console.log(dim(`  Scope could not be measured — the registry did not answer. "?" is not "unpublished".`))
      }

      prompts.outro("Done")
    })
  },
})

// ============================================================================
// iris skill show <name>
// ============================================================================

const SkillShowCommand = cmd({
  command: "show <name>",
  describe: "show skill details",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false })
      .option("full", {
        type: "boolean",
        default: false,
        describe: "print the whole playbook — step bodies, code and prose, not just the outline",
      })
      .option("local", {
        type: "boolean",
        default: false,
        describe: "skip the registry lookup — do not report scope or published-at",
      }),
  async handler(args) {
    await withInstance(async () => {
      const info = await Skill.get(args.name as string)
      if (!info) {
        await reportNotInstalled(String(args.name))
        process.exit(1)
      }

      const plan = await parsePlan(info)

      // #183406 defect 2 — is this thing published, and to whom? Optional (never fatal,
      // hard-capped) and skippable with --local, because `show` has always worked offline.
      const pub: PublishState = args.local
        ? { state: "unknown", reason: "--local: registry not checked" }
        : await fetchPublishState(String(plan.name))

      if (args.json) {
        // Additive — every field of `plan` is still at the top level exactly as before.
        await writeJson({ ...plan, publish: pub })
        return
      }

      UI.empty()
      prompts.intro(`◈  Skill: ${plan.name}`)

      printDivider()
      printKV("Version", plan.version)
      printKV("Description", plan.description)
      // What a model routes on. Printed next to the description because the two are
      // easy to conflate: description is WHAT this does, triggers are WHEN to reach
      // for it (#182840 / CTX-2).
      if (plan.triggers?.length) printKV("Triggers", plan.triggers.join(", "))
      if (plan.tags?.length) printKV("Tags", plan.tags.join(", "))
      printKV("Location", plan.location)
      // The shareable link, next to the local path (#182116). `show` used to give ONLY a
      // filesystem path, which is useless to anyone but the author on this machine. Printed
      // unconditionally rather than only when published: an unpublished playbook 404s at this
      // URL, and seeing that is a clearer answer than being told nothing.
      // The URL, then what it is actually worth. #183406 defect 2: this page returns 200 for an
      // unpublished name as well as a published one, so printing it alone invited exactly the
      // wrong inference. The next three lines are the answer the URL cannot give.
      printKV("URL", playbookUrl(String(plan.name)))

      if (pub.state === "published") {
        printKV("Scope", `${pub.scope}${pub.bloq_id ? ` (bloq #${pub.bloq_id})` : ""}`)
        printKV("Published", pub.published_at ?? dim("registered, but no published-at recorded"))
        if (pub.access_type) printKV("Access", pub.access_type)
        printKV("Who can open", audienceNote(pub.scope, pub.bloq_id))
      } else if (pub.state === "unpublished") {
        printKV("Scope", `${bold("not published")} ${dim("— local to this machine")}`)
        printKV("Published", dim("never"))
        printKV(
          "Share it",
          dim(`iris playbook publish ${plan.name} --scope private|project|public`),
        )
      } else {
        // NOT "unpublished". An unreachable registry cannot tell them apart, and guessing the
        // safe-sounding one is how someone concludes a public playbook is private.
        printKV("Scope", `${dim("unknown")} — ${pub.reason}`)
      }

      printKV("On Error", plan.onError)
      printKV("Timeout", `${plan.timeout}s`)

      // The container. Show what ${{playbook.root}} and ${{playbook.assets}}
      // actually resolve to here — a path convention nobody can see is one
      // nobody uses, and the SOP prose and the steps have to agree on it.
      const paths = playbookPaths(plan.location)
      printKV("Container", paths.root)
      printKV(
        "Assets",
        existsSync(paths.assets)
          ? `${paths.assets} ${dim(`(${readdirSync(paths.assets).length} files)`)}`
          : dim("none — ${{playbook.assets}} would point at " + paths.assets),
      )

      if (Object.keys(plan.args).length > 0) {
        console.log()
        console.log(bold("  Arguments:"))
        for (const [key, def] of Object.entries(plan.args)) {
          const req = def.required ? highlight("required") : dim("optional")
          const dflt = def.default !== undefined ? dim(` (default: ${def.default})`) : ""
          const vals = def.enum ? dim(` [${def.enum.join("|")}]`) : ""
          console.log(`    ${bold(key)}: ${def.type} ${req}${dflt}${vals}`)
        }
      }

      if (plan.steps.length > 0) {
        console.log()
        console.log(bold("  Steps:"))
        for (const step of plan.steps) {
          const mode = modeLabel(step.mode)
          const confirm = step.confirm ? highlight(" [confirm]") : ""
          const deps = step.depends ? dim(` (after: ${step.depends})`) : ""
          const cond = step.condition ? dim(` (if: ${step.condition})`) : ""
          console.log(`    ${bold(step.id)} — ${step.title}  ${mode}${confirm}${deps}${cond}`)
        }
      }

      // The outline above is not the playbook. The step bodies, the step code, and any prose
      // after the last step ARE the procedure — and `show` printed none of it (#182906).
      // Silently, which is what made it a bug rather than a preference: a model that ran
      // `show` had no way to tell it was holding 57% of the document. work-the-epic made it
      // concrete — its step 02 tells the reader to "read 'Writing it well' at the bottom of
      // this playbook", and `show` never printed that section. The instruction was not
      // followable through the surface that delivered it.
      // `--json` always carried the whole text; only this path dropped it.
      const rawDoc = existsSync(plan.location) ? readFileSync(plan.location, "utf8") : ""
      const docBody = rawDoc.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "").trimEnd()

      if (docBody) {
        if (args.full) {
          console.log()
          console.log(bold("  Playbook:"))
          console.log()
          for (const line of docBody.split("\n")) console.log(`  ${line}`)
        } else {
          // Never truncate silently. Report how much is withheld and how to get it: someone
          // told "310 lines, the outline omits them" goes and reads them, where someone shown
          // only an outline reasonably concludes the outline was the whole thing.
          const lines = docBody.split("\n").length
          const chars = plan.steps.reduce((n, s) => n + (s.body?.length ?? 0) + (s.code?.length ?? 0), 0)
          // `plan.guidance` was read here and does not exist on SkillPlan — never has. The
          // branch it gated could not fire, so this line has always rendered "and any prose"
          // while appearing to offer a character count. Surfaced when a later change let the
          // compiler see the property access; removed rather than typed away, because the
          // count it promised was never available to give.
          console.log()
          console.log(
            `  ${bold("Body:")} ${lines} lines. The outline above omits the step bodies` +
              (chars ? ` (${chars.toLocaleString()} chars)` : "") +
              ` and any prose.`,
          )
          console.log(`        ${dim("full text:")} iris playbook show ${plan.name} --full`)
          console.log(`        ${dim("json:     ")} iris playbook show ${plan.name} --json`)
        }
      }

      if (plan.integrations.length > 0) {
        printKV("Integrations", plan.integrations.join(", "))
      }

      printDivider()
      prompts.outro("Done")
    })
  },
})

// ============================================================================
// iris skill run <name> [args...]
// ============================================================================

const SkillRunCommand = cmd({
  command: "run <name> [skillArgs..]",
  describe: "execute a v2 skill",
  builder: (yargs) =>
    yargs
      // #183406 defect 4 — `iris playbook run iris-hive "x" --node dev-mini` died with
      // "Unknown argument: node", and live playbooks document exactly that form. yargs is
      // constructed before the playbook is read, so it cannot know which `--flags` a given
      // playbook declares; under strict parsing every one of them is unknown by definition.
      //
      // So unknown options fall through to `skillArgs` and are matched against the playbook's
      // OWN declared args (splitPlaybookArgv). The strictness is not dropped — it moves to
      // where the declarations are, and `unknownPlaybookFlags` reproduces the same
      // "Unknown argument" failure below. Declared options (--step, --json, -y, …) are still
      // parsed by yargs exactly as before, and positional args are untouched.
      .parserConfiguration({ "unknown-options-as-args": true })
      .positional("name", { type: "string", demandOption: true })
      .positional("skillArgs", { type: "string", array: true })
      .option("step", { type: "string", describe: "run a single step by ID" })
      .option("resume", { type: "boolean", default: false, describe: "resume from checkpoint" })
      .option("dry-run", { type: "boolean", default: false, describe: "show plan without executing" })
      .option("yes", { type: "boolean", default: false, describe: "skip confirmation prompts", alias: "y" })
      .option("verbose", { type: "boolean", default: false, describe: "print interpolated commands" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await withInstance(async () => {
      const info = await Skill.get(args.name as string)
      if (!info) {
        await reportNotInstalled(String(args.name))
        process.exit(1)
      }

      const plan = await parsePlan(info)

      // v1 skills — just print content
      if (plan.version !== 2) {
        const content = await Bun.file(info.location).text()
        console.log(content)
        return
      }

      // Resolve arguments
      const positionalArgs = (args.skillArgs as string[] ?? [])
      // #181577: one shared parser, so `playbook run` and `loop` cannot drift again.
      const { flagArgs, positional: cleanPositional } = splitPlaybookArgv(positionalArgs, plan.args)

      // The strictness yargs can no longer apply (see parserConfiguration above), applied here
      // where the playbook's declarations are actually known. Without this a mistyped
      // `--nodee dev-mini` would be swallowed as a boolean and "dev-mini" bound to whichever
      // positional came first — a wrong run that reports success (#183406, defect 4).
      const unknown = unknownPlaybookFlags(flagArgs, plan.args)
      if (unknown.length > 0) {
        const declared = Object.keys(plan.args)
        console.error(`Unknown argument${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}`)
        console.error(
          declared.length
            ? `"${plan.name}" declares: ${declared.map((k) => `--${k}`).join(", ")}`
            : `"${plan.name}" declares no arguments.`,
        )
        console.error(`  iris playbook show ${plan.name}`)
        process.exit(1)
      }

      let resolvedArgs: Record<string, unknown>
      try {
        resolvedArgs = resolveArgs(plan.args, cleanPositional, flagArgs)
      } catch (e: any) {
        console.error(e.message)
        process.exit(1)
      }
      resolvedArgs._raw = cleanPositional.join(" ")

      if (!args.json) {
        UI.empty()
        prompts.intro(`◈  Running: ${plan.name}`)
      }

      // Dry run
      if (args["dry-run"]) {
        if (args.json) {
          await writeJson({
            skill: plan.name,
            version: plan.version,
            args: resolvedArgs,
            steps: plan.steps.map((s) => ({ id: s.id, title: s.title, mode: s.mode, integrations: s.integrations })),
          })
          return
        }

        printDivider()
        console.log(bold("  Execution Plan:"))
        console.log()
        for (const step of plan.steps) {
          console.log(`  ${bold(step.id)} — ${step.title}  ${modeLabel(step.mode)}`)
        }
        printDivider()
        console.log(dim("  (dry-run — no steps executed)"))
        prompts.outro("Done")
        return
      }

      const sp = prompts.spinner()

      // Collected rather than printed inline: the spinner owns the current line, and a
      // console.log mid-step overwrites itself. Replayed after the summary.
      const warnings: Array<{ stepId: string; message: string }> = []

      const opts: ExecuteOptions = {
        dryRun: false,
        yes: args.yes as boolean,
        verbose: args.verbose as boolean,
        resume: args.resume as boolean,
        stepFilter: args.step as string | undefined,
        onWarn(w) {
          warnings.push(w)
        },
        onStepStart(step) {
          if (!args.json) sp.start(`  ${step.id}: ${step.title}`)
        },
        onStepEnd(step, result) {
          if (args.json) return
          const icon =
            result.status === "success" ? success("✓")
            : result.status === "skipped" ? dim("○")
            : result.status === "paused" ? "⏸"
            : "✗"
          const dur = result.duration_ms > 0 ? dim(` (${(result.duration_ms / 1000).toFixed(1)}s)`) : ""
          sp.stop(`  ${icon} ${step.id}: ${step.title}${dur}`, result.status === "success" ? 0 : 1)

          if (result.status === "success" && result.output && args.verbose) {
            const preview = result.output.length > 200 ? result.output.slice(0, 200) + "..." : result.output
            console.log(dim(`    ${preview.replace(/\n/g, "\n    ")}`))
          }
          if (result.status === "failed" && result.output) {
            console.log(`    ${result.output.slice(0, 300)}`)
          }
        },
        async onConfirm(stepId, command) {
          if (!canPromptHuman(args.json as boolean)) return declineUnattendedConfirm(stepId)
          const preview = command.length > 200 ? command.slice(0, 200) + "..." : command
          const result = await prompts.confirm({
            message: `Step "${stepId}" will execute:\n\n    ${preview}\n\n  Continue?`,
          })
          return !prompts.isCancel(result) && result === true
        },
      }

      // Only offer an interactive "Done?" prompt when a human is actually watching.
      // Unattended runs (--json, piped, scheduled) fall through to a persisted pause.
      if (canPromptHuman(args.json as boolean)) {
        opts.onManualPrompt = async (step) => {
          sp.stop(`  ${bold(step.id)}: ${step.title}`, 0)
          console.log()
          // `instructions` is the step as written — prose and EVERY fenced block, in the order
          // the author put them. Printing body-then-code dropped every fenced block after the
          // first and detached the one that survived from the sentence introducing it
          // (#183406, defect 6).
          if (step.instructions) {
            console.log(`    ${step.instructions.replace(/\n/g, "\n    ")}`)
          } else {
            if (step.body) console.log(`    ${step.body.replace(/\n/g, "\n    ")}`)
            if (step.code) console.log(`\n    ${dim(step.code.replace(/\n/g, "\n    "))}`)
          }
          console.log()
          const result = await prompts.confirm({ message: "Done?" })
          return !prompts.isCancel(result) && result === true
        }
      }

      const result = await executeSkill(plan, resolvedArgs, opts)

      const passedN = Object.values(result.steps).filter((r) => r.status === "success").length
      const failedN = Object.values(result.steps).filter((r) => r.status === "failed").length
      const skippedN = Object.values(result.steps).filter((r) => r.status === "skipped").length

      // #183406 defect 5 — "ran nothing" is not success.
      //
      //   iris playbook run iris-agreements "Probe" --step issue -y
      //   ✓ iris-agreements completed · 0 passed, 1 skipped · exit 0
      //
      // `issue` depends on a step --step excluded, so it was skipped, and a run of nothing but
      // skips satisfied `every(success || skipped)` and reported completion. Single-step smoke
      // testing was therefore worthless: the check that says "this step works" and the check
      // that says "this step never executed" printed the same thing and returned the same code.
      //
      // SCOPED TO --step DELIBERATELY. A full run whose steps are all `if:`-gated off has
      // legitimately done its job, and 94 playbooks plus whatever CI calls them depend on that
      // exiting 0. Narrowing to an explicitly-requested single step keeps automation intact and
      // fixes the case where the exit code is load-bearing.
      const ranNothing =
        Boolean(args.step) && result.status === "completed" && passedN === 0 && failedN === 0 && skippedN > 0

      if (args.json) {
        // Additive fields — the existing shape is untouched, so anything already parsing this
        // keeps working, and anything that wants the truth can now read it.
        await writeJson({ ...result, ran_nothing: ranNothing, warnings })
        if (ranNothing) process.exitCode = 1
        return
      }

      console.log()
      printDivider()

      const passed = passedN
      const failed = failedN
      const skippedCount = skippedN
      const totalMs = Object.values(result.steps).reduce((sum, r) => sum + r.duration_ms, 0)

      if (ranNothing) {
        console.log(`  ⚠  ${bold(result.skill)} — ${bold("NOTHING RAN")}`)
        for (const [id, sr] of Object.entries(result.steps)) {
          if (sr.status === "skipped") console.log(`    ○ ${id}: ${sr.output}`)
        }
        console.log()
        console.log(dim(`  --step runs ONE step. Run the chain that leads to it instead:`))
        console.log(dim(`    iris playbook run ${plan.name}${cleanPositional.length ? " " + cleanPositional.map((a) => JSON.stringify(a)).join(" ") : ""}`))
        console.log(dim(`  Or resume a run that already satisfied the dependency:  iris playbook resume <run-id>`))
        printDivider()
        prompts.outro("Nothing ran")
        process.exitCode = 1
        return
      }

      if (result.status === "completed") {
        console.log(`  ${success("✓")} ${bold(result.skill)} completed`)
        console.log(dim(`  ${passed} passed${skippedCount ? `, ${skippedCount} skipped` : ""} in ${(totalMs / 1000).toFixed(1)}s`))
      } else if (result.status === "paused") {
        console.log(`  ⏸  ${bold(result.skill)} paused — waiting on a human`)
        console.log(dim(`  ${passed} passed in ${(totalMs / 1000).toFixed(1)}s`))
        if (result.paused_on) {
          console.log()
          console.log(`  ${bold(result.paused_on.id)}: ${result.paused_on.title}`)
          if (result.paused_on.instructions) {
            console.log()
            console.log(`    ${result.paused_on.instructions.replace(/\n/g, "\n    ")}`)
          }
        }
        console.log()
        console.log(dim(`  Continue when done:  iris playbook resume ${result.run_id}`))
      } else {
        console.log(`  ✗ ${bold(result.skill)} ${result.status}`)
        console.log(`  ${passed} passed, ${failed} failed${skippedCount ? `, ${skippedCount} skipped` : ""} in ${(totalMs / 1000).toFixed(1)}s`)
        // Show failed step details
        for (const [id, sr] of Object.entries(result.steps)) {
          if (sr.status === "failed") {
            console.log(`    ✗ ${id}: ${sr.output.slice(0, 200)}`)
          }
        }
      }

      // Things that rendered wrong without failing. Printed after the summary rather than
      // during the run because the spinner owns the live line — and printed at all because
      // "the step succeeded" and "the step succeeded with a blank where your value should be"
      // were previously the same output (#183406, defect 3).
      if (warnings.length > 0) {
        console.log()
        for (const w of warnings) console.log(`  ⚠  ${bold(w.stepId)}: ${w.message}`)
      }

      if (args.verbose) {
        console.log(dim(`  Run: ${result.run_id}`))
      }

      printDivider()
      prompts.outro(
        result.status === "completed" ? success("Done")
        : result.status === "paused" ? "Paused"
        : "Done (with errors)",
      )
      // 0 = done, 2 = paused on a human step, 1 = failed. Paused is not a failure,
      // but it is not success either — callers must be able to tell the difference.
      if (result.status === "paused") process.exitCode = 2
      else if (result.status !== "completed") process.exitCode = 1
    })
  },
})

// ============================================================================
// iris skill test <name>
// ============================================================================

const SkillTestCommand = cmd({
  command: "test <name>",
  describe: "validate a skill's syntax and schema",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await withInstance(async () => {
      const info = await Skill.get(args.name as string)
      if (!info) {
        await reportNotInstalled(String(args.name))
        process.exit(1)
      }

      let plan: SkillPlan
      try {
        plan = await parsePlan(info)
      } catch (e: any) {
        if (args.json) {
          await writeJson({ valid: false, errors: [e.message] })
        } else {
          console.error(`Parse error: ${e.message}`)
        }
        process.exit(1)
        return
      }

      const issues = validatePlan(plan)

      if (args.json) {
        await writeJson({
          valid: !issues.some((i) => i.level === "error"),
          version: plan.version,
          steps: plan.steps.length,
          args: Object.keys(plan.args).length,
          issues,
        })
        return
      }

      UI.empty()
      prompts.intro(`◈  Validate: ${plan.name}`)

      printDivider()
      printKV("Version", plan.version)
      printKV("Steps", plan.steps.length)
      printKV("Args", Object.keys(plan.args).length)

      if (issues.length === 0) {
        console.log()
        console.log(success("  ✓ No issues found"))
      } else {
        console.log()
        for (const issue of issues) {
          const icon = issue.level === "error" ? "✗" : "⚠"
          const prefix = issue.stepId ? `[${issue.stepId}] ` : ""
          if (issue.level === "error") {
            console.log(`  ${icon} ${prefix}${issue.message}`)
          } else {
            console.log(dim(`  ${icon} ${prefix}${issue.message}`))
          }
        }
      }

      printDivider()
      const hasErrors = issues.some((i) => i.level === "error")
      prompts.outro(hasErrors ? "Validation failed" : success("Valid"))
      if (hasErrors) process.exitCode = 1
    })
  },
})

// ============================================================================
// iris skill history [run-id]
// ============================================================================

const SkillHistoryCommand = cmd({
  command: "history [runId]",
  describe: "list recent runs or show run details",
  builder: (yargs) =>
    yargs
      .positional("runId", { type: "string" })
      .option("prune", { type: "string", describe: "delete runs older than N days (e.g. 30d)" })
      .option("json", { type: "boolean", default: false })
      .option("limit", { type: "number", default: 20 }),
  async handler(args) {
    // Prune mode
    if (args.prune) {
      const match = (args.prune as string).match(/^(\d+)d$/)
      if (!match) {
        console.error('Invalid prune format. Use Nd, e.g. "30d"')
        process.exit(1)
      }
      const days = parseInt(match[1], 10)
      const count = pruneRuns(days)
      if (args.json) {
        console.log(JSON.stringify({ pruned: count }))
      } else {
        console.log(`Pruned ${count} run(s) older than ${days} days`)
      }
      return
    }

    // Single run detail
    if (args.runId) {
      const run = getRun(args.runId as string)
      if (!run) {
        console.error(`Run "${args.runId}" not found`)
        process.exit(1)
      }

      if (args.json) {
        await writeJson(run)
        return
      }

      UI.empty()
      prompts.intro(`◈  Run: ${run.run_id}`)
      printDivider()
      printKV("Skill", run.skill)
      printKV("Status", run.status)
      printKV("Started", run.started_at)
      printKV("Updated", run.updated_at)
      printKV("Args", JSON.stringify(run.args))

      console.log()
      console.log(bold("  Steps:"))
      for (const [id, sr] of Object.entries(run.steps)) {
        const icon =
          sr.status === "success" ? success("✓")
          : sr.status === "skipped" ? dim("○")
          : sr.status === "paused" ? "⏸"
          : "✗"
        const dur = sr.duration_ms > 0 ? dim(` (${(sr.duration_ms / 1000).toFixed(1)}s)`) : ""
        console.log(`    ${icon} ${bold(id)} — ${sr.status}${dur}`)
        if (sr.output && (sr.status === "failed" || sr.status === "paused")) {
          console.log(dim(`      ${sr.output.slice(0, 200)}`))
        }
      }
      printDivider()
      if (run.status === "paused") {
        console.log(dim(`  Waiting on a human. Continue with: iris playbook resume ${run.run_id}`))
      }
      prompts.outro("Done")
      return
    }

    // List all runs
    const runs = listRuns(args.limit as number)

    if (args.json) {
      await writeJson(runs)
      return
    }

    UI.empty()
    prompts.intro("◈  Skill Run History")

    if (runs.length === 0) {
      console.log(dim("  No runs found."))
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const run of runs) {
      const icon =
        run.status === "completed" ? success("✓")
        : run.status === "running" ? "◌"
        : run.status === "paused" ? "⏸"
        : "✗"
      const stepCount = Object.keys(run.steps).length
      const time = dim(run.updated_at.replace("T", " ").slice(0, 19))
      console.log(`  ${icon} ${bold(run.run_id)} ${run.skill} — ${run.status} (${stepCount} steps) ${time}`)
    }
    printDivider()
    console.log(dim(`  ${runs.length} run(s). Use "iris skill history <run-id>" for details.`))
    prompts.outro("Done")
  },
})

// ============================================================================
// iris playbook resume <run-id>
// ============================================================================

const SkillResumeCommand = cmd({
  command: "resume <runId>",
  describe: "resume a paused run after the human step is done",
  builder: (yargs) =>
    yargs
      .positional("runId", { type: "string", demandOption: true })
      .option("skip", {
        type: "boolean",
        default: false,
        describe: "mark the paused human step as NOT done (dependent steps are skipped)",
      })
      .option("yes", { type: "boolean", default: false, describe: "skip confirmation prompts", alias: "y" })
      .option("verbose", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await withInstance(async () => {
      const runId = args.runId as string
      const run = getRun(runId)
      if (!run) {
        console.error(`Run "${runId}" not found`)
        process.exit(1)
      }
      if (run.status !== "paused") {
        console.error(`Run "${runId}" is ${run.status}, not paused — nothing to resume.`)
        process.exit(1)
      }

      const info = await Skill.get(run.skill)
      if (!info) {
        console.error(`Skill "${run.skill}" not found — it may have been renamed or removed since this run started.`)
        process.exit(1)
      }
      const plan = await parsePlan(info)

      if (!args.json) {
        UI.empty()
        prompts.intro(`◈  Resuming: ${run.skill}`)
        console.log(dim(`  Run ${run.run_id}, paused at "${run.current_step}"`))
        console.log()
      }

      const sp = prompts.spinner()

      const opts: ExecuteOptions = {
        resumeRunId: runId,
        resolvePaused: args.skip ? "skip" : "done",
        yes: args.yes as boolean,
        verbose: args.verbose as boolean,
        onStepStart(step) {
          if (!args.json) sp.start(`  ${step.id}: ${step.title}`)
        },
        onStepEnd(step, result) {
          if (args.json) return
          const icon =
            result.status === "success" ? success("✓")
            : result.status === "skipped" ? dim("○")
            : result.status === "paused" ? "⏸"
            : "✗"
          const dur = result.duration_ms > 0 ? dim(` (${(result.duration_ms / 1000).toFixed(1)}s)`) : ""
          sp.stop(`  ${icon} ${step.id}: ${step.title}${dur}`, result.status === "success" ? 0 : 1)
          if (result.status === "failed" && result.output) {
            console.log(`    ${result.output.slice(0, 300)}`)
          }
        },
        async onConfirm(stepId, command) {
          if (!canPromptHuman(args.json as boolean)) return declineUnattendedConfirm(stepId)
          const preview = command.length > 200 ? command.slice(0, 200) + "..." : command
          const result = await prompts.confirm({
            message: `Step "${stepId}" will execute:\n\n    ${preview}\n\n  Continue?`,
          })
          return !prompts.isCancel(result) && result === true
        },
      }

      // Same rule as `run`: only prompt when a human is actually watching,
      // so a resume can itself pause again at the next human step.
      if (canPromptHuman(args.json as boolean)) {
        opts.onManualPrompt = async (step) => {
          sp.stop(`  ${bold(step.id)}: ${step.title}`, 0)
          console.log()
          // `instructions` is the step as written — prose and EVERY fenced block, in the order
          // the author put them. Printing body-then-code dropped every fenced block after the
          // first and detached the one that survived from the sentence introducing it
          // (#183406, defect 6).
          if (step.instructions) {
            console.log(`    ${step.instructions.replace(/\n/g, "\n    ")}`)
          } else {
            if (step.body) console.log(`    ${step.body.replace(/\n/g, "\n    ")}`)
            if (step.code) console.log(`\n    ${dim(step.code.replace(/\n/g, "\n    "))}`)
          }
          console.log()
          const result = await prompts.confirm({ message: "Done?" })
          return !prompts.isCancel(result) && result === true
        }
      }

      const result = await executeSkill(plan, run.args, opts)

      if (args.json) {
        await writeJson(result)
        if (result.status === "paused") process.exitCode = 2
        else if (result.status !== "completed") process.exitCode = 1
        return
      }

      console.log()
      printDivider()
      if (result.status === "completed") {
        console.log(`  ${success("✓")} ${bold(result.skill)} completed`)
      } else if (result.status === "paused") {
        console.log(`  ⏸  ${bold(result.skill)} paused again — waiting on a human`)
        if (result.paused_on) {
          console.log()
          console.log(`  ${bold(result.paused_on.id)}: ${result.paused_on.title}`)
          if (result.paused_on.instructions) {
            console.log()
            console.log(`    ${result.paused_on.instructions.replace(/\n/g, "\n    ")}`)
          }
        }
        console.log()
        console.log(dim(`  Continue when done:  iris playbook resume ${result.run_id}`))
      } else {
        console.log(`  ✗ ${bold(result.skill)} ${result.status}`)
        for (const [id, sr] of Object.entries(result.steps)) {
          if (sr.status === "failed") console.log(`    ✗ ${id}: ${sr.output.slice(0, 200)}`)
        }
      }
      printDivider()
      prompts.outro(
        result.status === "completed" ? success("Done")
        : result.status === "paused" ? "Paused"
        : "Done (with errors)",
      )
      if (result.status === "paused") process.exitCode = 2
      else if (result.status !== "completed") process.exitCode = 1
    })
  },
})

// ============================================================================
// iris playbook e2e — end-to-end test runner
// ============================================================================

const SkillE2ECommand = cmd({
  command: "e2e [playbook]",
  describe: "run end-to-end playbook tests (builtins + project playbooks)",
  builder: (yargs) =>
    yargs
      .positional("playbook", { type: "string", describe: "test a specific playbook by name" })
      .option("tier", { type: "string", describe: "filter by tier: local, edge, cloud", choices: ["local", "edge", "cloud"] })
      .option("mode", { type: "string", describe: "filter by step mode (e.g. shell, hive-script)" })
      .option("project", { type: "boolean", default: false, describe: "include project v2 playbooks" })
      .option("json", { type: "boolean", default: false, describe: "JSON output for CI/CD" })
      .option("verbose", { type: "boolean", default: false, describe: "print step outputs" }),
  async handler(args) {
    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Playbook E2E Tests")
    }

    const sp = args.json ? null : prompts.spinner()
    sp?.start("  Probing services...")

    const result = await withInstance(() =>
      runE2ESuite({
        tier: args.tier as Tier | undefined,
        mode: args.mode as string | undefined,
        playbook: args.playbook as string | undefined,
        project: args.project as boolean,
        verbose: args.verbose as boolean,
        json: args.json as boolean,
      }),
    )

    sp?.stop("  Services probed", 0)

    if (args.json) {
      await writeJson(result)
      if (result.failed > 0) process.exitCode = 1
      return
    }

    // Service availability
    printDivider()
    console.log(bold("  Services:"))
    for (const [name, available] of Object.entries(result.services)) {
      const icon = available ? success("✓") : dim("○")
      console.log(`    ${icon} ${name}`)
    }
    console.log()

    // Test results
    console.log(bold("  Tests:"))
    for (const test of result.tests) {
      const icon = test.status === "pass" ? success("✓") : test.status === "skip" ? dim("○") : "✗"
      const src = test.tier === "local" ? "" : dim(` [${test.tier}]`)
      const dur = test.duration_ms > 0 ? dim(` (${(test.duration_ms / 1000).toFixed(1)}s)`) : ""
      const reason = test.reason ? dim(` — ${test.reason}`) : ""
      console.log(`    ${icon} ${bold(test.name)}${src}${dur}${reason}`)

      if (args.verbose && test.status !== "skip") {
        for (const [stepId, sr] of Object.entries(test.steps)) {
          const stepIcon = sr.status === "success" ? success("✓") : sr.status === "skipped" ? dim("○") : "✗"
          console.log(`      ${stepIcon} ${stepId}`)
        }
      }
    }

    // Mode coverage
    if (result.coverage.untested.length > 0) {
      console.log()
      console.log(bold("  Mode Coverage:"))
      console.log(`    ${success("tested")}: ${result.coverage.tested.join(", ") || "(none)"}`)
      console.log(`    ${dim("untested")}: ${result.coverage.untested.join(", ")}`)
      console.log(dim(`    ${result.coverage.tested.length}/${result.coverage.total} modes exercised`))
    }

    printDivider()
    const summary = `  ${result.passed} passed, ${result.failed} failed, ${result.skipped} skipped — ${(result.duration_ms / 1000).toFixed(1)}s`
    console.log(result.failed === 0 ? success(summary) : summary)
    prompts.outro(result.failed === 0 ? success("Done") : "Done (with failures)")
    if (result.failed > 0) process.exitCode = 1
  },
})

// ============================================================================
// Helpers
// ============================================================================

function modeLabel(mode: string): string {
  switch (mode) {
    case "shell": return highlight("shell")
    case "prompt":
    case "ai": return highlight("prompt")
    case "hive": return highlight("hive")
    case "hive-script": return highlight("hive-script")
    case "skill":
    case "playbook": return highlight("playbook")
    case "cloud-workflow": return highlight("cloud-workflow")
    case "cloud-agentic": return highlight("cloud-agentic")
    case "n8n": return highlight("n8n")
    case "langgraph": return highlight("langgraph")
    case "schedule": return highlight("schedule")
    case "agent": return dim("agent")
    case "human":
    case "manual": return dim("human")
    default: return dim(mode)
  }
}

// ============================================================================
// iris skill remote — API agent skills (was: iris skills)
// ============================================================================

const RemoteListCommand = cmd({
  command: "list <agentId>",
  aliases: ["ls"],
  describe: "list skills for an agent",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Agent Skills — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills`)
    const ok = await handleApiError(res, "List skills")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const skills: any[] = firstArray(data?.data, data?.skills, (Array.isArray(data) ? data : []))
    if (args.json) { await writeJson(skills); prompts.outro("Done"); return }
    printDivider()
    if (skills.length === 0) console.log(`  ${dim("(no skills)")}`)
    else for (const s of skills) {
      console.log(`  ${bold(String(s.name ?? "Untitled"))}  ${dim(`#${s.id}`)}  ${s.is_active ? success("active") : dim("inactive")}`)
      if (s.description) console.log(`    ${dim(String(s.description).slice(0, 80))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const RemoteShowCommand = cmd({
  command: "show <agentId> <skillId>",
  describe: "show an agent skill's details",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("skillId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Skill #${args.skillId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills/${args.skillId}`)
    const ok = await handleApiError(res, "Show skill")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    printDivider()
    printKV("ID", data.id)
    printKV("Name", data.name)
    printKV("Description", data.description)
    printKV("Instructions", data.instructions)
    printKV("Tools", Array.isArray(data.tools) ? data.tools.join(", ") : data.tools)
    printKV("Triggers", Array.isArray(data.triggers) ? data.triggers.join(", ") : data.triggers)
    if (data.tags) printKV("Tags", Array.isArray(data.tags) ? data.tags.join(", ") : data.tags)
    printKV("Active", data.is_active)
    printDivider()
    prompts.outro("Done")
  },
})

const RemoteCreateCommand = cmd({
  command: "create <agentId>",
  describe: "create a new agent skill",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("name", { type: "string", demandOption: true })
      .option("description", { type: "string" })
      .option("instructions", { type: "string" })
      .option("tools", { type: "string", describe: "comma-separated tool names" })
      .option("triggers", { type: "string", describe: "comma-separated trigger phrases" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Agent Skill")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { name: args.name }
    if (args.description) payload.description = args.description
    if (args.instructions) payload.instructions = args.instructions
    if (args.tools) payload.tools = (args.tools as string).split(",").map((s) => s.trim())
    if (args.triggers) payload.triggers = (args.triggers as string).split(",").map((s) => s.trim())
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Create skill")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? {}
    prompts.outro(`${success("✓")} Created skill #${data.id ?? ""}`)
  },
})

const RemoteDeleteCommand = cmd({
  command: "delete <agentId> <skillId>",
  aliases: ["rm"],
  describe: "delete an agent skill",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("skillId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete skill #${args.skillId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v6/bloqs/agents/${args.agentId}/skills/${args.skillId}`, { method: "DELETE" })
    const ok = await handleApiError(res, "Delete skill")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Deleted`)
  },
})

const SkillRemoteCommand = cmd({
  command: "remote <command>",
  describe: "manage API agent skills (marketplace)",
  builder: (yargs) =>
    yargs
      .command(RemoteListCommand)
      .command(RemoteShowCommand)
      .command(RemoteCreateCommand)
      .command(RemoteDeleteCommand)
      .demandCommand(1, ""),
  handler() {},
})

// ============================================================================
// iris skill review — auto-generated skill drafts
// ============================================================================

const ReviewListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list auto-generated skill drafts pending review",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Skill Drafts — Pending Review")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/skills/auto-generated/pending`)
    const ok = await handleApiError(res, "List pending drafts"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const drafts: any[] = firstArray(data?.data)
    if (args.json) { await writeJson(drafts); prompts.outro("Done"); return }
    if (drafts.length === 0) {
      printDivider()
      console.log(`  ${dim("No drafts pending review.")}`)
      printDivider()
      prompts.outro("Done")
      return
    }
    printDivider()
    for (const d of drafts) {
      console.log(`  ${bold(`#${d.id}`)} ${d.display_name}`)
      console.log(`     ${dim(`tools: ${(d.tool_sequence ?? []).join(" -> ") || "(none)"}`)}`)
      console.log(`     ${dim(`confidence: ${d.confidence?.toFixed?.(2) ?? d.confidence}, bloq: ${d.originating_bloq_id ?? "(any)"}, examples: ${(d.trajectory_ids ?? []).length}`)}`)
      if (d.description) console.log(`     ${dim(d.description)}`)
      console.log()
    }
    printDivider()
    prompts.outro(`${drafts.length} draft(s) — approve with: iris skill review approve <id>`)
  },
})

const ReviewApproveCommand = cmd({
  command: "approve <id>",
  describe: "approve an auto-generated skill draft",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Approve Skill Draft #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/skills/${args.id}/approve`, { method: "POST", body: JSON.stringify({}) })
    const ok = await handleApiError(res, "Approve skill"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { await writeJson(data); prompts.outro("Done"); return }
    printDivider()
    console.log(`  ${success("✓")} ${data?.message ?? "Approved"}`)
    if (data?.data?.installation_id) console.log(`  ${dim(`Installation ID: ${data.data.installation_id}`)}`)
    printDivider()
    prompts.outro("Done")
  },
})

const ReviewRejectCommand = cmd({
  command: "reject <id>",
  describe: "reject an auto-generated skill draft",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", demandOption: true })
      .option("reason", { type: "string", describe: "optional rejection reason" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Reject Skill Draft #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const body: Record<string, unknown> = {}
    if (args.reason) body.reason = String(args.reason)
    const res = await irisFetch(`/api/v1/skills/${args.id}/reject`, { method: "POST", body: JSON.stringify(body) })
    const ok = await handleApiError(res, "Reject skill"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    if (args.json) { await writeJson(data); prompts.outro("Done"); return }
    printDivider()
    console.log(`  ${success("✓")} ${data?.message ?? "Rejected"}`)
    printDivider()
    prompts.outro("Done")
  },
})

const SkillReviewCommand = cmd({
  command: "review <command>",
  describe: "review auto-generated skill drafts — list, approve, reject",
  builder: (yargs) =>
    yargs
      .command(ReviewListCommand)
      .command(ReviewApproveCommand)
      .command(ReviewRejectCommand)
      .demandCommand(1, "specify: list | approve <id> | reject <id>"),
  handler() {},
})

// ============================================================================
// iris playbook sync — generate SKILL.md replicas for Claude Code
// ============================================================================

/**
 * The SKILL.md replica of a playbook: full prose kept, executable step blocks stripped.
 * One writer for `sync` and `install` — one copy, one behaviour.
 */
async function renderSkillReplica(info: { location: string }, plan: SkillPlan): Promise<string> {
  // Build SKILL.md replica: keep full prose, strip executable step blocks
  const rawMd = await Bun.file(info.location).text()
  const matter = (await import("gray-matter")).default
  const parsed = matter(rawMd)

  // Rebuild frontmatter (strip v2-only fields that Claude doesn't need)
  // The marker goes BELOW the frontmatter, never above it. A SKILL.md that does not begin
  // with `---` fails frontmatter parsing, and every reader then drops the skill or reads
  // the comment as its description: the IRIS Desktop app (1.18.69) loaded NONE of the 133
  // synced skills, and Claude Code listed all of them with "<!-- AUTO-GENERATED ... -->"
  // as their description, so none could trigger on their own triggers. Measured both ways
  // on the same file: moved below, both load it with the right description (#185809, #185848).
  // JSON.stringify, not a bare value: a description containing ": " is invalid YAML, and
  // two shipped skills had been unparseable for as long as they existed — masked, because
  // the marker above the frontmatter meant nothing ever parsed them. The IRIS CLI aborts
  // its WHOLE skill listing on one bad file (exit 1, zero skills); the Desktop app drops
  // just that one. One unquoted colon could take out every skill.
  const yaml = (v: string) => JSON.stringify(String(v ?? ""))
  const fmLines: string[] = [
    "---",
    `name: ${yaml(plan.name)}`,
    `description: ${yaml(plan.description)}`,
  ]
  // Preserve allowed-tools from original
  const toolsMatch = rawMd.match(/allowed-tools:\n((?:\s+-\s+\w+\n)+)/)
  if (toolsMatch) {
    fmLines.push("allowed-tools:")
    fmLines.push(toolsMatch[1].trimEnd())
  }
  fmLines.push("---")
  fmLines.push("")
  fmLines.push("<!-- AUTO-GENERATED by iris playbook sync — do not edit -->")

  // Strip executable step blocks (### step:xxx ... next ### or EOF)
  // but keep all other prose, headings, tables, code examples
  let body = parsed.content

  // Remove ### step: sections (heading + yaml fence + code fence + prose until next heading)
  const stepPattern = /^### step:\S+\s+.+$[\s\S]*?(?=^###\s|\n---\n|$(?![\s\S]))/gm
  body = body.replace(stepPattern, "")

  // Remove the "## Executable Steps (v2)" header if it exists
  body = body.replace(/^## Executable Steps.*\n*/m, "")

  // Add a usage hint at the top of the body
  const argEntries = Object.entries(plan.args)
  const argStr = argEntries
    .filter(([, d]) => d.required)
    .map(([k]) => `<${k}>`)
    .join(" ")

  const usageBlock = [
    "",
    `> Run this playbook: \`iris playbook run ${plan.name} ${argStr}\``.trim(),
  ]

  // Add step summary if v2
  if (plan.steps.length > 0) {
    usageBlock.push(`> Steps: ${plan.steps.map((s) => s.id).join(" → ")}`)
  }
  usageBlock.push("")

  const output = fmLines.join("\n") + "\n" + usageBlock.join("\n") + body.trim() + "\n"
  return output
}

/**
 * Write one replica into `skillsDir/<name>/SKILL.md`.
 * In the HOME skills dir (~/.claude/skills) a hand-written SKILL.md is left alone. A symlinked
 * skill folder is left alone by `sync` (on the author's machine every ~/.claude/skills entry links
 * into a repo checkout, and a bulk sync should not rewrite those), but `install` passes
 * `followSymlink` and writes through it when the file behind it is a generated replica (#186155).
 * See `decideSkillWrite`.
 */
function writeSkillReplica(
  skillsDir: string,
  name: string,
  output: string,
  opts: { home: boolean; followSymlink?: boolean },
): { ok: true; via: string | null } | { ok: false; reason: string } {
  const targetDir = pathJoin(skillsDir, name)
  const decision = decideSkillWrite(targetDir, { home: opts.home, followSymlink: opts.followSymlink ?? false })
  if (!decision.write) return { ok: false, reason: decision.reason }
  writeFileAtomic(pathJoin(decision.via ?? targetDir, "SKILL.md"), output)
  return { ok: true, via: decision.via }
}

const PlaybookSyncCommand = cmd({
  command: "sync",
  describe: "sync playbooks to .claude/skills/ (and optionally to API with --api)",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false })
      .option("api", { type: "boolean", default: false, describe: "also push metadata to iris-api for frontend/API access" })
      .option("target", {
        type: "string",
        describe: "where to sync: claude (default, .claude/skills), cursor (.cursor/rules), agents (AGENTS.md), or all — comma-separate for several",
      }),
  async handler(args) {
    let syncTargets: SyncTarget[]
    try {
      syncTargets = parseTargets(args.target as string | undefined)
    } catch (e: any) {
      prompts.log.error(e.message)
      process.exitCode = 1
      return
    }
    await withInstance(async () => {
      const allPlaybooks = await Skill.all()
      // Rendered once per playbook, then written to every requested target (#186212).
      const rendered: { name: string; description: string; output: string }[] = []
      const skillSyncFailures: string[] = []
      const { join } = await import("path")

      // Each playbook syncs BESIDE the .iris/playbooks it lives in: a global one
      // (~/.iris/playbooks) to ~/.claude/skills, a project one to <project>/.claude/skills.
      // Both Claude Code and the IRIS Desktop app read ~/.claude/skills from every project,
      // so a global playbook is usable everywhere. It used to go to <cwd>/.claude/skills,
      // i.e. wherever the terminal happened to be — once, C:\WINDOWS\system32.
      const cwd = process.cwd()
      const home = installHome()
      const fallbackSkillsDir = join(cwd, ".claude", "skills")
      const homeSkillsDir = join(home, ".claude", "skills")
      const targets = new Set<string>()

      let synced = 0
      let skipped = 0

      if (!args.json) {
        UI.empty()
        prompts.intro("◈  Playbook Sync")
      }

      for (const info of allPlaybooks) {
        // Only sync playbooks from .iris/playbooks/ (not legacy .claude/skills/)
        if (!info.location.includes("/playbooks/") && !info.location.endsWith("PLAYBOOK.md")) {
          skipped++
          continue
        }

        let plan
        try {
          plan = await parsePlan(info)
        } catch {
          skipped++
          continue
        }

        const output = await renderSkillReplica(info, plan)
        rendered.push({ name: plan.name, description: plan.description, output })
        if (!syncTargets.includes("claude")) continue

        // Write to .claude/skills/{name}/SKILL.md
        //
        // ONE BAD DIRECTORY MUST NOT KILL THE INSTALL. Reported 2026-09-03:
        // `playbook install iris-lexicon` fetched its metadata and then aborted
        // with EEXIST creating `.claude/skills/work-the-epic` — a directory
        // belonging to a DIFFERENT skill. Every legal playbook failed the same
        // way, so an entire workflow was unusable because one unrelated path
        // could not be made. (OneDrive-backed Desktop, where a synced
        // placeholder can defeat even recursive: true.)
        //
        // Skill sync is a convenience layered on the install; the playbook is
        // already on disk here. A failure is reported and counted, never fatal.
        const skillsDir = skillsDirForPlaybook(info.location) ?? fallbackSkillsDir
        try {
          const r = writeSkillReplica(skillsDir, plan.name, output, { home: skillsDir === homeSkillsDir })
          if (!r.ok) {
            skipped++
            if (!args.json) console.log(`  ${dim("·")} ${plan.name} ${dim(`— ${join(skillsDir, plan.name)} is ${r.reason}`)}`)
            continue
          }
          targets.add(skillsDir)
          synced++
          if (!args.json) console.log(`  ${success("✓")} ${plan.name} ${dim(skillsDir === homeSkillsDir ? "(global)" : "")}`)
        } catch (e: any) {
          skillSyncFailures.push(plan.name)
          if (!args.json) {
            console.log(`  ${dim("·")} ${plan.name} ${dim("— skill sync skipped:")} ${dim(String(e?.code ?? e?.message ?? e))}`)
          }
        }
      }

      // --target cursor / agents (#186212): the same replicas, for the other agents on this repo.
      // Written into the current project — Cursor and AGENTS.md readers are per-repo.
      const extraWritten: string[] = []
      if (syncTargets.includes("cursor") && rendered.length) {
        const rulesDir = join(cwd, ".cursor", "rules")
        let n = 0
        for (const r of rendered) {
          const file = join(rulesDir, `${r.name}.mdc`)
          const existing = existsSync(file) ? readFileSync(file, "utf8") : null
          if (!isGenerated(existing)) {
            if (!args.json) console.log(`  ${dim("·")} ${r.name} ${dim(`— ${file} is hand-written; left alone`)}`)
            continue
          }
          mkdirSync(rulesDir, { recursive: true })
          writeFileAtomic(file, toCursorRule(r.output, r.description))
          n++
        }
        extraWritten.push(`${n} Cursor rule(s) → ${rulesDir}`)
      }
      if (syncTargets.includes("agents") && rendered.length) {
        const file = join(cwd, "AGENTS.md")
        const existing = existsSync(file) ? readFileSync(file, "utf8") : null
        writeFileAtomic(file, upsertAgentsBlock(existing, rendered))
        extraWritten.push(`${rendered.length} playbook(s) indexed in ${file}`)
      }
      if (!args.json) for (const line of extraWritten) console.log(`  ${success("✓")} ${line}`)

      // --api: also push metadata to iris-api
      let apiSynced = 0
      if (args.api) {
        const token = await requireAuth()
        if (!token) {
          if (!args.json) console.log(dim("  Skipping API sync — not authenticated"))
        } else {
          for (const info of allPlaybooks) {
            if (!info.location.includes("/playbooks/") && !info.location.endsWith("PLAYBOOK.md")) continue
            let plan
            try { plan = await parsePlan(info) } catch { continue }

            // `content` is the SOP body, and without it this sync uploads a
            // catalogue: the API knows a playbook NAMED deploy exists, and
            // nothing about what it says. That is why the cloud connector could
            // list playbooks but never show one — the bodies were never sent.
            // The server only overwrites content when it is non-null, so
            // sending it here cannot wipe anything.
            let content: string | undefined
            try {
              content = await Bun.file(info.location).text()
            } catch {
              // Unreadable file — still register the metadata rather than skip.
            }

            const payload = {
              name: plan.name,
              description: plan.description,
              industries: plan.industries ?? [],
              triggers: plan.triggers ?? [],
              args_schema: plan.args,
              steps_summary: plan.steps.map((s) => ({ id: s.id, title: s.title, mode: s.mode, integrations: s.integrations })),
              version: plan.version,
              ...(content ? { content } : {}),
            }
            const { IRIS_API } = await import("./iris-api")
            const res = await irisFetch("/api/v1/playbooks", {
              method: "POST",
              body: JSON.stringify(payload),
            }, IRIS_API)

            if (res.ok) {
              apiSynced++
              if (!args.json) console.log(`  ${success(">")} ${plan.name} → API`)
            } else if (!args.json) {
              console.log(dim(`  ! ${plan.name} → API failed (${res.status})`))
            }
          }
        }
      }

      if (args.json) {
        // Additive fields; the three original keys are unchanged.
        console.log(JSON.stringify({
          synced,
          skipped,
          api_synced: apiSynced,
          target: [...targets][0] ?? fallbackSkillsDir,
          targets: [...targets],
          published: false,
          scope: "local",
        }))
      } else {
        printDivider()
        const apiMsg = args.api ? `, ${apiSynced} to API` : ""
        console.log(dim(`  ${synced} synced${apiMsg}, ${skipped} skipped`))
        if (skillSyncFailures.length > 0) {
          console.log(dim(`  ${skillSyncFailures.length} could not be written: ${skillSyncFailures.join(", ")}`))
          console.log(dim(`  The playbooks themselves are installed in .iris/playbooks/ and still run.`))
        }

        // #183406 defect 1 — "94 synced, 0 skipped" reads like a publish, and nothing said
        // otherwise. Ten playbooks written in one day were believed shared and were not: sync
        // writes SKILL.md files into this repo's .claude/skills/ for the agent running on THIS
        // machine, and stops there. Saying where the files went is not the same as saying who
        // can see them, and only the second question was the one people thought they had
        // answered.
        console.log()
        console.log(`  ${bold("Local only.")} These are ${highlight("not")} published.`)
        for (const t of targets.size ? targets : new Set([fallbackSkillsDir])) {
          console.log(dim(`  Written to ${t} — read by the agents on this machine, and nowhere else.`))
        }
        if (!args.api) {
          console.log(dim(`  Nothing was uploaded${args.api ? "" : " (no --api)"}; teammates and other machines see none of this.`))
        }
        console.log()
        console.log(`  ${dim("Share one:")}  iris playbook publish <name> --scope private|project|public`)
        console.log(`  ${dim("Check one:")}  iris playbook show <name>    ${dim("— reports its scope and whether it is published")}`)

        prompts.outro(success("Done"))
      }
    })
  },
})

// ============================================================================
// Parent commands: iris playbook + iris skill (alias)
// ============================================================================
// iris playbook attach / detach / attached — bloq ↔ playbook attachment
// Parity with the Bloq builder's Playbooks tab. Hits the fl-api bloq
// endpoints that store attachments in bloq.config['playbooks'].
// ============================================================================

const AttachedCommand = cmd({
  command: "attached",
  describe: "list playbooks attached to a bloq",
  builder: (yargs) =>
    yargs
      .option("bloq", { type: "number", demandOption: true, describe: "bloq (project) id" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Attached Playbooks — Bloq #${args.bloq}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/bloqs/${args.bloq}/playbooks`)
    const ok = await handleApiError(res, "List attached playbooks")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const attached: any[] = firstArray(data?.data, (Array.isArray(data) ? data : []))
    if (args.json) { await writeJson(attached); prompts.outro("Done"); return }
    printDivider()
    if (attached.length === 0) console.log(`  ${dim("(no playbooks attached)")}`)
    else for (const p of attached) {
      console.log(`  ${bold(String(p.name ?? "unknown"))}  ${p.attached_at ? dim(String(p.attached_at)) : ""}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const AttachCommand = cmd({
  command: "attach <playbookName>",
  describe: "attach a playbook to a bloq",
  builder: (yargs) =>
    yargs
      .positional("playbookName", { type: "string", demandOption: true })
      .option("bloq", { type: "number", demandOption: true, describe: "bloq (project) id" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Attach Playbook — Bloq #${args.bloq}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/bloqs/${args.bloq}/attach-playbook`, {
      method: "POST",
      body: JSON.stringify({ playbook_name: args.playbookName }),
    })
    const ok = await handleApiError(res, "Attach playbook")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    prompts.outro(`${success("✓")} ${data?.message ?? `Attached ${highlight(String(args.playbookName))}`}`)
  },
})

const DetachCommand = cmd({
  command: "detach <playbookName>",
  describe: "detach a playbook from a bloq",
  builder: (yargs) =>
    yargs
      .positional("playbookName", { type: "string", demandOption: true })
      .option("bloq", { type: "number", demandOption: true, describe: "bloq (project) id" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Detach Playbook — Bloq #${args.bloq}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/bloqs/${args.bloq}/detach-playbook`, {
      method: "POST",
      body: JSON.stringify({ playbook_name: args.playbookName }),
    })
    const ok = await handleApiError(res, "Detach playbook")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    prompts.outro(`${success("✓")} ${data?.message ?? `Detached ${highlight(String(args.playbookName))}`}`)
  },
})

// ============================================================================
// iris playbook publish — set an association scope and push to the cloud (#167269)
// ============================================================================

/**
 * The verdict, as a pure function so it can be tested without a network.
 *
 * The rule worth pinning: UNMEASURED IS NOT SAFE. If the public list could not be
 * reached we do not know whether the playbook is listed, and "we could not check"
 * must never render as "it is private" — that is the same false-green this whole
 * epic exists to remove.
 */
export function privacyVerdict(o: { directStatus: number; listed: boolean | null }): {
  private: boolean
  readable: boolean
  measured: boolean
} {
  const readable = o.directStatus === 200
  const measured = o.listed !== null
  return { readable, measured, private: !readable && o.listed === false }
}

const PlaybookCheckPrivateCommand = cmd({
  command: "check-private <name>",
  aliases: ["check-scope", "verify-private"],
  describe: "fetch a playbook as a stranger would and report whether it is actually private",
  builder: (y) =>
    y
      .positional("name", { describe: "playbook name", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    // #182344 G-11 — `--scope private` was an ASSERTED privacy claim with nothing behind it.
    //
    // The failure is asymmetric in the worst direction. If publishing breaks, the author sees
    // an error. If PRIVACY breaks, the author sees exactly what success looks like: the command
    // succeeds, no URL is printed, and the content is on the internet. People make disclosure
    // decisions on the strength of that word, so it has to be measured rather than trusted.
    //
    // BOTH probes are unauthenticated ON PURPOSE. requireAuth() is deliberately not called —
    // the question is what an anonymous caller gets, and answering it with a credential
    // attached is the exact mistake this command exists to prevent.
    const name = String(args.name)
    const base = IRIS_API.replace(/\/$/, "")
    const UA = { "User-Agent": "iris-playbook-check-private" }

    let directStatus = 0
    let directBody = ""
    try {
      const res = await fetch(`${base}/api/v1/playbooks/${encodeURIComponent(name)}`, { headers: UA })
      directStatus = res.status
      directBody = await res.text()
    } catch (err) {
      directStatus = -1
      directBody = String(err)
    }

    let listed: boolean | null = null
    let listCount = 0
    try {
      const res = await fetch(`${base}/api/v1/playbooks`, { headers: UA })
      if (res.ok) {
        const body: any = await res.json()
        const rows: any[] = firstArray(body?.playbooks, (Array.isArray(body) ? body : []))
        listCount = rows.length
        listed = rows.some((p) => String(p?.name) === name)
      }
    } catch {
      listed = null // could not measure — say so rather than call it a pass
    }

    const verdict = privacyVerdict({ directStatus, listed })
    const readable = verdict.readable
    const isPrivate = verdict.private

    if (args.json) {
      await writeJson({
        name,
        private: isPrivate,
        direct_status: directStatus,
        readable_anonymously: readable,
        listed_anonymously: listed,
        anonymous_list_size: listCount,
      })
      return
    }

    UI.empty()
    prompts.intro(`◈  Check private — ${name}`)
    printDivider()
    printKV("Direct fetch", `${directStatus}${readable ? "  ← READABLE" : "  (withheld)"}`)
    printKV("In public list", listed === null ? "could not measure" : listed ? "YES  ← LISTED" : `no  (${listCount} public playbooks returned)`)
    printDivider()

    if (isPrivate) {
      prompts.log.success("A stranger can neither read this playbook nor see that it exists.")
    } else if (listed === null) {
      process.exitCode = 1
      prompts.log.warn("Could not reach the public list — privacy is UNMEASURED, which is not the same as safe.")
    } else {
      process.exitCode = 1
      prompts.log.error(
        `This playbook is NOT private.\n` +
        (readable ? `  Its body is served to anonymous callers (HTTP ${directStatus}, ${directBody.length} bytes).\n` : "") +
        (listed ? `  It is listed to anonymous callers.\n` : "") +
        `  Narrow it:  iris playbook publish ${name} --scope private`,
      )
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// iris playbook share <name> — how do I share this, and does the link work?
// ============================================================================

/** One address a playbook can be opened at, exactly as the registry returned it. */
export type ShareLink = { kind: "public_url" | "canonical_url"; url: string }

export type ShareSummary = {
  name: string
  scope: string
  bloq_id: number | null
  access_type: string | null
  version: number | null
  published_at: string | null
  updated_at: string | null
  uuid: string | null
  /** ONLY addresses the API returned. Never built from the name — see shareSummary(). */
  links: ShareLink[]
  who_can_open: string
  /** Set when there is no link to send, saying what to do instead. */
  note: string | null
}

function isHttpUrl(v: unknown): v is string {
  return typeof v === "string" && /^https?:\/\//i.test(v)
}

/** Who can open a playbook at this scope, in the words you would say to the person you send it to. */
export function shareAudience(scope: string, bloqId: number | null): string {
  switch (scope) {
    case "public":   return "Anyone — it is listed in the marketplace, no sign-in needed"
    case "unlisted": return "Anyone with the link — it is not listed in the marketplace, no sign-in needed"
    case "project":  return `Signed-in members of board #${bloqId ?? "?"} only`
    case "private":  return "Only you, signed in"
    case "local":    return "Nobody else — it is on this machine only and was never uploaded"
    default:         return `Whoever the registry allows (scope "${scope}")`
  }
}

/**
 * What to tell someone about sharing a playbook, from the registry row alone. Pure, so it is
 * tested without a network.
 *
 * THE RULE: a URL is printed only if the API returned it. #185980 — at project scope `publish`
 * fell back to building `/playbooks/<name>` itself, and that address 404s for everyone, members
 * included, because the page never resolves a project-scope playbook. A made-up link that looks
 * exactly like a real one is worse than no link: it gets pasted into a message and fails there.
 */
export function shareSummary(pb: any, fallbackName?: string): ShareSummary {
  const name = String(pb?.name ?? fallbackName ?? "")
  const scope = String(pb?.scope ?? "unknown")
  const bloqId = pb?.bloq_id != null ? Number(pb.bloq_id) : null

  const links: ShareLink[] = []
  if (isHttpUrl(pb?.public_url)) links.push({ kind: "public_url", url: pb.public_url })
  if (isHttpUrl(pb?.canonical_url) && pb.canonical_url !== pb?.public_url) {
    links.push({ kind: "canonical_url", url: pb.canonical_url })
  }

  let note: string | null = null
  if (links.length === 0) {
    if (scope === "project") {
      note = `No web link — members of board #${bloqId ?? "?"} install it with: iris playbook install ${name}`
    } else if (scope === "private") {
      note = `No web link — it is private. Widen it first: iris playbook publish ${name} --scope unlisted`
    } else if (scope === "local") {
      note = `No web link — it was never uploaded. Publish it first: iris playbook publish ${name} --scope unlisted`
    } else {
      note = `The registry returned no web link for this playbook (scope "${scope}"), so there is none to share.`
    }
  }

  return {
    name,
    scope,
    bloq_id: bloqId,
    access_type: pb?.access_type ?? null,
    version: pb?.version != null ? Number(pb.version) : null,
    published_at: pb?.published_at ?? null,
    updated_at: pb?.updated_at ?? null,
    uuid: pb?.uuid ?? null,
    links,
    who_can_open: shareAudience(scope, bloqId),
    note,
  }
}

export type LinkCheck = { status: number; opens: boolean; detail: string }

/**
 * Judge an anonymous fetch of a share link. A 200 alone is not "it works": the detail page has
 * in the past framed a 200 around a null playbook, so the body must also name the playbook.
 */
export function judgeLinkFetch(status: number, body: string, name: string): LinkCheck {
  if (status === -1) return { status, opens: false, detail: "could not reach it — UNMEASURED, not the same as working" }
  if (status !== 200) return { status, opens: false, detail: `HTTP ${status} — a stranger gets an error page` }
  if (!body.includes(name)) return { status, opens: false, detail: "HTTP 200, but the page does not show this playbook" }
  return { status, opens: true, detail: "HTTP 200 — opens for someone who is not signed in" }
}

/** Fetch a link the way the person you send it to would: no credential attached, ever. */
async function checkLinkAnonymously(url: string, name: string): Promise<LinkCheck> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "iris-playbook-share" },
      signal: AbortSignal.timeout(10000),
    })
    return judgeLinkFetch(res.status, await res.text(), name)
  } catch (e: any) {
    return { ...judgeLinkFetch(-1, "", name), detail: `could not reach it (${e?.message ?? String(e)}) — UNMEASURED, not the same as working` }
  }
}

const PlaybookShareCommand = cmd({
  command: "share <name>",
  aliases: ["url", "access"],
  describe: "show a published playbook's link, who can open it, and whether the link works right now",
  builder: (y) =>
    y
      .positional("name", { describe: "playbook name", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const name = String(args.name)
    const json = Boolean(args.json)

    const token = await requireAuth()
    if (!token) return

    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(name)}`, {}, IRIS_API)
    let pb: any = null
    if (res.status === 404) {
      // Not in the registry. Either it only exists on this machine (scope local), or it does not exist.
      const local = await withInstance(() => Skill.get(name)).catch(() => null)
      if (!local) {
        const msg = `Playbook "${name}" is not published, and it is not on this machine.`
        if (json) await writeJson({ name, ok: false, error: msg })
        else console.error(msg)
        process.exitCode = 1
        return
      }
      pb = { name, scope: "local" }
    } else if (!res.ok) {
      await handleApiError(res, "Look up playbook")
      process.exitCode = 1
      return
    } else {
      const data = (await res.json()) as any
      pb = data?.playbook ?? data
    }

    const summary = shareSummary(pb, name)
    const checks = await Promise.all(summary.links.map((l) => checkLinkAnonymously(l.url, summary.name)))

    if (json) {
      await writeJson({
        ...summary,
        links: summary.links.map((l, i) => ({ ...l, anonymous_check: checks[i] })),
      })
      return
    }

    UI.empty()
    prompts.intro(`◈  Share — ${summary.name}`)
    printDivider()
    printKV("Scope", summary.scope)
    if (summary.bloq_id != null) printKV("Board", `#${summary.bloq_id}`)
    if (summary.access_type) printKV("Access", summary.access_type)
    if (summary.version != null) printKV("Registry version", String(summary.version))
    if (summary.published_at) printKV("Published", summary.published_at)
    if (summary.updated_at) printKV("Updated", summary.updated_at)
    printKV("Who can open it", summary.who_can_open)
    printDivider()
    summary.links.forEach((l, i) => {
      const label = l.kind === "public_url" ? "Link to send" : "Canonical link"
      const c = checks[i]
      console.log(`  ${bold(label)}  ${highlight(l.url)}`)
      console.log(`    ${c.opens ? success("✓") : "✗"} ${dim(`checked just now, signed out: ${c.detail}`)}`)
    })
    if (summary.note) console.log(`  ${summary.note}`)
    printDivider()
    prompts.outro("Done")
  },
})

/**
 * The web URL for a published playbook (#182116).
 *
 * publish used to succeed and hand back nothing shareable — `show` returns a filesystem path —
 * so a playbook could be published to a team and reach nobody. The page resolves by name and
 * inherits the API's visibility exactly: public to anyone, project to the bloq, private to the
 * owner, and a 404 for everyone else.
 *
 * Built from IRIS_API rather than hardcoded, so a staging or self-hosted install prints its own
 * host instead of confidently sending somebody to production.
 */
export function playbookUrl(name: string): string {
  const base = String(IRIS_API).replace(/\/+$/, "")

  // /playbooks/{name} — the real detail route (web.php: playbooks.show), serving a
  // Playbooks/Show page. This used to build /p/playbook?name=… : a query string against a
  // generic viewer page, which is not the address anyone would type, link, or recognise.
  // The docblock above already described /playbooks semantics; only the string was wrong.
  return `${base}/playbooks/${encodeURIComponent(name)}`
}

/**
 * Whether a playbook is published, and at what scope (#183406, defect 2).
 *
 * There was no way to ask. `show` printed a filesystem path and a URL; `list` printed names.
 * Neither said published or not, and the URL is not a substitute — it renders 200 for an
 * UNPUBLISHED name too (a non-public scope comes back with a null prop and the page still
 * frames), so opening it proves nothing either way. Ten playbooks were believed shared on the
 * strength of exactly that.
 *
 * THREE STATES, NEVER TWO. "Could not reach the registry" is not "unpublished" — this is the
 * same rule `check-private` states as UNMEASURED IS NOT SAFE, and it points the other way here:
 * rendering an unreachable registry as "not published" would tell someone their playbook is
 * private when it may well be public.
 *
 * Hard-capped at 3.5s total (irisFetch retries GETs three times, which is right for a command
 * that needs the answer and wrong for one decorating an otherwise-local view). A timeout is
 * "unknown", and every caller treats the lookup as optional.
 */
export type PublishState =
  | {
      state: "published"
      scope: string
      published_at: string | null
      bloq_id: number | null
      access_type: string | null
      updated_at: string | null
    }
  | { state: "unpublished" }
  | { state: "unknown"; reason: string }

/**
 * Every playbook the registry will show us, name -> scope, in ONE request (#183406, defect 2).
 *
 * `null` means we could not measure — never an empty map, because an empty map is
 * indistinguishable from "nothing is published" and that is the wrong half of the ambiguity to
 * resolve silently.
 */
async function fetchRegistryScopes(): Promise<Map<string, string> | null> {
  const rows = await fetchRegistryRows()
  if (rows === null) return null
  const out = new Map<string, string>()
  for (const p of rows) {
    if (p?.name) out.set(String(p.name), String(p.scope ?? "unknown"))
  }
  return out
}

/** Every playbook row the registry will show this caller. `null` = could not ask; never `[]` for that. */
async function fetchRegistryRows(): Promise<any[] | null> {
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000))
  try {
    const raced = await Promise.race([irisFetch(`/api/v1/playbooks`, {}, IRIS_API), timeout])
    if (raced === "timeout") return null
    const res = raced as Response
    if (!res.ok) return null
    const body = (await res.json()) as any
    return firstArray(body?.playbooks, Array.isArray(body) ? body : [])
  } catch {
    return null
  }
}

/**
 * The error for a playbook that is not on this machine.
 *
 * `run`, `show` and `test` read only the local disk, so a playbook published to the
 * marketplace answered a bare `Skill "x" not found` to every client who had not installed it.
 * True about the disk, and read by clients as "this playbook does not exist". Ask the
 * registry which of the three cases it is and name the next command.
 *
 * Deliberately NOT an auto-install: that would download shell steps from the network and
 * execute them without the user ever choosing to install them.
 */
export async function reportNotInstalled(name: string): Promise<void> {
  const state = await fetchPublishState(name)
  if (state.state === "published") {
    console.error(`Playbook "${name}" is not installed on this machine. It is published (${state.scope}) — install it, then run it again:`)
    console.error(`  iris playbook install ${name}`)
    return
  }
  if (state.state === "unpublished") {
    console.error(`Playbook "${name}" not found — it is not installed here, and nothing by that name is published that you can see.`)
    console.error(dim("  What you can install: iris playbook available"))
    return
  }
  console.error(`Playbook "${name}" is not installed on this machine, and the marketplace could not be checked (${state.reason}).`)
  console.error(dim(`  If it is published: iris playbook install ${name}`))
}

async function fetchPublishState(name: string): Promise<PublishState> {
  const timeout = new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 3500))
  try {
    const raced = await Promise.race([
      irisFetch(`/api/v1/playbooks/${encodeURIComponent(name)}`, {}, IRIS_API),
      timeout,
    ])
    if (raced === "timeout") return { state: "unknown", reason: "registry did not answer within 3.5s" }
    const res = raced as Response
    if (res.status === 404) return { state: "unpublished" }
    if (res.status === 401 || res.status === 403) {
      return { state: "unknown", reason: "not signed in — run `iris auth login` to see publish state" }
    }
    if (!res.ok) return { state: "unknown", reason: `registry returned HTTP ${res.status}` }
    const data = (await res.json()) as any
    const pb = data?.playbook ?? data
    if (!pb || !pb.name) return { state: "unpublished" }
    return {
      state: "published",
      scope: String(pb.scope ?? "unknown"),
      published_at: pb.published_at ?? null,
      bloq_id: pb.bloq_id ?? null,
      access_type: pb.access_type ?? null,
      updated_at: pb.updated_at ?? null,
    }
  } catch (e: any) {
    return { state: "unknown", reason: `could not reach the registry (${e?.message ?? String(e)})` }
  }
}

/** What a given scope means for who can open that URL. Said plainly, because "published" does not. */
function audienceNote(scope?: string, bloqId?: number | null): string {
  switch (scope) {
    case "public":   return "anyone — it is listed in the marketplace"
    case "unlisted": return "anyone with the link — it appears in no listing, and no sign-in is asked for"
    // Deliberately no longer described as "unlisted". It said that for months, which reads as
    // "a link will work" — and a link does NOT work: the reader has to be an OTP-proven member
    // of the bloq. That wording is what sent someone hunting for a share URL that did not exist.
    case "project":  return `members of bloq #${bloqId ?? "?"} only, and they must be signed in — a bare link will 404`
    case "private":  return "only you — but stored in the cloud registry, so it can reach another machine you sign into"
    case "local":    return "nobody but this machine — it is never uploaded, so there is no URL to open"
    default:         return "whoever the API allows"
  }
}

/**
 * Playbook scope -> exposure-gate tier. The two vocabularies differ on purpose: the ladder in
 * exposure-gate.ts is shared across pages, notes, datasets and components, so it says "team"
 * where playbooks say "project".
 */
function scopeToTier(scope: string): ExposureTier {
  switch (scope) {
    case "public":   return "public"
    case "unlisted": return "unlisted"
    case "project":  return "team"
    default:         return "private"   // private, local
  }
}

/**
 * What scope is this playbook at RIGHT NOW, so the gate compares against reality.
 *
 * A lookup that fails answers "private" — the most private thing it could be — because
 * isWidening() treats an unknown `from` the same way: when we cannot tell, err toward asking
 * rather than toward silently widening. Never let a network hiccup become consent.
 */
async function currentTier(name: string): Promise<ExposureTier> {
  try {
    // IRIS_API, not the default base. Playbooks live on the iris API; irisFetch defaults to
    // FL_API, so this asked the wrong service and every lookup fell through to "private" —
    // which made the publish gate treat every playbook as a widening and demand confirmation
    // for changes that were not widening at all.
    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(name)}`, {}, IRIS_API)
    if (!res.ok) return "private"
    const body = (await res.json()) as any
    return scopeToTier(String(body?.playbook?.scope ?? "private"))
  } catch {
    return "private"
  }
}

/**
 * Take a published playbook back out of view.
 *
 * IT DOES NOT UNDO A PUBLISH, and the output says so. Anyone who already installed it has it;
 * anything that crawled it has it. What this changes is what happens NEXT: the playbook leaves
 * the marketplace listing, stops resolving for people who are not you, and can no longer be
 * installed by a stranger who finds the name.
 *
 * Implemented as a narrowing to `private` rather than a delete, deliberately. The registry copy
 * is what `iris playbook install` restores from and what `verify` compares against — deleting
 * it to achieve "unpublished" would throw away the thing that lets you check the state you just
 * asked for. Use `--scope local` on publish if you want a playbook that was never uploaded.
 *
 * Narrowing needs no confirmation. The gate on `publish` exists because widening is the
 * irreversible direction; this one only ever removes reach.
 */
const UnpublishCommand = cmd({
  command: "unpublish <name>",
  describe: "take a playbook out of the marketplace — narrows it back to private (does NOT un-send it)",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    await requireAuth()

    // READ FOR REPORTING, NEVER AS A GATE.
    //
    // currentTier() answers "private" when it cannot tell — correct for publish, where an
    // unknown state should err toward asking. It is exactly wrong here: it would turn a failed
    // lookup into "already private, nothing to do" and silently leave a public playbook public.
    // Measured — that is precisely what happened on the first run of this command, because the
    // lookup was hitting the wrong service.
    //
    // Narrowing is always safe, so the write happens regardless and `before` only shapes the
    // wording.
    const before = await currentTier(String(args.name))

    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(String(args.name))}/publish`, {
      method: "POST",
      body: JSON.stringify({ scope: "private" }),
    }, IRIS_API)

    if (!res.ok) {
      const body = await res.text().catch(() => "")
      console.error(`  Could not unpublish: HTTP ${res.status} ${body.slice(0, 200)}`)
      process.exitCode = 1
      return
    }

    if (args.json) return void (await writeJson({ name: args.name, was: before, scope: "private", changed: true }))

    console.log()
    console.log(`  ${success("✓")} ${bold(String(args.name))} is now ${bold("private")}${before === "private" ? "" : dim(` (was ${before})`)}`)
    console.log(`  ${dim("Delisted, and no longer installable by anyone but you.")}`)
    console.log()
    // The honest half. A command called "unpublish" invites the belief that it undid the
    // publish, and it did not.
    if (before === "public" || before === "unlisted") {
      console.log(`  ${dim("This does NOT un-send it. Anyone who already installed it still has their copy,")}`)
      console.log(`  ${dim("and anything that crawled it while it was reachable still has what it read.")}`)
      console.log(`  ${dim("Change what matters — credentials, ids, internal names — rather than relying on this.")}`)
      console.log()
    }
    console.log(`  ${dim(`Check it: `)}${"iris playbook verify " + args.name}`)
  },
})

const PublishCommand = cmd({
  command: "publish <name>",
  describe: "publish a playbook with a scope: local | private | project | unlisted | public",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("scope", {
        type: "string",
        choices: ["local", "private", "project", "unlisted", "public"] as const,
        demandOption: true,
        describe:
          "association scope: local (this machine only, never uploaded), private (you, via the cloud registry), " +
          "project (a bloq/team, sign-in required), unlisted (anyone with the link, in no listing), " +
          "public (marketplace)",
      })
      .option("bloq", { type: "number", describe: "bloq (project) id — required when --scope project" })
      .option("access", {
        type: "string",
        choices: ["free", "paid"] as const,
        default: "free",
        describe: "access level for a public/marketplace publish",
      })
      .option("force", { type: "boolean", default: false, describe: "consent to a PUBLIC publish — REQUIRED when there is no terminal" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Publish Playbook — ${highlight(String(args.name))}`)

    // #182937 — `local` returns HERE, above everything.
    //
    // "private" was read as "stays on my machine". It does not: it is a cloud-backed,
    // you-only association — `playbook verify` compares the local file against the API
    // registry, and `check-private` fetches the URL "as a stranger would", both of which
    // require the thing to have been uploaded. That is the right primitive for reaching a
    // second machine you sign into, and the wrong one for "no cloud footprint".
    //
    // So this branch sits ABOVE the consent prompt, ABOVE requireAuth, and above every
    // irisFetch in this handler. Not as an optimisation — as the guarantee. There is no
    // ordering of the code below that can be reached with scope=local, which is what makes
    // "never written to the API registry" a property of the control flow rather than a promise
    // in a docstring.
    if (args.scope === "local") {
      const resolved = await withInstance(async () => {
        const info = await Skill.get(String(args.name))
        if (!info) return null
        const plan = await parsePlan(info)
        return { location: info.location, version: plan.version ?? undefined }
      })

      if (!resolved) {
        console.error(`  No playbook named '${args.name}' resolves on this machine.`)
        console.error(`  ${dim("`iris playbook list` shows the exact names.")}`)
        process.exitCode = 1
        prompts.outro("Done"); return
      }

      if (args.json) {
        await writeJson({
          ok: true,
          name: String(args.name),
          scope: "local",
          location: resolved.location,
          version: resolved.version ?? null,
          uploaded: false,
          audience: audienceNote("local"),
        })
        return
      }

      console.log()
      console.log(`  ${success(">")} ${bold(String(args.name))} is registered locally — nothing was uploaded.`)
      console.log(`    ${dim("on disk")}    ${resolved.location}`)
      if (resolved.version) console.log(`    ${dim("version")}   ${resolved.version}`)
      console.log(`    ${dim("audience")}  ${audienceNote("local")}`)
      console.log()
      console.log(`  ${dim(`Run it:   iris playbook run ${args.name}`)}`)
      console.log(`  ${dim(`List it:  iris playbook list`)}`)
      console.log(`  ${dim(`Later, to put it in the cloud registry: iris playbook publish ${args.name} --scope private`)}`)
      prompts.outro("Done")
      return
    }

    if (args.scope === "project" && !args.bloq) {
      console.error("  --bloq <id> is required when --scope project")
      prompts.outro("Done"); return
    }

    // A defect the SCHEMA validator cannot see must not reach other people.
    //
    // The pre-push hook runs this same check, and a publish is not a git push — which is
    // exactly how all three of the 2026-09-04 defects reached the marketplace. work-the-epic
    // shipped defaulting to `bloq: 297`, the authors' own bug board, so every stranger's run
    // filed into someone else's project; its publish step read a /tmp file no step wrote and
    // published whatever the previous run had left there. Both passed `iris playbook test`.
    //
    // Placed ABOVE the widening prompt on purpose: nobody should be asked to confirm making
    // a broken playbook public. Correctness first, exposure second.
    //
    // Blocking, not advisory. The whole lesson of those three is that a warning printed
    // beside a success message is read as success.
    {
      const md = await withInstance(async () => {
        const info = await Skill.get(String(args.name))
        return info ? await Bun.file(info.location).text() : null
      }).catch(() => null)

      const blocking = md ? blockingFindings(lintPlaybook(md), String(args.scope)) : []
      if (blocking.length) {
        UI.empty()
        console.error(`  Refusing to publish — ${blocking.length} defect(s) that \`iris playbook test\` calls valid:`)
        UI.empty()
        for (const f of blocking) {
          console.error(`    ${f.rule}  ${f.detail}`)
          console.error(`      ${dim(PLAYBOOK_RULES[f.rule])}`)
        }
        UI.empty()
        console.error(`  ${dim("These survive schema validation, so a green `playbook test` does not clear them.")}`)
        process.exitCode = 1
        prompts.outro("Refused — nothing published")
        return
      }
    }

    // #182344 G-04 — a marketplace publish is the widest thing this CLI can do.
    //
    // `from` is READ, not assumed. It was hardcoded to "private", which made every
    // re-publish of an already-project playbook look like a widening: the gate demanded
    // --force for a no-op at the scope the playbook was already at, moments after a
    // publish had reported that exact scope back. A guard that cries wolf on a no-op
    // trains people to pass --force reflexively, which is the worst possible outcome for
    // a guard whose entire job is to make one specific action deliberate.
    //
    // Failing to READ the current scope now falls back to "private" for the same reason
    // isWidening() does — err toward asking. But that is now a fallback for a failed
    // lookup, not the permanent answer it used to be.
    {
      const to = scopeToTier(String(args.scope))
      const from = await currentTier(String(args.name))
      const verdict = await confirmWiden({
        noun: "playbook",
        name: String(args.name),
        from,
        to: to as any,
        extra: args.scope === "public"
          ? [`It is listed in the marketplace as ${String(args.access ?? "free")} and anyone can install it.`]
          : args.scope === "unlisted"
            ? [
                "Anyone holding the link can read it without signing in.",
                "It stays out of every listing, but the link is the whole credential — once sent it cannot be recalled.",
              ]
            : [],
        force: Boolean(args.force),
      })
      if (!verdict.ok) {
        process.exitCode = verdict.reason === "needs-force" ? 1 : 0
        prompts.outro(verdict.reason === "needs-force" ? "Refused — nothing published" : "Cancelled — nothing published")
        return
      }
    }

    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const { IRIS_API } = await import("./iris-api")

    // 0. Upload the local playbook first (#180423).
    //
    // publish used to POST straight to /publish, which only ever succeeds for a playbook
    // the SERVER already knows. A playbook authored locally has never been uploaded, so
    // publish answered `not found` for something `list`, `show`, `test` and `sync` all
    // resolved happily — and since `.iris/` is gitignored, publish is the only way it can
    // leave the machine at all. The result was an author holding a working playbook with
    // no path to anyone else.
    //
    // So resolve it the same way every other verb does and upsert it before publishing.
    // Same endpoint and payload as `sync --api`; the server only overwrites content when
    // it is non-null, so this cannot blank an existing body.
    let foundLocally = false
    try {
      const local = await withInstance(async () => {
        const info = await Skill.get(String(args.name))
        if (!info) return null
        const plan = await parsePlan(info)
        let content: string | undefined
        try { content = await Bun.file(info.location).text() } catch { /* register metadata anyway */ }
        return { plan, content }
      })

      if (local) {
        foundLocally = true
        const upRes = await irisFetch("/api/v1/playbooks", {
          method: "POST",
          body: JSON.stringify({
            name: local.plan.name,
            description: local.plan.description,
            industries: local.plan.industries ?? [],
            triggers: local.plan.triggers ?? [],
            args_schema: local.plan.args,
            steps_summary: local.plan.steps.map((s: any) => ({ id: s.id, title: s.title, mode: s.mode, integrations: s.integrations ?? [] })),
            version: local.plan.version,
            ...(local.content ? { content: local.content } : {}),
          }),
        }, IRIS_API)

        if (!upRes.ok) {
          // Don't stop — the playbook may already exist server-side and still be publishable.
          // But say so, because publishing a stale body silently is its own bug.
          console.log(dim(`  ! Could not upload the local copy (${upRes.status}) — publishing whatever the server already holds.`))
        } else if (!args.json) {
          console.log(`  ${success(">")} Uploaded local copy`)
        }
      }
    } catch {
      // Local resolution is best-effort. A server-side-only playbook must still publish.
    }

    // 1. Set the association + route: iris-api records scope and upserts the marketplace row on public.
    // NOTE: playbooks live on IRIS_API (freelabel.net), not the default FL_API base — without this
    // the request hits fl-api, which has no publish route, and 404s.
    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(String(args.name))}/publish`, {
      method: "POST",
      body: JSON.stringify({
        scope: args.scope,
        bloq_id: args.bloq ?? null,
        access_type: args.access,
      }),
    }, IRIS_API)
    const ok = await handleApiError(res, "Publish playbook")
    if (!ok) {
      if (!foundLocally) {
        // The old failure mode, now explained rather than just reported: nothing named
        // this exists on the server AND nothing resolves locally, so there was nothing
        // to upload on the way through.
        console.error(`  ${dim(`No playbook named '${args.name}' was found locally either — check \`iris playbook list\` for the exact name.`)}`)
      }
      prompts.outro("Done"); return
    }
    const data = (await res.json()) as any

    // 2. Project scope: also attach to the bloq so the team sees it (config.playbooks[], #157174).
    if (args.scope === "project" && args.bloq) {
      const attachRes = await irisFetch(`/api/v1/bloqs/${args.bloq}/attach-playbook`, {
        method: "POST",
        body: JSON.stringify({ playbook_name: args.name }),
      })
      await handleApiError(attachRes, "Attach to bloq")
    }

    if (args.json) { await writeJson(data); prompts.outro("Done"); return }

    printDivider()
    const pb = data?.playbook ?? {}
    console.log(`  ${bold("Scope")}       ${pb.scope ?? args.scope}`)
    if (pb.bloq_id) console.log(`  ${bold("Bloq")}        #${pb.bloq_id}`)
    console.log(`  ${bold("Access")}      ${pb.access_type ?? args.access}`)
    // The address, or why there is not one. /playbooks/{name} has worked all along; nothing ever
    // returned it, so publish reported success and left the caller to guess — or to conclude that
    // playbooks had no web surface at all.
    if (data?.marketplace) {
      console.log(`  ${bold("Marketplace")} ${highlight(String(data.marketplace.slug))} ${dim(`(${data.marketplace.status})`)}`)
    }

    // ONE url line. This printed two: "none — only a public playbook gets one", immediately
    // followed by an actual URL. Both were labelled URL, so the output contradicted itself
    // and the reader had to guess which half to believe.
    //
    // The address is the same whatever the scope — /playbooks/{name} resolves by name and
    // inherits the API's visibility. Scope decides who can OPEN it, not whether it exists,
    // so that is said on its own line rather than by withholding the link.
    const url = String(pb.public_url || playbookUrl(String(args.name)))
    console.log(`  ${bold("URL")}         ${highlight(url)}`)
    // For an unlisted playbook the two addresses differ and both matter: the uuid is the
    // unguessable one you send, the slug is the stable one you cite in a doc. Printing only
    // one of them means somebody pastes the wrong kind into the wrong place.
    if ((pb.scope ?? args.scope) === "unlisted" && pb.canonical_url && pb.canonical_url !== url) {
      console.log(`  ${bold("Canonical")}   ${dim(String(pb.canonical_url))}`)
    }
    console.log(`  ${bold("Who can open")} ${audienceNote(pb.scope ?? String(args.scope), pb.bloq_id ?? args.bloq)}`)
    printDivider()
    prompts.outro(`${success("✓")} Published ${highlight(String(args.name))} as ${bold(String(args.scope))}`)
  },
})


// ============================================================================
// iris playbook doctor [name] — diagnose common playbook problems
// ============================================================================
// Every one of these was found by hand, once, the slow way: a version:1
// playbook with `### step:` blocks in the body silently falls back to a raw
// text dump instead of running (parsePlan only calls parseSteps when
// version===2), and a stray second copy of a playbook (a global install, an
// old clone) silently shadows the project one with no signal that it
// happened. Both are invisible from `run`/`test` alone. `doctor` surfaces
// them directly instead of a multi-hour bisection with python heredocs.

const PlaybookDoctorCommand = cmd({
  command: "doctor [name]",
  describe: "diagnose common playbook problems: version/step mismatches, shadow copies, validation issues",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", describe: "check a single playbook (default: check all)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await withInstance(async () => {
      const name = args.name as string | undefined

      if (name) {
        const info = await Skill.get(name)
        if (!info) {
          console.error(`Skill "${name}" not found`)
          process.exit(1)
        }
      }

      const targets = name ? [(await Skill.get(name))!] : await Skill.all()

      type Problem = { level: "error" | "warning"; message: string }
      type Report = { name: string; location: string; problems: Problem[] }
      const reports: Report[] = []

      for (const info of targets) {
        const problems: Problem[] = []

        // Shadow copies — every location this name resolves to, not just the winner.
        const locs = await Skill.locations(info.name)
        if (locs.length > 1) {
          problems.push({
            level: "warning",
            message: `${locs.length} copies found on disk — using ${locs[0].location}; ignoring: ${locs.slice(1).map((l) => l.location).join(", ")}`,
          })
        }

        let plan: SkillPlan
        try {
          plan = await parsePlan(info)
        } catch (e: any) {
          problems.push({ level: "error", message: `Failed to parse: ${e.message}` })
          reports.push({ name: info.name, location: info.location, problems })
          continue
        }

        // The version/steps trap (frontmatter `version` not EXACTLY 2 silently
        // degrades the plan to v1, which parses zero steps and executes nothing)
        // now lives in validatePlan, so `doctor`, `test`, `e2e` and the MCP
        // listing all report it identically. It used to be implemented here and
        // ONLY here — which is why `iris playbook test` passed a playbook that
        // `doctor` failed, and why a mis-versioned playbook could ship green.
        for (const issue of validatePlan(plan)) {
          problems.push({
            level: issue.level,
            message: issue.stepId ? `[${issue.stepId}] ${issue.message}` : issue.message,
          })
        }

        reports.push({ name: info.name, location: info.location, problems })
      }

      const unhealthy = reports.filter((r) => r.problems.length > 0)

      if (args.json) {
        await writeJson({ checked: reports.length, unhealthy: unhealthy.length, reports: unhealthy })
        if (unhealthy.some((r) => r.problems.some((p) => p.level === "error"))) process.exitCode = 1
        return
      }

      UI.empty()
      prompts.intro(name ? `◈  Doctor: ${name}` : `◈  Doctor — ${reports.length} playbook(s)`)
      printDivider()

      if (unhealthy.length === 0) {
        console.log(success(`  ✓ No problems found${name ? "" : ` across ${reports.length} playbook(s)`}`))
      } else {
        for (const r of unhealthy) {
          console.log(`  ${bold(r.name)}  ${dim(r.location)}`)
          for (const p of r.problems) {
            const icon = p.level === "error" ? "✗" : "⚠"
            console.log(p.level === "error" ? `    ${icon} ${p.message}` : dim(`    ${icon} ${p.message}`))
          }
          console.log()
        }
      }

      printDivider()
      const hasErrors = unhealthy.some((r) => r.problems.some((p) => p.level === "error"))
      prompts.outro(unhealthy.length === 0 ? success("Healthy") : hasErrors ? "Problems found" : "Warnings found")
      if (hasErrors) process.exitCode = 1
    })
  },
})

// ============================================================================
// iris playbook verify <name> — confirm a publish actually landed
// ============================================================================
// Replaces the manual dance done by hand after every publish today: curl the
// registry, grep the public page, python-parse the JSON, compare by eye.
// One command, three layers — local file, API registry, live public page —
// so "it published" (a checkmark) and "it's actually live and current"
// (this) can no longer be silently different things (see the empty-404-body
// and grep-for-a-symbol traps in PRODUCTION_DEBUGGING_GUIDE.md — same shape).

const PlaybookVerifyCommand = cmd({
  command: "verify <name>",
  describe: "confirm a publish actually landed — checks local file vs API registry vs the live public page",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const name = String(args.name)
    const json = args.json as boolean
    if (!json) {
      UI.empty()
      prompts.intro(`◈  Verify — ${highlight(name)}`)
    }

    const token = await requireAuth()
    if (!token) {
      if (json) { await writeJson({ name, ok: false, checks: [], error: "not authenticated" }); process.exitCode = 1; return }
      prompts.outro("Done"); return
    }

    type Check = { label: string; ok: boolean; detail: string }
    const checks: Check[] = []

    // 1. Local file
    const local = await withInstance(async () => {
      const info = await Skill.get(name)
      if (!info) return null
      try {
        const plan = await parsePlan(info)
        const content = await Bun.file(info.location).text()
        return { plan, content, location: info.location }
      } catch (e: any) {
        return { error: e.message as string, location: info.location }
      }
    })
    checks.push({
      label: "Local file",
      ok: Boolean(local && !("error" in local)),
      detail: !local ? "not found locally" : "error" in local ? `parse error: ${local.error}` : local.location,
    })

    // 2. API registry
    const { IRIS_API } = await import("./iris-api")
    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(name)}`, {}, IRIS_API)
    let pb: any = null
    if (res.ok) {
      const data = (await res.json()) as any
      pb = data?.playbook ?? data
    }
    checks.push({
      label: "API registry",
      ok: Boolean(pb),
      detail: pb ? `scope=${pb.scope}, version=${pb.version}, updated ${pb.updated_at ?? "?"}` : `not registered (HTTP ${res.status})`,
    })

    // 3. Content drift — does what's registered actually match the local file?
    // A green publish checkmark says the request succeeded, not that the body sent was current.
    if (local && !("error" in local) && pb?.content != null) {
      const same = local.content.trim() === String(pb.content).trim()
      checks.push({
        label: "Content matches API",
        ok: same,
        detail: same ? "identical" : `local file differs from what's registered — re-run "iris playbook sync --api" or "publish"`,
      })
    }

    // 4. Live public page — only meaningful once scope is public.
    if (pb?.public_url) {
      let pageOk = false
      let pageDetail: string
      try {
        const pageRes = await fetch(pb.public_url)
        pageOk = pageRes.ok
        pageDetail = pageOk ? `HTTP ${pageRes.status}` : `HTTP ${pageRes.status} — page not live`
      } catch (e: any) {
        pageDetail = `fetch failed: ${e.message}`
      }
      checks.push({ label: "Public page", ok: pageOk, detail: `${pb.public_url} (${pageDetail})` })
    } else if (pb) {
      const expectedPublic = pb.scope === "public"
      checks.push({
        label: "Public page",
        ok: !expectedPublic,
        detail: expectedPublic
          ? "scope is public but the API returned no public_url — inconsistent state"
          : `scope is "${pb.scope}" — no public page expected`,
      })
    }

    if (json) {
      const allOk = checks.every((c) => c.ok)
      await writeJson({ name, ok: allOk, checks })
      if (!allOk) process.exitCode = 1
      return
    }

    printDivider()
    for (const c of checks) {
      console.log(`  ${c.ok ? success("✓") : "✗"} ${bold(c.label)}  ${dim(c.detail)}`)
    }
    printDivider()
    const allOk = checks.every((c) => c.ok)
    prompts.outro(allOk ? success("Verified") : "Problems found")
    if (!allOk) process.exitCode = 1
  },
})

// ============================================================================
// iris playbook available / install — the PULL half
// ============================================================================
// publish/attach/sync covered author → server → the author's own .claude/skills.
// Nothing brought a PUBLISHED playbook DOWN to somebody else's machine, so an
// operator could install the CLI, wire MCP, open Claude Code — and receive zero
// procedures. `sync` is local → local; it only rewrites playbooks already on disk.
//
// GET /api/v1/playbooks is already scope-filtered server-side (visibleTo), and
// GET /api/v1/playbooks/{name} returns the full markdown body under the same
// filter — so this is a client change only. An unknown or invisible name 404s
// rather than 403s, deliberately: telling someone a private playbook EXISTS is
// itself a disclosure.

/**
 * Where an installed playbook lands — see src/skill/install-location.ts. Default is the home
 * dir (~/.iris/playbooks + ~/.claude/skills), which the CLI, Claude Code and the IRIS Desktop
 * app all read from any folder; a git project that already has .iris/playbooks keeps its own.
 */
function installTarget(name: string, mode: InstallMode = "auto") {
  const root = resolveInstallRoot({ cwd: process.cwd(), home: installHome(), mode })
  return { root, ...playbookFile(root, name) }
}

/** Installed anywhere the loader would find it from here — this project's copy or the global one. */
function isInstalled(name: string): boolean {
  return existsSync(installTarget(name).file) || existsSync(installTarget(name, "global").file)
}

const PlaybookAvailableCommand = cmd({
  command: "available",
  aliases: ["remote-list"],
  describe: "list published playbooks you can install (scoped to what you can see)",
  builder: (yargs) =>
    yargs
      .option("bloq", {
        type: "number",
        describe: "only playbooks published to this project (bloq id)",
      })
      .option("json", { type: "boolean", default: false })
      .example("$0 playbook available --bloq 517", "what can be run on the Pathways SOP Library"),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Playbooks — Available to Install")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const { IRIS_API } = await import("./iris-api")
    const res = await irisFetch(`/api/v1/playbooks`, {}, IRIS_API)
    const ok = await handleApiError(res, "List playbooks"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const all: any[] = firstArray(data?.playbooks, data?.data)

    /* A project-scoped playbook carries the bloq it was published to. Filtering
       here rather than server-side keeps one endpoint; if the list ever outgrows
       one response this moves to a query param, not a second command. */
    const bloqId = args.bloq == null ? null : Number(args.bloq)
    const list = bloqId == null ? all : all.filter((p) => Number(p?.bloq_id) === bloqId)

    if (args.json) { await writeJson(list); prompts.outro("Done"); return }
    if (!list.length) {
      printDivider()
      console.log(
        bloqId == null
          ? `  ${dim("Nothing published that you can see.")}`
          : `  ${dim(`No playbook is published to bloq #${bloqId}.`)}\n` +
            `  ${dim(`Publish one with: iris playbook publish <name> --scope project --bloq ${bloqId}`)}`,
      )
      if (bloqId != null && all.length) {
        console.log(`  ${dim(`(${all.length} playbook(s) are visible to you overall — drop --bloq to see them.)`)}`)
      }
      prompts.outro("Done"); return
    }

    printDivider()
    for (const p of list) {
      const installed = isInstalled(String(p.name))
      const mark = installed ? success("✓") : dim("·")
      const scope = p.scope ? dim(`[${p.scope}]`) : ""
      console.log(`  ${mark} ${highlight(String(p.name))} ${scope}`)
      if (p.description) console.log(`      ${dim(String(p.description))}`)
    }
    printDivider()
    prompts.outro(
      bloqId == null
        ? `${list.length} available — install with: iris playbook install <name>`
        : `${list.length} on bloq #${bloqId} (of ${all.length} visible) — install with: iris playbook install <name>`,
    )
  },
})

const PlaybookInstallCommand = cmd({
  command: "install <name>",
  aliases: ["pull"],
  describe: "download a published playbook (to ~/.iris/playbooks by default) and sync it to .claude/skills/ for Claude Code and the IRIS app",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("force", { type: "boolean", default: false, describe: "overwrite a local copy (discards local edits)" })
      .option("global", { type: "boolean", describe: "install to ~/.iris/playbooks even inside a project" })
      .option("project", { type: "boolean", describe: "install into this project (git root) instead of your home folder" })
      .conflicts("global", "project")
      .option("sync", { type: "boolean", default: true, describe: "also regenerate .claude/skills/ (--no-sync to skip)" })
      // boolean-negation is disabled globally (src/index.ts), so `--no-sync` is NOT
      // the negation of `--sync` — it has to be its own literal flag. Without this the
      // help text advertised a flag the parser rejected, and the only working form was
      // an undocumented `--sync=false` (#184593). That matters more than a typo: the
      // default REGENERATES .claude/skills/, so in a shared checkout the flag that
      // protects uncommitted skill edits was the one that would not parse.
      .option("no-sync", { type: "boolean", default: false, describe: "skip regenerating .claude/skills/" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const name = String(args.name)
    UI.empty()
    prompts.intro(`◈  Install Playbook — ${highlight(name)}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const { IRIS_API } = await import("./iris-api")
    const res = await irisFetch(`/api/v1/playbooks/${encodeURIComponent(name)}`, {}, IRIS_API)
    const ok = await handleApiError(res, "Fetch playbook"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const pb = data?.playbook ?? {}
    const content: string = pb.content ?? ""
    const registryVersion: string | null = pb.version == null ? null : String(pb.version)

    // A playbook row with no body is a publish that never uploaded one — say so
    // rather than writing an empty file that then fails to parse later.
    if (!content.trim()) {
      console.error(`  ${bold("No content")} — '${name}' is published but has no markdown body stored.`)
      console.error(`  ${dim("The author needs to run: iris playbook sync --api")}`)
      prompts.outro("Done"); return
    }

    const mode: InstallMode = args.global ? "global" : args.project ? "project" : "auto"
    const { root, dir, file } = installTarget(name, mode)

    // #185995 — "Already installed" used to be the whole answer, so a client ran a stale copy
    // (v4 against a published v9) with no way to know. Compare against what was recorded at
    // install time (.installed.json), not against the frontmatter, which publish does not bump.
    if (existsSync(file) && !args.force) {
      let local = ""
      try { local = readFileSync(file, "utf8") } catch { /* unreadable → treated as differing */ }
      const verdict = assessInstalled({ name, localContent: local, record: readInstalled(dir), registryVersion, registryContent: content })
      if (args.json) {
        await writeJson({ installed: false, reason: "already_installed", state: verdict.state, local_edits: verdict.localEdits, registry_version: registryVersion, path: file, message: verdict.message })
        prompts.outro("Done"); return
      }
      console.error(`  ${bold("Already installed")} ${dim(file)}`)
      console.error(`  ${verdict.state === "current" ? dim(verdict.message) : bold(verdict.message)}`)
      prompts.outro("Done"); return
    }

    // #185996 — mkdir tolerates an existing (OneDrive) folder, and the file is written to a temp
    // name and renamed over the old one, so --force no longer dies with EEXIST on Windows.
    writeFileAtomic(file, content)
    try {
      writeInstalled(dir, { name, version: registryVersion, sha256: sha256(content), installed_at: new Date().toISOString() })
    } catch { /* the record only powers the staleness check; the install itself succeeded */ }

    // Sync THIS playbook beside the root it was installed into — ~/.claude/skills for a global
    // install, <project>/.claude/skills for a project one. Claude Code and the IRIS Desktop app
    // both scan ~/.claude/skills from every project.
    const syncSkills = args.sync && !args["no-sync"]
    let skillFile: string | null = null
    let skillNote: string | null = null
    let skillVia: string | null = null
    if (syncSkills) {
      try {
        const info = { name, description: String(pb.description ?? ""), location: file }
        const plan = await parsePlan(info)
        const output = await renderSkillReplica(info, plan)
        const r = writeSkillReplica(root.skillsDir, plan.name, output, { home: root.scope === "global", followSymlink: true })
        if (r.ok) {
          skillFile = pathJoin(root.skillsDir, plan.name, "SKILL.md")
          skillVia = r.via
        }
        else skillNote = `${pathJoin(root.skillsDir, plan.name)} is ${r.reason}`
      } catch (e: any) {
        skillNote = `skill sync did not finish: ${String(e?.code ?? e?.message ?? e)}`
      }
    }

    // An older copy nearer the cwd (e.g. a pre-1.3.274 install in Desktop\.iris\playbooks) is
    // scanned BEFORE the global one and would silently keep running. Name it.
    const shadows = root.scope === "global" ? shadowingCopies(name, process.cwd(), file, installHome()) : []

    if (args.json) {
      await writeJson({
        installed: name,
        path: file,
        scope: pb.scope ?? null,
        version: registryVersion,
        location: root.scope,
        skill_path: skillFile,
        skill_note: skillNote,
        skill_via_symlink: skillVia,
        shadowed_by: shadows,
      })
      prompts.outro("Done"); return
    }

    printDivider()
    printKV("Name", name)
    if (pb.scope) printKV("Scope", String(pb.scope))
    if (registryVersion) printKV("Version", registryVersion)
    printKV("Playbook", file)
    if (skillFile) printKV("Skill", skillFile)
    printKV("Location", root.scope === "global" ? "global — your home folder" : `project — ${root.root}`)
    printDivider()
    if (root.scope === "global") {
      console.log(`  ${success("✓")} Works from any folder: ${bold("iris playbook run")} ${name}, the ${bold("IRIS app")} and ${bold("Claude Code")}.`)
    } else {
      console.log(`  ${success("✓")} Works in this project: ${bold("iris playbook run")} ${name}, and the IRIS app / Claude Code opened on ${root.root}.`)
      console.log(dim(`  (${root.reason}. For every folder instead: --global)`))
    }
    if (skillVia) console.log(dim(`  Skill refreshed through a symlink: ${pathJoin(skillVia, "SKILL.md")}`))
    if (skillNote) {
      // Not dim: the playbook updated but the copy Claude Code reads did not (#186155).
      console.log(`  ${bold("!")} Claude Code skill NOT refreshed: ${skillNote}`)
      console.log(dim(`    Claude Code and the IRIS app will keep using the old copy until it is replaced.`))
    }
    for (const s of shadows) {
      console.log(`  ${bold("!")} An older copy takes priority when you run from here: ${s}`)
      console.log(dim(`    Delete that folder so this install is the one that runs: ${pathJoin(s, "..")}`))
    }
    console.log(dim(`  Update later: iris playbook install ${name} --force`))

    prompts.outro(`${success("✓")} Installed ${highlight(name)}${skillFile ? " and synced for Claude Code + IRIS" : ""}`)
  },
})

// ============================================================================

export const PlatformPlaybookCommand = cmd({
  command: "playbook <subcommand>",
  describe: "playbooks — orchestrate workflows across all engines (shell, AI, Hive, n8n, Neuron)",
  builder: (yargs) =>
    yargs
      .command(PlaybookDraftCommand)
      // One walkthrough, three readers: `draft` for an agent, `sop` for a person,
      // `sync` for Claude. #P0b — moved off the `sop` verb, which owns service requests.
      .command(PlaybookSopDraftCommand)
      .command(SkillListCommand)
      .command(SkillSearchCommand)
      .command(SkillShowCommand)
      .command(SkillRunCommand)
      .command(SkillResumeCommand)
      .command(SkillTestCommand)
      .command(SkillHistoryCommand)
      .command(SkillE2ECommand)
      .command(PlaybookSyncCommand)
      .command(SkillRemoteCommand)
      .command(SkillReviewCommand)
      .command(PublishCommand)
      .command(UnpublishCommand)
      .command(PlaybookCheckPrivateCommand)
      .command(PlaybookShareCommand)
      .command(PlaybookDoctorCommand)
      .command(PlaybookVerifyCommand)
      .command(PlaybookAvailableCommand)
      .command(PlaybookInstallCommand)
      .command(AttachCommand)
      .command(DetachCommand)
      .command(AttachedCommand)
      // A playbook CONTAINS procedures, skills and an org chart (#180756), so they live under
      // it rather than beside it. `iris sop` keeps working for plain document SOPs.
      .command(PlaybookContentsCommands.items)
      .command(PlaybookContentsCommands.roles)
      .command(PlaybookContentsCommands.require)
      .command(PlaybookContentsCommands.ack)
      .demandCommand(1, "")
      // Playbooks COMPOSE — a step can run another playbook. That has worked since the
      // executor shipped and no playbook in the registry uses it, because nothing anywhere
      // said it was possible. Stating it here is most of the fix (#182309).
      .epilogue(
        [
          "Playbooks compose. A step can hand off to another playbook:",
          "",
          "    ### step:s2 Capture the process as an SOP",
          "",
          "    ```yaml",
          "    mode: playbook",
          "    playbook: capture-sops-and-process-maps",
          "    args: <passed positionally to the child's declared args>",
          "    ```",
          "",
          "The child runs inline, its steps appear nested in the run output, and its",
          "combined output becomes this step's result. A failing child fails the parent",
          "step. Nesting is capped at 3 deep, and a playbook may not call itself.",
          "",
          "Use it to keep one procedure per playbook and chain them, rather than writing",
          "\"now go run X\" as an instruction a person has to notice and follow.",
        ].join("\n"),
      ),
  handler() {},
})

// Backward compat: iris skill → iris playbook
export const PlatformSkillCommand = cmd({
  command: "skill <subcommand>",
  aliases: [],
  describe: false as any, // hidden from help (playbook is the primary)
  builder: (yargs) =>
    yargs
      .command(PlaybookDraftCommand)
      .command(PlaybookSopDraftCommand)
      .command(SkillListCommand)
      .command(SkillShowCommand)
      .command(SkillRunCommand)
      .command(SkillResumeCommand)
      .command(SkillTestCommand)
      .command(SkillHistoryCommand)
      .command(SkillE2ECommand)
      .command(PlaybookSyncCommand)
      .command(SkillRemoteCommand)
      .command(SkillReviewCommand)
      .command(PublishCommand)
      .command(UnpublishCommand)
      .command(PlaybookCheckPrivateCommand)
      .command(PlaybookAvailableCommand)
      .command(PlaybookInstallCommand)
      .command(AttachCommand)
      .command(DetachCommand)
      .command(AttachedCommand)
      .demandCommand(1, ""),
  handler() {},
})
