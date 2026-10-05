import type { Argv } from "yargs"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, dim, bold, IRIS_API, writeJson } from "./iris-api"
import { readFileSync } from "fs"

/**
 * `iris agents bench` — an agent's benchmark history.
 *
 * The runs were never missing. EvalSuiteRunner has written every evaluation to
 * ai_evaluation_runs — agent, model, suite, pass rate, per-case results, git commit —
 * for as long as it has existed. There was simply no way to ask it a question, so
 * "which model is this agent actually best on" was answered from memory.
 *
 * This is the read side. It exists to make a model choice DEFENSIBLE: you can show the
 * runs, filter them to the work in question, and point at the row.
 *
 * The one thing every view here refuses to do is quote a score without its run count.
 * A 100 from one run and a 92 from twelve are not the same claim, and a leaderboard that
 * hides the denominator rewards the model that was measured least — which is precisely
 * how the model tournament came out wrong.
 */

interface BenchRow {
  id: number
  suite: string
  model: string
  pass_rate: number
  average_score: number
  badge?: string | null
  status?: string | null
  tests: { total: number; passed: number; failed: number }
  duration_ms?: number | null
  quick?: boolean
  git_commit?: string | null
  sdk_version?: string | null
  completed_at?: string | null
}

interface CompareRow {
  suite: string
  model: string
  runs: number
  score_floor: number
  score_mean: number
  score_peak: number
  pass_rate: number
  avg_ms: number
  confident: boolean
}

function when(iso?: string | null): string {
  if (!iso) return "—"
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return "—"
  return d.toISOString().slice(0, 16).replace("T", " ")
}

function pad(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s.padEnd(n)
}

const BenchListCommand = cmd({
  command: "list <agentId>",
  aliases: ["ls"],
  describe: "benchmark history for an agent — filter and sort it",
  builder: (yargs: Argv) =>
    yargs
      .positional("agentId", { describe: "agent ID", type: "number", demandOption: true })
      .option("suite", { describe: "filter by suite (partial match)", type: "string" })
      .option("model", { describe: "filter by model (partial match)", type: "string" })
      .option("badge", { describe: "filter by certification badge", type: "string" })
      .option("since", { describe: "only runs completed on or after this date", type: "string" })
      .option("until", { describe: "only runs completed on or before this date", type: "string" })
      .option("min-score", { describe: "only runs at or above this average score", type: "number" })
      .option("q", { describe: "free-text search over suite, model and badge", type: "string" })
      .option("sort", {
        describe: "sort column",
        type: "string",
        choices: ["completed_at", "started_at", "pass_rate", "average_score", "total_duration_ms", "total_tests"],
        default: "completed_at",
      })
      .option("dir", { describe: "sort direction", type: "string", choices: ["asc", "desc"], default: "desc" })
      .option("limit", { describe: "rows to show", type: "number", default: 25 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const p = new URLSearchParams()
    for (const [k, v] of Object.entries({
      suite: args.suite, model: args.model, badge: args.badge,
      since: args.since, until: args.until, min_score: args["min-score"],
      q: args.q, sort: args.sort, dir: args.dir, per_page: args.limit,
    })) {
      if (v !== undefined && v !== null && v !== "") p.set(k, String(v))
    }

    const res = await irisFetch(`/api/v6/agents/${args.agentId}/benchmarks?${p}`, {}, IRIS_API)
    if (!(await handleApiError(res, "Benchmarks"))) return
    const body = (await res.json()) as { data: BenchRow[]; meta: any; summary: any }

    if (args.json) return writeJson(body)

    UI.empty()
    prompts.intro(`◈  Benchmarks — Agent #${args.agentId}`)

    const s = body.summary
    if (!s || s.total_runs === 0) {
      prompts.log.warn("No benchmark runs recorded for this agent yet.")
      prompts.log.info(`Run one: ${dim("php artisan eval:v6 agent_eval --agent-id=" + args.agentId)}`)
      prompts.outro("Done")
      return
    }

    prompts.log.info(
      `${bold(String(s.total_runs))} run(s) · ${s.suites.length} suite(s) · ${s.models.length} model(s)` +
      (s.last_run_at ? `  ${dim("last " + when(s.last_run_at))}` : ""),
    )
    if (s.best) {
      prompts.log.info(`Best recorded: ${bold(s.best.model)} on ${s.best.suite} ${dim(`(${s.best.score})`)}`)
    }

    printDivider()
    console.log(
      `  ${dim(pad("id", 8) + pad("suite", 24) + pad("model", 22) + "score  pass   tests    " + pad("badge", 12) + "when")}`,
    )
    for (const r of body.data) {
      const tests = `${r.tests.passed}/${r.tests.total}`
      console.log(
        `  ${pad(String(r.id), 8)}${pad(r.suite, 24)}${bold(pad(r.model ?? "—", 22))}` +
        `${String(Math.round(r.average_score)).padStart(5)}  ${(Math.round(r.pass_rate) + "%").padStart(4)}  ` +
        `${pad(tests, 8)}${pad(r.badge ?? "—", 12)}${dim(when(r.completed_at))}`,
      )
    }
    printDivider()
    console.log(`  ${dim(`showing ${body.data.length} of ${body.meta.total} · sorted by ${body.meta.sort} ${body.meta.dir}`)}`)
    console.log(`  ${dim(`iris agents bench show ${args.agentId} <id>   ·   iris agents bench compare ${args.agentId}`)}`)
    prompts.outro("Done")
  },
})

const BenchShowCommand = cmd({
  command: "show <agentId> <runId>",
  describe: "one benchmark run, with its per-case results",
  builder: (yargs: Argv) =>
    yargs
      .positional("agentId", { describe: "agent ID", type: "number", demandOption: true })
      .positional("runId", { describe: "benchmark run ID", type: "number", demandOption: true })
      .option("failed", { describe: "show only the cases that failed", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v6/agents/${args.agentId}/benchmarks/${args.runId}`, {}, IRIS_API)
    if (!(await handleApiError(res, "Benchmark run"))) return
    const { data } = (await res.json()) as { data: BenchRow & { test_results?: any[] } }

    if (args.json) return writeJson(data)

    UI.empty()
    prompts.intro(`◈  Benchmark #${data.id}`)
    prompts.log.info(`${bold(data.model ?? "—")} on ${data.suite}`)
    console.log(
      `  ${dim("score")} ${bold(String(Math.round(data.average_score)))}   ` +
      `${dim("pass")} ${Math.round(data.pass_rate)}%   ` +
      `${dim("tests")} ${data.tests.passed}/${data.tests.total}   ` +
      `${dim("badge")} ${data.badge ?? "—"}`,
    )
    // The commit and SDK version are what make an old run comparable to a new one —
    // a score without them cannot be attributed to anything you could change.
    console.log(
      `  ${dim("commit")} ${data.git_commit ?? "—"}   ${dim("sdk")} ${data.sdk_version ?? "—"}   ` +
      `${dim("when")} ${when(data.completed_at)}${data.quick ? dim("   (quick mode)") : ""}`,
    )

    const cases = (data.test_results ?? []).filter((c: any) => (args.failed ? !c.passed : true))
    if (cases.length) {
      printDivider()
      for (const c of cases) {
        const mark = c.passed ? "✓" : "✗"
        console.log(`  ${c.passed ? mark : bold(mark)} ${pad(String(c.name ?? "case"), 44)}${dim(String(c.score ?? ""))}`)
        if (!c.passed && c.feedback) console.log(`      ${dim(String(c.feedback).slice(0, 150))}`)
      }
    }
    prompts.outro("Done")
  },
})

const BenchCompareCommand = cmd({
  command: "compare <agentId>",
  aliases: ["vs"],
  describe: "best model per suite for this agent, ranked on the worst run",
  builder: (yargs: Argv) =>
    yargs
      .positional("agentId", { describe: "agent ID", type: "number", demandOption: true })
      .option("suite", { describe: "restrict to one suite (partial match)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const p = args.suite ? `?suite=${encodeURIComponent(args.suite)}` : ""
    const res = await irisFetch(`/api/v6/agents/${args.agentId}/benchmarks/compare${p}`, {}, IRIS_API)
    if (!(await handleApiError(res, "Benchmark compare"))) return
    const { data } = (await res.json()) as { data: CompareRow[] }

    if (args.json) return writeJson(data)

    UI.empty()
    prompts.intro(`◈  Model comparison — Agent #${args.agentId}`)
    if (!data.length) {
      prompts.log.warn("No benchmark runs to compare yet.")
      prompts.outro("Done")
      return
    }

    // Ranked on the FLOOR, and the run count sits beside every score, because a model
    // measured once is not a model that scored well.
    console.log(`  ${dim("ranked on the worst run — the one production meets")}`)
    printDivider()
    console.log(`  ${dim(pad("suite", 24) + pad("model", 22) + "floor  mean  peak  pass   runs   avg ms")}`)
    let suite = ""
    for (const r of data) {
      if (r.suite !== suite) {
        suite = r.suite
      }
      const runs = r.confident ? String(r.runs) : `${r.runs}!`
      console.log(
        `  ${pad(r.suite, 24)}${bold(pad(r.model ?? "—", 22))}` +
        `${String(Math.round(r.score_floor)).padStart(5)} ${String(Math.round(r.score_mean)).padStart(5)} ` +
        `${String(Math.round(r.score_peak)).padStart(5)} ${(Math.round(r.pass_rate) + "%").padStart(5)}  ` +
        `${runs.padStart(5)}  ${String(r.avg_ms).padStart(7)}`,
      )
    }
    printDivider()
    if (data.some((r) => !r.confident)) {
      console.log(`  ${dim("! fewer than 3 runs — that score is an anecdote, not a result")}`)
    }
    prompts.outro("Done")
  },
})


const BenchRecordCommand = cmd({
  command: "record <agentId>",
  aliases: ["add"],
  describe: "record a benchmark run against an agent (from a JSON file, or - for stdin)",
  builder: (yargs: Argv) =>
    yargs
      .positional("agentId", { describe: "agent ID", type: "number", demandOption: true })
      .option("file", {
        alias: "f",
        describe: "JSON payload: one run, or an array of runs. '-' reads stdin",
        type: "string",
        demandOption: true,
      })
      .option("suite", { describe: "override the suite name on every run in the file", type: "string" })
      .option("note", { describe: "attach a note to every run recorded", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return

    const raw =
      args.file === "-"
        ? await new Response(Bun.stdin.stream()).text()
        : readFileSync(args.file, "utf-8")

    let parsed: any
    try {
      parsed = JSON.parse(raw)
    } catch (e) {
      UI.error(`Not valid JSON: ${e instanceof Error ? e.message : String(e)}`)
      process.exitCode = 1
      return
    }

    // One run or many — a harness that produced five model comparisons should not have
    // to be invoked five times, and a harness that produced one should not have to wrap
    // it in an array.
    const runs: any[] = Array.isArray(parsed) ? parsed : [parsed]
    const recorded: any[] = []
    const failed: Array<{ index: number; error: string }> = []

    for (const [i, run] of runs.entries()) {
      const payload = { ...run }
      if (args.suite) payload.suite = args.suite
      if (args.note && !payload.notes) payload.notes = args.note

      const res = await irisFetch(
        `/api/v6/agents/${args.agentId}/benchmarks`,
        { method: "POST", body: JSON.stringify(payload) },
        IRIS_API,
      )
      if (!res.ok) {
        let msg = `HTTP ${res.status}`
        try {
          const b: any = await res.json()
          msg = b?.error?.message ?? b?.message ?? JSON.stringify(b).slice(0, 200)
        } catch {}
        failed.push({ index: i, error: msg })
        continue
      }
      const { data } = (await res.json()) as { data: BenchRow }
      recorded.push(data)
    }

    if (args.json) {
      writeJson({ recorded, failed })
      if (failed.length) process.exitCode = 1
      return
    }

    UI.empty()
    prompts.intro(`◈  Record benchmarks — Agent #${args.agentId}`)
    for (const r of recorded) {
      console.log(`  ${bold("#" + r.id)}  ${pad(r.suite, 26)}${pad(r.model ?? "—", 22)}` +
        `score ${Math.round(r.average_score)}  pass ${Math.round(r.pass_rate)}%`)
    }
    // Partial success is reported as partial, and exits non-zero. Printing "recorded 3"
    // when 5 were sent is how a gap in the history goes unnoticed.
    for (const f of failed) {
      console.log(`  ${bold("✗")} run ${f.index}: ${dim(f.error)}`)
    }
    printDivider()
    console.log(`  ${dim(`recorded ${recorded.length}/${runs.length}`)}`)
    console.log(`  ${dim(`iris agents bench list ${args.agentId}`)}`)
    prompts.outro(failed.length ? "Done with errors" : "Done")
    if (failed.length) process.exitCode = 1
  },
})

const BenchNoteCommand = cmd({
  command: "note <agentId> <runId> <text>",
  describe: "annotate a recorded run — what you concluded, which no score contains",
  builder: (yargs: Argv) =>
    yargs
      .positional("agentId", { describe: "agent ID", type: "number", demandOption: true })
      .positional("runId", { describe: "benchmark run ID", type: "number", demandOption: true })
      .positional("text", { describe: "the note", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(
      `/api/v6/agents/${args.agentId}/benchmarks/${args.runId}/notes`,
      { method: "POST", body: JSON.stringify({ text: args.text }) },
      IRIS_API,
    )
    if (!(await handleApiError(res, "Note"))) return
    const { data } = (await res.json()) as { data: { id: number; notes: any[] } }

    if (args.json) return writeJson(data)

    UI.empty()
    prompts.intro(`◈  Note on benchmark #${data.id}`)
    for (const n of data.notes) {
      console.log(`  ${dim(when(n.at))}  ${n.text}`)
    }
    prompts.outro("Done")
  },
})

export const AgentsBenchCommand = cmd({
  command: "bench",
  aliases: ["benchmarks"],
  describe: "benchmark history for an agent — list, show, compare models",
  builder: (yargs: Argv) =>
    yargs
      .command(BenchListCommand)
      .command(BenchShowCommand)
      .command(BenchCompareCommand)
      .command(BenchRecordCommand)
      .command(BenchNoteCommand)
      .demandCommand(),
  async handler() {},
})
