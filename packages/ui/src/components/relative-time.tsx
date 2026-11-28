import { createSignal, splitProps, type ComponentProps } from "solid-js"

/**
 * ONE way to say when something happened.
 *
 *   just now · 5m ago · 3h ago · yesterday · 4d ago · Nov 3 · Nov 3, 2025
 *   in 5m · in 3h · tomorrow · in 4d                                (the future)
 *
 * The exact date and time is always one hover away: `<RelativeTime>` puts it in the `title`, and
 * `absoluteTime()` gives the same words for anywhere else. Never show a raw ISO timestamp.
 *
 * Pure and deterministic: pass `now` (ms) and, in tests, a `locale`. An empty or unreadable value
 * is "" — the caller decides what an unknown time reads as ("never", "—"), not this.
 */
export type TimeInput = string | number | Date | null | undefined

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export function toTime(input: TimeInput): number | undefined {
  if (input === null || input === undefined || input === "") return undefined
  const t = input instanceof Date ? input.getTime() : typeof input === "number" ? input : Date.parse(input)
  return Number.isFinite(t) ? t : undefined
}

/** Whole calendar days from `a` to `b` in local time (b later → positive). */
function calendarDays(a: number, b: number): number {
  const da = new Date(a)
  const db = new Date(b)
  const ua = Date.UTC(da.getFullYear(), da.getMonth(), da.getDate())
  const ub = Date.UTC(db.getFullYear(), db.getMonth(), db.getDate())
  return Math.round((ub - ua) / DAY)
}

/** "Nov 3", or "Nov 3, 2025" when it is not this year. */
export function shortDate(input: TimeInput, opts: { now?: number; locale?: string } = {}): string {
  const t = toTime(input)
  if (t === undefined) return ""
  const now = opts.now ?? Date.now()
  const sameYear = new Date(t).getFullYear() === new Date(now).getFullYear()
  return new Date(t).toLocaleDateString(opts.locale, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

/** The words, so an app can pass its translations. English by default. */
export interface RelativeWords {
  justNow: string
  minutesAgo: (n: number) => string
  hoursAgo: (n: number) => string
  yesterday: string
  daysAgo: (n: number) => string
  inMinutes: (n: number) => string
  inHours: (n: number) => string
  tomorrow: string
  inDays: (n: number) => string
}

export const ENGLISH_RELATIVE_WORDS: RelativeWords = {
  justNow: "just now",
  minutesAgo: (n) => `${n}m ago`,
  hoursAgo: (n) => `${n}h ago`,
  yesterday: "yesterday",
  daysAgo: (n) => `${n}d ago`,
  inMinutes: (n) => `in ${n}m`,
  inHours: (n) => `in ${n}h`,
  tomorrow: "tomorrow",
  inDays: (n) => `in ${n}d`,
}

export function relativeTime(
  input: TimeInput,
  now: number = Date.now(),
  opts: { locale?: string; words?: Partial<RelativeWords> } = {},
): string {
  const t = toTime(input)
  if (t === undefined) return ""
  const w = opts.words ? { ...ENGLISH_RELATIVE_WORDS, ...opts.words } : ENGLISH_RELATIVE_WORDS
  const diff = now - t
  const abs = Math.abs(diff)
  if (abs < MINUTE) return w.justNow
  const future = diff < 0
  if (abs < HOUR) {
    const m = Math.floor(abs / MINUTE)
    return future ? w.inMinutes(m) : w.minutesAgo(m)
  }
  if (abs < DAY) {
    const h = Math.floor(abs / HOUR)
    return future ? w.inHours(h) : w.hoursAgo(h)
  }
  const days = Math.abs(calendarDays(t, now))
  if (days <= 1) return future ? w.tomorrow : w.yesterday
  if (days < 7) return future ? w.inDays(days) : w.daysAgo(days)
  return shortDate(t, { now, locale: opts.locale })
}

/** "Nov 3, 2026, 4:05 PM" — the words for a hover, a tooltip, or a detail view's "Exact time". */
export function absoluteTime(input: TimeInput, opts: { locale?: string } = {}): string {
  const t = toTime(input)
  if (t === undefined) return ""
  return new Date(t).toLocaleString(opts.locale, { dateStyle: "medium", timeStyle: "short" })
}

/** An ISO timestamp as platforms send it: 2026-11-03, 2026-11-03T16:05:00Z, …+02:00. */
const ISO_TIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

export function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && ISO_TIME.test(value.trim()) && Number.isFinite(Date.parse(value))
}

/** "5m ago (Nov 3, 2026, 4:05 PM)" — for a detail field or plain text where there is no hover. */
export function timeWithExact(input: TimeInput, now: number = Date.now(), opts: { locale?: string } = {}): string {
  const rel = relativeTime(input, now, opts)
  return rel ? `${rel} (${absoluteTime(input, opts)})` : ""
}

// One clock for every <RelativeTime> on screen: it moves once a minute, so "just now" becomes
// "1m ago" without each row running its own timer.
const [clock, setClock] = createSignal(Date.now())
let ticking = false
function tick() {
  if (ticking || typeof window === "undefined") return
  ticking = true
  setInterval(() => setClock(Date.now()), MINUTE)
}

export interface RelativeTimeProps extends Omit<ComponentProps<"time">, "children"> {
  value: TimeInput
  /** Fix the clock (tests, a frozen screenshot). Defaults to a shared once-a-minute clock. */
  now?: number
  /** What to show when there is no time. Default: nothing is rendered. */
  fallback?: string
}

/** `<time datetime title>` with the relative words inside and the exact time on hover. */
export function RelativeTime(props: RelativeTimeProps) {
  const [split, rest] = splitProps(props, ["value", "now", "fallback"])
  tick()
  const t = () => toTime(split.value)
  const text = () => (t() === undefined ? (split.fallback ?? "") : relativeTime(t(), split.now ?? clock()))
  return (
    <time
      {...rest}
      data-component="relative-time"
      dateTime={t() === undefined ? undefined : new Date(t()!).toISOString()}
      title={t() === undefined ? undefined : absoluteTime(t())}
    >
      {text()}
    </time>
  )
}
