/**
 * `iris heartbeats query` (#189245) — which of my agents are late, silent or failing, and since when.
 *
 * Every state is @heyiris/pulse-core's `stateOf`, the function the Desktop Heartbeats panel draws
 * with, so this command and the panel cannot disagree. The rows come from the two fl-api calls the
 * panel makes (the user's heartbeat jobs, then each job's runs); nothing here re-derives a state.
 *
 * A list that cannot be read is NOT MEASURED and says why. It is never printed as "0 late".
 */
import { cmd } from "./cmd"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, dim, bold, writeJson } from "./iris-api"
import {
  ago,
  BEAT_STATES,
  isHeartbeatJob,
  LIVE_STATUSES,
  queryHeartbeats,
  readHeartbeat,
  RUNS_PER_ROW,
  unwrap,
  type BeatState,
  type HeartbeatQueryResult,
  type HeartbeatRow,
} from "@heyiris/pulse-core"

type Get = (path: string) => Promise<Response>

async function failure(res: Response): Promise<string> {
  const j = (await res.json().catch(() => null)) as any
  const msg = j?.message ?? j?.error
  return typeof msg === "string" && msg ? `fl-api ${res.status}: ${msg}` : `fl-api ${res.status}`
}

/** The user's live heartbeats, each with its runs. A run list that fails leaves that row unread. */
export async function fetchHeartbeatRows(
  userId: number,
  get: Get = (p) => irisFetch(p),
): Promise<{ measured: boolean; reason?: string; rows: HeartbeatRow[] }> {
  try {
    const res = await get(`/api/v1/users/${userId}/bloqs/scheduled-jobs?agent_jobs_only=1`)
    if (!res.ok) return { measured: false, reason: await failure(res), rows: [] }
    const jobs = unwrap(await res.json()).filter((j) => isHeartbeatJob(j) && LIVE_STATUSES.has(String(j.status)))
    const rows = await Promise.all(
      jobs.map(async (j) => {
        try {
          const r = await get(`/api/v1/users/${userId}/bloqs/scheduled-jobs/${j.id}/executions?limit=${RUNS_PER_ROW}`)
          return readHeartbeat(j, r.ok ? unwrap(await r.json()) : null)
        } catch {
          return readHeartbeat(j, null)
        }
      }),
    )
    return { measured: true, rows }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), rows: [] }
  }
}

/** "late,silent" → ["late","silent"]. A state that does not exist is an error, not an empty match. */
export function parseStates(v: string | undefined): BeatState[] | undefined {
  if (v === undefined || v.trim() === "") return undefined
  const states = v.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)
  for (const s of states) {
    if (!BEAT_STATES.includes(s as BeatState)) throw new Error(`state "${s}" does not exist — states are ${BEAT_STATES.join(", ")}`)
  }
  return states as BeatState[]
}

type Measured = { measured: boolean; reason?: string }

export function heartbeatQueryJson(q: HeartbeatQueryResult | null, m: Measured) {
  if (!m.measured || !q) return { measured: false, reason: m.reason ?? "not measured", now: null, counts: null, matches: [] }
  return {
    measured: true,
    now: q.now,
    counts: q.counts,
    matches: q.matches.map((x) => ({
      jobId: x.row.jobId,
      agentId: x.row.agentId,
      agentName: x.row.agentName,
      state: x.state,
      since: x.since,
      line: x.line,
      problems: x.problems,
      runsMeasured: x.row.runsMeasured,
    })),
  }
}

const MARK: Record<BeatState, string> = { late: "◷", silent: "○", failing: "✗", running: "◐", ok: "●", paused: "‖" }

export function formatHeartbeatQuery(q: HeartbeatQueryResult | null, m: Measured): string[] {
  if (!m.measured || !q) return [`  Heartbeats: not measured — ${m.reason ?? "unknown reason"}`]
  const now = Date.parse(q.now)
  const out = [`  ${BEAT_STATES.map((s) => `${q.counts[s]} ${s}`).join(" · ")}`, ""]
  if (!q.matches.length) out.push(dim("  No heartbeat matches."))
  const width = Math.min(28, Math.max(...q.matches.map((x) => x.row.agentName.length), 5))
  for (const x of q.matches) {
    const since = x.since ? `since ${ago(x.since, now)}` : "since —"
    out.push(`  ${MARK[x.state]} ${x.state.padEnd(7)}  ${bold(x.row.agentName.slice(0, width).padEnd(width))}  ${dim(since.padEnd(16))}  ${x.line}`)
    if (!x.row.runsMeasured) out.push(dim(`      runs not read — the state above is from the schedule alone`))
  }
  return out
}

const QueryCmd = cmd({
  command: "query",
  describe: "agents by heartbeat state — the same states the Heartbeats panel shows",
  builder: (y) =>
    y
      .option("state", { describe: "comma list: late, silent, failing, running, ok, paused", type: "string" })
      .option("since", { describe: "only states that began since: 30m, 24h, 7d, 2w or an ISO time", type: "string" })
      .option("agent", { describe: "agent id or part of a name (repeatable)", type: "array", string: true })
      .option("user-id", { describe: "user id (defaults to the signed-in user)", type: "number" })
      .option("json", { describe: "machine-readable output", type: "boolean", default: false }),
  async handler(args) {
    let states: BeatState[] | undefined
    try {
      states = parseStates(args.state)
    } catch (e) {
      UI.error((e as Error).message)
      process.exitCode = 2
      return
    }
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return
    const res = await fetchHeartbeatRows(userId)
    let q: HeartbeatQueryResult | null = null
    if (res.measured) {
      try {
        q = queryHeartbeats(res.rows, { states, since: args.since, agents: args.agent as string[] | undefined })
      } catch (e) {
        UI.error((e as Error).message)
        process.exitCode = 2
        return
      }
    }
    if (args.json) await writeJson(heartbeatQueryJson(q, res))
    else {
      UI.empty()
      for (const line of formatHeartbeatQuery(q, res)) UI.println(line)
      UI.empty()
    }
    if (!res.measured) process.exitCode = 1
  },
})

export const PlatformHeartbeatsCommand = cmd({
  command: "heartbeats",
  describe: "your agents' heartbeats — query them by state (late, silent, failing…)",
  builder: (y) => y.command(QueryCmd).demandCommand(),
  async handler() {},
})
