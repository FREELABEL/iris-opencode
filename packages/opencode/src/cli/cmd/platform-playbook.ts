import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, printKV, irisFetch, requireAuth, handleApiError } from "./iris-api"
import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import {
  parsePlan,
  executeSkill,
  resolveArgs,
  validatePlan,
  listRuns,
  getRun,
  pruneRuns,
  type SkillPlan,
  type StepDef,
  type StepResult,
  type ExecuteOptions,
} from "../../skill/executor"
import { runE2ESuite, probeServices, type E2ESuiteResult, type Tier } from "../../skill/e2e/runner"

// Wrap callback in Instance.provide so Skill.all()/get() can find .claude/skills/
async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: process.cwd(), fn })
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
        console.log(JSON.stringify(plans.map((p) => ({
          name: p.plan.name,
          version: p.plan.version,
          description: p.plan.description,
          steps: p.plan.steps.length,
          location: p.plan.location,
        })), null, 2))
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
        console.log(JSON.stringify(plan, null, 2))
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
      const flagArgs: Record<string, unknown> = {}
      const cleanPositional: string[] = []
      for (const a of positionalArgs) {
        if (a.startsWith("--")) {
          const eqIdx = a.indexOf("=")
          if (eqIdx > 2) {
            flagArgs[a.slice(2, eqIdx)] = a.slice(eqIdx + 1)
          } else {
            flagArgs[a.slice(2)] = true
          }
        } else {
          cleanPositional.push(a)
        }
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
          console.log(JSON.stringify({
            skill: plan.name,
            version: plan.version,
            args: resolvedArgs,
            steps: plan.steps.map((s) => ({ id: s.id, title: s.title, mode: s.mode })),
          }, null, 2))
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
          const icon = result.status === "success" ? success("✓") : result.status === "skipped" ? dim("○") : "✗"
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
        async onManualPrompt(step) {
          if (args.json) return true
          sp.stop(`  ${bold(step.id)}: ${step.title}`, 0)
          console.log()
          if (step.body) console.log(`    ${step.body.replace(/\n/g, "\n    ")}`)
          if (step.code) console.log(`\n    ${dim(step.code.replace(/\n/g, "\n    "))}`)
          console.log()
          const result = await prompts.confirm({ message: "Done?" })
          return !prompts.isCancel(result) && result === true
        },
      }

      const result = await executeSkill(plan, resolvedArgs, opts)

      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
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
      prompts.outro(result.status === "completed" ? success("Done") : "Done (with errors)")
      if (result.status !== "completed") process.exitCode = 1
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
          console.log(JSON.stringify({ valid: false, errors: [e.message] }, null, 2))
        } else {
          console.error(`Parse error: ${e.message}`)
        }
        process.exit(1)
        return
      }

      const issues = validatePlan(plan)

      if (args.json) {
        console.log(JSON.stringify({
          valid: !issues.some((i) => i.level === "error"),
          version: plan.version,
          steps: plan.steps.length,
          args: Object.keys(plan.args).length,
          issues,
        }, null, 2))
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
        console.log(JSON.stringify(run, null, 2))
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
        const icon = sr.status === "success" ? success("✓") : sr.status === "skipped" ? dim("○") : "✗"
        const dur = sr.duration_ms > 0 ? dim(` (${(sr.duration_ms / 1000).toFixed(1)}s)`) : ""
        console.log(`    ${icon} ${bold(id)} — ${sr.status}${dur}`)
        if (sr.output && sr.status === "failed") {
          console.log(dim(`      ${sr.output.slice(0, 200)}`))
        }
      }
      printDivider()
      prompts.outro("Done")
      return
    }

    // List all runs
    const runs = listRuns(args.limit as number)

    if (args.json) {
      console.log(JSON.stringify(runs, null, 2))
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
      const icon = run.status === "completed" ? success("✓") : run.status === "running" ? "◌" : "✗"
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
// iris playbook e2e — end-to-end test runner
// ============================================================================

const SkillE2ECommand = cmd({
  command: "e2e",
  describe: "run end-to-end playbook tests",
  builder: (yargs) =>
    yargs
      .option("tier", { type: "string", describe: "filter by tier: local, edge, cloud", choices: ["local", "edge", "cloud"] })
      .option("mode", { type: "string", describe: "filter by step mode (e.g. shell, hive-script)" })
      .option("json", { type: "boolean", default: false, describe: "JSON output for CI/CD" })
      .option("verbose", { type: "boolean", default: false, describe: "print step outputs" }),
  async handler(args) {
    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Playbook E2E Tests")
    }

    const sp = args.json ? null : prompts.spinner()
    sp?.start("  Probing services...")

    const result = await runE2ESuite({
      tier: args.tier as Tier | undefined,
      mode: args.mode as string | undefined,
      verbose: args.verbose as boolean,
      json: args.json as boolean,
    })

    sp?.stop("  Services probed", 0)

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
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
      const tier = dim(` [${test.tier}]`)
      const dur = test.duration_ms > 0 ? dim(` (${(test.duration_ms / 1000).toFixed(1)}s)`) : ""
      const reason = test.reason ? dim(` — ${test.reason}`) : ""
      console.log(`    ${icon} ${bold(test.name)}${tier}${dur}${reason}`)

      if (args.verbose && test.status !== "skip") {
        for (const [stepId, sr] of Object.entries(test.steps)) {
          const stepIcon = sr.status === "success" ? success("✓") : sr.status === "skipped" ? dim("○") : "✗"
          console.log(`      ${stepIcon} ${stepId}`)
        }
      }
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
    if (args.json) { console.log(JSON.stringify(skills, null, 2)); prompts.outro("Done"); return }
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
    if (args.json) { console.log(JSON.stringify(drafts, null, 2)); prompts.outro("Done"); return }
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
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
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
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
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

            const payload = {
              name: plan.name,
              description: plan.description,
              args_schema: plan.args,
              steps_summary: plan.steps.map((s) => ({ id: s.id, title: s.title, mode: s.mode })),
              version: plan.version,
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

export const PlatformPlaybookCommand = cmd({
  command: "playbook <subcommand>",
  describe: "playbooks — orchestrate workflows across all engines (shell, AI, Hive, n8n, Neuron)",
  builder: (yargs) =>
    yargs
      .command(SkillListCommand)
      .command(SkillShowCommand)
      .command(SkillRunCommand)
      .command(SkillTestCommand)
      .command(SkillHistoryCommand)
      .command(SkillE2ECommand)
      .command(PlaybookSyncCommand)
      .command(SkillRemoteCommand)
      .command(SkillReviewCommand)
      .demandCommand(1, ""),
  handler() {},
})

// Backward compat: iris skill → iris playbook
export const PlatformSkillCommand = cmd({
  command: "skill <subcommand>",
  aliases: [],
  describe: false as any, // hidden from help (playbook is the primary)
  builder: (yargs) =>
    yargs
      .command(SkillListCommand)
      .command(SkillShowCommand)
      .command(SkillRunCommand)
      .command(SkillTestCommand)
      .command(SkillHistoryCommand)
      .command(SkillE2ECommand)
      .command(PlaybookSyncCommand)
      .command(SkillRemoteCommand)
      .command(SkillReviewCommand)
      .demandCommand(1, ""),
  handler() {},
})
