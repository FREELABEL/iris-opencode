import { FL_API, irisFetch, type PlatformResult } from "./platform"

/**
 * Lexicon › Agreements (#192484, epic #192479) — the Desktop side of `iris lexicon agreements`.
 *
 * Same fl-api routes as `platform-agreements.ts` on `main`: GET /api/v1/agreements (filtered),
 * GET /{id}, POST / (raise), POST /{id}/issue, POST /{id}/revoke.
 *
 * EVERY FIELD THE PANEL READS IS COPIED HERE BY NAME, and the route's Schema declares the same
 * names. Effect Schema drops what it was not told about without a word — that is how `wakes` and
 * `ledgerSince` vanished before PR #459 — so the panel must never read a field this file did not
 * put there. Values are coerced to the declared type here, so an fl-api change of type becomes a
 * null on screen rather than a 500 from the encoder.
 *
 * `waitingDays`, `live` and `expiringSoon` are computed by fl-api and passed through. Two surfaces
 * each deriving "outstanding" from raw dates will eventually disagree in front of a client.
 *
 * Signing is not here, deliberately (as in the CLI): a signature must be attributable to the person
 * who gave it. Issue and revoke ARE here, and both reach the counterparty — the panel confirms
 * them by name; this module just makes the call.
 */

export interface AgreementPartyLink {
  role: string
  name: string | null
  status: string
  url: string | null
}

export interface AgreementRow {
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
  partyLinks: AgreementPartyLink[]
  live: boolean
  partiesTotal: number
  partiesSigned: number
  waitingOn: string | null
  waitingDays: number | null
  expiringSoon: boolean
  raisedByCaller: boolean
}

export interface AgreementSummary {
  total: number
  awaiting: number
  executed: number
  expiringSoon: number
  revoked: number
}

export interface AgreementDocument {
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
}

export interface AgreementSeal {
  status: string
  detail: string | null
  chain: string | null
}

export interface AgreementTrailRow {
  seq: number | null
  action: string
  ip: string | null
  at: string | null
}

export interface AgreementDetail {
  agreement: AgreementRow | null
  document: AgreementDocument | null
  seal: AgreementSeal | null
  trail: AgreementTrailRow[]
}

export interface AgreementsQuery {
  /** A case id (the lead id) or a synced case ref. Absent = every case. */
  case?: string
  status?: string
  type?: string
}

export interface RaiseInput {
  case: string
  type: string
  name: string
  firm: string
  email?: string
  org?: string
  template?: string
  body?: string
  term?: string
  expires?: string
}

/** The seam a test replaces. */
export const agreementDeps = {
  fetch: (path: string, init?: RequestInit) => irisFetch(path, FL_API, init),
}

const str = (v: unknown): string | null => (typeof v === "string" ? v : typeof v === "number" ? String(v) : null)
const num = (v: unknown): number | null => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v
  return typeof n === "number" && Number.isFinite(n) ? n : null
}
const arr = (v: unknown): any[] => (Array.isArray(v) ? v : [])

export function readRow(r: any): AgreementRow {
  return {
    id: num(r?.id) ?? 0,
    type: str(r?.type) ?? "",
    kind: str(r?.kind),
    counterparty: str(r?.counterparty) ?? "",
    org: str(r?.org),
    email: str(r?.email),
    disclosingParty: str(r?.disclosingParty),
    status: str(r?.status) ?? "",
    tier: str(r?.tier) ?? "standard",
    subjectRef: str(r?.subjectRef),
    issuedAt: str(r?.issuedAt),
    executedAt: str(r?.executedAt),
    expiryDate: str(r?.expiryDate),
    revokedAt: str(r?.revokedAt),
    documentHash: str(r?.documentHash),
    signingUrl: str(r?.signingUrl),
    partyLinks: arr(r?.partyLinks).map((p) => ({
      role: str(p?.role) ?? "",
      name: str(p?.name),
      status: str(p?.status) ?? "",
      url: str(p?.url),
    })),
    live: r?.live === true,
    partiesTotal: num(r?.partiesTotal) ?? 1,
    partiesSigned: num(r?.partiesSigned) ?? 0,
    waitingOn: str(r?.waitingOn),
    waitingDays: num(r?.waitingDays),
    expiringSoon: r?.expiringSoon === true,
    raisedByCaller: r?.raisedByCaller === true,
  }
}

function readSummary(s: any, rows: AgreementRow[]): AgreementSummary {
  return {
    total: num(s?.total) ?? rows.length,
    awaiting: num(s?.awaiting) ?? 0,
    executed: num(s?.executed) ?? 0,
    expiringSoon: num(s?.expiringSoon) ?? 0,
    revoked: num(s?.revoked) ?? 0,
  }
}

function readDocument(d: any): AgreementDocument | null {
  if (!d || typeof d !== "object") return null
  return {
    kind: str(d.kind),
    title: str(d.title),
    reference: str(d.reference),
    parties: arr(d.parties).map((p) => ({ role: str(p?.role) ?? "", name: str(p?.name), meta: str(p?.meta) })),
    preamble: str(d.preamble),
    clauses: arr(d.clauses).map((c) => ({ heading: str(c?.heading), body: str(c?.body) ?? "" })),
    endNote: str(d.endNote),
    signatures: arr(d.signatures).map((s) => ({
      role: str(s?.role) ?? "",
      name: str(s?.name),
      method: str(s?.method),
      signedAt: str(s?.signedAt),
    })),
    recordNote: str(d.recordNote),
    integrityNote: str(d.integrityNote),
  }
}

/** fl-api says why in one of three places; the most specific wins. */
export function failureReason(status: number, j: any): string {
  const first = j?.errors && typeof j.errors === "object" ? Object.values(j.errors).flat()[0] : undefined
  return str(j?.message) ?? str(j?.error) ?? str(first) ?? `fl-api ${status}`
}

async function call(path: string, init?: RequestInit): Promise<{ ok: true; body: any } | { ok: false; reason: string }> {
  try {
    const res = await agreementDeps.fetch(`/api/v1/agreements${path}`, init)
    const body = (await res.json().catch(() => null)) as any
    if (!res.ok) return { ok: false, reason: failureReason(res.status, body) }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Lexicon's filter, as `iris lexicon agreements list [case]` sends it. */
export function ledgerQuery(q: AgreementsQuery): string {
  const qs = new URLSearchParams()
  const c = q.case?.trim()
  if (c) qs.set("subject", `case:${c}`)
  else qs.set("subject_prefix", "case:")
  if (q.status?.trim()) qs.set("status", q.status.trim())
  if (q.type?.trim()) qs.set("type", q.type.trim())
  return `?${qs}`
}

const EMPTY_SUMMARY: AgreementSummary = { total: 0, awaiting: 0, executed: 0, expiringSoon: 0, revoked: 0 }

export async function fetchAgreements(
  q: AgreementsQuery,
): Promise<PlatformResult<{ summary: AgreementSummary; agreements: AgreementRow[] }>> {
  const r = await call(ledgerQuery(q))
  if (!r.ok) return { measured: false, reason: r.reason, data: { summary: EMPTY_SUMMARY, agreements: [] } }
  const agreements = arr(r.body?.agreements).map(readRow)
  return { measured: true, data: { summary: readSummary(r.body?.summary, agreements), agreements } }
}

const NO_DETAIL: AgreementDetail = { agreement: null, document: null, seal: null, trail: [] }

export async function fetchAgreement(id: number): Promise<PlatformResult<AgreementDetail>> {
  const r = await call(`/${id}`)
  if (!r.ok) return { measured: false, reason: r.reason, data: NO_DETAIL }
  const b = r.body ?? {}
  return {
    measured: true,
    data: {
      agreement: b.agreement ? readRow(b.agreement) : null,
      document: readDocument(b.document),
      seal: b.seal ? { status: str(b.seal.status) ?? "unsealed", detail: str(b.seal.detail), chain: str(b.seal.chain) } : null,
      trail: arr(b.trail).map((e) => ({ seq: num(e?.seq), action: str(e?.action) ?? "", ip: str(e?.ip), at: str(e?.at) })),
    },
  }
}

const post = (body?: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(body ?? {}) })
const blank = (s?: string) => (s?.trim() ? s.trim() : null)

/**
 * Raise ONLY — never issues. `issue: false` is sent explicitly: what reaches the counterparty goes
 * through issueAgreement, which the panel puts behind a confirm naming them.
 */
export async function raiseAgreement(input: RaiseInput): Promise<PlatformResult<{ agreement: AgreementRow | null }>> {
  if (!input.case?.trim()) return { measured: false, reason: "Which case is this for?", data: { agreement: null } }
  if (!input.name?.trim()) return { measured: false, reason: "Who signs it?", data: { agreement: null } }
  if (!input.firm?.trim()) return { measured: false, reason: "Which firm issues it?", data: { agreement: null } }
  const r = await call(
    "",
    post({
      agreement_type: input.type || "engagement",
      template_slug: blank(input.template),
      body: blank(input.body),
      counterparty_name: input.name.trim(),
      counterparty_email: blank(input.email),
      counterparty_org: blank(input.org),
      disclosing_party: input.firm.trim(),
      subject_ref: `case:${input.case.trim()}`,
      access_tier: "standard",
      term: blank(input.term),
      expiry_date: blank(input.expires),
      issue: false,
    }),
  )
  if (!r.ok) return { measured: false, reason: r.reason, data: { agreement: null } }
  return { measured: true, data: { agreement: r.body?.agreement ? readRow(r.body.agreement) : null } }
}

/** Emails the signing link (also re-sends). Outward-facing. */
export async function issueAgreement(id: number): Promise<PlatformResult<{ agreement: AgreementRow | null }>> {
  const r = await call(`/${id}/issue`, post())
  if (!r.ok) return { measured: false, reason: r.reason, data: { agreement: null } }
  return { measured: true, data: { agreement: r.body?.agreement ? readRow(r.body.agreement) : null } }
}

/** Revokes and closes the access it authorised. The reason goes on the audit chain, so it is required. */
export async function revokeAgreement(id: number, reason: string): Promise<PlatformResult<{ agreement: AgreementRow | null }>> {
  if (!reason?.trim()) return { measured: false, reason: "Say why — it is recorded on the audit chain.", data: { agreement: null } }
  const r = await call(`/${id}/revoke`, post({ reason: reason.trim() }))
  if (!r.ok) return { measured: false, reason: r.reason, data: { agreement: null } }
  return { measured: true, data: { agreement: r.body?.agreement ? readRow(r.body.agreement) : null } }
}
