import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, writeJson, dim, bold, success, warn, IRIS_API } from "./iris-api"
import { UI } from "../ui"
import { selectTool } from "./platform-intent-select"

// ============================================================================
// iris intent — which of these does this mean?
//
// I1 of #186466. Calls POST /api/v1/intent, which runs the SAME IntentClassifier
// the agent router uses, so the CLI and the router can never report two different
// answers for one sentence.
//
// NAMED `intent` DELIBERATELY (ADR-01). Not `iris jev` — that is a vendor's
// product name, reads as their tool, and is wrong the day the default model
// changes; model-agnostic is the whole position. Not `intent-router` — that names
// the mechanism, and the caller wants the outcome.
//
// AND NOTE THE COLLISION IT AVOIDS: KINETIC (#186341) uses `Intent` as a TYPE —
// a device-control document. That is a NOUN. This is a VERB on text. If KINETIC
// ever grows a CLI it is `iris kinetic …`, never `iris intent …`.
// ============================================================================

// ── bench ────────────────────────────────────────────────────────────────────

const DEMO_CASES = [
  { input: "Read my latest emails from Gmail", expect: "complex" },
  { input: "check my calendar for today", expect: "complex" },
  { input: "Search my Google Drive for the Q3 reports", expect: "complex" },
  { input: "Send a Slack message to #general", expect: "complex" },
  { input: "what can you do", expect: "simple" },
  { input: "help", expect: "simple" },
  // Adversarial substring collisions — "recall" contains "call", "driveway" contains "drive".
  // A matcher that fires on letters rather than words routes these to a real-world action.
  { input: "Can you recall what we agreed last week?", expect: "escalate" },
  { input: "Tell me about driveway sealing costs", expect: "escalate" },
  { input: "what do you think about the new pricing model", expect: "escalate" },
  { input: "summarise that for me", expect: "escalate" },
]

/**
 * Right-align on VISIBLE width. `padStart` counts escape sequences, so the moment a cell is
 * coloured the column shifts by the length of its ANSI codes — the green "0" and the dim "0"
 * rendered flush against each other. Strip the codes to measure, then pad.
 */
function rpad(s: string, width: number): string {
  const visible = s.replace(/\x1b\[[0-9;]*m/g, "").length
  return " ".repeat(Math.max(0, width - visible)) + s
}

const BenchCommand = cmd({
  command: "bench",
  describe: "measure which model routes YOUR traffic best — one row per provider, on the same cases",
  builder: (yargs) =>
    yargs
      .option("cases", {
        describe: "JSON file of {input, expect} cases — omit to use the shipped demo set",
        type: "string",
      })
      .option("models", { describe: "comma-separated providers to compare", type: "string", default: "rules" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example("iris intent bench", "the shipped demo set, local rules only — free and instant")
      .example("iris intent bench --models rules,gpt-4.1-nano", "compare local rules against a model")
      .example("iris intent bench --cases ./my-traffic.json --models rules,jev --json", "your cases, for CI"),
  async handler(args) {
    const a = args as any
    if (!(await requireAuth())) return

    let cases = DEMO_CASES
    if (a.cases) {
      const f = Bun.file(String(a.cases))
      if (!(await f.exists())) {
        prompts.log.error(`No such file: ${a.cases}`)
        process.exitCode = 1
        return
      }
      const parsed = (await f.json().catch(() => null)) as any
      // Accept both a bare array and the frozen-fixture envelope, because the file people
      // already have is the fixture shape.
      const rows = Array.isArray(parsed) ? parsed : parsed?.cases
      if (!Array.isArray(rows) || rows.length === 0) {
        prompts.log.error("Expected a JSON array of {input, expect}, or an object with a `cases` array.")
        process.exitCode = 1
        return
      }
      cases = rows
    }

    const models = String(a.models)
      .split(",")
      .map((s: string) => s.trim())
      .filter(Boolean)

    const res = await irisFetch(
      "/api/v1/intent/bench",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cases, models }),
      },
      IRIS_API,
    )
    const body = (await res.json().catch(() => ({}))) as any
    const d = body?.data ?? {}

    if (a.json) {
      if (!res.ok) process.exitCode = 1
      return writeJson(d)
    }

    if (!res.ok) {
      prompts.log.error(d?.error ?? body?.message ?? `HTTP ${res.status}`)
      process.exitCode = 1
      return
    }

    UI.empty()
    console.log(`  ${bold(String(d.cases))} cases${a.cases ? dim(`  from ${a.cases}`) : dim("  (shipped demo set)")}`)
    UI.empty()
    console.log(
      `  ${"provider".padEnd(16)}${"wrong".padStart(6)}${"fail".padStart(6)}${"prec".padStart(7)}${"cover".padStart(7)}${"reqs".padStart(6)}${"p50".padStart(10)}${"p95".padStart(10)}`,
    )
    console.log(`  ${dim("─".repeat(78))}`)

    for (const r of d.results ?? []) {
      if (r.error) {
        console.log(`  ${String(r.model).padEnd(16)}${dim(r.error)}`)
        continue
      }
      // `wrong` first and never dimmed — it is the number that decides whether the rest matters.
      //
      // BUT A GREEN 0 ONLY MEANS SOMETHING IF SOMETHING WAS DECIDED. A provider whose every call
      // failed scored 0 wrong and 0 coverage, and the row read as clean at a glance — a rate-limited
      // run looked like a well-behaved one. `fail` is now a column, and the 0 goes green only when
      // there were real decisions behind it.
      const clean = r.confidently_wrong === 0 && r.decided > 0
      const wrong = clean ? success("0") : String(r.confidently_wrong)
      const failed = r.failed > 0 ? warn(String(r.failed)) : dim("0")
      const local = r.local ? dim("  local") : ""
      console.log(
        `  ${String(r.model).padEnd(16)}${rpad(wrong, 6)}${rpad(failed, 6)}` +
          `${rpad(String(r.precision_pct ?? "—"), 7)}${rpad(String(r.coverage_pct), 7)}` +
          `${rpad(String(r.requests), 6)}${rpad(r.p50_ms + "ms", 10)}${rpad(r.p95_ms + "ms", 10)}${local}`,
      )
      if (r.failed > 0) {
        console.log(`    ${dim(`↳ ${r.failed} of ${d.cases} calls failed — this row measured almost nothing`)}`)
      }
      for (const ex of r.examples_confidently_wrong ?? []) {
        console.log(`    ${dim(`↳ "${ex.input}" → ${ex.got}, expected ${ex.expected}`)}`)
      }
    }

    UI.empty()
    console.log(`  ${dim("wrong = confidently routed and WRONG. coverage only counts if precision holds.")}`)
    console.log(
      `  ${dim("no cost column: we do not carry trustworthy per-token pricing — multiply reqs by your own rate.")}`,
    )
    UI.empty()
  },
})

export const PlatformIntentCommand = cmd({
  command: "intent [text]",
  aliases: ["classify"],
  describe: "pick the iris command for what you want to do — or, with --choices, which of your labels a message means",
  builder: (yargs) =>
    yargs
      // Subcommands registered BEFORE the positional. With `intent [text]` and `.command()`
      // attached last, yargs rendered bench's help using the PARENT's positional and options and
      // hid its own — the command routed correctly and documented itself wrongly, which is the
      // worse half of that bug.
      .command(BenchCommand)
      .positional("text", { describe: "what you want to do, in your own words", type: "string" })
      .option("choices", {
        describe: "comma-separated labels to choose between (default: the built-in simple/complex)",
        type: "string",
      })
      .option("local-only", {
        describe: "never ask a model — fail instead if no local rule covers it",
        type: "boolean",
        default: false,
      })
      .option("model", { describe: "model to escalate to (nano only)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("run", {
        describe: "run the picked command (not if it still needs an argument)",
        type: "boolean",
        default: false,
      })
      .option("limit", { describe: "how many of find's commands to choose between", type: "number", default: 12 })
      .option("top", { describe: "how many related commands to list (5–30)", type: "number", default: 10 })
      .option("via", {
        describe: "who decides: auto = the Decide engine, then the platform classifier, then find's order",
        type: "string",
        choices: ["auto", "decide", "platform", "keyword"],
        default: "auto",
      })
      .example('iris intent "connect my instagram"', "which iris command does this?")
      .example('iris intent "check platform health" --run', "pick it and run it")
      .example('iris intent "find my overdue leads" --choices simple,complex', "classify into your own labels")
      .example('iris intent "card charged twice" --choices billing,support,sales', "your own labels")
      .example('iris intent "..." --local-only', "refuse to egress when the rules miss"),
  async handler(args) {
    const a = args as any
    // `iris intent` with nothing is a request for help, not an error.
    if (!a.text) {
      prompts.log.info("Say what you want to do, and it picks the iris command:")
      prompts.log.info(dim('  iris intent "connect my instagram"'))
      prompts.log.info(dim('  iris intent "card charged twice" --choices billing,support,sales'))
      prompts.log.info(dim("  iris intent bench --models rules,gpt-4.1-nano"))
      return
    }
    // TOOL SELECTION is the default: `iris intent "<text>"` answers "which iris command?".
    // The label classifier below runs only when the caller brings its own --choices.
    if (!a.choices && !a["local-only"] && !a.model) {
      // String(): a numeric-looking text arrives from yargs as a number.
      return selectTool({
        text: String(a.text),
        json: a.json,
        run: a.run,
        limit: Number(a.limit) || 12,
        decide: a.via === "auto" || a.via === "decide",
        platform: a.via === "auto" || a.via === "platform",
        top: Number(a.top) || 10,
      })
    }
    if (!(await requireAuth())) return

    const choices = a.choices
      ? String(a.choices)
          .split(",")
          .map((s: string) => s.trim())
          .filter(Boolean)
      : undefined

    if (choices && choices.length < 2) {
      prompts.log.error("--choices needs at least two labels — choosing one of one is not a choice.")
      process.exitCode = 1
      return
    }

    // IRIS_API EXPLICITLY. irisFetch defaults to fl-api (raichu.heyiris.io); this route lives in
    // fl-iris-api. Omitting it returns a 404 from the wrong service, which reads exactly like an
    // undeployed route — half an hour of debugging the deploy that had already landed.
    const res = await irisFetch(
      "/api/v1/intent",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: String(a.text),
          ...(choices ? { choices } : {}),
          ...(a["local-only"] ? { local_only: true } : {}),
          ...(a.model ? { model: String(a.model) } : {}),
        }),
      },
      IRIS_API,
    )

    const body = (await res.json().catch(() => ({}))) as any
    const d = body?.data ?? {}

    // --json emits the DECISION, not the envelope, so `| jq -e '.choice'` works — which is the
    // exit check this slice is scored against.
    //
    // AND IT EXITS NON-ZERO WHEN IT DID NOT DECIDE. The first version returned here before the
    // `!res.ok` branch below, so `--json` reported every refusal with exit 0: a script doing
    // `iris intent … --json || handle` never saw an error, and an undecided run was
    // byte-identical to a decided one for anything checking status. Same defect requireAuth
    // documents at #180540, reintroduced two files away.
    if (a.json) {
      if (!res.ok) process.exitCode = 1
      return writeJson(d)
    }

    if (!res.ok) {
      prompts.log.error(d?.error ?? body?.message ?? `HTTP ${res.status}`)
      if (d?.would_have_asked) {
        prompts.log.info(dim(`  would have asked ${d.would_have_asked} — drop --local-only to allow it`))
      }
      if (d?.raw) prompts.log.info(dim(`  model said: ${d.raw}`))
      process.exitCode = 1
      return
    }

    UI.empty()
    console.log(`  ${bold(String(d.choice))}  ${dim(`${d.ms}ms`)}`)
    // decided_by is printed EVERY time, not only when it is interesting. It is the field that
    // makes a wrong route traceable, and a field you only sometimes see is one nobody relies on.
    const by =
      d.decided_by === "rules"
        ? `${success("local rules")}${d.rule ? dim(`  ${d.rule} → "${d.matched}"`) : ""}  ${dim("no model, no egress")}`
        : `${d.decided_by}${d.tokens ? dim(`  ${d.tokens} tokens`) : ""}`
    console.log(`  ${dim("decided by")}  ${by}`)
    UI.empty()
  },
})
