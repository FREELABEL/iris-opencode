/**
 * Pulse (#189286) — what the panel shows for each stop, decided without a DOM.
 * Design: heyiris.io/p/pulse-panel-directions, pick 01 "the route".
 *
 * The one rule every function here keeps: a stop that could not look is SHUT, and a shut stop
 * has no number. Not 0, not a dash that reads as zero next to real zeros — the word "shut".
 */

export type Provenance = "measured" | "partial" | "not-kept" | "not-measured"

export type PulseStop = {
  id: string
  label: string
  from?: string
  shut: boolean
  reason: string | null
  provenance: Provenance
  count: number | null
  floor: boolean
  delta: number | null
  text: string
  owed: number
  fix?: { label: string; command?: string }
  items: Array<{ when?: string; where: string; text?: string }>
}

export type TopicSummary = {
  hits: number
  floor: boolean
  withHits: number
  reachable: number
  total: number
  shut: number
  prior: number | null
  lastTouched: number | null
}

export type TopicPulse = { keyword: string; days: number; repo: string; ms: number; summary: TopicSummary; stops: PulseStop[] }

export type ContactRow = { id: number; name: string; company: string | null; status: string | null; email: string | null }

export type ContactPulse = {
  lead: ContactRow
  days: number
  ms: number
  score: { score: number | null; band: string | null; previous: number | null; history: Array<{ at: string; score: number }>; coverage: number | null }
  stops: PulseStop[]
  owed: Array<{ what: string; amount?: string; since?: string }>
  channels: { read: number; total: number }
}

export const PROVENANCE_WORD: Record<Provenance, string> = {
  measured: "measured",
  partial: "partial — some of it could not be read, or the count stopped at a ceiling",
  "not-kept": "not kept — the source does not record it as of now",
  "not-measured": "not measured — shown as shut, never as 0",
}

/** The tally on the right of a stop: the main figure and, when there is one, the change. */
export function tallyOf(s: PulseStop): { main: string; delta: string | null; tone: "shut" | "none" | "count" | "money" | "wait" } {
  if (s.shut) return { main: "shut", delta: null, tone: "shut" }
  if (s.count === null) return { main: "—", delta: null, tone: "none" }
  const main = s.id === "deal" ? money(s.count) : `${s.count.toLocaleString("en-US")}${s.floor ? "+" : ""}`
  const delta = s.delta ? `${s.delta > 0 ? "+" : "−"}${Math.abs(s.delta).toLocaleString("en-US")}` : null
  const tone = s.id === "deal" ? (s.owed ? "wait" : "money") : s.count === 0 ? "none" : "count"
  return { main, delta, tone }
}

export function money(n: number): string {
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`
}

/** The pin on the left of a stop: its place on the route, or × when it could not get in. */
export function pinsOf(stops: PulseStop[]): string[] {
  let n = 0
  return stops.map((s) => (s.shut ? "×" : String(++n)))
}

/** "101 hits at 3 of 5 reachable stops" — the floor and the shut stops stay in the sentence. */
export function topicLine(s: TopicSummary): string {
  const p = topicParts(s)
  return `${p.hits} ${p.rest}`
}

/** The same sentence split so the number can be set in the data face and the words in the body face. */
export function topicParts(s: TopicSummary): { hits: string; rest: string } {
  return {
    hits: `${s.hits.toLocaleString("en-US")}${s.floor ? "+" : ""}`,
    rest: `hit${s.hits === 1 ? "" : "s"} at ${s.withHits} of ${s.reachable} reachable stop${s.reachable === 1 ? "" : "s"}`,
  }
}

/** "101 vs 56 the 30 days before", or why there is no comparison. */
export function priorLine(s: TopicSummary, days: number): { text: string; tone: "up" | "down" | "flat" | "none" } {
  if (s.prior === null) return { text: "no earlier window to compare — a stop could not rebuild it", tone: "none" }
  const tone = s.hits > s.prior ? "up" : s.hits < s.prior ? "down" : "flat"
  return { text: `${s.hits.toLocaleString("en-US")} vs ${s.prior.toLocaleString("en-US")} the ${days} days before`, tone }
}

export function touchedLine(at: number | null, now: number): string {
  if (!at) return "not touched in the window"
  const d = Math.floor((now - at) / 86_400_000)
  if (d <= 0) return "today"
  if (d === 1) return "yesterday"
  return d < 14 ? `${d} days ago` : `${Math.floor(d / 7)} weeks ago`
}

const BAND_WORD: Record<string, string> = { healthy: "healthy", at_risk: "at risk", failing: "failing", critical: "critical" }
export function bandWord(band: string | null): string {
  if (!band) return "no score yet"
  return BAND_WORD[band] ?? band.replace(/_/g, " ")
}

/** "30 runs in 21 days" — how much history the sparkline is drawn from. */
export function runsLine(history: Array<{ at: string; score: number }>): string | null {
  if (history.length < 2) return null
  const ts = history.map((h) => Date.parse(h.at.replace(" ", "T"))).filter(Number.isFinite)
  if (ts.length < 2) return `${history.length} runs`
  const days = Math.max(1, Math.round((Math.max(...ts) - Math.min(...ts)) / 86_400_000))
  return `${history.length} runs in ${days} day${days === 1 ? "" : "s"}`
}

/** Bar heights (px) for the score trend, oldest to newest, last 12 runs. */
export function sparkOf(history: Array<{ score: number }>, max = 16, min = 3): number[] {
  const xs = history.slice(-12).map((h) => h.score)
  if (!xs.length) return []
  const lo = Math.min(...xs)
  const hi = Math.max(...xs)
  return xs.map((x) => (hi === lo ? Math.round((max + min) / 2) : Math.round(min + ((x - lo) / (hi - lo)) * (max - min))))
}

/** "partial read — 4 of 5 channels blind", or null when every channel was read. */
export function blindLine(c: { read: number; total: number }): string | null {
  const blind = c.total - c.read
  if (blind <= 0) return null
  return `partial read — ${blind} of ${c.total} channel${c.total === 1 ? "" : "s"} blind`
}

export function whenOf(iso: string | undefined, now: number): string {
  if (!iso) return ""
  const t = Date.parse(iso.replace(" ", "T"))
  if (!Number.isFinite(t)) return ""
  const d = Math.floor((now - t) / 86_400_000)
  if (d < 0) return new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
  if (d === 0) return `today ${new Date(t).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`
  if (d === 1) return "yesterday"
  return d < 14 ? `${d} days ago` : new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" })
}
