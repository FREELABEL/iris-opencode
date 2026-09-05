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

/**
 * A dedup key that does NOT include the amount — unlike `fingerprint`.
 *
 * `fingerprint` breaks the moment the same external fact is reported twice with
 * a different amount (#182038): an ad platform's daily spend stat is often
 * partial when it first syncs and revised once the day finalizes, so the same
 * logical row (same platform, account, campaign, date) hashes to two different
 * fingerprints and gets inserted twice instead of corrected once. `sourceRef`
 * is built from caller-supplied stable identity instead, so the same logical
 * row keeps the same key across amount revisions — see `classifySync`.
 */
export function sourceRef(parts: (string | number | null | undefined)[]): string {
  return parts
    .map((p) => String(p ?? "").trim())
    .filter(Boolean)
    .join("|")
}

/**
 * What a re-sync against a `source_ref` means, given what is already on file.
 *
 * Pure so the three-way branch is testable without a network: no existing row
 * is a plain insert, the same amount is a no-op re-sync, and a DIFFERENT amount
 * is a correction to the existing row — not a second transaction. That last
 * case is the whole fix for #182038: a platform's stats finalizing during the
 * day must update the one row that fact belongs to, not multiply it.
 */
export function classifySync(existingCents: number | undefined, newCents: number): "fresh" | "duplicate" | "correction" {
  if (existingCents == null) return "fresh"
  return existingCents === newCents ? "duplicate" : "correction"
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
    return { ok: false, reason: `amount ${bare} not found in source text` }
  const date = normalizeDate(String(ex?.date ?? ""))
  if (!date) return { ok: false, reason: "no usable date" }
  const amount = Number(bare)
  if (!(amount > 0)) return { ok: false, reason: "amount is zero" }
  return { ok: true, amount, date }
}

/**
 * WHAT THE DOCUMENT RAIL WILL READ, and how it decides.
 *
 * A PDF with a text layer is read as TEXT, never photographed into a vision
 * model. The text layer is the document's own account of itself: it is free,
 * exact, and cannot misread its own glyphs. Vision is the fallback for pixels,
 * not the default for documents — sending a digital invoice through OCR is a
 * worse answer at a higher price.
 *
 * Anything not listed here returns null and is REFUSED BY NAME rather than
 * skipped. A folder where three of twelve files quietly did not count is
 * indistinguishable from one where all twelve were read.
 */
export const BILL_IMAGE_MIME: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".heic": "image/heic",
}

export type BillKind = "image" | "pdf" | "text"

export function billKind(filePath: string): BillKind | null {
  const ext = (String(filePath).match(/\.[^./\\]+$/)?.[0] ?? "").toLowerCase()
  if (ext in BILL_IMAGE_MIME) return "image"
  if (ext === ".pdf") return "pdf"
  if (ext === ".txt" || ext === ".md") return "text"
  return null
}

/**
 * Is a transcript worth sending to the extractor at all?
 *
 * An OCR call that returns three characters has failed, but it fails as a
 * SUCCESS: a non-empty string, an extractor that finds no amount, and a
 * quarantine line reading "no amount extracted" — which describes the receipt
 * rather than the instrument, and points the reader at the wrong thing. The
 * floor is deliberately low; it is here to separate "read nothing" from "read a
 * receipt with no total", not to judge quality.
 */
export function transcriptIsUsable(text: string): boolean {
  return String(text ?? "").replace(/\s+/g, "").length >= 24
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
  rows: { amount_cents: number; scope?: string; category?: string; date: string; superseded_by_split?: boolean }[]
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
    // A split parent (#182035) is replaced by its children, not summed alongside
    // them — counting it here double-books the original invoice on top of every
    // campaign it was split into.
    if (r.superseded_by_split) {
      note("superseded by split", cents)
      continue
    }
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

// =============================================================================
// Spending groups (#181985) and spend policy (#181986).
//
// Both are pure functions over plain records so they can be tested without a
// network. The bugs these guard against are the same family as the ones above:
// a rule that silently does not apply is indistinguishable from a rule that
// passed, and that is exactly how $18 of household spend became invisible.
// =============================================================================

export type BudgetLike = {
  name?: string
  category?: string
  group?: string
  scope?: string
  period?: string
  cap?: number | string
  active?: boolean
}

export type GroupLike = {
  key?: string
  name?: string
  categories?: string[]
  scope?: string
  active?: boolean
}

export const norm = (s: unknown): string => String(s ?? "").trim().toLowerCase()

/**
 * The categories a budget actually measures.
 *
 * A budget caps EITHER one category or a group of them. Returning [] for a
 * group that does not resolve is deliberate and load-bearing: `actualCents`
 * over an empty category list must sum nothing, so a typo'd group name shows
 * as a budget measuring zero categories rather than one silently matching
 * every transaction. See `groupResolves` — the caller is expected to say so.
 */
export function budgetCategories(b: BudgetLike, groups: GroupLike[]): string[] {
  if (b.group) {
    const g = groups.find((x) => norm(x.key) === norm(b.group) && x.active !== false)
    if (!g) return []
    return (g.categories ?? []).map(norm).filter(Boolean)
  }
  const c = norm(b.category)
  return c ? [c] : []
}

/** False when a budget names a group that does not exist — a cap measuring nothing. */
export function groupResolves(b: BudgetLike, groups: GroupLike[]): boolean {
  if (!b.group) return true
  return groups.some((g) => norm(g.key) === norm(b.group) && g.active !== false)
}

/**
 * Every category covered by some active budget, groups expanded.
 *
 * `unbudgetedSpend` subtracts this set. Before groups existed it subtracted
 * `budgets.map(b => b.category)`, so the moment a budget moved to a group its
 * member categories would ALL have re-appeared as unbudgeted — the report would
 * have doubled the same dollars, once inside the group and once outside it.
 */
export function coveredCategories(budgets: BudgetLike[], groups: GroupLike[]): string[] {
  const out = new Set<string>()
  for (const b of budgets) {
    if (b.active === false) continue
    for (const c of budgetCategories(b, groups)) out.add(c)
  }
  return [...out]
}

/**
 * A category claimed by more than one active group.
 *
 * Overlapping groups double-count: the same $40 of groceries lands in "Food"
 * and in "Essentials", both look correct in isolation, and the totals do not
 * add up to the ledger. Detected rather than resolved — picking a winner would
 * be a guess about intent.
 */
export function overlappingCategories(groups: GroupLike[]): { category: string; groups: string[] }[] {
  const owners = new Map<string, string[]>()
  for (const g of groups) {
    if (g.active === false) continue
    for (const c of (g.categories ?? []).map(norm).filter(Boolean)) {
      owners.set(c, [...(owners.get(c) ?? []), String(g.key ?? g.name ?? "?")])
    }
  }
  return [...owners.entries()]
    .filter(([, gs]) => gs.length > 1)
    .map(([category, gs]) => ({ category, groups: gs }))
}

// ── policy ───────────────────────────────────────────────────────────────────

export type Policy = {
  scope?: string
  require_category?: boolean
  require_group?: boolean
  require_description?: boolean
  declared_only?: boolean
  max_single_expense?: number | null
  allowed_categories?: string[]
  active?: boolean
}

/**
 * No policy is NOT an empty policy — it is no enforcement at all.
 *
 * Every flag defaults off so installing this feature cannot retroactively
 * invalidate a ledger written before it existed. Turning enforcement on is a
 * decision someone makes; it is never the side effect of an upgrade.
 */
export const NO_POLICY: Policy = {
  require_category: false,
  require_group: false,
  require_description: false,
  declared_only: false,
  max_single_expense: null,
  allowed_categories: [],
}

export type Violation = { code: string; message: string }

export type TxDraft = {
  amount_cents?: number
  description?: string
  category?: string
  scope?: string
}

/**
 * Check a transaction against a policy BEFORE it is written.
 *
 * Returns every violation rather than the first, because fixing them one
 * round-trip at a time is how someone gives up and reaches for --force.
 *
 * `knownCategories` is the declared set (chart of accounts + group members).
 * When it is EMPTY, `declared_only` cannot be evaluated — and an empty list is
 * treated as "nothing is declared", which would reject everything. So the caller
 * must pass a real list; this function refuses to enforce declared_only against
 * an empty one and says so, rather than failing every write.
 */
export function evaluatePolicy(tx: TxDraft, policy: Policy | null | undefined, knownCategories: string[]): Violation[] {
  const p = { ...NO_POLICY, ...(policy ?? {}) }
  if (p.active === false) return []
  const v: Violation[] = []
  const cat = norm(tx.category)

  if (p.require_description && !String(tx.description ?? "").trim()) {
    v.push({ code: "description_required", message: "policy requires a description" })
  }
  if (p.require_category && !cat) {
    v.push({ code: "category_required", message: "policy requires a category — pass -c <category>" })
  }
  if (p.max_single_expense != null && p.max_single_expense > 0) {
    const capCents = Math.round(p.max_single_expense * 100)
    if ((tx.amount_cents ?? 0) > capCents) {
      v.push({
        code: "over_single_limit",
        message: `single expense exceeds the policy limit of $${p.max_single_expense.toFixed(2)}`,
      })
    }
  }
  const allowed = (p.allowed_categories ?? []).map(norm).filter(Boolean)
  if (allowed.length > 0 && cat && !allowed.includes(cat)) {
    v.push({ code: "category_not_allowed", message: `category "${cat}" is not in this scope's allowed list` })
  }
  if (p.declared_only && cat) {
    const known = knownCategories.map(norm).filter(Boolean)
    // Refusing to enforce against an empty declared set is the whole point:
    // otherwise switching this on with no accounts loaded rejects every write
    // and reads as "mint is broken" rather than "nothing is declared yet".
    if (known.length > 0 && !known.includes(cat)) {
      v.push({ code: "category_undeclared", message: `category "${cat}" is not declared — add it or use --force` })
    }
  }
  return v
}

/**
 * require_group is checked separately because it needs the group table, and a
 * category can be valid while belonging to no group at all.
 */
export function groupViolations(tx: TxDraft, policy: Policy | null | undefined, groups: GroupLike[]): Violation[] {
  const p = { ...NO_POLICY, ...(policy ?? {}) }
  if (p.active === false || !p.require_group) return []
  const cat = norm(tx.category)
  if (!cat) return [] // already caught by require_category; do not double-report
  const inGroup = groups.some(
    (g) => g.active !== false && (g.categories ?? []).map(norm).includes(cat),
  )
  return inGroup
    ? []
    : [{ code: "group_required", message: `category "${cat}" belongs to no spending group — add it with: iris mint group set <key> --add ${cat}` }]
}

/**
 * A category covered by more than one active BUDGET (groups expanded).
 *
 * Groups make this newly possible: a "Food & Home" group budget and a legacy
 * "Groceries" category budget both legitimately cover groceries, each reads
 * correctly on its own, and the TOTAL line then counts those dollars twice.
 * Distinct from `overlappingCategories`, which compares groups to each other —
 * this compares what the budgets actually measure.
 */
export function overlappingBudgets(
  budgets: BudgetLike[],
  groups: GroupLike[],
): { category: string; budgets: string[] }[] {
  const owners = new Map<string, string[]>()
  for (const b of budgets) {
    if (b.active === false) continue
    const label = String(b.name ?? b.category ?? b.group ?? "?")
    for (const c of budgetCategories(b, groups)) {
      owners.set(c, [...(owners.get(c) ?? []), label])
    }
  }
  return [...owners.entries()]
    .filter(([, bs]) => bs.length > 1)
    .map(([category, bs]) => ({ category, budgets: bs }))
}

// =============================================================================
// Splits (#182035) and paid-from / reimbursable (#182036).
// =============================================================================

/**
 * Divide one invoice's total across several campaigns/categories.
 *
 * Requires the parts to sum EXACTLY to the total — no silent rounding or
 * remainder-absorption. A split that is off by a cent is not a rounding
 * artifact to paper over; it means one of the numbers someone typed is wrong,
 * and that has to surface now rather than as unexplained drift the next time
 * `mint verify` runs.
 */
export function planSplit(
  totalCents: number,
  parts: { label: string; cents: number }[],
): { label: string; cents: number }[] | { error: string } {
  if (parts.length === 0) return { error: "no split parts given" }
  for (const p of parts) {
    if (!p.label.trim()) return { error: "every split part needs a label" }
    if (!Number.isFinite(p.cents) || p.cents <= 0) return { error: `"${p.label}" must be a positive amount` }
  }
  const sum = parts.reduce((s, p) => s + p.cents, 0)
  if (sum !== totalCents) {
    const fmt = (c: number) => (c / 100).toFixed(2)
    return {
      error: `parts sum to $${fmt(sum)} but the invoice is $${fmt(totalCents)} — drift of $${fmt(Math.abs(sum - totalCents))}`,
    }
  }
  return parts
}

/**
 * A transaction paid from a different account than the budget it counts
 * against (metadata.scope) is a reimbursable, not a normal expense — the
 * "business ad bought on a personal card" case #182036 is about. `null` means
 * there is nothing to reconcile: no `paid_from` recorded, or it matches scope,
 * which is every transaction written before this existed.
 *
 * Direction: the BOOKS owe the ACCOUNT that actually paid. A business ad
 * charged to a personal card is scope=business, paid_from=personal — business
 * benefited from the spend, personal fronted the cash, so business owes
 * personal, i.e. owed_by=scope, owed_to=paid_from.
 */
export function reimbursableOf(tx: {
  metadata?: { scope?: string; paid_from?: string }
}): { owed_by: string; owed_to: string } | null {
  const scope = tx.metadata?.scope
  const paidFrom = tx.metadata?.paid_from
  if (!paidFrom || !scope || paidFrom === scope) return null
  return { owed_by: scope, owed_to: paidFrom }
}
