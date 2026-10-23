import { hostname } from "os"
import { IRIS_API, irisFetch, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/**
 * Every AI session on every machine you can reach — the data behind Hive › Sessions (epic #189446).
 *
 * Nothing new is collected here. Each machine's daemon already reports its sessions on every
 * heartbeat, and fl-iris-api already returns them on the node list `iris hive sessions` reads. This
 * is that list, mapped for the Desktop, plus the two doors a person needs once they can see it:
 * read a session (the server's transcript reader) and reply to it (a `session_message` task, the
 * same thing `iris hive send-input` sends).
 *
 * WHAT IS LEFT OUT. `project_path` is a local path with the OS username in it. The server's own
 * fleet view never emits it, and neither does this.
 */

/** A report older than this cannot vouch for any status it carried — the server's REPORT_FRESH_S. */
export const REPORT_FRESH_MS = 600_000

export type SessionsReport = "fresh" | "stale" | "unknown" | "never"

export interface HiveSession {
  sessionId: string
  provider: string
  label: string
  /** needs_you | active | idle | stale | unknown — derived by the daemon, then by the server's clock. */
  status: string
  /** working | retrying | null (not measured — never "waiting"). */
  activity: string | null
  model: string | null
  branch: string | null
  updatedAt: string | null
  /** The question a person is being waited on for, when there is one. */
  question: string | null
}

export interface HiveSessionNode {
  id: string
  name: string
  online: boolean
  lastHeartbeat: string | null
  report: SessionsReport
  reportedAt: string | null
  /** Providers the daemon could not ask, or cut at its cap — the list is a floor, not a count. */
  incomplete: string[]
  sessions: HiveSession[]
}

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() !== "" ? v : null)

/** The server's clock, for a server that predates `sessions_report`. Same rule, same constant. */
export function reportOf(serverValue: unknown, reportedAt: string | null, now: number): SessionsReport {
  if (serverValue === "fresh" || serverValue === "stale" || serverValue === "unknown" || serverValue === "never") {
    return serverValue
  }
  const t = reportedAt ? Date.parse(reportedAt) : NaN
  if (Number.isNaN(t)) return "never"
  if (t > now + REPORT_FRESH_MS) return "unknown"
  return now - t <= REPORT_FRESH_MS ? "fresh" : "stale"
}

function questionOf(w: any): string | null {
  const q = Array.isArray(w?.questions) ? w.questions[0] : null
  return str(q?.question) ?? str(q?.text) ?? str(q) ?? null
}

/** /api/v6/nodes → machines with their sessions. Pure; `now` injected. */
export function sessionsFromNodes(json: any, now: number): HiveSessionNode[] {
  const nodes: any[] = Array.isArray(json?.nodes) ? json.nodes : Array.isArray(json?.data) ? json.data : []
  return nodes.map((n) => {
    const reportedAt = str(n?.sessions_updated_at)
    const report = reportOf(n?.sessions_report, reportedAt, now)
    const raw: any[] = Array.isArray(n?.active_sessions) ? n.active_sessions : []
    const sessions: HiveSession[] = raw
      .filter((s) => s && typeof s.session_id === "string" && s.session_id !== "")
      .map((s) => ({
        sessionId: s.session_id,
        provider: str(s.provider) ?? "unknown",
        label: str(s.label) ?? str(s.name) ?? "Session",
        // An old server sent the daemon's status verbatim; apply the same rule it now applies.
        status: report === "fresh" ? (str(s.status) ?? "unknown") : "unknown",
        activity: report === "fresh" && (s.activity === "working" || s.activity === "retrying") ? s.activity : null,
        model: str(s.model),
        branch: str(s.git_branch),
        updatedAt: str(s.updated_at),
        question: report === "fresh" && s.status === "needs_you" ? questionOf(s.waiting) : null,
      }))
    const incomplete = [
      ...(Array.isArray(n?.sessions_truncated) ? n.sessions_truncated : []),
      ...(Array.isArray(n?.sessions_unreachable) ? n.sessions_unreachable : []),
    ].filter((p): p is string => typeof p === "string")
    return {
      id: String(n?.id ?? ""),
      name: str(n?.name) ?? "unnamed",
      online: n?.connection_status === "online",
      lastHeartbeat: str(n?.last_heartbeat_at),
      report,
      reportedAt,
      incomplete: [...new Set(incomplete)],
      sessions,
    }
  })
}

export async function fetchHiveSessions(now = Date.now()): Promise<PlatformResult<{ nodes: HiveSessionNode[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { nodes: [] } }
  try {
    const res = await irisFetch(`/api/v6/nodes/?user_id=${userId}`, IRIS_API)
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { nodes: [] } }
    return { measured: true, data: { nodes: sessionsFromNodes(await res.json(), now) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { nodes: [] } }
  }
}

export interface TranscriptMessage {
  role: string
  type: string
  text: string | null
  tool: string | null
  at: string | null
}

export interface Transcript {
  ranOn: string | null
  messages: TranscriptMessage[]
  /** Byte cursor for the next read; with it the machine sends only what was appended. */
  offset: number | null
  /** true: these rows APPEND to what the reader has. false: they REPLACE it. */
  incremental: boolean
}

/** The server's transcript (fl-iris-api SessionTranscript) → rows. Pure. */
export function transcriptOf(json: any): Transcript {
  const msgs: any[] = Array.isArray(json?.messages) ? json.messages : []
  const reset = json?.reset === true
  return {
    ranOn: str(json?.ran_on),
    messages: msgs.map((m) => ({
      role: str(m?.role) ?? "unknown",
      type: str(m?.type) ?? "text",
      text: str(m?.text) ?? str(m?.content) ?? null,
      tool: str(m?.tool) ?? str(m?.name) ?? null,
      at: str(m?.timestamp) ?? str(m?.at) ?? null,
    })),
    offset: typeof json?.offset === "number" ? json.offset : null,
    incremental: json?.incremental === true && !reset,
  }
}

export async function fetchHiveTranscript(
  sessionId: string,
  opts: { machine?: string; provider?: string; since?: number; limit?: number },
): Promise<PlatformResult<Transcript>> {
  const empty: Transcript = { ranOn: null, messages: [], offset: null, incremental: false }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  const q = new URLSearchParams({ user_id: String(userId), limit: String(opts.limit ?? 40) })
  if (opts.machine) q.set("machine", opts.machine)
  if (opts.provider) q.set("provider", opts.provider)
  if (typeof opts.since === "number") q.set("since", String(opts.since))
  try {
    const res = await irisFetch(`/api/v6/nodes/sessions/${encodeURIComponent(sessionId)}/transcript?${q}`, IRIS_API)
    // The route always answers 200 once it exists; a 404 means this IRIS server predates it.
    if (res.status === 404) return { measured: false, reason: "the IRIS server cannot read sessions from other machines yet", data: empty }
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: empty }
    const json = (await res.json()) as any
    // A machine that could not answer is not an empty session. Say which it is.
    if (json?.success === false) return { measured: false, reason: str(json.error) ?? "the machine did not answer", data: empty }
    return { measured: true, data: transcriptOf(json) }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

/** Providers whose reply lands in the window that is already open. Claude Code's would fork a new run. */
export const REPLY_IN_PLACE = new Set(["opencode"])

export async function replyToHiveSession(input: {
  sessionId: string
  nodeId: string
  provider: string
  label?: string
  message: string
}): Promise<PlatformResult<{ taskId: string | null }>> {
  const message = input.message.trim()
  if (!message) return { measured: false, reason: "nothing to send", data: { taskId: null } }
  if (!REPLY_IN_PLACE.has(input.provider)) {
    return {
      measured: false,
      reason: `replying to a ${input.provider} session from here would start a separate run, not type into the open one`,
      data: { taskId: null },
    }
  }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { taskId: null } }
  try {
    const res = await irisFetch(`/api/v6/nodes/tasks`, IRIS_API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        node_id: input.nodeId,
        type: "session_message",
        title: `reply to ${input.label ?? input.sessionId}`.slice(0, 255),
        prompt: message,
        // Same shape as `iris hive send-input`, including where it came FROM (#182785).
        config: {
          session_id: input.sessionId,
          provider: input.provider,
          message,
          from: hostname().replace(/\.local$/, ""),
        },
      }),
    })
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { taskId: null } }
    const json = (await res.json()) as any
    return { measured: true, data: { taskId: str(json?.task?.id) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { taskId: null } }
  }
}
