/**
 * What happened when a comms channel was read — three outcomes, not two (#185776).
 *
 * Every ingester in platform-atlas-comms.ts used to answer failure with an empty array. So a
 * bridge that refused to read Mail (503: "the iris daemon has no Full Disk Access") printed
 * "apple_mail: no messages found", "Total: 0 new", and exited 0 — identical to a client who had
 * never written. Measured 2026-09-17 on Kristen Montero (#28363): her ledger held only our own
 * outbound mail, and nothing on it could say that was a failure to look rather than silence.
 *
 *   read           the channel answered. Zero items is a real, reportable zero.
 *   nothing        there is no handle to read with (no email, no phone). Not a failure, not a zero.
 *   unavailable    the channel could not be read. Never reported as "no messages".
 *
 * A read can be BOTH partly read and partly unavailable (a lead with two addresses, one of which
 * failed). That is reported as partial, because the items that did arrive are real and the ones
 * that did not are unknown.
 */

export type ChannelRead = {
  items: any[]
  /** Why part or all of the channel could not be read. Non-empty = something is unknown. */
  unavailable: string[]
  /** Set when there was no handle to read with at all. */
  nothing?: string
  /** At least one source for this channel answered — so a zero alongside a failure is partial, not unreadable. */
  answered?: boolean
}

export const readOk = (items: any[] = []): ChannelRead => ({ items, unavailable: [] })
export const unavailable = (...reasons: string[]): ChannelRead => ({ items: [], unavailable: reasons })
export const nothingToRead = (why: string): ChannelRead => ({ items: [], unavailable: [], nothing: why })

/**
 * A bridge non-2xx, as a sentence. The bridge usually says exactly what is wrong in its JSON
 * `error` — the Full Disk Access refusal is precise and actionable — and the old code printed the
 * status and threw that away.
 */
export function describeHttpFailure(source: string, status: number, bodyText: string): string {
  let detail = ""
  try {
    const parsed = JSON.parse(bodyText)
    detail = String(parsed?.error ?? parsed?.message ?? "").trim()
  } catch {
    detail = bodyText.trim()
  }
  if (!detail && status === 401) detail = "no/invalid X-Bridge-Key — run: iris bridge status"
  detail = detail.replace(/\s+/g, " ").slice(0, 200)
  return `${source} returned HTTP ${status}${detail ? `: ${detail}` : ""}`
}

export type ChannelOutcome = {
  kind: "unavailable" | "partial" | "empty" | "nothing" | "items"
  /** true when this channel must make the whole run fail. */
  failed: boolean
  /** The status line for everything except a successful read with items (the ingest reports that). */
  line: string
}

export function channelOutcome(ch: string, read: ChannelRead): ChannelOutcome {
  const reasons = read.unavailable.filter(Boolean)
  const why = reasons.join("; ")
  if (reasons.length && read.items.length === 0 && !read.answered) {
    return { kind: "unavailable", failed: true, line: `${ch}: COULD NOT READ — ${why}` }
  }
  if (reasons.length) {
    // Zero items here is possible (a source answered with nothing) and is still partial: the part
    // that answered really had nothing, the part that failed is unknown.
    return { kind: "partial", failed: true, line: `${ch}: read ${read.items.length} message(s), but part of the channel could not be read — ${why}` }
  }
  if (read.nothing) {
    return { kind: "nothing", failed: false, line: `${ch}: nothing to read — ${read.nothing}` }
  }
  if (read.items.length === 0) {
    return { kind: "empty", failed: false, line: `${ch}: no messages found` }
  }
  return { kind: "items", failed: false, line: `${ch}: ${read.items.length} message(s)` }
}

/** The closing line when any channel failed. A total that hides this is the bug. */
export function failedRunWarning(failedChannels: string[]): string | null {
  if (failedChannels.length === 0) return null
  return (
    `${failedChannels.length} channel(s) could not be fully read: ${failedChannels.join(", ")}. ` +
    `The totals above do NOT mean there was no contact on ${failedChannels.length === 1 ? "that channel" : "those channels"}.`
  )
}
