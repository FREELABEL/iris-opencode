import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, success, warn, writeJson, IRIS_API } from "./iris-api"

/**
 * `iris agents watch|take-over|hand-back` — is it stuck? (#187921)
 *
 * On 28 Sep a Pathways user asked three times whether her agent was stuck during a 75-minute
 * Drive rename loop; all anyone could see was "Thinking". `iris hive watch` tails text events
 * from local tmux panes only — it cannot see a server-side agent run at all.
 *
 * iris-api now keeps a live view of every V6 run: the step it is on and for how long, and its
 * last tool calls (name, argument NAMES and sizes, status, duration — never argument values).
 * `watch` tails it. `take-over` pauses the run after the step it is on; `hand-back` resumes the
 * same run, optionally telling the agent something (-m). Only the run's user, the agent's
 * creator or the bloq owner may do any of this; anyone else gets "not found".
 *
 * All on iris-api (IRIS_API), not fl-api — a call to the wrong host 404s.
 */

type Fetcher = (path: string, init: RequestInit) => Promise<Response>
const defaultFetcher: Fetcher = (path, init) => irisFetch(path, init, IRIS_API)

export function agentId(raw: unknown): number | { error: string } {
  const id = Number(raw)
  if (raw === undefined || raw === null || String(raw).trim() === "") return { error: "Which agent? Pass an agent id." }
  if (!Number.isInteger(id) || id <= 0) return { error: `"${raw}" is not an agent id — expected a positive number.` }
  return id
}

export const livePath = (id: number, limit = 10) => `/api/v1/agents/${id}/live?limit=${limit}`
export const controlPath = (runId: string, action: "take-over" | "hand-back") =>
  `/api/v1/runs/${encodeURIComponent(runId)}/${action}`

function secs(s: unknown): string {
  if (typeof s !== "number") return "—"
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return m < 60 ? `${m}m ${Math.round(s % 60)}s` : `${Math.floor(m / 60)}h ${m % 60}m`
}

/** The step line: what it is doing, on which step, for how long. Pure. */
export function stepLine(run: any): string {
  if (!run) return "nothing running for this agent"
  const s = run.current_step ?? {}
  const step = s.max_iterations ? `step ${s.iteration}/${s.max_iterations}` : `step ${s.iteration ?? 0}`
  const t = run.takeover?.status
  if (run.status === "paused" || t === "paused") return `PAUSED after ${step} — you have the wheel (iris agents hand-back ${run.agent_id})`
  if (t === "pause_requested") return `pausing after ${step}…`
  if (run.status !== "running") return `finished: ${run.status} at ${step}`
  const quiet = typeof run.seconds_since_last_event === "number" && run.seconds_since_last_event >= 120
    ? ` — no activity for ${secs(run.seconds_since_last_event)}, may be stuck`
    : ""
  if (s.phase === "tool") return `${step}: running ${s.tool} for ${secs(s.seconds_on_step)}${quiet}`
  if (s.phase === "thinking") return `${step}: deciding next action for ${secs(s.seconds_on_step)}${quiet}`
  return `${step}: ${s.phase ?? "working"}${quiet}`
}

/** One finished tool call. Argument names only — the server never sends values. Pure. */
export function callLine(c: any): string {
  const ms = typeof c.duration_ms === "number" ? (c.duration_ms < 1000 ? `${c.duration_ms}ms` : `${(c.duration_ms / 1000).toFixed(1)}s`) : "…"
  const keys = Object.keys(c.args ?? {}).filter((k) => k !== "…")
  const err = c.error ? ` — ${c.error}` : ""
  return `#${c.iteration} ${c.tool} ${c.status} ${ms}${keys.length ? ` (${keys.join(", ")})` : ""}${err}`
}

/**
 * Calls not printed yet, oldest first. A call is printed once, when it has finished — a
 * running call shows in the step line instead. Keyed on start time + tool + fingerprint. Pure.
 */
export function unseenCalls(calls: any[], seen: Set<string>): any[] {
  const out: any[] = []
  for (const c of calls ?? []) {
    if (c.status === "running") continue
    const key = `${c.started_at}|${c.tool}|${c.args_fingerprint}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(c)
  }
  return out
}

export async function fetchLive(id: number, fetcher: Fetcher = defaultFetcher, limit = 10): Promise<Response> {
  return fetcher(livePath(id, limit), { method: "GET" })
}

/** Resolve the agent's current run, then take it over or hand it back. */
export async function sendControl(
  id: number,
  action: "take-over" | "hand-back",
  message: string | undefined,
  fetcher: Fetcher = defaultFetcher,
): Promise<{ error: string } | { res: Response; runId: string }> {
  const liveRes = await fetchLive(id, fetcher, 1)
  if (!liveRes.ok) return { error: liveRes.status === 404 ? "Agent not found (or not yours)." : `iris-api ${liveRes.status}` }
  const body = (await liveRes.json().catch(() => ({}))) as any
  const runId = body?.run?.run_id
  if (!runId) return { error: "This agent has no recent run to " + (action === "take-over" ? "take over." : "hand back.") }
  const payload = action === "hand-back" && message?.trim() ? { message: message.trim() } : {}
  const res = await fetcher(controlPath(runId, action), { method: "POST", body: JSON.stringify(payload) })
  return { res, runId }
}

async function runControl(action: "take-over" | "hand-back", args: any): Promise<void> {
  const json = !!args.json
  if (!json) { UI.empty(); prompts.intro(`◈  ${action === "take-over" ? "Take over" : "Hand back"} agent #${args.id}`) }
  const fail = async (msg: string) => {
    if (json) await writeJson({ success: false, error: msg })
    else { prompts.log.error(msg); prompts.outro("Done") }
    process.exitCode = 1
  }
  const id = agentId(args.id)
  if (typeof id !== "number") return fail(id.error)
  if (!(await requireAuth())) return fail("not authenticated")

  const sent = await sendControl(id, action, args.message)
  if ("error" in sent) return fail(sent.error)
  if (!(await handleApiError(sent.res, action === "take-over" ? "Take over" : "Hand back"))) { process.exitCode = 1; return }
  const body = (await sent.res.json().catch(() => ({}))) as any
  if (json) return void (await writeJson(body))
  prompts.log.info(`${success("✓")} ${body?.message ?? "Done"}`)
  prompts.outro(dim(`iris agents watch ${id}`))
}

export const AgentsWatchCommand = cmd({
  command: "watch <id>",
  describe: "is it stuck? tail an agent's current run: its step and each tool call as it finishes",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "string", demandOption: true })
      .option("interval", { describe: "seconds between polls", type: "number", default: 2 })
      .option("once", { describe: "print the current view and exit", type: "boolean", default: false })
      .option("json", { describe: "print the raw live view (with --once: one object)", type: "boolean", default: false })
      .example("iris agents watch 42", "follow agent #42's run")
      .example("iris agents take-over 42", "pause it after the current step")
      .example('iris agents hand-back 42 -m "skip the archive folder"', "resume it with an instruction"),
  async handler(args) {
    const id = agentId(args.id)
    if (typeof id !== "number") { console.error(id.error); process.exitCode = 1; return }
    if (!(await requireAuth())) { process.exitCode = 1; return }

    const seen = new Set<string>()
    let lastLine = ""
    const tick = async (): Promise<boolean> => {
      const res = await fetchLive(id, defaultFetcher, 20).catch(() => null)
      if (!res) return true // network blip: keep watching
      if (!res.ok) { console.error(res.status === 404 ? "Agent not found (or not yours)." : `iris-api ${res.status}`); process.exitCode = 1; return false }
      const body = (await res.json().catch(() => ({}))) as any
      const run = body?.run ?? null
      if (args.json) { console.log(JSON.stringify(run)); return !args.once }
      for (const c of unseenCalls(run?.recent_tool_calls ?? [], seen)) {
        const line = callLine(c)
        console.log(c.status === "error" ? warn(line) : dim(line))
      }
      const line = stepLine(run)
      if (line !== lastLine) { console.log(line); lastLine = line }
      return !args.once
    }

    if (!(await tick())) return
    const poll = setInterval(async () => { if (!(await tick())) clearInterval(poll) }, Math.max(1, Number(args.interval) || 2) * 1000)
    process.on("SIGINT", () => { clearInterval(poll); console.log(dim("\nStopped watching.")); process.exit(0) })
    await new Promise(() => {})
  },
})

export const AgentsTakeOverCommand = cmd({
  command: "take-over <id>",
  describe: "pause an agent's current run after the step it is on (hand it back with hand-back)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    await runControl("take-over", args)
  },
})

export const AgentsHandBackCommand = cmd({
  command: "hand-back <id>",
  describe: "resume a run you took over, optionally telling the agent what to do differently",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "string", demandOption: true })
      .option("message", { alias: "m", describe: "what the agent is told when it continues", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    await runControl("hand-back", args)
  },
})
