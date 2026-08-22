/**
 * Pure logic behind `iris mint` — no network, no CLI, no clock beyond what is
 * passed in. Split out so it can be tested, because every bug this file has had
 * was in exactly this kind of code and none of it was reachable by a test:
 *
 *   · toISOString() filed a 22:43 CDT purchase as TOMORROW, and a Saturday-night
 *     one into NEXT WEEK's budget window.
 *   · amounts were rounded to cents PER ROW then summed, so hundreds of sub-cent
 *     usage lines each rounded to zero and the total came up short.
 *   · --min-amount filtered BEFORE the daily rollup, deleting rows from the very
 *     buckets they belonged in.
 *
 * See mint-core.test.ts — each of those has a regression test now.
 */

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`
}

export function today(): string {
  return ymd(new Date())
}

/**
 * Period window as [from, to] ISO dates, inclusive.
 * Weekly starts SUNDAY — the Sunday shop/plan ritual the grocery budget is built
 * around. A Monday-start week would split every bulk run across two budgets.
 */
export function periodWindow(period: string, ref = new Date()): [string, string] {
  // Seed from the LOCAL calendar date, then do the arithmetic in UTC space so DST
  // shifts cannot move a boundary by a day.
  const d = new Date(Date.UTC(ref.getFullYear(), ref.getMonth(), ref.getDate()))
  const iso = (x: Date) => x.toISOString().slice(0, 10)
  if (period === "weekly") {
    const start = new Date(d)
    start.setUTCDate(d.getUTCDate() - d.getUTCDay())
    const end = new Date(start)
    end.setUTCDate(start.getUTCDate() + 6)
    return [iso(start), iso(end)]
  }
  if (period === "yearly") {
    return [iso(new Date(Date.UTC(d.getUTCFullYear(), 0, 1))), iso(new Date(Date.UTC(d.getUTCFullYear(), 11, 31)))]
  }
  // monthly (default)
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1))
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0))
  return [iso(start), iso(end)]
}

export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = [],
    field = "",
    inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += c
    } else if (c === '"') inQuotes = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n") {
      row.push(field)
      rows.push(row)
      row = []
      field = ""
    } else if (c !== "\r") field += c
  }
  if (field.length || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows.filter((r) => r.some((x) => x.trim() !== ""))
}

/** Header names real exports actually use, best match first. */
export const DATE_COLS = [
  "transaction date",
  "posting date",
  "post date",
  "posted date",
  "start_time_iso",
  "date",
  "trans date",
]
export const AMT_COLS = ["amount", "amount_value", "debit", "withdrawal", "value"]
export const DESC_COLS = ["description", "details", "line_item", "memo", "payee", "name", "merchant", "narrative"]

export function pickCol(headers: string[], candidates: string[], override?: string): number {
  const lower = headers.map((h) => h.trim().toLowerCase())
  if (override) {
    const i = lower.indexOf(override.trim().toLowerCase())
    return i
  }
  for (const c of candidates) {
    const i = lower.indexOf(c)
    if (i >= 0) return i
  }
  for (const c of candidates) {
    const i = lower.findIndex((h) => h.includes(c))
    if (i >= 0) return i
  }
  return -1
}

export function normalizeDate(raw: string): string | null {
  const v = (raw ?? "").trim()
  if (!v) return null
  let m = v.match(/^(\d{4})-(\d{2})-(\d{2})/) // ISO / ISO datetime
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = v.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/) // US M/D/YYYY
  if (m) return `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`
  const d = new Date(v)
  return isNaN(d.getTime()) ? null : ymd(d)
}

/**
 * "$1,234.56" · "(12.34)" negative · "0E-6176" scientific → DOLLARS, full precision.
 * Deliberately NOT cents: a usage export is full of sub-cent line items, and
 * rounding each to cents before summing rounds hundreds of them to zero.
 * Round once, at the row that actually gets written.
 */
export function parseAmountDollars(raw: string): number | null {
  let v = (raw ?? "").trim()
  if (!v) return null
  let neg = false
  if (/^\(.*\)$/.test(v)) {
    neg = true
    v = v.slice(1, -1)
  }
  v = v.replace(/[$,\s]/g, "")
  if (v.startsWith("-")) {
    neg = true
    v = v.slice(1)
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return n * (neg ? -1 : 1)
}

/**
 * Dedup key. Re-importing the same statement must be a no-op — that is the whole
 * reason to prefer statement upload over a bank feed. atlas_transactions has no
 * external_id, so the fingerprint rides in metadata and is compared on read.
 */
export function fingerprint(date: string, cents: number, desc: string): string {
  return `${date}|${cents}|${desc.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 60)}`
}

export function centsOf(i: { amount: number }): number {
  return Math.round(i.amount * 100)
}

export function verifyAgainstSource(
  ex: any,
  haystack: string,
): { ok: boolean; reason?: string; amount?: number; date?: string } {
  const amountRaw = String(ex?.amount ?? "").trim()
  if (!amountRaw) return { ok: false, reason: "no amount extracted" }
  const bare = amountRaw.replace(/[$,\s]/g, "")
  if (!/^\d+(\.\d{1,2})?$/.test(bare)) return { ok: false, reason: `amount not numeric: "${amountRaw}"` }
  // Literal presence — with and without thousands separators.
  const withCommas = Number(bare).toLocaleString("en-US", { minimumFractionDigits: 2 })
  const hay = haystack.replace(/\s+/g, " ")
  if (!hay.includes(bare) && !hay.includes(withCommas))
    return { ok: false, reason: `amount ${bare} not found in email body` }
  const date = normalizeDate(String(ex?.date ?? ""))
  if (!date) return { ok: false, reason: "no usable date" }
  const amount = Number(bare)
  if (!(amount > 0)) return { ok: false, reason: "amount is zero" }
  return { ok: true, amount, date }
}

/**
 * Apple Mail is SENDER-anchored — the bridge requires `from`, and `subject` can
 * only narrow within a sender. So the local rail sweeps a list of sender terms
 * rather than one subject query. That is a real coverage limit, not a preference:
 * a receipt from a merchant not in this list is not seen.
 */
export const DEFAULT_SENDERS = [
  "receipt",
  "receipts",
  "billing",
  "invoice",
  "no-reply",
  "noreply",
  "orders",
  "order",
  "payment",
  "payments",
  "stripe",
  "amazon",
  "apple",
  "google",
  "openai",
  "anthropic",
  "uber",
  "doordash",
  "instacart",
  "spotify",
]

export function sparkline(values: number[]): string {
  if (values.length === 0) return ""
  const blocks = "▁▂▃▄▅▆▇█"
  const max = Math.max(...values),
    min = Math.min(...values)
  const span = max - min || 1
  return values.map((v) => blocks[Math.min(7, Math.floor(((v - min) / span) * 7))]).join("")
}

// ── reconciliation ───────────────────────────────────────────────────────────

export type ReconInput = {
  /** What a snapshot/report CLAIMS was spent, in cents. */
  claimed_cents: number
  /** The individual ledger rows that claim is supposedly built from. */
  rows: { amount_cents: number; scope?: string; category?: string; date: string }[]
  scope: string
  category?: string
  from: string
  to: string
}

export type ReconResult = {
  ok: boolean
  claimed_cents: number
  actual_cents: number
  drift_cents: number
  counted: number
  excluded: { reason: string; count: number; cents: number }[]
}

/**
 * Does a reported figure actually tie to the rows behind it?
 *
 * This is the difference between a number and a number you can defend. The whole
 * audit story is worthless if `mint status` says $305.99 and nobody can show
 * which rows sum to it — and every exclusion (wrong scope, wrong window, wrong
 * category) is itemised rather than silently dropped, because "the total is off
 * by $12" is useless next to "these two rows are outside the window".
 *
 * Pure and total: no clock, no network, no partial results.
 */
export function reconcile(input: ReconInput): ReconResult {
  const buckets = new Map<string, { count: number; cents: number }>()
  const note = (reason: string, cents: number) => {
    const b = buckets.get(reason) ?? { count: 0, cents: 0 }
    b.count++
    b.cents += cents
    buckets.set(reason, b)
  }

  let actual = 0,
    counted = 0
  for (const r of input.rows) {
    const cents = Number(r.amount_cents) || 0
    // Untagged rows belong to NO scope. Counting them here would reintroduce the
    // exact bug the strict matching in mint was written to prevent.
    if (!r.scope) {
      note("no scope tag", cents)
      continue
    }
    if (r.scope !== input.scope) {
      note(`scope=${r.scope}`, cents)
      continue
    }
    if (input.category && String(r.category ?? "").toLowerCase() !== input.category.toLowerCase()) {
      note(`category=${r.category || "(none)"}`, cents)
      continue
    }
    const d = String(r.date).slice(0, 10)
    if (d < input.from || d > input.to) {
      note("outside window", cents)
      continue
    }
    actual += cents
    counted++
  }

  const excluded = [...buckets.entries()]
    .map(([reason, b]) => ({ reason, count: b.count, cents: b.cents }))
    .sort((a, b) => b.cents - a.cents)

  return {
    ok: actual === input.claimed_cents,
    claimed_cents: input.claimed_cents,
    actual_cents: actual,
    drift_cents: actual - input.claimed_cents,
    counted,
    excluded,
  }
}
