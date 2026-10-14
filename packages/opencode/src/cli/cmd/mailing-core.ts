/**
 * `iris mailing` — the pure half. Argument parsing, the request body, the send gate, and the
 * mapping from a server refusal to a sentence a non-technical sender can act on.
 *
 * Nothing in here touches the network or the terminal, so every rule that decides whether an
 * email leaves the building is testable without either (see mailing-core.test.ts). The command
 * file is a thin shell around these functions and irisFetch.
 *
 * Server: fl-iris-api /api/v1/mailings (epic #189371). The server does the rendering,
 * dedupe, exclusion and sending; this client never sends an email itself.
 */

// ── audiences ──────────────────────────────────────────────────────────────

export type Audience = { name: string; dataset_item_id: number } | { name: string; rows: Record<string, string>[] }

/**
 * `--audience members=186974` → a dataset item. `--audience guests=./guests.csv` → rows read
 * from a local CSV or JSON file (the reader is injected so this stays pure).
 */
export function parseAudience(raw: string, readFile?: (path: string) => string): Audience {
  const s = String(raw ?? "").trim()
  const eq = s.indexOf("=")
  if (eq <= 0 || eq === s.length - 1) {
    throw new UsageError(
      `--audience needs a name and a list, like  --audience members=186974  (got "${s || "nothing"}")`,
    )
  }
  const name = s.slice(0, eq).trim()
  const value = s.slice(eq + 1).trim()
  if (!/^[A-Za-z0-9 _-]+$/.test(name)) {
    throw new UsageError(`Audience name "${name}" — use letters, numbers, spaces, - or _ (e.g. members, prospects).`)
  }
  if (/^\d+$/.test(value)) return { name, dataset_item_id: Number(value) }
  if (/\.(csv|json)$/i.test(value)) {
    if (!readFile) throw new UsageError(`Cannot read ${value}.`)
    let text: string
    try {
      text = readFile(value)
    } catch {
      throw new UsageError(`Could not open ${value} — check the path.`)
    }
    const rows = /\.json$/i.test(value) ? rowsFromJson(text, value) : parseCsv(text)
    if (rows.length === 0) throw new UsageError(`${value} has no rows.`)
    return { name, rows }
  }
  throw new UsageError(
    `--audience ${name}=${value}: the part after "=" must be a list number (e.g. 186974) or a .csv/.json file.`,
  )
}

function rowsFromJson(text: string, path: string): Record<string, string>[] {
  let d: any
  try {
    d = JSON.parse(text)
  } catch {
    throw new UsageError(`${path} is not valid JSON.`)
  }
  const rows = Array.isArray(d) ? d : Array.isArray(d?.rows) ? d.rows : null
  if (!rows) throw new UsageError(`${path} must be a JSON array of rows (or {"rows": [...]}).`)
  return rows.map((r: any) => Object.fromEntries(Object.entries(r ?? {}).map(([k, v]) => [k, v == null ? "" : String(v)])))
}

/** RFC 4180-ish: quoted fields, doubled quotes, CRLF. First line is the header. */
export function parseCsv(text: string): Record<string, string>[] {
  const records: string[][] = []
  let field = ""
  let rec: string[] = []
  let q = false
  const t = text.replace(/^﻿/, "")
  for (let i = 0; i < t.length; i++) {
    const c = t[i]
    if (q) {
      if (c === '"' && t[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') q = false
      else field += c
    } else if (c === '"') q = true
    else if (c === ",") {
      rec.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && t[i + 1] === "\n") i++
      rec.push(field)
      records.push(rec)
      rec = []
      field = ""
    } else field += c
  }
  if (field !== "" || rec.length) {
    rec.push(field)
    records.push(rec)
  }
  const nonEmpty = records.filter((r) => r.some((v) => v.trim() !== ""))
  if (nonEmpty.length < 2) return []
  const [head, ...body] = nonEmpty
  const keys = head.map((h) => h.trim())
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])))
}

// ── --skip-status "Email Status=Extrapolated,Unavailable" ─────────────────────

export function parseSkipStatus(values: string[] | string | undefined): Record<string, string[]> | undefined {
  const list = (Array.isArray(values) ? values : values ? [values] : []).filter((v) => String(v).trim())
  if (!list.length) return undefined
  const out: Record<string, string[]> = {}
  for (const raw of list) {
    const s = String(raw)
    const eq = s.indexOf("=")
    if (eq <= 0) {
      throw new UsageError(`--skip-status needs a column and values, like  --skip-status "Email Status=Extrapolated,Unavailable"`)
    }
    const field = s.slice(0, eq).trim()
    const vals = s
      .slice(eq + 1)
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
    if (!vals.length) throw new UsageError(`--skip-status ${field}= lists no values to skip.`)
    out[field] = [...new Set([...(out[field] ?? []), ...vals])]
  }
  return out
}

export function parseEmails(values: string[] | string | undefined, flag: string): string[] {
  const list = (Array.isArray(values) ? values : values ? [values] : [])
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean)
  for (const e of list) {
    if (e !== "me" && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new UsageError(`${flag} ${e} is not an email address.`)
  }
  return [...new Set(list)]
}

// ── personalisation ───────────────────────────────────────────────────────────

export const REASON_DEFAULTS = {
  title_fields: ["Title", "Job Title"],
  company_fields: ["Company", "Company Name", "Organization"],
  fallback: "I thought this would be relevant to you.",
}

export type ReasonSpec = { title_fields: string[]; company_fields: string[]; fallback: string }

export function parsePersonalize(
  values: string[] | string | undefined,
  overrides: { titleField?: string; companyField?: string; fallback?: string } = {},
): ReasonSpec | undefined {
  const list = (Array.isArray(values) ? values : values ? [values] : []).flatMap((v) => String(v).split(","))
  const kinds = list.map((v) => v.trim().toLowerCase()).filter(Boolean)
  for (const k of kinds) {
    if (k !== "reason") throw new UsageError(`--personalize ${k}: the only option today is "reason" (a line from each person's title and company).`)
  }
  if (!kinds.includes("reason")) return undefined
  const split = (s?: string) => (s ? s.split(",").map((x) => x.trim()).filter(Boolean) : undefined)
  return {
    title_fields: split(overrides.titleField) ?? REASON_DEFAULTS.title_fields,
    company_fields: split(overrides.companyField) ?? REASON_DEFAULTS.company_fields,
    fallback: overrides.fallback?.trim() || REASON_DEFAULTS.fallback,
  }
}

// ── the create body ───────────────────────────────────────────────────────────

export type NewArgs = {
  subject?: string
  audience?: string[] | string
  exclude?: string[] | string
  "skip-status"?: string[] | string
  personalize?: string[] | string
  "title-field"?: string
  "company-field"?: string
  "reason-fallback"?: string
  "email-field"?: string
  "from-email"?: string
  "from-name"?: string
  "postal-address"?: string
  integration?: number | string
}

export function buildCreateBody(args: NewArgs, html: string, readFile?: (p: string) => string): Record<string, unknown> {
  const subject = String(args.subject ?? "").trim()
  if (!subject) throw new UsageError(`--subject is required, e.g.  --subject "You're invited: October 29"`)
  if (!html || !html.trim()) throw new UsageError("The template is empty.")
  const audiences = (Array.isArray(args.audience) ? args.audience : args.audience ? [args.audience] : []).map((a) =>
    parseAudience(a, readFile),
  )
  if (!audiences.length) throw new UsageError("Add at least one --audience, e.g.  --audience members=186974")
  const names = audiences.map((a) => a.name.toLowerCase())
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) throw new UsageError(`Two audiences are called "${dup}" — give each a different name.`)

  const body: Record<string, unknown> = { subject, html, audiences }
  const exclude = parseEmails(args.exclude, "--exclude").filter((e) => e !== "me")
  if (exclude.length) body.exclude = exclude
  const skip = parseSkipStatus(args["skip-status"])
  if (skip) body.exclude_statuses = skip
  const reason = parsePersonalize(args.personalize, {
    titleField: args["title-field"],
    companyField: args["company-field"],
    fallback: args["reason-fallback"],
  })
  if (reason) body.reason = reason
  if (args["email-field"]) body.email_field = String(args["email-field"])
  if (args["from-email"]) {
    const f = String(args["from-email"]).trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(f)) throw new UsageError(`--from-email ${f} is not an email address.`)
    body.from_email = f
  }
  if (args["from-name"]) body.from_name = String(args["from-name"])
  if (args["postal-address"]) body.footer = { postal_address: String(args["postal-address"]) }
  if (args.integration !== undefined && args.integration !== "") {
    const n = Number(args.integration)
    if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--integration must be a connection number (see: iris integrations list).`)
    body.integration_id = n
  }
  return body
}

/** `--template 189315` is an Atlas item; anything else is a file path. */
export function templateSource(raw: string | number | undefined): { kind: "item"; id: number } | { kind: "file"; path: string } {
  const s = String(raw ?? "").trim()
  if (!s) throw new UsageError("--template is required: an .html file, or the number of an Atlas item holding the email.")
  if (/^\d+$/.test(s)) return { kind: "item", id: Number(s) }
  return { kind: "file", path: s }
}

// ── reading what the server says ──────────────────────────────────────────────
//
// fl-iris-api MailingSender::summary():
//   counts: { <audience>: { total, sendable, dropped: {no_email, duplicate, excluded, suppressed},
//                           sent, failed, pending, suppressed, unknown } }
//   totals: { sendable, sent, failed, pending, suppressed, unknown }
//   status: draft | sending | paused | stopped | sent ; send_audiences: names the current send covers
//   placeholders_left: integer ; postal_address_missing: bool ; last_error

const n = (v: unknown): number => (typeof v === "number" && isFinite(v) ? v : Number(v) || 0)

type AudCounts = { name: string; c: any }

function audienceCounts(m: any): AudCounts[] {
  const src = m?.counts
  if (Array.isArray(src)) return src.map((a: any) => ({ name: String(a?.name ?? "?"), c: a ?? {} }))
  if (src && typeof src === "object") {
    return Object.entries(src)
      .filter(([, v]) => v && typeof v === "object")
      .map(([name, c]) => ({ name, c }))
  }
  return []
}

/** Ready (sendable) count per audience. */
export function readyByAudience(m: any): Array<{ name: string; ready: number }> {
  return audienceCounts(m).map(({ name, c }) => ({ name, ready: n(c.sendable ?? c.ready) }))
}

const REASON_WORDS: Record<string, string> = {
  no_email: "no email",
  duplicate: "already on the list",
  excluded: "held back by --exclude / --skip-status",
  suppressed: "unsubscribed earlier",
}

/** Dropped rows by reason, summed over audiences, e.g. "22 no email, 10 held back by …". */
export function droppedLine(m: any): string {
  const sum: Record<string, number> = {}
  for (const { c } of audienceCounts(m)) {
    for (const [k, v] of Object.entries(c?.dropped ?? {})) sum[k] = (sum[k] ?? 0) + n(v)
  }
  return Object.entries(sum)
    .filter(([, v]) => v > 0)
    .map(([k, v]) => `${v} ${REASON_WORDS[k] ?? k.replace(/_/g, " ")}`)
    .join(", ")
}

export function totalReady(m: any, only?: string[]): number {
  const rows = readyByAudience(m)
  if (!rows.length) return n(m?.totals?.sendable)
  const want = only?.length ? new Set(only.map((s) => s.toLowerCase())) : null
  return rows.filter((r) => !want || want.has(r.name.toLowerCase())).reduce((a, r) => a + r.ready, 0)
}

/** Names of {{placeholders}} still in a rendered sample — the server only counts them. */
export function placeholderNames(m: any): string[] {
  const names = new Set<string>()
  for (const s of Array.isArray(m?.sample) ? m.sample : []) {
    for (const x of `${s?.subject ?? ""} ${s?.html ?? ""}`.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) names.add(x[1])
  }
  return [...names]
}

/** How many messages still carry an unfilled {{placeholder}} (0 = none). */
export function placeholdersLeft(m: any): number {
  const p = m?.placeholders_left
  if (Array.isArray(p)) return p.length
  return n(p)
}

/** "Draft #12 — 101 members, 70 prospects ready." */
export function draftHeadline(m: any): string {
  const parts = readyByAudience(m).map((a) => `${a.ready} ${a.name}`)
  const ready = parts.length ? parts.join(", ") : `${totalReady(m)} people`
  const status = String(m?.status ?? "draft")
  const label = status === "draft" ? "Draft" : `Mailing (${status})`
  return `${label} #${m?.id ?? "?"} — ${ready} ready.`
}

export type Progress = { status: string; sent: number; failed: number; pending: number; unknown: number; total: number }

/**
 * Progress of the CURRENT send: only the audiences in send_audiences, so a members-only send
 * finishes at "0 to go" even though the prospects are still pending.
 */
export function progressOf(m: any): Progress {
  const scope = Array.isArray(m?.send_audiences) && m.send_audiences.length ? new Set(m.send_audiences.map((s: any) => String(s))) : null
  const auds = audienceCounts(m).filter((a) => !scope || scope.has(a.name))
  const sum = (k: string) => auds.reduce((a, { c }) => a + n(c?.[k]), 0)
  const t = auds.length ? null : m?.totals ?? {}
  const sent = t ? n(t.sent) : sum("sent")
  const failed = t ? n(t.failed) : sum("failed")
  const pending = t ? n(t.pending) : sum("pending")
  const unknown = t ? n(t.unknown) : sum("unknown")
  const total = t ? n(t.sendable) : sum("sendable")
  return { status: String(m?.status ?? "unknown"), sent, failed, pending, unknown, total }
}

/** Statuses after which nothing more will happen without the user acting. */
export const SETTLED = new Set(["sent", "paused", "stopped", "failed"])

export function isSettled(m: any): boolean {
  return SETTLED.has(String(m?.status ?? "").toLowerCase())
}

// ── the send gate ─────────────────────────────────────────────────────────────

export type GateResult = { go: true } | { go: false; reason: "declined" | "needs_yes" | "nobody" }

/**
 * Whether a send may go ahead. Order matters and is the point of the test file:
 * nobody to send to → no; --yes → yes; no terminal → refuse (never assume consent from a
 * script); otherwise ask, and only an explicit yes counts.
 */
export async function sendGate(opts: {
  count: number
  yes: boolean
  interactive: boolean
  ask: (question: string) => Promise<boolean>
}): Promise<GateResult> {
  if (!(opts.count > 0)) return { go: false, reason: "nobody" }
  if (opts.yes) return { go: true }
  if (!opts.interactive) return { go: false, reason: "needs_yes" }
  const ok = await opts.ask(`Send to ${opts.count} ${opts.count === 1 ? "person" : "people"}? (y/N)`)
  return ok === true ? { go: true } : { go: false, reason: "declined" }
}

// ── friendly errors ───────────────────────────────────────────────────────────

export type Friendly = { message: string; fix?: string[]; code: string; details?: string[] }

const CONNECT_MAILJET = [
  "iris integrations connect mailjet --field api_key=<API_KEY> --field api_secret=<SECRET_KEY>",
  "(the keys are in Mailjet → Account Settings → API Key Management)",
]

/**
 * A server refusal → one plain sentence and the command that fixes it. fl-iris-api's
 * MailingRefused sends {success:false, message, reason}; the reason code decides, and the
 * wording is a fallback for a server that only sends prose.
 */
export function friendlyError(status: number, body: any, ctx: { id?: string | number; names?: string[] } = {}): Friendly {
  const code = String(
    (typeof body?.reason === "string" ? body.reason : "") ||
      body?.code ||
      body?.error_code ||
      (typeof body?.error === "string" && /^[a-z0-9_]+$/.test(body.error) ? body.error : ""),
  )
  const text = [body?.message, typeof body?.error === "string" && body.error !== code ? body.error : ""].filter(Boolean).join(" ")
  const is = (...codes: string[]) => codes.includes(code)
  const says = (re: RegExp) => !code && re.test(text)
  const id = ctx.id ?? "<number>"

  if (status === 401 || is("unauthenticated")) {
    return { code: "auth", message: "You are not signed in to IRIS (or your sign-in expired).", fix: ["iris auth login --force"] }
  }
  if (is("no_mailjet", "mailjet_not_connected", "integration_not_found") || says(/mailjet.*(not connected|no .*connection)|connect .*mailjet/i)) {
    return {
      code: "mailjet_not_connected",
      message: is("integration_not_found")
        ? "That Mailjet connection does not exist on your account. Leave out --integration to use your own, or connect Mailjet:"
        : "Connect your Mailjet first — IRIS sends through your own Mailjet account.",
      fix: CONNECT_MAILJET,
    }
  }
  if (is("integration_inactive")) {
    return { code: code, message: "Your Mailjet connection is switched off or its keys stopped working. Connect it again:", fix: CONNECT_MAILJET }
  }
  if (is("integration_forbidden")) {
    return { code, message: "That Mailjet connection belongs to someone else. Leave out --integration to use your own." }
  }
  if (is("from_required", "no_sender") || says(/no (saved )?sender|from_email/i)) {
    return {
      code: "no_sender",
      message: "No sender address: tell IRIS which address the email comes from.",
      fix: [
        `Add it to the draft:  --from-email you@yourdomain.com --from-name "Your Name"`,
        "The address must be approved in Mailjet first (Account Settings → Sender addresses & domains).",
      ],
    }
  }
  if (is("from_invalid")) {
    return { code, message: text || "The sender address is not a valid email address.", fix: [`--from-email you@yourdomain.com`] }
  }
  if (is("placeholders_left") || says(/placeholder/i)) {
    const names = (ctx.names ?? []).map((p) => `{{${p}}}`)
    const count = n(body?.placeholders_left)
    return {
      code: "placeholders_left",
      message: names.length
        ? `The email still has blanks that no column fills: ${names.join(", ")}.`
        : `${count || "Some"} message(s) still have a blank {{…}} that no column fills. Nothing was sent.`,
      fix: [
        "Each {{Name}} must match a column in your list exactly (spelling and capitals).",
        "Fix the email or the column, then make a new draft:  iris mailing new …",
      ],
      details: ctx.names,
    }
  }
  if (is("dataset_not_found")) {
    return { code, message: text.replace(/^Dataset item/, "List") + " Check the number after the = in --audience." }
  }
  if (is("dataset_not_tabular")) {
    return { code, message: "That Atlas item is not a list of rows. Pass the number of a dataset (a table), or a .csv file." }
  }
  if (is("unknown_audience")) {
    return { code, message: text || `Mailing #${id} has no audience by that name.`, fix: [`iris mailing status ${id}`] }
  }
  if (is("nothing_to_send")) {
    return { code, message: `${text || "Nothing left to send."} Everyone in it has already been sent (or skipped).`, fix: [`iris mailing log ${id}`] }
  }
  if (is("already_sending")) {
    return { code, message: `Mailing #${id} is already sending.`, fix: [`iris mailing status ${id}`, `To stop it:  iris mailing pause ${id}`] }
  }
  if (is("not_sending")) {
    return { code, message: text || `Mailing #${id} is not sending, so there is nothing to pause.`, fix: [`iris mailing status ${id}`] }
  }
  if (is("confirm_required")) {
    return { code, message: "Not sent — the send was not confirmed." }
  }
  if (is("test_to_required", "invalid_test_address", "test_too_large", "no_recipients", "too_many_recipients", "audiences_required", "audience_name", "audience_rows", "audience_source", "subject_required", "html_required")) {
    return { code, message: text || "The server did not accept that." }
  }
  if (status === 404 || is("not_found")) {
    return { code: "not_found", message: `There is no mailing #${id} on your account.`, fix: ["iris mailing list"] }
  }
  if (status === 403) {
    return { code: code || "forbidden", message: text || "You do not have access to that list or mailing." }
  }
  if (status === 422 && body?.errors && typeof body.errors === "object") {
    const details = Object.entries(body.errors).map(([f, m]) => `${f}: ${(Array.isArray(m) ? m : [m]).join(", ")}`)
    return { code: "invalid", message: text || "The server did not accept that mailing.", details }
  }
  if (status === 429) return { code: "rate_limited", message: "Too many requests — wait a minute and try again." }
  if (status >= 500) {
    return {
      code: code || "server_error",
      message: text || `The mailing service hit an error (HTTP ${status}).`,
      fix: ctx.id ? [`Check where it stands:  iris mailing status ${ctx.id}`] : undefined,
    }
  }
  return { code: code || `http_${status}`, message: text || `The request failed (HTTP ${status}).` }
}

// ── CSV out ─────────────────────────────────────────────────────────────────────

export function toCsv(rows: Record<string, unknown>[], columns?: string[]): string {
  const cols = columns ?? [...new Set(rows.flatMap((r) => Object.keys(r)))]
  const cell = (v: unknown) => {
    const s = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v)
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\n") + "\n"
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "UsageError"
  }
}
