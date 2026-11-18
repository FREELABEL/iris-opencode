import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, warn, writeJson, IRIS_API } from "./iris-api"
import { agentId } from "./platform-agents-watch"

/**
 * `iris agents runs` / `iris agents replay` — the flight recorder (#190085).
 *
 * `-V` shows a run's steps while it happens, and only if you asked before it started. iris-api
 * now keeps every run — chat, Slack, heartbeats, agent-calls-agent — step by step, after it
 * ends, with a 0..1 score and a flag when a run falls under the floor or well under that agent's
 * own recent average. `runs` lists them; `replay` walks one back step by step.
 *
 * Shapes only, like `watch`: tool names, argument NAMES and sizes, statuses, timings. Never a
 * value, a result, a prompt or a reply. Self-scoped: you see your own runs.
 */

type Fetcher = (path: string, init: RequestInit) => Promise<Response>
const defaultFetcher: Fetcher = (path, init) => irisFetch(path, init, IRIS_API)

export function runsPath(q: { agent?: number; flagged?: boolean; status?: string; days?: number; limit?: number }): string {
  const p = new URLSearchParams()
  if (q.agent) p.set("agent_id", String(q.agent))
  if (q.flagged) p.set("flagged", "1")
  if (q.status) p.set("status", q.status)
  if (q.days) p.set("days", String(q.days))
  p.set("limit", String(q.limit ?? 20))
  return `/api/v6/agent-runs?${p}`
}

export const runPath = (runId: string) => `/api/v6/agent-runs/${encodeURIComponent(runId)}`

/** A run id, or the first 8+ characters of one — what `runs` prints. Checked offline. */
export function runRef(raw: unknown): string | { error: string } {
  const s = String(raw ?? "").trim().toLowerCase()
  if (!s) return { error: "Which run? Pass a run id from `iris agents runs`." }
  if (s.length < 8 || !/^[0-9a-f-]+$/.test(s)) return { error: `"${raw}" is not a run id — give at least its first 8 characters.` }
  return s
}

export function ms(n: unknown): string {
  if (typeof n !== "number") return "—"
  if (n < 1000) return `${n}ms`
  if (n < 60_000) return `${(n / 1000).toFixed(1)}s`
  return `${Math.floor(n / 60_000)}m ${Math.round((n % 60_000) / 1000)}s`
}

export function scoreText(score: unknown): string {
  return typeof score === "number" ? score.toFixed(2) : "—"
}

/** One run in the list. Pure. */
export function runLine(r: any): string {
  const flag = r.flagged ? "⚑ " : "  "
  const tools = r.tool_calls ? `${r.tool_calls} tool${r.tool_calls === 1 ? "" : "s"}${r.tool_errors ? ` (${r.tool_errors} failed)` : ""}` : "no tools"
  const when = r.started_at ? new Date(r.started_at).toISOString().slice(0, 16).replace("T", " ") : ""
  return `${flag}${String(r.run_id).slice(0, 8)}  ${scoreText(r.score)}  ${String(r.status).padEnd(9)} ${String(r.agent_name ?? `#${r.agent_id}`).slice(0, 24).padEnd(24)} ${tools}, ${ms(r.duration_ms)}  ${dim(`${r.source ?? ""} ${when}`.trim())}`
}

/** One step of a replay. Shapes only — the server never sends values. Pure. */
export function stepText(s: any): string | null {
  const at = `+${ms(s.at_ms)}`.padStart(8)
  const it = s.iteration != null ? `#${s.iteration}` : "  "
  const d = s.detail ?? {}
  switch (s.type) {
    case "iteration":
      return null // the step number is on every line already
    case "thinking":
      return `${at} ${it} thinking${d.model ? ` (${d.model}, ${d.tools_available ?? 0} tools)` : ""}`
    case "reasoning":
      return `${at} ${it} decided${d.tools?.length ? ` → ${d.tools.join(", ")}` : " → answer"}`
    case "tool_call": {
      const keys = Object.keys(d.args ?? {}).filter((k) => k !== "…")
      return `${at} ${it} → ${s.tool}${keys.length ? `(${keys.join(", ")})` : "()"}`
    }
    case "tool_result":
      return `${at} ${it} ← ${s.tool ?? "tool"} ${s.status}${s.duration_ms != null ? ` ${ms(s.duration_ms)}` : ""}${d.error ? ` — ${d.error}` : ""}`
    case "tool_skipped":
      return `${at} ${it} ✕ ${s.tool} skipped (same call again)`
    case "memory_injection":
      return `${at}    context: ${d.memory_type ?? "memory"}${d.document_count != null ? ` (${d.document_count} docs)` : ""}`
    case "text":
      return `${at} ${it} wrote ${d.chars ?? 0} chars`
    case "done":
      return `${at} ${it} done: ${s.status} (${d.chars ?? 0} chars)`
    default:
      return `${at} ${it} ${s.type}${s.tool ? ` ${s.tool}` : ""}${s.status ? ` ${s.status}` : ""}`
  }
}

/** Why the score is what it is — one line per deduction. Pure. */
export function reasonLines(r: any): string[] {
  return (r.score_reasons ?? []).map((x: any) => `−${Number(x.points).toFixed(2)}  ${x.detail}`)
}

async function fail(json: boolean, msg: string): Promise<void> {
  if (json) await writeJson({ success: false, error: msg })
  else console.error(msg)
  process.exitCode = 1
}

export const AgentsRunsCommand = cmd({
  command: "runs [agent]",
  describe: "every agent run, kept after it ends — scored, and flagged when quality drops",
  builder: (yargs) =>
    yargs
      .positional("agent", { describe: "agent ID (default: all your agents)", type: "string" })
      .option("flagged", { describe: "only runs flagged as a quality drop", type: "boolean", default: false })
      .option("status", { describe: "completed | failed | timeout | cancelled | paused | running", type: "string" })
      .option("days", { describe: "only runs started in the last N days", type: "number" })
      .option("limit", { describe: "how many (max 200)", type: "number", default: 20 })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example("iris agents runs 42", "agent #42's last 20 runs")
      .example("iris agents runs --flagged --days 7", "what went badly this week")
      .example("iris agents replay 3f9c2a1b", "walk one run back, step by step"),
  async handler(args) {
    const json = !!args.json
    let agent: number | undefined
    if (args.agent !== undefined) {
      const id = agentId(args.agent)
      if (typeof id !== "number") return fail(json, id.error)
      agent = id
    }
    if (!(await requireAuth())) return fail(json, "not authenticated")

    const res = await defaultFetcher(runsPath({ agent, flagged: !!args.flagged, status: args.status as string | undefined, days: args.days as number | undefined, limit: args.limit as number }), { method: "GET" })
    if (!(await handleApiError(res, "List runs"))) { process.exitCode = 1; return }
    const body = (await res.json().catch(() => ({}))) as any
    if (json) return void (await writeJson(body))

    const runs: any[] = body?.runs ?? []
    if (!runs.length) {
      console.log(dim(args.flagged ? "No flagged runs." : "No runs recorded yet — runs are kept from the moment the server has the flight recorder."))
      return
    }
    console.log(dim("  run       score status    agent                    tools, time"))
    for (const r of runs) console.log(r.flagged ? warn(runLine(r)) : runLine(r))
    const flagged = runs.filter((r) => r.flagged).length
    console.log(dim(`\n${runs.length} run(s)${flagged ? `, ${flagged} flagged` : ""} · iris agents replay <run>`))
  },
})

export const AgentsReplayCommand = cmd({
  command: "replay <run>",
  describe: "walk a recorded agent run back step by step: each tool call, its result and timing, and its score",
  builder: (yargs) =>
    yargs
      .positional("run", { describe: "run ID, or its first 8 characters (from `iris agents runs`)", type: "string", demandOption: true })
      .option("play", { describe: "print steps at the pace they happened (up to 4× faster)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const json = !!args.json
    const ref = runRef(args.run)
    if (typeof ref !== "string") return fail(json, ref.error)
    if (!(await requireAuth())) return fail(json, "not authenticated")

    const res = await defaultFetcher(runPath(ref), { method: "GET" })
    if (res.status === 404) return fail(json, `No run ${ref} (or not yours).`)
    if (!(await handleApiError(res, "Replay"))) { process.exitCode = 1; return }
    const body = (await res.json().catch(() => ({}))) as any
    if (json) return void (await writeJson(body))

    const r = body.run ?? {}
    UI.empty()
    prompts.intro(`◈  Replay ${String(r.run_id).slice(0, 8)} · ${r.agent_name ?? `agent #${r.agent_id}`}`)
    console.log(dim(`  ${r.source ?? "?"} · ${r.model ?? "model ?"} · started ${r.started_at ?? "?"}`))
    console.log()

    let last = 0
    for (const s of body.steps ?? []) {
      const line = stepText(s)
      if (line === null) continue
      if (args.play) {
        const wait = Math.min(Math.max(0, (s.at_ms ?? 0) - last) / 4, 2000)
        if (wait > 0) await new Promise((ok) => setTimeout(ok, wait))
        last = s.at_ms ?? last
      }
      console.log(s.status === "error" ? warn(line) : line)
    }

    console.log()
    const head = `${bold("score")} ${scoreText(r.score)}${r.baseline_score != null ? dim(` (this agent's recent average ${scoreText(r.baseline_score)})`) : ""}`
    console.log(r.flagged ? warn(`⚑ ${head} — flagged`) : `${success("✓")} ${head}`)
    for (const l of reasonLines(r)) console.log(dim(`  ${l}`))
    prompts.outro(dim(`${r.status} · ${r.iterations} step(s) · ${r.tool_calls} tool call(s) · ${ms(r.duration_ms)}${r.total_tokens ? ` · ${r.total_tokens} tokens` : ""}`))
  },
})
