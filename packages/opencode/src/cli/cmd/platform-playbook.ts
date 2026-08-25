import { cmd } from "./cmd"
import { PlaybookContentsCommands } from "./platform-playbook-contents"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, printKV, irisFetch, requireAuth, handleApiError, writeJson } from "./iris-api"
import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import {
  parsePlan,
  parseSteps,
  executeSkill,
  resolveArgs,
  splitPlaybookArgv,
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
import { existsSync, readdirSync } from "fs"
import { join as pathJoin } from "path"
import { runE2ESuite, probeServices, type E2ESuiteResult, type Tier, type ModeCoverage } from "../../skill/e2e/runner"
import { PlaybookDraftCommand } from "./playbook-draft"
import { PlaybookSopDraftCommand } from "./sop-draft"

// Wrap callback in Instance.provide so Skill.all()/get() can find .claude/skills/
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: process.cwd(), fn })
}

/**
 * Can we actually ask a human a question right now?
 * False for --json and for non-interactive stdin (pipes, CI, scheduled jobs) —
 * those runs pause at human steps instead of blocking on a prompt nobody sees.
 */
function canPromptHuman(json: boolean): boolean {
  return !json && Boolean(process.stdin.isTTY)
}

// ============================================================================
// iris skill list
// ============================================================================

const SkillListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all discovered skills (v1 + v2)",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false, describe: "JSON output" })
      .option("v2", { type: "boolean", default: false, describe: "show only v2 skills" }),
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

      if (args.json) {
        await writeJson(plans.map((p) => ({
          name: p.plan.name,
          version: p.plan.version,
          description: p.plan.description,
          steps: p.plan.steps.length,
          location: p.plan.location,
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
        console.log(`  ${bold(plan.name)}${version}${steps}`)
        console.log(`    ${dim(plan.description)}`)
      }
      printDivider()
      console.log(dim(`  ${plans.length} skill(s) found`))

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
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await withInstance(async () => {
      const info = await Skill.get(args.name as string)
      if (!info) {
        console.error(`Skill "${args.name}" not found`)
        process.exit(1)
      }

      const plan = await parsePlan(info)

      if (args.json) {
        await writeJson(plan)
        return
      }

      UI.empty()
      prompts.intro(`◈  Skill: ${plan.name}`)

      printDivider()
      printKV("Version", plan.version)
      printKV("Description", plan.description)
      printKV("Location", plan.location)
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
        console.error(`Skill "${args.name}" not found`)
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

      const opts: ExecuteOptions = {
        dryRun: false,
        yes: args.yes as boolean,
        verbose: args.verbose as boolean,
        resume: args.resume as boolean,
        stepFilter: args.step as string | undefined,
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
          if (args.json) return true
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
          if (step.body) console.log(`    ${step.body.replace(/\n/g, "\n    ")}`)
          if (step.code) console.log(`\n    ${dim(step.code.replace(/\n/g, "\n    "))}`)
          console.log()
          const result = await prompts.confirm({ message: "Done?" })
          return !prompts.isCancel(result) && result === true
        }
      }

      const result = await executeSkill(plan, resolvedArgs, opts)

      if (args.json) {
        await writeJson(result)
        return
      }

      console.log()
      printDivider()

      const passed = Object.values(result.steps).filter((r) => r.status === "success").length
      const failed = Object.values(result.steps).filter((r) => r.status === "failed").length
      const skippedCount = Object.values(result.steps).filter((r) => r.status === "skipped").length
      const totalMs = Object.values(result.steps).reduce((sum, r) => sum + r.duration_ms, 0)

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
        console.error(`Skill "${args.name}" not found`)
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
          if (!canPromptHuman(args.json as boolean)) return true
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
          if (step.body) console.log(`    ${step.body.replace(/\n/g, "\n    ")}`)
          if (step.code) console.log(`\n    ${dim(step.code.replace(/\n/g, "\n    "))}`)
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
    const skills: any[] = data?.data ?? data?.skills ?? (Array.isArray(data) ? data : [])
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
    const drafts: any[] = data?.data ?? []
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

const PlaybookSyncCommand = cmd({
  command: "sync",
  describe: "sync playbooks to .claude/skills/ (and optionally to API with --api)",
  builder: (yargs) =>
    yargs
      .option("json", { type: "boolean", default: false })
      .option("api", { type: "boolean", default: false, describe: "also push metadata to iris-api for frontend/API access" }),
  async handler(args) {
    await withInstance(async () => {
      const allPlaybooks = await Skill.all()
      const { mkdirSync, writeFileSync, existsSync, statSync } = await import("fs")
      const { join, dirname } = await import("path")

      // Find project root (where .iris/ or .claude/ lives)
      const cwd = process.cwd()
      const claudeSkillsDir = join(cwd, ".claude", "skills")

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

        // Build SKILL.md replica: keep full prose, strip executable step blocks
        const rawMd = await Bun.file(info.location).text()
        const matter = (await import("gray-matter")).default
        const parsed = matter(rawMd)

        // Rebuild frontmatter (strip v2-only fields that Claude doesn't need)
        const fmLines: string[] = [
          "<!-- AUTO-GENERATED by iris playbook sync — do not edit -->",
          "---",
          `name: ${plan.name}`,
          `description: ${plan.description}`,
        ]
        // Preserve allowed-tools from original
        const toolsMatch = rawMd.match(/allowed-tools:\n((?:\s+-\s+\w+\n)+)/)
        if (toolsMatch) {
          fmLines.push("allowed-tools:")
          fmLines.push(toolsMatch[1].trimEnd())
        }
        fmLines.push("---")

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

        // Write to .claude/skills/{name}/SKILL.md
        const targetDir = join(claudeSkillsDir, plan.name)
        const targetFile = join(targetDir, "SKILL.md")
        mkdirSync(targetDir, { recursive: true })
        writeFileSync(targetFile, output)
        synced++

        if (!args.json) {
          console.log(`  ${success("✓")} ${plan.name}`)
        }
      }

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
        console.log(JSON.stringify({ synced, skipped, api_synced: apiSynced }))
      } else {
        printDivider()
        const apiMsg = args.api ? `, ${apiSynced} to API` : ""
        console.log(dim(`  ${synced} synced to .claude/skills/${apiMsg}, ${skipped} skipped`))
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
    const attached: any[] = data?.data ?? (Array.isArray(data) ? data : [])
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

const PublishCommand = cmd({
  command: "publish <name>",
  describe: "publish a playbook with a scope: private | project | public",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("scope", {
        type: "string",
        choices: ["private", "project", "public"] as const,
        demandOption: true,
        describe: "association scope: private (you), project (a bloq/team), public (marketplace)",
      })
      .option("bloq", { type: "number", describe: "bloq (project) id — required when --scope project" })
      .option("access", {
        type: "string",
        choices: ["free", "paid"] as const,
        default: "free",
        describe: "access level for a public/marketplace publish",
      })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Publish Playbook — ${highlight(String(args.name))}`)

    if (args.scope === "project" && !args.bloq) {
      console.error("  --bloq <id> is required when --scope project")
      prompts.outro("Done"); return
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
    if (pb.public_url) {
      console.log(`  ${bold("URL")}         ${highlight(String(pb.public_url))}`)
    } else {
      console.log(
        `  ${bold("URL")}         ${dim("none — only a public playbook gets one")}` +
          dim(`  (re-run with --scope public)`),
      )
    }
    if (data?.marketplace) {
      console.log(`  ${bold("Marketplace")} ${highlight(String(data.marketplace.slug))} ${dim(`(${data.marketplace.status})`)}`)
    }
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

/** Where an installed playbook lands. `sync` only picks up .iris/playbooks/. */
function installTarget(name: string): { dir: string; file: string } {
  const dir = pathJoin(process.cwd(), ".iris", "playbooks", name)
  return { dir, file: pathJoin(dir, "PLAYBOOK.md") }
}

const PlaybookAvailableCommand = cmd({
  command: "available",
  aliases: ["remote-list"],
  describe: "list published playbooks you can install (scoped to what you can see)",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Playbooks — Available to Install")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const { IRIS_API } = await import("./iris-api")
    const res = await irisFetch(`/api/v1/playbooks`, {}, IRIS_API)
    const ok = await handleApiError(res, "List playbooks"); if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const list: any[] = data?.playbooks ?? data?.data ?? []

    if (args.json) { await writeJson(list); prompts.outro("Done"); return }
    if (!list.length) {
      printDivider()
      console.log(`  ${dim("Nothing published that you can see.")}`)
      prompts.outro("Done"); return
    }

    printDivider()
    const { existsSync } = await import("fs")
    for (const p of list) {
      const installed = existsSync(installTarget(String(p.name)).file)
      const mark = installed ? success("✓") : dim("·")
      const scope = p.scope ? dim(`[${p.scope}]`) : ""
      console.log(`  ${mark} ${highlight(String(p.name))} ${scope}`)
      if (p.description) console.log(`      ${dim(String(p.description))}`)
    }
    printDivider()
    prompts.outro(`${list.length} available — install with: iris playbook install <name>`)
  },
})

const PlaybookInstallCommand = cmd({
  command: "install <name>",
  aliases: ["pull"],
  describe: "download a published playbook into .iris/playbooks/ and sync it to .claude/skills/",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true })
      .option("force", { type: "boolean", default: false, describe: "overwrite a local copy (discards local edits)" })
      .option("sync", { type: "boolean", default: true, describe: "also regenerate .claude/skills/ (--no-sync to skip)" })
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

    // A playbook row with no body is a publish that never uploaded one — say so
    // rather than writing an empty file that then fails to parse later.
    if (!content.trim()) {
      console.error(`  ${bold("No content")} — '${name}' is published but has no markdown body stored.`)
      console.error(`  ${dim("The author needs to run: iris playbook sync --api")}`)
      prompts.outro("Done"); return
    }

    const { dir, file } = installTarget(name)
    const { existsSync, mkdirSync, writeFileSync } = await import("fs")

    if (existsSync(file) && !args.force) {
      console.error(`  ${bold("Already installed")} ${dim(file)}`)
      console.error(`  ${dim("Re-download and discard local edits with: --force")}`)
      prompts.outro("Done"); return
    }

    mkdirSync(dir, { recursive: true })
    writeFileSync(file, content, "utf8")

    if (args.json) {
      await writeJson({ installed: name, path: file, scope: pb.scope ?? null })
      prompts.outro("Done"); return
    }

    printDivider()
    printKV("Name", name)
    if (pb.scope) printKV("Scope", String(pb.scope))
    if (pb.version) printKV("Version", String(pb.version))
    printKV("Path", file)
    printDivider()

    if (args.sync) {
      // Reuse the existing writer rather than reimplementing the SKILL.md transform
      // (frontmatter rebuild, step-block stripping, usage hint) — one copy, one behaviour.
      await (PlaybookSyncCommand as any).handler({ json: false, api: false })
    }

    prompts.outro(`${success("✓")} Installed ${highlight(name)}${args.sync ? " and synced to .claude/skills/" : ""}`)
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
      .command(PlaybookAvailableCommand)
      .command(PlaybookInstallCommand)
      .command(AttachCommand)
      .command(DetachCommand)
      .command(AttachedCommand)
      .demandCommand(1, ""),
  handler() {},
})
