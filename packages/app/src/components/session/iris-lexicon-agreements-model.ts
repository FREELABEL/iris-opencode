/**
 * Lexicon › Agreements (#192484) — the decisions the panel makes, kept pure so they are tested
 * without mounting Solid. The shapes mirror /iris/agreements, which declares every one of these
 * fields (packages/opencode/src/iris/agreements.ts); reading one that is not declared there gets
 * `undefined`, silently.
 */

export interface PartyLink {
  role: string
  name: string | null
  status: string
  url: string | null
}

export interface Agreement {
  id: number
  type: string
  kind: string | null
  counterparty: string
  org: string | null
  email: string | null
  disclosingParty: string | null
  status: string
  tier: string
  subjectRef: string | null
  issuedAt: string | null
  executedAt: string | null
  expiryDate: string | null
  revokedAt: string | null
  documentHash: string | null
  signingUrl: string | null
  partyLinks: PartyLink[]
  live: boolean
  partiesTotal: number
  partiesSigned: number
  waitingOn: string | null
  waitingDays: number | null
  expiringSoon: boolean
  raisedByCaller: boolean
}

export interface AgreementDetail {
  agreement: Agreement | null
  document: {
    kind: string | null
    title: string | null
    reference: string | null
    parties: { role: string; name: string | null; meta: string | null }[]
    preamble: string | null
    clauses: { heading: string | null; body: string }[]
    endNote: string | null
    signatures: { role: string; name: string | null; method: string | null; signedAt: string | null }[]
    recordNote: string | null
    integrityNote: string | null
  } | null
  seal: { status: string; detail: string | null; chain: string | null } | null
  trail: { seq: number | null; action: string; ip: string | null; at: string | null }[]
}

export type Bucket = "all" | "awaiting" | "draft" | "executed" | "closed"
export const BUCKETS: readonly Bucket[] = ["all", "awaiting", "draft", "executed", "closed"]
export const BUCKET_WORD: Record<Bucket, string> = {
  all: "All",
  awaiting: "Awaiting",
  draft: "Drafts",
  executed: "Executed",
  closed: "Closed",
}

const AWAITING = new Set(["sent", "opened", "partially_signed"])
const CLOSED = new Set(["revoked", "declined", "expired"])

export function bucketOf(status: string): Exclude<Bucket, "all"> {
  if (status === "executed") return "executed"
  if (AWAITING.has(status)) return "awaiting"
  if (CLOSED.has(status)) return "closed"
  return "draft"
}

export function tally(rows: Agreement[]): Record<Bucket, number> {
  const t: Record<Bucket, number> = { all: rows.length, awaiting: 0, draft: 0, executed: 0, closed: 0 }
  for (const r of rows) t[bucketOf(r.status)]++
  return t
}

export const matches = (a: Agreement, b: Bucket) => b === "all" || bucketOf(a.status) === b

/** The CLI's words (EXECUTED, AWAITING, …), in sentence case. Expiring beats executed. */
export function stateWord(a: Pick<Agreement, "status" | "expiringSoon" | "partiesTotal" | "partiesSigned">): string {
  if (a.status === "executed") return a.expiringSoon ? "Expiring" : "Executed"
  if (a.status === "partially_signed") return `${a.partiesSigned}/${a.partiesTotal} signed`
  if (a.status === "sent" || a.status === "opened") return a.status === "opened" ? "Opened" : "Awaiting"
  if (!a.status) return "Unknown"
  return a.status.charAt(0).toUpperCase() + a.status.slice(1).replace(/_/g, " ")
}

/** The tone a state is drawn in: text colour only, never a bar. */
export function toneOf(a: Pick<Agreement, "status" | "expiringSoon" | "waitingDays">): "good" | "warn" | "bad" | "quiet" {
  if (a.status === "executed") return a.expiringSoon ? "warn" : "good"
  if (a.status === "declined" || a.status === "revoked" || a.status === "expired") return "bad"
  if (AWAITING.has(a.status) && (a.waitingDays ?? 0) >= 7) return "warn"
  return "quiet"
}

/** The case a subject ref names. Older rows say `matter:`; the CLI files under `case:`. */
export function caseOf(subjectRef: string | null): string | null {
  if (!subjectRef) return null
  const m = /^(case|matter):(.+)$/.exec(subjectRef)
  return m ? m[2] : null
}

export const shortHash = (h: string | null) => (h ? `${h.slice(0, 8)}…${h.slice(-4)}` : null)

export function waitLine(a: Pick<Agreement, "waitingDays" | "waitingOn" | "status">): string | null {
  if (!AWAITING.has(a.status) || a.waitingDays === null || a.waitingDays === undefined) return null
  const days = a.waitingDays === 1 ? "1 day" : `${a.waitingDays} days`
  return a.waitingOn ? `${days} waiting on ${a.waitingOn}` : `${days} waiting`
}

/** Why Issue is not offered, or null when it is. The server re-checks; this only saves a refusal. */
export function issueBlock(a: Agreement): string | null {
  if (a.status === "executed") return "Already executed — nothing to send."
  if (CLOSED.has(a.status)) return `This agreement is ${a.status}.`
  if (!a.email) return "No email on this agreement, so there is nowhere to send the link."
  return null
}

export const canRevoke = (a: Agreement) => !CLOSED.has(a.status)
export const issueVerb = (a: Agreement) => (a.status === "draft" ? "Issue" : "Re-send")

export interface Recipient {
  name: string
  role: string
  email: string | null
}

/**
 * WHO RECEIVES IT — named in the confirm, because issue and revoke both reach a person outside the
 * firm. The counterparty, with the address the email goes to, then every other party who has not
 * signed yet (a multi-party agreement chases each one). A party that has signed is not chased.
 */
export function recipients(a: Agreement): Recipient[] {
  const out: Recipient[] = [{ name: a.counterparty || "the counterparty", role: "Counterparty", email: a.email }]
  for (const p of a.partyLinks) {
    if (p.status === "signed") continue
    if (!p.name || p.name === a.counterparty) continue
    out.push({ name: p.name, role: p.role, email: null })
  }
  return out
}

export const AGREEMENT_TYPES: readonly { id: string; label: string; defaultWording?: true }[] = [
  { id: "engagement", label: "Engagement letter" },
  { id: "fee", label: "Fee agreement" },
  { id: "co_counsel", label: "Co-counsel" },
  { id: "tolling", label: "Tolling" },
  { id: "settlement", label: "Settlement" },
  { id: "release", label: "Release" },
  { id: "letter_of_protection", label: "Letter of protection" },
  { id: "medical_authorization", label: "Medical authorization" },
  { id: "nda", label: "NDA", defaultWording: true },
  { id: "baa", label: "BAA", defaultWording: true },
  { id: "other", label: "Other" },
]

export interface RaiseForm {
  case: string
  type: string
  name: string
  email: string
  org: string
  firm: string
  template: string
  body: string
  term: string
  expires: string
}

export const emptyRaise = (caseRef = ""): RaiseForm => ({
  case: caseRef,
  type: "engagement",
  name: "",
  email: "",
  org: "",
  firm: "",
  template: "",
  body: "",
  term: "",
  expires: "",
})

/** The first thing stopping a raise, in words — or null. Mirrors what fl-api would refuse. */
export function raiseProblem(f: RaiseForm): string | null {
  if (!f.case.trim()) return "Which case is this for?"
  if (!f.name.trim()) return "Who signs it?"
  if (!f.firm.trim()) return "Which firm issues it?"
  if (f.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(f.email.trim())) return "That email doesn't look right."
  if (f.expires.trim() && !/^\d{4}-\d{2}-\d{2}$/.test(f.expires.trim())) return "Expiry is a date: YYYY-MM-DD."
  const t = AGREEMENT_TYPES.find((x) => x.id === f.type)
  if (!t?.defaultWording && !f.body.trim() && !f.template.trim())
    return "This type has no default wording. Paste the approved wording, or name a template."
  return null
}

/** What the engine route takes — blanks left out rather than sent as "". */
export function raisePayload(f: RaiseForm): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(f)) if (v.trim()) out[k] = v.trim()
  return out
}

/** `agreement.opened` → "Opened". */
export const trailWord = (action: string) => {
  const w = action.replace(/^agreement\./, "").replace(/_/g, " ")
  return w.charAt(0).toUpperCase() + w.slice(1)
}
