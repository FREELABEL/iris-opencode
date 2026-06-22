import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, success, highlight, printDivider, printKV, irisFetch, requireAuth, requireUserId, handleApiError } from "./iris-api"
import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import {
  parsePlan,
  executeSkill,
  resolveArgs,
  type ExecuteOptions,
  type SkillResult,
} from "../../skill/executor"

// ============================================================================
// iris loop — the first-class agentic-loop primitive (G2 verify/iterate + G3 budget)
//
// A v2 playbook runs ONE cycle. `iris loop` runs it REPEATEDLY until a verifier
// step says the goal is met, bounded by a hard --max-cycles cap (the closed-loop
// budget guard from the loop-engineering economics). The playbook carries memory
// forward between cycles itself (e.g. agentic-loop writes ./agentic-loop/next-steps.md
// and reads it on the next cycle), so each iteration builds on the last.
//
// "Done" is signalled by a VERDICT line in any step's output — by convention
// `VERDICT: SHIP` (met) vs `VERDICT: ITERATE` (keep going). `--until` overrides the
// done-token. This is generic: any playbook that emits such a line becomes loopable.
// ============================================================================

async function withInstance<T>(fn: () => Promise<T>): Promise<T> {
  return Instance.provide({ directory: process.cwd(), fn })
}

/** Pull the last `VERDICT: <word>` token from a finished run's step outputs. */
function extractVerdict(result: SkillResult, verdictStep?: string): string | null {
  const scan = (text: string): string | null => {
    const matches = [...text.matchAll(/VERDICT:\s*([A-Za-z_-]+)/g)]
    return matches.length > 0 ? matches[matches.length - 1][1].toUpperCase() : null
  }
  if (verdictStep && result.steps[verdictStep]?.output) {
    const v = scan(result.steps[verdictStep].output)
    if (v) return v
  }
  // Otherwise scan every step's output, last verdict wins (the verify step usually).
  let found: string | null = null
  for (const step of Object.values(result.steps)) {
    if (step.output) {
      const v = scan(step.output)
      if (v) found = v
    }
  }
  return found
}

const LoopRunCommand = cmd({
  command: "run <name> [skillArgs..]",
  describe: "run a playbook repeatedly until its verifier says done (or --max-cycles is hit)",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true, describe: "v2 playbook to loop" })
      .positional("skillArgs", { type: "string", array: true })
      .option("until", { type: "string", default: "SHIP", describe: "VERDICT token that means done (default SHIP)" })
      .option("max-cycles", { type: "number", default: 3, describe: "hard cap on cycles — the closed-loop budget guard" })
      .option("verdict-step", { type: "string", describe: "step id whose output holds the VERDICT (default: auto-detect)" })
      .option("stop-on-fail", { type: "boolean", default: true, describe: "stop the loop if a cycle has a failed step" })
      .option("yes", { type: "boolean", default: false, alias: "y", describe: "skip confirmation prompts" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await withInstance(async () => {
      const info = await Skill.get(args.name as string)
      if (!info) {
        console.error(`Playbook "${args.name}" not found`)
        process.exit(1)
      }

      const plan = await parsePlan(info)
      if (plan.version !== 2) {
        console.error(`"${args.name}" is a v1 skill — loops need a v2 playbook with a VERDICT step.`)
        process.exit(1)
      }

      // Resolve args once (same shape as `playbook run`); reused every cycle.
      const positionalArgs = (args.skillArgs as string[] ?? [])
      const flagArgs: Record<string, unknown> = {}
      const cleanPositional: string[] = []
      for (const a of positionalArgs) {
        if (a.startsWith("--")) {
          const eqIdx = a.indexOf("=")
          if (eqIdx > 2) flagArgs[a.slice(2, eqIdx)] = a.slice(eqIdx + 1)
          else flagArgs[a.slice(2)] = true
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

      const maxCycles = Math.max(1, Math.floor(args["max-cycles"] as number))
      const until = String(args.until).toUpperCase()
      const verdictStep = args["verdict-step"] as string | undefined

      if (!args.json) {
        UI.empty()
        prompts.intro(`◈  Loop: ${plan.name}`)
        console.log(`  ${dim(`goal-met when`)} ${bold(`VERDICT: ${until}`)}  ${dim(`·  budget`)} ${bold(`${maxCycles} cycles`)}`)
        printDivider()
      }

      const cycles: Array<{ cycle: number; status: string; verdict: string | null }> = []
      let met = false

      for (let cycle = 1; cycle <= maxCycles; cycle++) {
        if (!args.json) console.log(`\n  ${bold(`Cycle ${cycle}/${maxCycles}`)}`)

        const opts: ExecuteOptions = {
          dryRun: false,
          yes: true, // loops are unattended by nature; never block on a confirm prompt
          verbose: false,
          resume: false,
          onStepEnd(step, result) {
            if (args.json) return
            const icon = result.status === "success" ? success("✓") : result.status === "skipped" ? dim("○") : "✗"
            console.log(`    ${icon} ${dim(step.id)}`)
          },
          async onConfirm() { return true },
          async onManualPrompt() { return true },
        }

        const result = await executeSkill(plan, { ...resolvedArgs }, opts)
        const verdict = extractVerdict(result, verdictStep)
        const failed = Object.values(result.steps).some((r) => r.status === "failed")
        cycles.push({ cycle, status: result.status, verdict })

        if (!args.json) {
          const vLabel = verdict ? bold(verdict) : dim("no verdict")
          console.log(`    ${dim("→ verdict:")} ${verdict === until ? success(vLabel) : vLabel}`)
        }

        if (verdict === until) { met = true; break }

        if (failed && args["stop-on-fail"]) {
          if (!args.json) console.log(`    ${dim("→ stopping: a step failed this cycle (use --no-stop-on-fail to keep going)")}`)
          break
        }
      }

      if (args.json) {
        console.log(JSON.stringify({ playbook: plan.name, until, max_cycles: maxCycles, met, cycles }, null, 2))
        return
      }

      console.log()
      printDivider()
      printKV("Playbook", plan.name)
      printKV("Cycles run", `${cycles.length} / ${maxCycles}`)
      printKV("Goal met", met ? success(`yes — VERDICT ${until}`) : `no — hit ${cycles.length >= maxCycles ? "cycle budget" : "a failure"}`)
      printDivider()
      if (met) {
        prompts.outro(`${success("✓")} Loop converged in ${cycles.length} cycle(s)`)
      } else {
        console.log(`  ${dim("Not converged. Re-run to continue, or raise")} ${highlight("--max-cycles")}${dim(".")}`)
        prompts.outro("Done")
      }
    })
  },
})

// ============================================================================
// iris loop schedule — tie the loop into the HEARTBEAT system (the outer loop)
//
// `loop run` is the burst/foreground loop (iterate fast now, full specialist
// fan-out). `loop schedule` is the autonomous version: it registers a recurring
// agent heartbeat where EACH FIRING runs one loop cycle, with memory carried in a
// bloq (so #146918's persistent-KB attach is what makes convergence-over-time work).
// The cadence IS the outer loop; the verifier's VERDICT tells the human when it has
// converged. So a weekly heartbeat = one cycle/week, building on last week's memory.
// ============================================================================

const LoopScheduleCommand = cmd({
  command: "schedule <name>",
  describe: "run the loop autonomously on a heartbeat — one cycle per firing, memory in a bloq",
  builder: (yargs) =>
    yargs
      .positional("name", { type: "string", demandOption: true, describe: "the loop/playbook this heartbeat runs" })
      .option("agent", { type: "number", demandOption: true, describe: "orchestrator agent id that runs each cycle" })
      .option("frequency", { type: "string", default: "weekly", describe: "cadence (hourly, daily, weekly, monthly, …)" })
      .option("bloq", { type: "number", describe: "memory bloq id — each cycle reads prior next-steps from it and writes the new ones back (needs #146918)" })
      .option("goal", { type: "string", describe: "the loop goal (set once)" })
      .option("until", { type: "string", default: "SHIP", describe: "VERDICT token that means converged" })
      .option("time", { type: "string", default: "09:00", describe: "time of day (HH:MM)" })
      .option("user-id", { type: "number", describe: "user ID (or IRIS_USER_ID env)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Schedule loop: ${args.name}`) }
    const token = await requireAuth(); if (!token) { if (!args.json) prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const until = String(args.until).toUpperCase()
    const goal = (args.goal as string) ?? `the '${args.name}' loop's standing goal`
    const memo = args.bloq
      ? `Read the prior next-steps from your knowledge base (bloq ${args.bloq}); after this cycle, write the new next-steps back to it so next time continues where this left off.`
      : `Track next-steps in your working memory so the next cycle continues where this left off.`

    // One heartbeat firing = one loop cycle. The agent embodies the orchestrator +
    // specialists in its own ReactLoop (the foreground `loop run` does the full
    // multi-agent fan-out; this is the recurring single-agent cycle).
    const prompt =
      `Run ONE cycle of the "${args.name}" agentic loop. Goal (set once): ${goal}. ` +
      `${memo} Steps this cycle: (1) discover what still needs doing, (2) do the work — build/scout/grow as the goal needs, ` +
      `(3) VERIFY against the goal and end your reply with a line "VERDICT: ${until}" if the goal is met or "VERDICT: ITERATE" if not, ` +
      `(4) write the carry-forward next-steps. Keep it closed-loop and bounded.`

    const payload = {
      agent_id: args.agent,
      task_name: `loop:${args.name}`,
      prompt,
      time: args.time,
      frequency: args.frequency,
      timezone: "America/New_York",
      data: { type: "agent_task", loop: args.name, until, bloq: args.bloq ?? null },
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Wiring the loop onto a heartbeat…")
    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Schedule loop")
      if (!ok) { spinner?.stop("Failed", 1); process.exitCode = 1; if (!args.json) prompts.outro("Done"); return }
      const data = (await res.json()) as any
      const job = data?.data ?? data

      if (args.json) { console.log(JSON.stringify(job, null, 2)); return }
      spinner?.stop(success("Scheduled"))
      printDivider()
      printKV("Loop", args.name)
      printKV("Agent", `#${args.agent}`)
      printKV("Cadence", args.frequency)
      printKV("Memory", args.bloq ? `bloq #${args.bloq}` : "agent working memory")
      printKV("Converged when", `VERDICT: ${until}`)
      printKV("Job id", job?.id ?? "—")
      printDivider()
      console.log(`  ${dim("Each firing runs one cycle and carries memory forward. Watch it:")}`)
      console.log(`    ${highlight(`iris schedules history ${job?.id ?? "<id>"}`)}   ${dim("· per-cycle verdicts")}`)
      console.log(`    ${highlight(`iris monitor agent ${args.agent}`)}   ${dim("· agent health")}`)
      prompts.outro(`${success("✓")} Loop running on a ${args.frequency} heartbeat`)
    } catch (err) {
      spinner?.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

export const PlatformLoopCommand = cmd({
  command: "loop",
  describe: "run a playbook on an autonomous verify→iterate loop (burst now, or on a heartbeat)",
  builder: (yargs) => yargs.command(LoopRunCommand).command(LoopScheduleCommand).demandCommand(),
  async handler() {},
})
