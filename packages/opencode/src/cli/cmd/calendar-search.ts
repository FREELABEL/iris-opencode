/**
 * `iris calendar search` — one query across every calendar, with an account of what was NOT searched.
 *
 * Why (epic #187374, 2026-09-30): the attendee emails for a follow-up were on a calendar invite.
 * `iris calendar list` searched the one connected Google account and said "No events"; Apple
 * Calendar on the Mac, read by hand, said the same. Both were right about where they looked. The
 * invite had gone to an account connected nowhere, and nothing said so. A search that cannot tell
 * "nothing matched" from "I did not look" is the bug this module exists to fix, so the coverage
 * report (`sources`) is part of every result, never an optional footer.
 *
 * Pure helpers live here and are unit-tested; the provider calls live in `runCalendarSearch`.
 */
import { execFile } from "node:child_process"

export type SourceStatus = "ok" | "failed" | "unsupported"

export interface SearchSource {
  name: string
  kind: "google" | "outlook" | "apple" | "windows-outlook"
  status: SourceStatus
  /** matching events found in this source */
  count: number
  /** calendars read inside this source */
  calendars?: number
  /** why it failed or was not supported */
  reason?: string
  integrationId?: number
}

export interface Attendee {
  email: string
  name?: string
  response?: string
  organizer?: boolean
}

export interface FoundEvent {
  title: string
  start: string
  end?: string
  location?: string
  attendees: Attendee[]
  /** every source + calendar the event was seen in (one meeting is often on several) */
  seenIn: string[]
  id?: string
  uid?: string
}

export interface SearchResult {
  query: string
  window: { from: string; to: string }
  events: FoundEvent[]
  sources: SearchSource[]
  /** true only when every source we know about was searched successfully */
  complete: boolean
}

const norm = (s: unknown) => String(s ?? "").trim().toLowerCase()

/** Google returns {dateTime} for timed events and {date} for all-day ones; accept both, and strings. */
export function eventTime(v: any): string {
  if (!v) return ""
  if (typeof v === "string") return v
  return v.dateTime || v.date || ""
}

/** Shape a Google Calendar API event into a FoundEvent. */
export function fromGoogleEvent(ev: any, seenIn: string): FoundEvent {
  const attendees: Attendee[] = (Array.isArray(ev?.attendees) ? ev.attendees : [])
    .filter((a: any) => a?.email && !a.resource)
    .map((a: any) => ({
      email: String(a.email).toLowerCase(),
      ...(a.displayName ? { name: String(a.displayName) } : {}),
      ...(a.responseStatus ? { response: String(a.responseStatus) } : {}),
      ...(a.organizer ? { organizer: true } : {}),
    }))
  // An organizer who is not also an attendee (common for invites you RECEIVED) still matters —
  // they are the person who sent it.
  const org = ev?.organizer?.email ? String(ev.organizer.email).toLowerCase() : ""
  if (org && !org.endsWith("calendar.google.com") && !attendees.some((a) => a.email === org)) {
    attendees.unshift({ email: org, ...(ev.organizer.displayName ? { name: ev.organizer.displayName } : {}), organizer: true })
  }
  return {
    title: String(ev?.summary ?? "(no title)"),
    start: eventTime(ev?.start),
    end: eventTime(ev?.end) || undefined,
    location: ev?.location || undefined,
    attendees,
    seenIn: [seenIn],
    id: ev?.id,
    uid: ev?.iCalUID,
  }
}

/**
 * Does the event match the query? Title, description, location, and every attendee name or email.
 * Google's own `q` already does this server-side; this is the same rule for sources that cannot
 * filter (Apple Calendar), and a safety net so every source answers the same question.
 */
export function matchesQuery(ev: { title?: string; description?: string; location?: string; attendees?: Attendee[] }, query: string): boolean {
  const terms = norm(query).split(/\s+/).filter(Boolean)
  if (terms.length === 0) return true
  const hay = [ev.title, ev.description, ev.location, ...(ev.attendees ?? []).flatMap((a) => [a.email, a.name])]
    .map(norm)
    .join(" \u0000 ")
  return terms.every((t) => hay.includes(t))
}

/**
 * One meeting usually appears several times — on your calendar, a shared one, and an Apple
 * Calendar mirror of the same Google account. Merge on iCalUID when we have it, else on
 * title + start minute. Attendee lists are unioned so a sparse copy cannot hide anyone.
 */
export function mergeEvents(events: FoundEvent[]): FoundEvent[] {
  const byKey = new Map<string, FoundEvent>()
  for (const ev of events) {
    const startMin = (() => {
      const t = Date.parse(ev.start)
      return Number.isFinite(t) ? String(Math.floor(t / 60000)) : norm(ev.start)
    })()
    // A recurring series shares ONE iCalUID across every instance, so the UID alone would fold a
    // weekly meeting into a single row (measured 2026-09-30: four Saddle Pass sprints became one).
    const key = ev.uid ? `uid:${ev.uid}|${startMin}` : `t:${norm(ev.title)}|${startMin}`
    const altKey = `t:${norm(ev.title)}|${startMin}`
    const existing = byKey.get(key) ?? byKey.get(altKey)
    if (!existing) {
      const copy = { ...ev, attendees: [...ev.attendees], seenIn: [...ev.seenIn] }
      byKey.set(key, copy)
      byKey.set(altKey, copy)
      continue
    }
    for (const s of ev.seenIn) if (!existing.seenIn.includes(s)) existing.seenIn.push(s)
    for (const a of ev.attendees) {
      const cur = existing.attendees.find((x) => x.email === a.email)
      if (!cur) existing.attendees.push({ ...a })
      else {
        if (!cur.name && a.name) cur.name = a.name
        if (!cur.response && a.response) cur.response = a.response
        if (a.organizer) cur.organizer = true
      }
    }
    if (!existing.uid && ev.uid) existing.uid = ev.uid
  }
  return [...new Set(byKey.values())].sort((a, b) => (Date.parse(a.start) || 0) - (Date.parse(b.start) || 0))
}

/** Every distinct attendee across the events, minus the user's own addresses. */
export function uniqueAttendees(events: FoundEvent[], selfEmails: string[] = []): Attendee[] {
  const self = new Set(selfEmails.map(norm))
  const out = new Map<string, Attendee>()
  for (const ev of events)
    for (const a of ev.attendees) {
      if (!a.email || self.has(a.email) || !a.email.includes("@")) continue
      const cur = out.get(a.email)
      if (!cur) out.set(a.email, { email: a.email, ...(a.name ? { name: a.name } : {}) })
      else if (!cur.name && a.name) cur.name = a.name
    }
  return [...out.values()]
}

/** Complete only if at least one source ran and none failed. Unsupported sources are not failures. */
export function isComplete(sources: SearchSource[]): boolean {
  return sources.some((s) => s.status === "ok") && !sources.some((s) => s.status === "failed")
}

// ── Apple Calendar (macOS, local) ────────────────────────────────────────────────────────────
//
// EventKit, compiled once and cached. Two routes were measured and rejected on 2026-09-30:
//  - Calendar.sqlitedb: behind Full Disk Access, private schema ("unable to open database file").
//  - AppleEvents to Calendar.app: a date-bounded `whose` over a real calendar set took >90s, and a
//    timed-out AppleEvent does NOT stop — Calendar sat at 61% CPU for minutes working through
//    requests nobody was waiting for, and every later request queued behind them (the same trap
//    comms-mail-applescript.ts documents for Mail). A search tool must not be able to wedge the
//    user's calendar app.
// EventKit queries an indexed store and expands recurrences. It never ASKS for access — a CLI
// search must not raise a dialog — it reports the authorization status and how to grant it.
export const EVENTKIT_READER_SWIFT = String.raw`import EventKit
import Foundation
let store = EKEventStore()
let status = EKEventStore.authorizationStatus(for: .event).rawValue
// 3 = fullAccess (macOS 14+) / authorized (older). 4 = writeOnly: can add events, cannot read them.
guard status == 3 else {
  print("{\"status\":\(status),\"calendars\":0,\"events\":[],\"errors\":[]}")
  exit(0)
}
let iso = ISO8601DateFormatter()
iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
let plain = ISO8601DateFormatter()
func parse(_ s: String) -> Date? { iso.date(from: s) ?? plain.date(from: s) }
guard CommandLine.arguments.count >= 3, let from = parse(CommandLine.arguments[1]), let to = parse(CommandLine.arguments[2]) else {
  FileHandle.standardError.write("usage: reader <fromISO> <toISO>\n".data(using: .utf8)!); exit(2)
}
let cals = store.calendars(for: .event)
var out: [[String: Any]] = []
for e in store.events(matching: store.predicateForEvents(withStart: from, end: to, calendars: nil)) {
  var att: [[String: String]] = []
  for a in e.attendees ?? [] { att.append(["email": a.url.absoluteString, "name": a.name ?? ""]) }
  if let o = e.organizer, !att.contains(where: { $0["email"] == o.url.absoluteString }) {
    att.insert(["email": o.url.absoluteString, "name": o.name ?? ""], at: 0)
  }
  out.append([
    "calendar": e.calendar?.title ?? "", "title": e.title ?? "",
    "start": plain.string(from: e.startDate), "end": plain.string(from: e.endDate),
    "location": e.location ?? "", "description": String((e.notes ?? "").prefix(2000)),
    "uid": e.calendarItemExternalIdentifier ?? "", "attendees": att,
  ])
}
let data = try! JSONSerialization.data(withJSONObject: ["status": status, "calendars": cals.count, "events": out, "errors": []])
print(String(data: data, encoding: .utf8)!)
`

/** Why an EventKit status code means we could not read, in words a person can act on. */
export function eventKitStatusReason(status: number): string | null {
  if (status === 3) return null
  const fix = "grant it in System Settings → Privacy & Security → Calendars → your terminal app → Full Access"
  if (status === 4) return `this terminal has write-only calendar access (it can add events, not read them) — ${fix}`
  if (status === 0) return `this terminal has never been granted calendar access — ${fix}`
  if (status === 2) return `calendar access was denied for this terminal — ${fix}`
  if (status === 1) return "calendar access is restricted on this Mac (device policy)"
  return `unknown calendar authorization status ${status}`
}

const run = (file: string, args: string[], timeoutMs: number) =>
  new Promise<{ err: any; stdout: string; stderr: string }>((resolve) =>
    execFile(file, args, { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) =>
      resolve({ err, stdout: String(stdout), stderr: String(stderr) }),
    ),
  )

/** Build (once) and return the path of the cached EventKit reader, or the reason it can't be built. */
async function eventKitReader(): Promise<{ ok: true; bin: string } | { ok: false; reason: string }> {
  const { homedir } = await import("node:os")
  const { join } = await import("node:path")
  const { existsSync, mkdirSync, writeFileSync } = await import("node:fs")
  const { createHash } = await import("node:crypto")
  const dir = join(homedir(), ".iris", "helpers")
  const tag = createHash("sha1").update(EVENTKIT_READER_SWIFT).digest("hex").slice(0, 10)
  const bin = join(dir, `calendar-reader-${tag}`)
  if (existsSync(bin)) return { ok: true, bin }
  // /usr/bin/swiftc is a shim that offers to install the developer tools (a dialog) when they are
  // missing, so check for them first instead of letting the shim ask.
  const dev = await run("xcode-select", ["-p"], 5000)
  if (dev.err) return { ok: false, reason: "needs Apple's command line tools to build the calendar reader — run: xcode-select --install" }
  mkdirSync(dir, { recursive: true })
  const src = join(dir, `calendar-reader-${tag}.swift`)
  writeFileSync(src, EVENTKIT_READER_SWIFT)
  const b = await run("swiftc", ["-O", "-o", bin, src], 180000)
  if (b.err) return { ok: false, reason: `could not build the calendar reader: ${(b.stderr || String(b.err.message)).replace(/\s+/g, " ").slice(0, 160)}` }
  return { ok: true, bin }
}

export async function readAppleCalendar(from: Date, to: Date, timeoutMs = 60000): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  const reader = await eventKitReader()
  if (!reader.ok) return reader
  const r = await run(reader.bin, [from.toISOString(), to.toISOString()], timeoutMs)
  if (r.err) return { ok: false, reason: (r.stderr || (r.err.killed ? "timed out" : "calendar reader failed")).replace(/\s+/g, " ").slice(0, 200) }
  try {
    const status = Number(JSON.parse(r.stdout).status ?? 3)
    const why = eventKitStatusReason(status)
    if (why) return { ok: false, reason: why }
  } catch {
    /* parse errors are reported by the caller */
  }
  return { ok: true, stdout: r.stdout }
}

/** Turn the local reader's output (Apple JXA or Windows PowerShell — same shape) into FoundEvents, applying the query. Pure — tested directly. */
export function parseAppleCalendar(stdout: string, query: string, label = "Apple Calendar"): { events: FoundEvent[]; calendars: number; errors: string[] } {
  const d = JSON.parse(stdout)
  const events: FoundEvent[] = []
  for (const e of d.events ?? []) {
    const attendees: Attendee[] = (e.attendees ?? [])
      .map((a: any) => ({ email: norm(String(a.email).replace(/^mailto:/i, "")), ...(a.name ? { name: a.name } : {}), ...(a.response ? { response: a.response } : {}) }))
      .filter((a: Attendee) => a.email.includes("@"))
    const ev = { title: e.title || "(no title)", description: e.description, location: e.location, attendees }
    if (!matchesQuery(ev, query)) continue
    events.push({
      title: ev.title,
      start: e.start ?? "",
      end: e.end,
      location: e.location || undefined,
      attendees,
      seenIn: [`${label} · ${e.calendar}`],
      uid: e.uid,
    })
  }
  return { events, calendars: Number(d.calendars ?? 0), errors: d.errors ?? [] }
}

// ── Outlook on Windows (local) ───────────────────────────────────────────────────────────────
//
// Outlook's COM object model through PowerShell. UNVERIFIED: written on macOS 2026-09-30 and not
// yet run on Windows — the epic carries that verdict until someone does.
export const WINDOWS_OUTLOOK_PS = String.raw`
param([string]$From, [string]$To)
$ErrorActionPreference = 'Stop'
$ol = New-Object -ComObject Outlook.Application
$ns = $ol.GetNamespace('MAPI')
$out = @{ calendars = 0; events = @(); errors = @() }
foreach ($store in $ns.Stores) {
  try {
    $folder = $store.GetDefaultFolder(9)  # olFolderCalendar
    $out.calendars++
    $items = $folder.Items
    $items.IncludeRecurrences = $true
    $items.Sort('[Start]')
    $f = "[Start] >= '" + ([datetime]$From).ToString('g') + "' AND [Start] <= '" + ([datetime]$To).ToString('g') + "'"
    foreach ($i in $items.Restrict($f)) {
      $att = @()
      foreach ($r in $i.Recipients) {
        $addr = $r.Address
        try { if ($r.AddressEntry.Type -eq 'EX') { $addr = $r.AddressEntry.GetExchangeUser().PrimarySmtpAddress } } catch {}
        $att += @{ email = $addr; name = $r.Name }
      }
      $out.events += @{ calendar = $store.DisplayName; title = $i.Subject; start = $i.Start.ToUniversalTime().ToString('o');
        end = $i.End.ToUniversalTime().ToString('o'); location = $i.Location; description = ([string]$i.Body).Substring(0, [Math]::Min(2000, ([string]$i.Body).Length));
        uid = $i.GlobalAppointmentID; attendees = $att }
    }
  } catch { $out.errors += ($store.DisplayName + ': ' + $_.Exception.Message) }
}
$out | ConvertTo-Json -Depth 6 -Compress
`

export function readWindowsOutlook(from: Date, to: Date, timeoutMs = 90000): Promise<{ ok: true; stdout: string } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `& { ${WINDOWS_OUTLOOK_PS} } -From '${from.toISOString()}' -To '${to.toISOString()}'`],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err) return resolve({ ok: false, reason: String(stderr || err.message).replace(/\s+/g, " ").trim().slice(0, 200) })
        resolve({ ok: true, stdout: String(stdout) })
      },
    )
  })
}

/** The local calendar app for this OS, or null with the reason there is none. */
export function localSource(platform: string = process.platform): { kind: "apple" | "windows-outlook"; name: string } | { kind: null; reason: string } {
  if (platform === "darwin") return { kind: "apple", name: "Apple Calendar (this Mac)" }
  if (platform === "win32") return { kind: "windows-outlook", name: "Outlook (this PC)" }
  return { kind: null, reason: `no local calendar reader for ${platform}` }
}

/** Run up to `limit` async jobs at once. */
export async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}
