/**
 * WHAT A COUPLE HAS ALREADY SPENT — the half a per-act ceiling cannot see.
 *
 * `max_single_expense_cents` caps ONE act. A night of patrol is a thousand acts, each well under
 * the cap, and the cap never fires once. So the guard also needs windows: what this run has spent,
 * what today has spent, and how many acts today. Those come from the act log the node already
 * writes — the ledger line is local until Mint takes it (#184906 step 4), and this reads it.
 *
 * Pure: the caller hands over the rows.
 */

export interface ActRow {
  /** Shared by the coarse and fine gates of one act — see the dedupe in spendFor. */
  act_id?: string | null
  ts?: string
  couple_id?: string | null
  decision?: string
  estimated_cents?: number | null
  run_id?: string | null
}

export interface Spend {
  runCents: number
  dayCents: number
  dayActs: number
}

export const EMPTY_SPEND: Spend = { runCents: 0, dayCents: 0, dayActs: 0 }

/** UTC day, because a fleet spans time zones and "today" has to mean the same thing on every node. */
export const utcDay = (iso: string): string => String(iso ?? "").slice(0, 10)

/**
 * Sum what this couple has actually spent.
 *
 * ONLY ALLOWED ACTS COUNT. A refusal costs nothing, and counting refusals would let a misconfigured
 * agent exhaust its own budget by being refused all day — a denial of service wearing the costume
 * of a spending control.
 */
export function spendFor(acts: ActRow[], q: { coupleId: string; runId?: string | null; now: string }): Spend {
  const day = utcDay(q.now)

  // ONE ACT, ONE COUNT. A single command passes two gates — the command-level check and the
  // instance-level check in the act path — and both record. Counting the rows would double every
  // act's cost and halve every ceiling. Rows sharing an act_id collapse to the dearest of them.
  const byAct = new Map<string, ActRow>()
  const loose: ActRow[] = []
  for (const a of acts ?? []) {
    if (!a || a.couple_id !== q.coupleId || a.decision !== "allow") continue
    if (!a.act_id) { loose.push(a); continue }
    const seen = byAct.get(a.act_id)
    if (!seen || cents(a) > cents(seen)) byAct.set(a.act_id, a)
  }

  let runCents = 0
  let dayCents = 0
  let dayActs = 0
  for (const a of [...byAct.values(), ...loose]) {
    const c = cents(a)
    if (utcDay(String(a.ts ?? "")) === day) {
      dayCents += c
      dayActs += 1
    }
    if (q.runId && a.run_id === q.runId) runCents += c
  }
  return { runCents, dayCents, dayActs }
}

export interface BudgetPolicy {
  max_single_expense_cents?: number | null
  max_run_cents?: number | null
  max_day_cents?: number | null
  max_day_acts?: number | null
}

/** The refusal, or null if every ceiling still has room. Cost of THIS act is included before comparing. */
export function budgetRefusal(policy: BudgetPolicy | undefined, spend: Spend, estimate: number | null | undefined): string | null {
  const p = policy ?? {}
  const cost = typeof estimate === "number" && Number.isFinite(estimate) ? estimate : 0

  if (typeof p.max_single_expense_cents === "number" && cost > p.max_single_expense_cents)
    return `this act is estimated at ${money(cost)} and one act may not exceed ${money(p.max_single_expense_cents)}`

  if (typeof p.max_day_acts === "number" && spend.dayActs + 1 > p.max_day_acts)
    return `this couple has already acted ${spend.dayActs} time(s) today and may act ${p.max_day_acts} time(s) per day`

  if (typeof p.max_run_cents === "number" && spend.runCents + cost > p.max_run_cents)
    return `this run has spent ${money(spend.runCents)} and one run may not exceed ${money(p.max_run_cents)}`

  if (typeof p.max_day_cents === "number" && spend.dayCents + cost > p.max_day_cents)
    return `today has spent ${money(spend.dayCents)} and one day may not exceed ${money(p.max_day_cents)}`

  return null
}

const cents = (a: ActRow): number =>
  typeof a.estimated_cents === "number" && Number.isFinite(a.estimated_cents) ? a.estimated_cents : 0

function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}
