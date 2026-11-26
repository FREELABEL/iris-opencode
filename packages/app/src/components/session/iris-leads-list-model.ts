/**
 * The Leads list as a seller scans it (#194364): stage, company and value on every row, and the
 * pipeline — each stage's count and value — above it. Pure, so it is tested without a DOM.
 */
import type { StatusTone } from "@opencode-ai/ui/status-badge"
import { STAGE_ORDER, stageKey } from "./iris-leads-tab-model"

/** A stage's semantic tone: New neutral → Contacted info → Qualified accent → Proposal warning → Won success; Lost critical. */
const TONES: [RegExp, StatusTone][] = [
  [/^(won|closed ?won|converted)/, "success"],
  [/^(lost|closed ?lost)/, "critical"],
  [/^(proposal|negotiation|in negotiation)/, "warning"],
  [/^(qualified|interested)/, "accent"],
  [/^(contacted|follow|responded|replied)/, "info"],
]
export function stageTone(status: string | null | undefined): StatusTone {
  const s = (status ?? "").trim().toLowerCase()
  return TONES.find(([re]) => re.test(s))?.[1] ?? "neutral"
}

/** "$40k", "$1.3M", "$950" — for the pipeline strip, where a row of full figures would not fit. */
export function compactMoney(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ""
  if (n >= 1_000_000) return `$${trim(n / 1_000_000)}M`
  if (n >= 1_000) return `$${trim(n / 1_000)}k`
  return `$${Math.round(n)}`
}
const trim = (x: number) => (x >= 100 ? String(Math.round(x)) : x.toFixed(1).replace(/\.0$/, ""))

/** The deal value as a number, or undefined when there is none (never 0 drawn as "$0"). */
export function valueOf(v: string | number | null | undefined): number | undefined {
  if (v == null || v === "") return undefined
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

export type PipelineStage = { status: string; tone: StatusTone; count: number; value?: number }

/**
 * One cell per stage, in pipeline order. Counts come from the server's stage counts when there are
 * any (they cover every lead, not just the page loaded); values only when every lead is loaded,
 * because a value summed over one page of many would be a smaller, wrong number.
 */
export function pipeline(
  rows: { status?: string | null; price_bid?: string | number | null }[],
  opts: { counts?: { status: string; count: number }[]; complete: boolean },
): PipelineStage[] {
  const by = new Map<string, PipelineStage>()
  const cell = (status: string) => {
    const k = stageKey(status)
    let c = by.get(k)
    if (!c) by.set(k, (c = { status, tone: stageTone(status), count: 0 }))
    return c
  }
  const counted = !!opts.counts?.length
  for (const s of opts.counts ?? []) cell(s.status).count += s.count
  for (const r of rows) {
    if (!r.status) continue
    const c = cell(r.status)
    if (!counted) c.count++
    const v = valueOf(r.price_bid)
    if (opts.complete && v) c.value = (c.value ?? 0) + v
  }
  const at = (s: string) => {
    const i = STAGE_ORDER.findIndex((x) => stageKey(x) === stageKey(s))
    return i < 0 ? STAGE_ORDER.length : i
  }
  return [...by.values()]
    .filter((c) => c.count > 0)
    .sort((a, b) => at(a.status) - at(b.status) || a.status.localeCompare(b.status))
}

/** The line over the strip: how many leads, and the value still open (not Won, not Lost). */
export function pipelineTotal(stages: PipelineStage[]): { count: number; open?: number } {
  const count = stages.reduce((t, s) => t + s.count, 0)
  const valued = stages.filter((s) => s.value !== undefined)
  if (!valued.length) return { count }
  const open = valued
    .filter((s) => s.tone !== "success" && s.tone !== "critical")
    .reduce((t, s) => t + (s.value ?? 0), 0)
  return { count, open }
}
