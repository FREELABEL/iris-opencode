/**
 * Shape of a /api/mail/search response, across bridge daemon versions.
 *
 * THE BUG THIS EXISTS FOR. The Envelope-Index rewrite (31s of AppleScript → 0.1s of
 * SQLite) changed the response key from `messages` to `emails`. The CLI was not updated,
 * so `data.messages` was always undefined, always fell back to `[]`, and `iris mail
 * search` reported "No emails from X in the last N days" for EVERY sender — against a
 * mailbox holding 274,414 messages, 936 of them that week.
 *
 * A performance win that silently zeroed the feature, and reported it as a normal empty
 * result. It went unnoticed because "no results" and "broken reader" printed the same
 * sentence, and it was believed: it produced a wrong diagnosis about a user's email
 * infrastructure before anyone checked the reader itself.
 */

/**
 * Extract rows from whichever daemon answered.
 *
 * Accepts BOTH keys deliberately — most fleet nodes still run the pre-rewrite daemon that
 * returns `messages`, so pinning to the new name alone would just move the silence to a
 * different set of machines.
 *
 * Throws on an unrecognised shape. An unreadable response must NEVER render as "you have
 * no mail"; that equivalence IS the defect, and a thrown error is the only thing that
 * keeps the two apart.
 */
export function mailRows(data: any): any[] {
  const rows = data?.emails ?? data?.messages
  if (!Array.isArray(rows)) {
    throw new Error(
      `bridge returned an unrecognised mail response (keys: ${Object.keys(data ?? {}).join(", ") || "none"}) — ` +
        `expected 'emails' or 'messages'. This is a bridge/CLI version mismatch, not an empty mailbox.`,
    )
  }

  // The same rename, one field down: the rewrite sends `date_sent`, the renderer prints
  // `msg.date`. Not fatal like the array key — it just made the Date line disappear from
  // every result, quietly, which is why nobody reported it. Normalised here so both call
  // sites and both daemon versions render the same.
  return rows.map((r: any) =>
    r && typeof r === "object" && r.date === undefined && r.date_sent !== undefined
      ? { ...r, date: r.date_sent }
      : r,
  )
}

export interface MailSearchArgs {
  query?: string
  subject?: string
  days: number
  limit: number
  full?: boolean
  maxBody?: number
  attachments?: boolean
  /** Match the query as an address that SENT or RECEIVED the message (both directions). */
  thread?: boolean
}

/**
 * Query string for /api/mail/search (#189941). The query is passed through as data — the bridge
 * escapes it — and an empty one is refused here rather than becoming `from=` + "No emails from """.
 */
export function mailSearchParams(a: MailSearchArgs): URLSearchParams | { error: string } {
  const q = String(a.query ?? "").trim()
  const s = String(a.subject ?? "").trim()
  if (!q && !s) return { error: "Give a sender (name or address) to search for, or a subject with -s \"…\"." }
  const p = new URLSearchParams({ days: String(a.days), limit: String(a.limit) })
  if (q) p.set(a.thread ? "participant" : "from", q)
  if (s) p.set("subject", s)
  if (a.full) {
    p.set("include_body", "1")
    p.set("max_body", String(a.maxBody ?? 4000))
  }
  if (a.attachments) p.set("include_attachments", "1")
  return p
}

export function describeMailQuery(a: { query?: string; subject?: string; thread?: boolean; days: number }): string {
  const q = String(a.query ?? "").trim()
  const s = String(a.subject ?? "").trim()
  const who = q ? (a.thread ? `to or from "${q}"` : `from "${q}"`) : ""
  const subj = s ? `with subject "${s}"` : ""
  return `No emails ${[who, subj].filter(Boolean).join(" ")} in the last ${a.days} days`
}

/** Why a row asked for with --full has no body, or null when it has one. */
export function bodyMissingNote(row: any): string | null {
  if (typeof row?.body === "string" && row.body.length > 0) return null
  if (row?.body_error) return `(no body — ${row.body_error})`
  if (!row || !("body" in row)) return "(no body — this bridge is older than body support; update the IRIS daemon)"
  return "(empty body)"
}
