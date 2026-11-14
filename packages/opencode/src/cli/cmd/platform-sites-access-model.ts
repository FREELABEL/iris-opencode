// Pure logic for `iris sites doctor` and `iris sites access` (#192662).
//
// A site owns ONE sign-in policy (settings.gate). Member pages inherit it; a page's own gate
// may only NARROW it. Nothing here touches the network so every rule is unit-testable.
//
// The gate a page or site carries is the same shape everywhere:
//   { allowedDomains: string[], allowedEmails: string[], requireOtp?: boolean, ...other keys }
//
// Admission rule (mirrors fl-api GateDomainPolicy::decide): an address gets in when it is on
// allowedEmails exactly, or its domain is on allowedDomains. Both lists empty = no list.

export interface Gate {
  allowedDomains: string[]
  allowedEmails: string[]
  requireOtp?: boolean
  [key: string]: unknown
}

export interface GateRead {
  gate: Gate | null
  /** The stored value was a STRING, not an object. Always a defect. */
  storedAsString: boolean
  /** For a string gate: what the string seems to have meant (best effort), else null. */
  recovered: Gate | null
  raw: unknown
}

const DOMAIN_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/
const EMAIL_RE = /^[^\s@,;"'<>()[\]]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/

export function normDomain(d: string): string {
  return String(d).trim().toLowerCase().replace(/^@/, "").replace(/\.$/, "")
}

export function normEmail(e: string): string {
  return String(e).trim().toLowerCase()
}

export function isValidDomain(d: string): boolean {
  return DOMAIN_RE.test(normDomain(d))
}

export function isValidEmail(e: string): boolean {
  return EMAIL_RE.test(normEmail(e))
}

function uniq(xs: string[]): string[] {
  return [...new Set(xs)]
}

function strList(v: unknown, norm: (s: string) => string): string[] {
  if (!Array.isArray(v)) return []
  return uniq(v.filter((x) => typeof x === "string" && x.trim() !== "").map((x) => norm(x as string)))
}

function toGate(obj: Record<string, unknown>): Gate {
  return {
    ...obj,
    allowedDomains: strList(obj.allowedDomains, normDomain),
    allowedEmails: strList(obj.allowedEmails, normEmail),
  }
}

/**
 * Best-effort reading of a gate that was stored as a string. Handles real JSON and the
 * unquoted form an agent once wrote: "{allowedDomains:[a.com,b.com],allowedEmails:[x@y.com]}".
 */
export function recoverStringGate(s: string): Gate | null {
  const text = s.trim()
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return toGate(parsed)
  } catch {
    /* not JSON — try the loose form */
  }
  const out: Record<string, unknown> = {}
  let found = false
  const listRe = /(allowedDomains|allowedEmails|platformMemberRoles)\s*:\s*\[([^\]]*)\]/g
  for (const m of text.matchAll(listRe)) {
    found = true
    out[m[1]] = m[2]
      .split(",")
      .map((x) => x.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean)
  }
  const boolRe = /(requireOtp|showAllowedDomains)\s*:\s*(true|false)/g
  for (const m of text.matchAll(boolRe)) {
    found = true
    out[m[1]] = m[2] === "true"
  }
  return found ? toGate(out) : null
}

/** Read whatever is stored at a gate slot, flagging a string instead of trusting it. */
export function readGate(raw: unknown): GateRead {
  if (raw === undefined || raw === null || raw === "") {
    return { gate: null, storedAsString: false, recovered: null, raw }
  }
  if (typeof raw === "string") {
    return { gate: null, storedAsString: true, recovered: recoverStringGate(raw), raw }
  }
  if (typeof raw === "object" && !Array.isArray(raw)) {
    return { gate: toGate(raw as Record<string, unknown>), storedAsString: false, recovered: null, raw }
  }
  return { gate: null, storedAsString: true, recovered: null, raw }
}

export function hasList(g: Gate | null | undefined): g is Gate {
  return !!g && (g.allowedDomains.length > 0 || g.allowedEmails.length > 0)
}

export function domainOf(email: string): string | null {
  const at = normEmail(email).lastIndexOf("@")
  if (at < 1) return null
  const d = normEmail(email).slice(at + 1)
  return d ? d : null
}

export type Decision = { allowed: boolean; reason: "email" | "domain" | "no_list" | "not_on_list" | "malformed" }

/** Does this gate admit this address? Same order as the server: exact address, then domain. */
export function admits(g: Gate | null, email: string): Decision {
  if (!hasList(g)) return { allowed: true, reason: "no_list" }
  const addr = normEmail(email)
  if (g.allowedEmails.includes(addr)) return { allowed: true, reason: "email" }
  const d = domainOf(addr)
  if (!d) return { allowed: false, reason: "malformed" }
  if (g.allowedDomains.includes(d)) return { allowed: true, reason: "domain" }
  return { allowed: false, reason: "not_on_list" }
}

/**
 * The list a member page actually enforces: the set of addresses BOTH the site and the page
 * admit. With only one side configured, that side wins. Exact:
 *   domains = siteDomains ∩ pageDomains
 *   emails  = (siteEmails the page admits) ∪ (pageEmails the site admits)
 */
export function effectiveGate(site: Gate | null, page: Gate | null): Gate | null {
  const s = hasList(site) ? site : null
  const p = hasList(page) ? page : null
  if (!s && !p) return null
  if (!s) return { allowedDomains: [...p!.allowedDomains], allowedEmails: [...p!.allowedEmails] }
  if (!p) return { allowedDomains: [...s.allowedDomains], allowedEmails: [...s.allowedEmails] }
  const domains = s.allowedDomains.filter((d) => p.allowedDomains.includes(d))
  const emails = uniq([
    ...s.allowedEmails.filter((e) => admits(p, e).allowed),
    ...p.allowedEmails.filter((e) => admits(s, e).allowed),
  ])
  return { allowedDomains: domains, allowedEmails: emails }
}

/** Entries on the page's own list that the site's list does not admit — they cannot widen it. */
export function wideningEntries(site: Gate | null, page: Gate | null): string[] {
  if (!hasList(site) || !hasList(page)) return []
  return [
    ...page.allowedDomains.filter((d) => !site.allowedDomains.includes(d)).map((d) => `@${d}`),
    ...page.allowedEmails.filter((e) => !admits(site, e).allowed),
  ]
}

export interface ListDiff {
  same: boolean
  onlySite: string[]
  onlyPage: string[]
}

/** Compare two lists as written (domains prefixed with @). */
export function diffLists(site: Gate | null, page: Gate | null): ListDiff {
  const flat = (g: Gate | null) =>
    hasList(g) ? [...g.allowedDomains.map((d) => `@${d}`), ...g.allowedEmails] : []
  const a = flat(site)
  const b = flat(page)
  const onlySite = a.filter((x) => !b.includes(x))
  const onlyPage = b.filter((x) => !a.includes(x))
  return { same: onlySite.length === 0 && onlyPage.length === 0, onlySite, onlyPage }
}

export function describeList(g: Gate | null): string {
  if (!hasList(g)) return "(no list)"
  return [...g.allowedDomains.map((d) => `@${d}`), ...g.allowedEmails].join(", ")
}

// ----------------------------------------------------------------------------
// Owner board
// ----------------------------------------------------------------------------

export function ownerKey(rec: { owner_type?: unknown; owner_id?: unknown } | null | undefined): string | null {
  if (!rec || !rec.owner_type) return null
  return `${rec.owner_type}:${rec.owner_id ?? "null"}`
}

/**
 * The owner every member page should share: the site's own bloq owner when it has one,
 * otherwise the most common page owner (ties: the first seen).
 */
export function expectedOwner(siteOwner: string | null, pageOwners: Array<string | null>): string | null {
  if (siteOwner && siteOwner.startsWith("bloq:")) return siteOwner
  const counts = new Map<string, number>()
  for (const o of pageOwners) if (o) counts.set(o, (counts.get(o) ?? 0) + 1)
  let best: string | null = null
  let n = 0
  for (const [k, c] of counts) if (c > n) { best = k; n = c }
  return best ?? siteOwner
}

// ----------------------------------------------------------------------------
// Doctor report
// ----------------------------------------------------------------------------

export interface PageInput {
  id: number | string
  slug: string
  title?: string
  owner_type?: string | null
  owner_id?: number | string | null
  requires_auth?: boolean | null
  json_content?: Record<string, any> | null
  /** set when the page could not be read */
  error?: string
}

export interface PageReport {
  id: number | string
  slug: string
  owner: string | null
  ownerMismatch: boolean
  requireOtp: boolean
  gateStoredAsString: boolean
  gateRaw?: unknown
  gateRecovered: Gate | null
  pageList: Gate | null
  effective: Gate | null
  differsFromSite: boolean
  diff: ListDiff
  widening: string[]
  email?: { address: string; allowed: boolean; reason: string }
  flags: string[]
  error?: string
}

export interface SiteReport {
  site: { id: number | string; slug?: string; name?: string; owner: string | null }
  siteGate: Gate | null
  siteGateStoredAsString: boolean
  siteRequireOtp: boolean
  expectedOwner: string | null
  pages: PageReport[]
  flags: string[]
  ok: boolean
}

function explain(d: Decision, g: Gate | null, email: string): string {
  switch (d.reason) {
    case "email": return `email ${normEmail(email)} is on the list`
    case "domain": return `domain @${domainOf(email)} is on the list`
    case "no_list": return "no allow-list (any address that can receive a code)"
    case "malformed": return "not a valid email address"
    default: return `neither ${normEmail(email)} nor @${domainOf(email) ?? "?"} is on ${describeList(g)}`
  }
}

export function buildReport(input: {
  site: Record<string, any>
  settings: Record<string, any> | null
  pages: PageInput[]
  email?: string
}): SiteReport {
  const { site, settings, pages, email } = input
  const siteRead = readGate(settings?.gate)
  const siteGate = siteRead.gate
  const siteRequireOtp = !!(siteGate?.requireOtp)
  const siteOwner = ownerKey(site)
  const owners = pages.filter((p) => !p.error).map((p) => ownerKey(p))
  const expected = expectedOwner(siteOwner, owners)

  const flags: string[] = []
  if (siteRead.storedAsString) flags.push("site gate is stored as a STRING — it must be an object")

  const reports: PageReport[] = pages.map((p) => {
    const pf: string[] = []
    if (p.error) {
      pf.push(`could not read page: ${p.error}`)
      return {
        id: p.id, slug: p.slug, owner: null, ownerMismatch: false, requireOtp: false,
        gateStoredAsString: false, gateRecovered: null, pageList: null, effective: null,
        differsFromSite: false, diff: { same: true, onlySite: [], onlyPage: [] }, widening: [],
        flags: pf, error: p.error,
      }
    }
    const jc = p.json_content ?? {}
    const read = readGate(jc.gate)
    const owner = ownerKey(p)
    const ownerMismatch = !!expected && owner !== expected
    if (ownerMismatch) pf.push(`owner ${owner ?? "none"} — expected ${expected}`)
    if (read.storedAsString) pf.push("gate is stored as a STRING — it must be an object")
    const requireOtp = !!jc.requireOtp || !!p.requires_auth
    const pageList = read.gate
    const effective = effectiveGate(siteGate, pageList)
    const diff = diffLists(siteGate, hasList(pageList) ? pageList : siteGate)
    const differs = hasList(pageList) && hasList(siteGate) && !diff.same
    if (differs && hasList(siteGate)) pf.push("own list differs from the site's")
    const widening = wideningEntries(siteGate, pageList)
    if (widening.length) pf.push(`own list tries to widen the site's: ${widening.join(", ")} (ignored)`)
    if (siteRequireOtp && !requireOtp) pf.push("site requires sign-in but this page does not")
    if (hasList(siteGate) && hasList(pageList) && hasList(effective) === false)
      pf.push("site ∩ page leaves NOBODY on the list")

    const r: PageReport = {
      id: p.id, slug: p.slug, owner, ownerMismatch, requireOtp,
      gateStoredAsString: read.storedAsString,
      gateRaw: read.storedAsString ? read.raw : undefined,
      gateRecovered: read.recovered,
      pageList, effective, differsFromSite: differs, diff, widening, flags: pf,
    }
    if (email) {
      if (!requireOtp) {
        r.email = { address: normEmail(email), allowed: true, reason: "page does not require sign-in" }
      } else {
        const d = admits(effective, email)
        r.email = { address: normEmail(email), allowed: d.allowed, reason: explain(d, effective, email) }
      }
    }
    return r
  })

  // No site list yet: say so when member pages disagree with each other — that is the drift
  // the site policy exists to end.
  if (!hasList(siteGate)) {
    const distinct = new Set(reports.filter((r) => hasList(r.pageList)).map((r) => describeList(r.pageList)))
    if (distinct.size > 1) flags.push(`no site list, and member pages carry ${distinct.size} different lists of their own`)
  }

  const anyFlag = flags.length > 0 || reports.some((r) => r.flags.length > 0)
  return {
    site: { id: site.id, slug: site.slug, name: site.name, owner: siteOwner },
    siteGate,
    siteGateStoredAsString: siteRead.storedAsString,
    siteRequireOtp,
    expectedOwner: expected,
    pages: reports,
    flags,
    ok: !anyFlag,
  }
}

// ----------------------------------------------------------------------------
// Access edits (settings.gate merge)
// ----------------------------------------------------------------------------

export interface AccessEdit {
  allowDomains?: string[]
  allowEmails?: string[]
  removeDomains?: string[]
  removeEmails?: string[]
  requireOtp?: boolean
}

export interface MergeResult {
  ok: boolean
  errors: string[]
  before: Gate | null
  after: Gate
  changes: string[]
  /** settings.gate was a string before this edit — the merge replaces it with an object */
  repairedString: boolean
}

/** Split repeatable/comma-separated flag values into a clean list. */
export function flagList(v: unknown): string[] {
  const arr = Array.isArray(v) ? v : v === undefined || v === null ? [] : [v]
  return arr.flatMap((x) => String(x).split(",")).map((s) => s.trim()).filter(Boolean)
}

/**
 * Merge an edit into settings.gate. Validates every entry locally and refuses the whole edit
 * on any bad one. Keeps unknown keys on the gate (showAllowedDomains, platformMemberRoles…).
 * A gate that was stored as a string is rebuilt from what it recognisably meant.
 */
export function mergeGate(current: unknown, edit: AccessEdit): MergeResult {
  const read = readGate(current)
  const base: Gate = read.gate ?? read.recovered ?? { allowedDomains: [], allowedEmails: [] }
  const errors: string[] = []

  const addD = (edit.allowDomains ?? []).map(normDomain)
  const remD = (edit.removeDomains ?? []).map(normDomain)
  const addE = (edit.allowEmails ?? []).map(normEmail)
  const remE = (edit.removeEmails ?? []).map(normEmail)

  for (const d of addD) {
    if (d.includes("@")) errors.push(`"${d}" looks like an email — use --allow-email`)
    else if (!isValidDomain(d)) errors.push(`"${d}" is not a valid domain`)
  }
  for (const e of addE) if (!isValidEmail(e)) errors.push(`"${e}" is not a valid email address`)

  const before: Gate | null = read.gate
    ? { ...read.gate, allowedDomains: [...read.gate.allowedDomains], allowedEmails: [...read.gate.allowedEmails] }
    : null
  const domains = uniq([...base.allowedDomains.filter((d) => !remD.includes(d)), ...addD])
  const emails = uniq([...base.allowedEmails.filter((e) => !remE.includes(e)), ...addE])
  const after: Gate = { ...base, allowedDomains: domains, allowedEmails: emails }
  if (edit.requireOtp !== undefined) after.requireOtp = edit.requireOtp

  const changes: string[] = []
  if (read.storedAsString) changes.push("gate was a string — rewritten as an object")
  for (const d of domains) if (!base.allowedDomains.includes(d)) changes.push(`+ @${d}`)
  for (const d of base.allowedDomains) if (!domains.includes(d)) changes.push(`- @${d}`)
  for (const e of emails) if (!base.allowedEmails.includes(e)) changes.push(`+ ${e}`)
  for (const e of base.allowedEmails) if (!emails.includes(e)) changes.push(`- ${e}`)
  for (const d of remD) if (!base.allowedDomains.includes(d)) changes.push(`(@${d} was not on the list)`)
  for (const e of remE) if (!base.allowedEmails.includes(e)) changes.push(`(${e} was not on the list)`)
  if (edit.requireOtp !== undefined && !!base.requireOtp !== edit.requireOtp)
    changes.push(`requireOtp: ${!!base.requireOtp} → ${edit.requireOtp}`)

  if (!errors.length && read.gate && hasList(read.gate) && !hasList(after))
    errors.push("this edit would empty the allow-list — an empty list lets ANY address sign in. Refused.")

  return { ok: errors.length === 0, errors, before, after, changes, repairedString: read.storedAsString }
}

/** Does the gate read back from the server equal what we sent? */
export function sameGate(a: unknown, b: Gate): boolean {
  const r = readGate(a)
  if (!r.gate) return false
  const sort = (x: string[]) => [...x].sort().join("|")
  return (
    sort(r.gate.allowedDomains) === sort(b.allowedDomains) &&
    sort(r.gate.allowedEmails) === sort(b.allowedEmails) &&
    !!r.gate.requireOtp === !!b.requireOtp
  )
}
