/**
 * The checker's eyes — what is ON the phone's screen, read independently of whoever put it there.
 *
 * WHY THIS IS SEPARATE FROM THE ACTOR (#191798). ARTEMIS's pro profile verifies the TARGET of each
 * action — that it is about to tap the button it meant to. Nothing verified the CONTENT: that the
 * date it typed is the date the task asked for. An agent that typed Nov 14 believing it typed
 * Nov 4 will also read its own screen as Nov 4, so the agent that acted can never be the one that
 * grades the act. This module reads the accessibility tree that `uiautomator dump` produces and
 * compares it against values the TASK declared before anything ran.
 *
 * Pure: no adb, no files. platform-android.ts fetches the XML and turns a verdict into an act.
 */

export interface UiNode {
  text: string
  desc: string
  id: string
  cls: string
  clickable: boolean
  enabled: boolean
  bounds: { x1: number; y1: number; x2: number; y2: number } | null
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, "&")

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}="([^"]*)"`))
  return m ? decodeXml(m[1]) : ""
}

/** Parse `uiautomator dump` XML. Tolerant of the "UI hierchary dumped to" trailer adb appends. */
export function parseUiDump(xml: string): UiNode[] {
  const nodes: UiNode[] = []
  for (const m of String(xml ?? "").matchAll(/<node\b[^>]*>/g)) {
    const tag = m[0]
    const b = attr(tag, "bounds").match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/)
    nodes.push({
      text: attr(tag, "text"),
      desc: attr(tag, "content-desc"),
      id: attr(tag, "resource-id"),
      cls: attr(tag, "class"),
      clickable: attr(tag, "clickable") === "true",
      enabled: attr(tag, "enabled") !== "false",
      bounds: b ? { x1: +b[1], y1: +b[2], x2: +b[3], y2: +b[4] } : null,
    })
  }
  return nodes
}

/** Every visible string on the screen, one per line — what a person reading it would see. */
export function screenText(nodes: UiNode[]): string {
  return nodes
    .flatMap((n) => [n.text, n.desc])
    .map((s) => s.trim())
    .filter(Boolean)
    .join("\n")
}

// ─────────────────────────────── send-class targets ───────────────────────────────

/**
 * A send-class act is one that cannot be taken back: it leaves the phone. Matched on the WHOLE
 * label, not a substring — "Send feedback" in a menu and "Resend code" are not the commit button,
 * and a substring rule would have the checker gate (and then tap) the wrong thing.
 */
export const SEND_LABEL = /^(send|submit|confirm|pay|pay now|post|book|book now|place order|done|save|reschedule|schedule|transfer|buy|buy now|publish|reply)$/i

export function isSendLabel(label: string): boolean {
  return SEND_LABEL.test(String(label ?? "").trim())
}

/** Clickable, enabled nodes whose label is a send verb. More than one is ambiguous — see the batch. */
export function findSendTargets(nodes: UiNode[]): UiNode[] {
  // A label often sits on a non-clickable TextView inside a clickable parent. The dump is a
  // pre-order walk, so attribute the label to the nearest clickable node whose bounds contain it.
  const out: UiNode[] = []
  for (const n of nodes) {
    const label = (n.text || n.desc).trim()
    if (!isSendLabel(label) || !n.enabled || !n.bounds) continue
    const target = n.clickable ? n : nodes.find((p) => p.clickable && p.enabled && p.bounds && contains(p.bounds, n.bounds!))
    if (target && !out.includes(target)) out.push({ ...target, text: target.text || label })
  }
  return out
}

const contains = (o: NonNullable<UiNode["bounds"]>, i: NonNullable<UiNode["bounds"]>) =>
  o.x1 <= i.x1 && o.y1 <= i.y1 && o.x2 >= i.x2 && o.y2 >= i.y2

export function centerOf(n: UiNode): [number, number] | null {
  if (!n.bounds) return null
  return [Math.round((n.bounds.x1 + n.bounds.x2) / 2), Math.round((n.bounds.y1 + n.bounds.y2) / 2)]
}

// ─────────────────────────────── dates and times ───────────────────────────────

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/
const HHMM = /^([01]?\d|2[0-3]):[0-5]\d$/

const pad = (n: number) => String(n).padStart(2, "0")
const iso = (y: number, m: number, d: number) => (m >= 1 && m <= 12 && d >= 1 && d <= 31 ? `${y}-${pad(m)}-${pad(d)}` : null)
const monthIndex = (word: string) => {
  const i = MONTHS.indexOf(word.slice(0, 3).toLowerCase())
  return i >= 0 ? i + 1 : 0
}
const fullYear = (y: string | undefined, fallback: number) => (!y ? fallback : y.length === 2 ? 2000 + Number(y) : Number(y))

/**
 * Every date on the screen, as ISO. A date shown without a year ("Tue, Nov 4") takes `year`, which
 * is the EXPECTED date's year: apps routinely drop the year, and refusing those would make the
 * checker refuse every booking screen ever built. US M/D order for slashes — the order a US phone
 * renders; a day-first locale is an open question recorded on #191798, not guessed at here.
 */
export function datesOnScreen(text: string, year: number): string[] {
  const found = new Set<string>()
  const add = (v: string | null) => v && found.add(v)
  const t = String(text ?? "")
  for (const m of t.matchAll(/\b(\d{4})-(\d{1,2})-(\d{1,2})\b/g)) add(iso(+m[1], +m[2], +m[3]))
  for (const m of t.matchAll(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g)) add(iso(fullYear(m[3], year), +m[1], +m[2]))
  const mon = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?"
  for (const m of t.matchAll(new RegExp(`\\b${mon}\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "gi")))
    add(iso(fullYear(m[3], year), monthIndex(m[1]), +m[2]))
  for (const m of t.matchAll(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+${mon}(?:,?\\s+(\\d{4}))?\\b`, "gi")))
    add(iso(fullYear(m[3], year), monthIndex(m[2]), +m[1]))
  return [...found]
}

/** Every clock time on the screen, as 24h HH:MM. "2 PM", "2:00pm" and "14:00" are one time. */
export function timesOnScreen(text: string): string[] {
  const found = new Set<string>()
  // Each pass CONSUMES what it matched. Without that, "2:00 PM" is also read by the bare-hour pass
  // as "00 PM" — a phantom 12:00 on screen, which would let a task expecting noon pass on a 2pm
  // booking. Found by the test, not in review.
  let t = String(text ?? "")
  const take = (re: RegExp, fn: (m: RegExpMatchArray) => string | null) => {
    t = t.replace(re, (...args) => {
      const v = fn(args.slice(0, -2) as unknown as RegExpMatchArray)
      if (v) found.add(v)
      return " "
    })
  }
  take(/\b(\d{1,2}):(\d{2})\s*([ap])\.?\s?m\b\.?/gi, (m) => (+m[1] >= 1 && +m[1] <= 12 && +m[2] < 60 ? to24(+m[1], +m[2], m[3]) : null))
  take(/\b(\d{1,2})\s*([ap])\.?\s?m\b\.?/gi, (m) => (+m[1] >= 1 && +m[1] <= 12 ? to24(+m[1], 0, m[2]) : null))
  take(/\b(\d{1,2}):(\d{2})\b/g, (m) => (+m[1] < 24 && +m[2] < 60 ? `${pad(+m[1])}:${m[2]}` : null))
  return [...found]
}

function to24(h: number, min: number, ap: string): string {
  const pm = ap.toLowerCase() === "p"
  const hh = h % 12 + (pm ? 12 : 0)
  return `${pad(hh)}:${pad(min)}`
}

// ─────────────────────────────── the verdict ───────────────────────────────

export interface Mismatch {
  key: string
  expected: string
  /** What the screen showed instead, when the value is a kind we can read (a date, a time). */
  seen: string[]
}

export interface CheckResult {
  ok: boolean
  checked: number
  mismatches: Mismatch[]
}

/** A plain value must appear as a whole token: 85.03 must not be satisfied by $185.03. */
function tokenPresent(haystack: string, needle: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, " ")
  const h = norm(haystack)
  const n = norm(needle).trim()
  if (!n) return false
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  return new RegExp(`(^|[^a-z0-9.])${esc}($|[^a-z0-9]|\\.(?![0-9]))`, "i").test(h)
}

/**
 * Does the screen show what the task said it would? Every expected value must be present. The key
 * is a label for the report; the VALUE's shape decides how it is read — an ISO date is compared as
 * a date in whatever form the app renders it, HH:MM as a time, anything else as a whole token.
 */
export function checkExpect(nodes: UiNode[], expect: Record<string, unknown>): CheckResult {
  const text = screenText(nodes)
  const mismatches: Mismatch[] = []
  const entries = Object.entries(expect ?? {})
  for (const [key, raw] of entries) {
    const expected = String(raw ?? "").trim()
    if (ISO_DATE.test(expected)) {
      const seen = datesOnScreen(text, Number(expected.slice(0, 4)))
      if (!seen.includes(expected)) mismatches.push({ key, expected, seen })
    } else if (HHMM.test(expected)) {
      const want = `${pad(Number(expected.split(":")[0]))}:${expected.split(":")[1]}`
      const seen = timesOnScreen(text)
      if (!seen.includes(want)) mismatches.push({ key, expected: want, seen })
    } else if (!tokenPresent(text, expected)) {
      mismatches.push({ key, expected, seen: [] })
    }
  }
  return { ok: entries.length > 0 && mismatches.length === 0, checked: entries.length, mismatches }
}
