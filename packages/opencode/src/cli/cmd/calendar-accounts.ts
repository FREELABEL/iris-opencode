/**
 * Google Calendar across EVERY connected account (#189944).
 *
 * Two defects, one assumption — "there is one calendar":
 *   1. Pulse/doctor printed "Google Calendar connected + verified" from the bridge's
 *      /api/calendar/events, which reads THIS MAC's Calendar store. It never called Google, so it
 *      stayed green while `iris calendar free` said the Google account was revoked.
 *   2. With 5 accounts, a READ (free/busy, a lead's meetings) was refused until you picked one
 *      with --account. A read is answered by asking every account and merging; only a WRITE
 *      needs a choice.
 */

import { irisFetch, IRIS_API, resolveUserId } from "./iris-api"
import { firstArray } from "../../util/array"

/** Every google-calendar connection record for the signed-in user. Throws when they cannot be listed. */
export async function listGoogleCalendarConnections(): Promise<any[]> {
  const uid = await resolveUserId()
  if (!uid) throw new Error("not signed in")
  const res = await irisFetch(`/api/v1/users/${uid}/integrations`, {}, IRIS_API)
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = (await res.json()) as any
  return firstArray(data?.connections, data?.data, data).filter((c: any) => String(c?.type ?? "").toLowerCase() === "google-calendar")
}

export interface AccountResult<T> {
  conn: any
  label: string
  ok: boolean
  value?: T
  error?: string
}

export function accountLabel(conn: any): string {
  return String(conn?.account_email || conn?.email || `google-calendar #${conn?.id}`)
}

export function providerError(raw: string): string {
  if (/ConnectedAccountNotFound|not found or may have been deleted/i.test(raw)) return "connection no longer exists at the provider — reconnect it"
  if (/revoked|invalid_grant|expired|\b401\b|unauthori[sz]ed/i.test(raw)) return "authorization expired — reconnect it"
  const m = raw.match(/"message"\s*:\s*"([^"]{1,140})/)
  return (m ? m[1] : raw).replace(/\s+/g, " ").slice(0, 160)
}

/** Run a read against every connection (by integration id), 3 at a time. Never throws. */
export async function forEachAccount<T>(conns: any[], call: (integrationId: number) => Promise<T>, concurrency = 3): Promise<AccountResult<T>[]> {
  const out: AccountResult<T>[] = new Array(conns.length)
  let next = 0
  const worker = async () => {
    while (next < conns.length) {
      const i = next++
      const conn = conns[i]
      const label = accountLabel(conn)
      try {
        const value: any = await call(Number(conn.id))
        if (value && typeof value === "object" && value.success === false) {
          const e = typeof value.error === "string" ? value.error : JSON.stringify(value.error ?? "no response")
          out[i] = { conn, label, ok: false, error: providerError(e) }
        } else {
          out[i] = { conn, label, ok: true, value }
        }
      } catch (e: any) {
        out[i] = { conn, label, ok: false, error: providerError(String(e?.message ?? e)) }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, conns.length) }, worker))
  return out
}

export interface CalendarHealth {
  name: string
  ok: boolean
  status: "verified" | "error" | "not_connected"
  detail?: string
  error?: string
  hint?: string
}

/** "Verified" only when every connected account answered a real Google API call. */
export function calendarHealthFrom(results: AccountResult<unknown>[]): CalendarHealth {
  const name = "Google Calendar"
  if (results.length === 0) return { name, ok: false, status: "not_connected", hint: "connect: iris integrations connect google-calendar" }
  const failed = results.filter((r) => !r.ok)
  if (failed.length === 0) return { name, ok: true, status: "verified", detail: `${results.length} of ${results.length} account(s) answered` }
  return {
    name,
    ok: false,
    status: "error",
    error: `${failed.length} of ${results.length} account(s) failing — ${failed.map((f) => `${f.label}: ${f.error}`).join("; ")}`.slice(0, 400),
    hint: "reconnect the failing account(s): iris integrations connect google-calendar",
  }
}

export interface Slot {
  start: string
  end: string
  duration_minutes: number
}

/** Free across ALL accounts = time that is free on every one of them. */
export function intersectFreeSlots(lists: Array<Array<{ start: string; end: string }>>): Slot[] {
  if (lists.length === 0) return []
  const norm = (l: Array<{ start: string; end: string }>) =>
    l
      .map((s) => [new Date(s.start).getTime(), new Date(s.end).getTime()] as [number, number])
      .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
      .sort((x, y) => x[0] - y[0])
  let acc = norm(lists[0])
  for (const other of lists.slice(1).map(norm)) {
    const next: [number, number][] = []
    for (const [a1, b1] of acc) for (const [a2, b2] of other) {
      const a = Math.max(a1, a2)
      const b = Math.min(b1, b2)
      if (b > a) next.push([a, b])
    }
    acc = next.sort((x, y) => x[0] - y[0])
  }
  return acc.map(([a, b]) => ({ start: new Date(a).toISOString(), end: new Date(b).toISOString(), duration_minutes: Math.round((b - a) / 60000) }))
}

/** Events from every account that answered, one per event id; failures listed, not hidden. */
export function mergeAccountEvents(results: AccountResult<any[]>[]): { events: any[]; failed: string[]; read: number } {
  const seen = new Set<string>()
  const events: any[] = []
  for (const r of results) {
    if (!r.ok) continue
    for (const ev of r.value ?? []) {
      const key = String(ev?.id ?? ev?.iCalUID ?? `${ev?.summary}|${ev?.start ?? ev?.start_time}`)
      if (seen.has(key)) continue
      seen.add(key)
      events.push(ev)
    }
  }
  return { events, failed: results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`), read: results.filter((r) => r.ok).length }
}

/**
 * Free time in [from, to] computed from an account's events: the window minus every event that
 * blocks time. Used when the provider's free/busy action fails for a reason that is not auth
 * (measured 2026-10-19: Composio FREE_BUSY_QUERY 400 "missing items" on every account).
 * Transparent ("show as free") and declined events do not block time.
 */
export function freeFromEvents(events: any[], from: string, to: string): Slot[] {
  const w0 = new Date(from).getTime()
  const w1 = new Date(to).getTime()
  if (!(w1 > w0)) return []
  const when = (t: any) => new Date(t && typeof t === "object" ? (t.dateTime ?? t.date) : t).getTime()
  const busy = events
    .filter((e) => e?.transparency !== "transparent")
    .filter((e) => !(Array.isArray(e?.attendees) && e.attendees.some((a: any) => a?.self && a?.responseStatus === "declined")))
    .map((e) => [Math.max(w0, when(e?.start ?? e?.start_time)), Math.min(w1, when(e?.end ?? e?.end_time))] as [number, number])
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((x, y) => x[0] - y[0])
  const free: Slot[] = []
  let cursor = w0
  for (const [a, b] of busy) {
    if (a > cursor) free.push({ start: new Date(cursor).toISOString(), end: new Date(a).toISOString(), duration_minutes: Math.round((a - cursor) / 60000) })
    cursor = Math.max(cursor, b)
  }
  if (w1 > cursor) free.push({ start: new Date(cursor).toISOString(), end: new Date(w1).toISOString(), duration_minutes: Math.round((w1 - cursor) / 60000) })
  return free
}
