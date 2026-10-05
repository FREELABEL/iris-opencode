/**
 * Revenue-model profiles — RO-7 (#182271).
 *
 * WHY THIS EXISTS. The RevOps KPI layer was built against one revenue model: a B2B SaaS
 * funnel (leads → deals → MRR → CAC → NRR). The customer it was built toward, GTC MediGuide
 * (bloq #601), is a TELEHEALTH provider, where "revenue operations" means the revenue CYCLE —
 * eligibility, prior auth, coding, claim submission, adjudication, denials, A/R. That is not a
 * missing metric, it is a missing half (RO-6, #182260).
 *
 * We cannot answer which model applies — only the client can. Waiting blocks the build;
 * guessing wastes weeks in whichever direction is wrong. So the model stops being a
 * prerequisite and becomes a PARAMETER.
 *
 * THE SPINE. Strip both models to their mechanics and they are the same shape with different
 * nouns:
 *
 *     work item → staged pipeline → terminal outcome → reason taxonomy → recovery motion
 *                → cycle time → cost ratio
 *
 *   opportunity / claim · closed-won / paid · closed-lost / denied · loss reason / CARC code
 *   re-engagement / appeal · sales-cycle length / days in A/R · CAC / cost to collect
 *
 * That mapping was derived by laying the HFMA MAP Keys (29 KPIs, the actual healthcare
 * standard) beside our own gap map — not by analogy-hunting. It is why this is an abstraction
 * and not a stretch.
 *
 * THE DISCIPLINE, because over-abstracting is the real risk here:
 *   - The SPINE holds only what both models genuinely share. Nothing enters it because it
 *     might be useful later.
 *   - Anything model-specific lives in its PROFILE. Prior-auth turnaround and DNFB are
 *     payer_billed only; MQL scoring and pipeline coverage are subscription only.
 *   - If a concept only fits one side, it does not go in the spine. A forced-fit row is worse
 *     than a missing one.
 *
 * Registry lives here rather than in YAML because the consumer is the CLI and a typed module
 * needs no parser and can be unit-tested. If agents or the API later need to read profiles,
 * this moves to a served registry — the shape is deliberately serialisable.
 */

export interface RevenueModelProfile {
  /** Stable key stored on the bloq's business_context.revenue_model. */
  key: string
  /** How a human refers to this model. */
  label: string
  /** What one unit of work is called in this model. */
  workItem: string
  /** The terminal state where money arrives. */
  terminalPaid: string
  /** The terminal state where it does not. */
  terminalUnpaid: string
  /** The controlled vocabulary explaining an unpaid terminal. */
  reasonTaxonomy: string
  /** What you do about an unpaid terminal. */
  recovery: string
  /** How long the work item takes, and between which two stamps. */
  cycleMetric: { name: string; from: string; to: string }
  /** The efficiency ratio this model is judged on. */
  costRatio: { name: string; num: string; den: string }
  /** One line on when this profile is the right one. */
  whenToUse: string
}

export const REVENUE_MODELS: Record<string, RevenueModelProfile> = {
  subscription: {
    key: "subscription",
    label: "Subscription / B2B",
    workItem: "opportunity",
    terminalPaid: "won",
    terminalUnpaid: "lost",
    reasonTaxonomy: "loss_reasons",
    recovery: "re_engagement",
    cycleMetric: { name: "sales_cycle_length", from: "created_at", to: "terminal_at" },
    costRatio: { name: "CAC", num: "sm_spend", den: "new_logos" },
    whenToUse: "You sell a contract or subscription to another business. Revenue recurs per account.",
  },

  payer_billed: {
    key: "payer_billed",
    label: "Payer-billed healthcare",
    workItem: "claim",
    terminalPaid: "paid",
    terminalUnpaid: "denied",
    reasonTaxonomy: "carc_rarc",
    recovery: "appeal",
    // HFMA FM-1 Net Days in A/R. Starts at SERVICE, not at claim submission — charge lag is
    // part of the number, and measuring from submission hides it.
    cycleMetric: { name: "days_in_ar", from: "service_date", to: "cash_posted" },
    // HFMA FM-6 Cost to Collect.
    costRatio: { name: "cost_to_collect", num: "revcycle_cost", den: "cash_collected" },
    whenToUse: "You deliver care and bill a payer per encounter. Revenue arrives per claim, after adjudication.",
  },

  cash_pay: {
    key: "cash_pay",
    label: "Direct / cash-pay",
    workItem: "encounter",
    terminalPaid: "collected",
    terminalUnpaid: "uncollected",
    reasonTaxonomy: "nonpayment_reasons",
    recovery: "collections",
    cycleMetric: { name: "days_to_collect", from: "service_date", to: "cash_posted" },
    costRatio: { name: "cost_to_collect", num: "billing_cost", den: "cash_collected" },
    whenToUse:
      "You deliver care or service and the patient/customer pays directly. No payer adjudication, so no denials — but collection risk moves to the individual.",
  },
}

/** The default. Chosen so existing boards keep their exact current meaning. */
export const DEFAULT_REVENUE_MODEL = "subscription"

export function listRevenueModels(): RevenueModelProfile[] {
  return Object.values(REVENUE_MODELS)
}

export function getRevenueModel(key?: string | null): RevenueModelProfile {
  const k = String(key ?? "").trim().toLowerCase()
  return REVENUE_MODELS[k] ?? REVENUE_MODELS[DEFAULT_REVENUE_MODEL]
}

/** True when `key` names a profile we actually declare. */
export function isKnownRevenueModel(key?: string | null): boolean {
  return !!REVENUE_MODELS[String(key ?? "").trim().toLowerCase()]
}

/**
 * Read the active profile off a bloq's business_context.
 *
 * Returns the resolved profile AND whether it was explicitly declared, because those are
 * different facts and the caller must be able to say which. An undeclared bloq is running on
 * the default, not on a decision someone made — and reporting a default as a choice is the
 * same class of error as a gate that says "gated" without saying gated to whom.
 */
export function resolveRevenueModel(businessContext: any): {
  profile: RevenueModelProfile
  declared: boolean
  rawValue: string | null
  unknown: boolean
} {
  const raw = businessContext?.revenue_model
  const rawValue = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null
  const unknown = rawValue !== null && !isKnownRevenueModel(rawValue)
  return {
    profile: getRevenueModel(rawValue),
    declared: rawValue !== null && !unknown,
    rawValue,
    unknown,
  }
}

/**
 * Does this KPI apply under the active profile?
 *
 * An ABSENT `applies_to` means "applies everywhere" — deliberately, so that tagging can be
 * incremental and an untagged KPI never silently disappears from a board. Disappearing is the
 * failure mode that matters here: a metric that vanishes reads as "we don't track that",
 * which is indistinguishable from "we track it and it's fine".
 */
export function kpiAppliesTo(item: any, modelKey: string): boolean {
  const applies = item?.applies_to
  if (applies == null) return true
  const list = Array.isArray(applies) ? applies : [applies]
  const normalised = list.map((v) => String(v).trim().toLowerCase()).filter(Boolean)
  if (normalised.length === 0) return true
  return normalised.includes(modelKey)
}

/**
 * Partition a KPI list by the active profile.
 *
 * Returns both halves rather than filtering, so the caller can SAY how many were set aside.
 * A filtered list that does not report what it dropped is a smaller lie than a wrong number,
 * but it is still one.
 */
export function partitionByModel<T>(items: T[], modelKey: string): { active: T[]; hidden: T[] } {
  const active: T[] = []
  const hidden: T[] = []
  for (const it of items) (kpiAppliesTo(it, modelKey) ? active : hidden).push(it)
  return { active, hidden }
}
