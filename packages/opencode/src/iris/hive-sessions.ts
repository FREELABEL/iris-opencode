import { hostname } from "os"
import { IRIS_API, irisFetch, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/**
 * Every AI session on every machine you can reach — the data behind Hive › Sessions (epic #189446).
 *
 * Nothing new is collected here. Each machine's daemon already reports its sessions on every
 * heartbeat, and fl-iris-api already returns them on the node list `iris hive sessions` reads. This
 * is that list, mapped for the Desktop with the CLI's own rules (`iris hive sessions` on main:
 * detailed=1, one row per provider + id from the newest report, old records retired, the same
 * label), plus the doors a person needs once they can see it: read a session (the server's
 * transcript reader), talk to it (the `session_message` task `iris hive ask` sends), and answer the
 * question it is waiting on (the task `iris hive answer` sends). #189446, #191171.
 *
 * WHAT IS LEFT OUT. `project_path` is a local path with the OS username in it. The server's own
 * fleet view never emits it, and neither does this.
 */

/** A report older than this cannot vouch for any status it carried — the server's REPORT_FRESH_S. */
export const REPORT_FRESH_MS = 600_000

/**
 * A node record whose report is older than this lists nothing — `iris hive sessions`'
 * REPORT_WINDOW_MS, itself the server's SessionRows::REPORT_WINDOW_S (#190653). A machine that
 * re-registered keeps its OLD record, and that record keeps its last list forever.
 */
export const REPORT_WINDOW_MS = 7 * 86400 * 1000

export type SessionsReport = "fresh" | "stale" | "unknown" | "never"

/**
 * Providers a message can be sent into (`iris hive send-input` / `ask`), and whose waiting question
 * `iris hive answer` can reach. `acp` is a session held open by `iris acp run --keep` (#191170).
 */
export const MESSAGEABLE_PROVIDERS = ["claude_code", "opencode", "acp"] as const
export const ANSWERABLE_PROVIDERS = ["claude_code", "opencode", "acp"] as const

/** Why a row cannot take a message from here, or null when it can. Said on the row, not hidden. */
export function readOnlyReason(provider: string): string | null {
  if ((MESSAGEABLE_PROVIDERS as readonly string[]).includes(provider)) return null
  if (provider === "codex") return "Codex sessions are listed, not driven: the machine has no way to type into one"
  if (provider === "ollama") return "Ollama runs are model calls, not conversations: there is nothing to type into"
  return `IRIS cannot send into ${provider} sessions — only Claude Code, IRIS / opencode and ACP sessions take messages`
}

/** One question a session is waiting on, with its options numbered the way the agent reads them. */
export interface WaitingQuestion {
  question: string
  header: string | null
  /** `n` is the option number the agent shows (1-based, original position); empty labels are skipped, not renumbered. */
  options: Array<{ n: number; label: string }>
}

export interface HiveSession {
  sessionId: string
  provider: string
  /** The label `iris hive sessions` prints — same cleaning, same fallback, same length. */
  label: string
  /** needs_you | active | idle | stale | unknown — derived by the daemon, then by the server's clock. */
  status: string
  /** working | retrying | null (not measured — never "waiting"). */
  activity: string | null
  model: string | null
  branch: string | null
  updatedAt: string | null
  /** The first question a person is being waited on for, when there is one. */
  question: string | null
  /** Every waiting question with its options (#188536). Empty unless fresh and needs_you. */
  questions: WaitingQuestion[]
  /** Why this row cannot be messaged or answered from here; null when it can. */
  readOnly: string | null
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

/** An old record of a machine that re-registered: named, with how many rows it holds that are NOT shown. */
export interface RetiredRecord {
  name: string
  rows: number
  at: string
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

/**
 * `iris hive sessions`' label(), verbatim: a label derived from what the session IS. Names seen on
 * the live fleet include a raw tool-use id, a line of box drawing and private-use glyphs, so an
 * unusable name falls back to `<project folder> · <last 8 of id>`. Only the folder NAME is used —
 * the path itself (with the OS username in it) never leaves the sidecar.
 */
export function labelOf(s: { name?: unknown; project_path?: unknown; session_id: string }): string {
  const clean = (typeof s.name === "string" ? s.name : "")
    .replace(/[\u0000-\u001f\u2500-\u257f\ue000-\uf8ff]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  const usable = clean.length >= 4 && /[a-z0-9]/i.test(clean) && !/^new session\b/i.test(clean)
  if (usable) return clean.length > 46 ? clean.slice(0, 45) + "…" : clean
  const proj = (typeof s.project_path === "string" ? s.project_path : "").split("/").filter(Boolean).pop() || "?"
  return `${proj} · ${s.session_id.slice(-8)}`
}

/** `waitingLines`' rules as data: a question kind, a non-empty question, options by their own number. */
export function waitingOf(w: any): WaitingQuestion[] {
  if (!w || w.kind !== "question" || !Array.isArray(w.questions)) return []
  const out: WaitingQuestion[] = []
  for (const q of w.questions) {
    if (!q || typeof q.question !== "string" || !q.question.trim()) continue
    const opts: any[] = Array.isArray(q.options) ? q.options : []
    out.push({
      question: q.question.replace(/\s+/g, " ").trim(),
      header: str(q.header),
      options: opts.flatMap((o, i) => (o && typeof o.label === "string" && o.label.trim() ? [{ n: i + 1, label: o.label.trim().slice(0, 100) }] : [])),
    })
  }
  return out
}

/**
 * `iris hive sessions`' reportedSessions(), applied per machine: a record whose report is older than
 * REPORT_WINDOW_MS contributes no rows (it is returned in `retired`, never silently dropped), and a
 * session reported by several records (provider + id) is taken from the newest report. A node with
 * no report time at all is kept: unknown is not old.
 */
export function fleetFromNodes(json: any, now: number): { nodes: HiveSessionNode[]; retired: RetiredRecord[] } {
  const all: any[] = Array.isArray(json?.nodes) ? json.nodes : Array.isArray(json?.data) ? json.data : []
  const retired: RetiredRecord[] = []
  const live: any[] = []
  const best = new Map<string, { node: any; s: any; at: number }>()
  for (const n of all) {
    const list: any[] = Array.isArray(n?.active_sessions) ? n.active_sessions : []
    const at = Date.parse(n?.sessions_updated_at ?? n?.last_heartbeat_at ?? "")
    if (!Number.isNaN(at) && now - at > REPORT_WINDOW_MS && list.length) {
      retired.push({ name: String(n?.name), rows: list.length, at: n.sessions_updated_at ?? n.last_heartbeat_at })
      continue
    }
    // An old record with NO rows hides nothing, so it stays on the list: the CLI names it as a
    // machine that has not reported, and absent must not look like empty.
    live.push(n)
    const t = Number.isNaN(at) ? 0 : at
    for (const s of list) {
      if (!s || typeof s.session_id !== "string" || s.session_id === "") continue
      const key = `${s.provider ?? ""}|${s.session_id}`
      const prev = best.get(key)
      if (!prev || t > prev.at) best.set(key, { node: n, s, at: t })
    }
  }
  const kept = new Set([...best.values()].map((e) => e.s))

  const nodes = live.map((n): HiveSessionNode => {
    const reportedAt = str(n?.sessions_updated_at)
    const report = reportOf(n?.sessions_report, reportedAt, now)
    const raw: any[] = Array.isArray(n?.active_sessions) ? n.active_sessions : []
    const sessions: HiveSession[] = raw
      .filter((s) => kept.has(s))
      .map((s) => {
        const provider = str(s.provider) ?? "unknown"
        const questions = report === "fresh" && s.status === "needs_you" ? waitingOf(s.waiting) : []
        return {
          sessionId: s.session_id,
          provider,
          label: labelOf(s),
          // An old server sent the daemon's status verbatim; apply the same rule it now applies.
          status: report === "fresh" ? (str(s.status) ?? "unknown") : "unknown",
          activity: report === "fresh" && (s.activity === "working" || s.activity === "retrying") ? s.activity : null,
          model: str(s.model),
          branch: str(s.git_branch),
          updatedAt: str(s.updated_at),
          question: questions[0]?.question ?? null,
          questions,
          readOnly: readOnlyReason(provider),
        }
      })
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
  return { nodes, retired }
}

/** /api/v6/nodes → machines with their sessions. Pure; `now` injected. */
export function sessionsFromNodes(json: any, now: number): HiveSessionNode[] {
  return fleetFromNodes(json, now).nodes
}

export async function fetchHiveSessions(
  now = Date.now(),
): Promise<PlatformResult<{ nodes: HiveSessionNode[]; retired: RetiredRecord[] }>> {
  const empty = { nodes: [], retired: [] }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  try {
    // detailed=1: the same request `iris hive sessions` makes.
    const res = await irisFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`, IRIS_API)
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: empty }
    return { measured: true, data: fleetFromNodes(await res.json(), now) }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
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


// ── Talking to a session (the CLI's `iris hive ask` and `iris hive answer`) ─────────────────────

const from = () => hostname().replace(/\.local$/, "")

/**
 * The task `iris hive ask` creates, field for field: a `session_message` with `submit`, so the
 * session takes a turn (it spends THAT session's tokens) and the reply can be followed in its
 * transcript. `from` names this machine so the message does not look typed by the recipient (#182785).
 */
export function askTaskBody(input: { userId: number | string; nodeId: string; sessionId: string; provider: string; label: string; message: string; from: string }) {
  return {
    user_id: input.userId,
    node_id: input.nodeId,
    type: "session_message",
    title: `ask ${input.label}`,
    prompt: input.message,
    config: { session_id: input.sessionId, provider: input.provider, message: input.message, from: input.from, submit: true },
  }
}

/** The task `iris hive answer` creates: one answer per question, by option number or label. */
export function answerTaskBody(input: { userId: number | string; nodeId: string; sessionId: string; provider: string; choices: string[]; from: string }) {
  return {
    user_id: input.userId,
    node_id: input.nodeId,
    type: "session_message",
    title: `answer ${input.sessionId.slice(-8)}`,
    prompt: input.choices.join(" | "),
    config: { session_id: input.sessionId, provider: input.provider, answers: input.choices, from: input.from },
  }
}

/**
 * Why the cloud refused a task it just created, or null (CLI hive-chat-follow refusedAtCreate). A
 * refusal arrives as a 201 whose task is already `failed` — e.g. "is busy (CPU at 168%)" (#190945).
 */
export function refusedAtCreate(created: any): string | null {
  const t = created?.task
  if (!t || t.status !== "failed") return null
  const why = t.result?.metadata?.reason ?? t.result?.error ?? t.error ?? "the task failed"
  return String(why).slice(0, 200)
}

export async function askHiveSession(input: {
  sessionId: string
  nodeId: string
  provider: string
  label?: string
  message: string
}): Promise<PlatformResult<{ taskId: string | null }>> {
  const message = input.message.trim()
  if (!message) return { measured: false, reason: "nothing to send", data: { taskId: null } }
  const ro = readOnlyReason(input.provider)
  if (ro) return { measured: false, reason: ro, data: { taskId: null } }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { taskId: null } }
  try {
    const body = askTaskBody({ userId, nodeId: input.nodeId, sessionId: input.sessionId, provider: input.provider, label: input.label ?? input.sessionId, message, from: from() })
    body.title = body.title.slice(0, 255)
    const res = await irisFetch(`/api/v6/nodes/tasks`, IRIS_API, { method: "POST", body: JSON.stringify(body) })
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim(), data: { taskId: null } }
    const json = (await res.json()) as any
    const refused = refusedAtCreate(json)
    if (refused) return { measured: false, reason: `the machine refused it: ${refused}`, data: { taskId: null } }
    return { measured: true, data: { taskId: json?.task?.id != null ? String(json.task.id) : null } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { taskId: null } }
  }
}

const TERMINAL = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])

export interface AnswerOutcome {
  taskId: string | null
  /** answered: the node delivered it · refused: the node said why not · pending: no result in time. */
  status: "answered" | "refused" | "pending"
  /** hook = the waiting hook took it · keystroke = typed into its tmux pane (Claude Code). */
  via: string | null
  answers: Array<{ question: string; answer: string }>
  error: string | null
}

/**
 * What a finished answer task says (CLI `iris hive answer`): the node prints one JSON line last;
 * `delivered` means answered. "Sent" is not "answered" — the node may refuse (not on screen, not in
 * tmux), and that refusal is the whole answer.
 */
export function answerOutcome(taskId: string | null, task: any): AnswerOutcome {
  if (!task || !TERMINAL.has(task.status)) return { taskId, status: "pending", via: null, answers: [], error: null }
  const r = task.result ?? {}
  const stdout = String(r.stdout ?? r.output ?? "")
  const stderr = str(r.stderr)
  let body: any = null
  try {
    body = JSON.parse(stdout.trim().split("\n").pop() || "")
  } catch {}
  if (body?.delivered) {
    const answers = Object.entries(body.answers && typeof body.answers === "object" ? body.answers : {}).map(([question, a]) => ({ question, answer: String(a) }))
    return { taskId, status: "answered", via: String(body.delivered), answers, error: null }
  }
  return { taskId, status: "refused", via: null, answers: [], error: str(body?.error) ?? stderr ?? str(task.error) ?? "the node gave no reason" }
}

export async function answerHiveSession(
  input: { sessionId: string; nodeId: string; provider: string; choices: string[] },
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<PlatformResult<AnswerOutcome>> {
  const none: AnswerOutcome = { taskId: null, status: "pending", via: null, answers: [], error: null }
  const choices = input.choices.map((c) => String(c).trim()).filter(Boolean)
  if (!choices.length) return { measured: false, reason: "no answer given", data: none }
  if (!(ANSWERABLE_PROVIDERS as readonly string[]).includes(input.provider)) {
    return { measured: false, reason: `Answering is supported for Claude Code, IRIS / opencode and ACP sessions; this one is ${input.provider}`, data: none }
  }
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: none }
  try {
    const body = answerTaskBody({ userId, nodeId: input.nodeId, sessionId: input.sessionId, provider: input.provider, choices, from: from() })
    const res = await irisFetch(`/api/v6/nodes/tasks`, IRIS_API, { method: "POST", body: JSON.stringify(body) })
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status} ${(await res.text().catch(() => "")).slice(0, 200)}`.trim(), data: none }
    const created = (await res.json()) as any
    const refused = refusedAtCreate(created)
    const taskId = created?.task?.id != null ? String(created.task.id) : null
    if (refused) return { measured: true, data: { ...none, taskId, status: "refused", error: refused } }
    const deadline = Date.now() + (opts.timeoutMs ?? 45_000)
    while (taskId && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1500))
      const t = await irisFetch(`/api/v6/nodes/tasks/${encodeURIComponent(taskId)}?user_id=${userId}`, IRIS_API)
      if (!t.ok) break
      const out = answerOutcome(taskId, ((await t.json()) as any)?.task)
      if (out.status !== "pending") return { measured: true, data: out }
    }
    return { measured: true, data: { ...none, taskId } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: none }
  }
}
