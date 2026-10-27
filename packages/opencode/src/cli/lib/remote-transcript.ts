// Read an AI session's transcript off whichever machine holds it (#191230).
//
// `iris recall` finds a session on any machine you own (#191223); this opens it. The server does
// the reading — GET /api/v6/nodes/sessions/{id}/transcript asks the machine's bridge for the
// messages and passes them through. Nothing is stored on the server; the transcript stays on its
// machine and is read when asked. Measured 2026-10-26: a Desktop session on the MacBook read from
// iris-hive-001 in 1.7s.

export type TranscriptQuery = { machine?: string; provider?: string; limit?: number; since?: number | null }

export type TranscriptMessage = {
  role?: string
  type?: string
  content?: unknown
  text?: unknown
  tool?: string
  command?: string | null
  file_path?: string | null
  timestamp?: string
}

/** Session ids the server accepts (its route pattern) — refuse anything else before it becomes a URL. */
export const SESSION_ID = /^[A-Za-z0-9._:-]{1,191}$/

export function transcriptPath(id: string, q: TranscriptQuery = {}): string {
  if (!SESSION_ID.test(id)) throw new Error(`"${id}" is not a session id`)
  const qs = new URLSearchParams()
  if (q.machine) qs.set("machine", q.machine)
  if (q.provider) qs.set("provider", q.provider)
  if (q.limit) qs.set("limit", String(Math.max(1, Math.min(100, Math.floor(q.limit)))))
  if (q.since != null) qs.set("since", String(q.since))
  const s = qs.toString()
  return `/api/v6/nodes/sessions/${encodeURIComponent(id)}/transcript${s ? `?${s}` : ""}`
}

const oneLine = (v: unknown, max: number) => {
  const t = (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v)).replace(/\s+/g, " ").trim()
  return t.length > max ? t.slice(0, max - 1) + "…" : t
}

/**
 * The entries `next` adds to `prev`, when both are "the latest N" pages of the same session.
 * The new page is the old one shifted left plus what was appended, so find the longest tail of
 * `prev` that starts `next` and return the rest. Matching by overlap rather than by a set of seen
 * entries keeps a genuinely repeated entry (the same file read twice) — entries carry no unique id.
 * No overlap at all means more was appended than one page holds: the whole page is new.
 */
export function appendedSince(prev: TranscriptMessage[], next: TranscriptMessage[]): TranscriptMessage[] {
  const a = prev.map((m) => JSON.stringify(m))
  const b = next.map((m) => JSON.stringify(m))
  for (let k = Math.min(a.length, b.length); k > 0; k--) {
    let same = true
    for (let i = 0; i < k && same; i++) same = a[a.length - k + i] === b[i]
    if (same) return next.slice(k)
  }
  return next
}

/** One message as [label, text]: what was said, or for a tool call the command or file it touched. */
export function messageLine(m: TranscriptMessage, max = 160): [string, string] {
  if (m.type === "tool_use" || m.tool) {
    const what = m.command || m.file_path || m.content || m.text || ""
    return [`${m.tool ?? "tool"}`, oneLine(what, max)]
  }
  return [String(m.role ?? m.type ?? "?"), oneLine(m.content ?? m.text ?? "", max)]
}

/** What a follow has shown so far: the latest page (the overlap baseline) and the machine's cursor. */
export type FollowState = { page: TranscriptMessage[]; offset: number | null }

/** The most a poll asks for — the server's cap. Polls never use --limit, which only sizes the first screen. */
export const FOLLOW_PAGE = 100

/**
 * One poll's answer → what to print and the new state, or `refetch` when the answer cannot be
 * used as-is (#191302). A reset comes back EMPTY: the daemon sends no rows when more arrived than a
 * page holds (session-tail readSince: truncated → reset), so printing it as "the latest" lost every
 * entry in between. The caller then asks again without a cursor and passes the page to fromPage().
 */
export function advance(
  state: FollowState,
  res: { messages?: TranscriptMessage[]; offset?: number | null; reset?: boolean },
): { print: TranscriptMessage[]; state: FollowState } | { refetch: true } {
  if (res.reset) return { refetch: true }
  const rows = res.messages ?? []
  if (state.offset != null && res.offset != null) {
    // A cursor: these rows are exactly what was appended.
    return { print: rows, state: { page: [...state.page, ...rows].slice(-FOLLOW_PAGE), offset: res.offset } }
  }
  // No cursor (IRIS sessions live in SQLite): the latest page again; print what it adds.
  return { print: appendedSince(state.page, rows), state: { page: rows, offset: res.offset ?? null } }
}

/** A freshly fetched latest page after a reset: print what it adds; `gap` when nothing overlaps. */
export function fromPage(
  state: FollowState,
  rows: TranscriptMessage[],
  offset: number | null,
): { print: TranscriptMessage[]; state: FollowState; gap: boolean } {
  const print = appendedSince(state.page, rows)
  const gap = state.page.length > 0 && rows.length > 0 && print.length === rows.length
  return { print, state: { page: rows, offset }, gap }
}
