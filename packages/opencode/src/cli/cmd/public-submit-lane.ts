// ============================================================================
// Public submit lanes — pure helpers (#192478)
//
// A dataset opts in to a public, write-only lane through its own settings, under
// `public_submit`. The server side is fl-iris-api App\Support\PublicSubmissions; this file
// builds and checks that block, so `iris datasets public-submit` can turn a dataset into a
// public intake in one command instead of a hand-written JSON blob.
//
// Pure on purpose: no network, so every rule here is testable on its own.
// ============================================================================

export interface LaneConfig {
  enabled: boolean
  page: string
  collection: string
  aliases?: Record<string, string>
  set?: Record<string, string | number | boolean | null>
  require_any?: string[]
  origins?: string[]
  ref_prefix?: string
  per_sender?: number
  per_hour?: number
  /** Staff told by email when a submission arrives (max 5). The email carries a reference and a link, never the sender's words. */
  notify_emails?: string[]
  /** Where that email links (a heyiris.io/p/ page); defaults to the lane's page. */
  notify_link?: string
  /** What staff may change on a submission, and which statuses are allowed. */
  staff_update?: { fields?: string[]; statuses?: string[] }
}

/** The ceilings fl-iris-api enforces whatever the settings say. Kept here so `show` tells the truth. */
export const MAX_PER_SENDER = 20
export const MAX_PER_HOUR = 1000

const SLUG = /^[a-z0-9][a-z0-9-]{0,190}$/
const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/
const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/

export type LaneOptions = {
  page?: string
  collection?: string
  alias?: string[]
  set?: string[]
  require?: string[]
  origin?: string[]
  refPrefix?: string
  perSender?: number
  perHour?: number
  /** Emails to alert on a new submission; ["none"] clears the list. */
  notify?: string[]
  notifyLink?: string
  /** Statuses staff may set (comma-separated or repeated); ["any"] clears the restriction. */
  statuses?: string[]
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
const STATUS = /^[a-z][a-z0-9_-]{0,39}$/
const MAX_NOTIFY = 5

function pairs(list: string[] | undefined, label: string, errors: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const raw of list ?? []) {
    const i = raw.indexOf("=")
    const k = i > 0 ? raw.slice(0, i).trim() : ""
    const v = i > 0 ? raw.slice(i + 1).trim() : ""
    if (!KEY.test(k) || v === "") {
      errors.push(`--${label} '${raw}' must look like key=value`)
      continue
    }
    out[k] = v
  }
  return out
}

/** "true"/"false"/numbers become real values; everything else stays a string. */
export function scalar(v: string): string | number | boolean | null {
  if (v === "true") return true
  if (v === "false") return false
  if (v === "null") return null
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v)
  return v
}

/**
 * The lane block to store: the existing one with the given options applied. Options not given
 * keep their current value, so `enable --per-sender 10` does not erase the aliases.
 */
export function buildLane(
  existing: Partial<LaneConfig> | null | undefined,
  opts: LaneOptions,
  schemaFields: string[],
): { lane?: LaneConfig; errors: string[]; warnings: string[] } {
  const errors: string[] = []
  const warnings: string[] = []
  const prev = existing ?? {}

  const page = (opts.page ?? prev.page ?? "").trim()
  const collection = (opts.collection ?? prev.collection ?? "").trim()
  if (!SLUG.test(page)) errors.push("--page must be the published page's slug (lowercase letters, digits, dashes)")
  if (!SLUG.test(collection)) errors.push("--collection must be lowercase letters, digits or dashes (e.g. submissions)")

  const aliases = { ...(prev.aliases ?? {}), ...pairs(opts.alias, "alias", errors) }
  const setRaw = pairs(opts.set, "set", errors)
  const set: Record<string, string | number | boolean | null> = { ...(prev.set ?? {}) }
  for (const [k, v] of Object.entries(setRaw)) set[k] = scalar(v)

  const requireAny = opts.require?.length
    ? opts.require.flatMap((r) => r.split(",")).map((r) => r.trim()).filter(Boolean)
    : (prev.require_any ?? [])

  const origins = [...new Set([...(prev.origins ?? []), ...(opts.origin ?? []).map((o) => o.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))])]
  for (const o of origins) if (!HOST.test(o)) errors.push(`--origin '${o}' is not a host name (e.g. example.com)`)

  // Field names must exist on the schema — the server keeps only declared keys, so a typo here
  // would silently drop that data on every submission.
  const known = new Set(schemaFields)
  if (known.size) {
    for (const [from, to] of Object.entries(aliases)) {
      if (!known.has(to)) errors.push(`--alias ${from}=${to}: '${to}' is not a field on this dataset`)
    }
    for (const k of Object.keys(set)) {
      if (!known.has(k)) errors.push(`--set ${k}: '${k}' is not a field on this dataset`)
    }
    for (const k of requireAny) {
      if (!known.has(k)) errors.push(`--require ${k}: '${k}' is not a field on this dataset`)
    }
  }
  if (!requireAny.length) {
    warnings.push("No --require: an empty submission would be saved. Name at least one field a real sender always fills.")
  }

  const refPrefix = (opts.refPrefix ?? prev.ref_prefix ?? "").trim().toUpperCase()
  if (refPrefix && !/^[A-Z]{2,8}$/.test(refPrefix)) errors.push("--ref-prefix must be 2–8 letters (e.g. INTAKE)")

  const perSender = opts.perSender ?? prev.per_sender ?? 5
  const perHour = opts.perHour ?? prev.per_hour ?? 200
  if (!Number.isInteger(perSender) || perSender < 1) errors.push("--per-sender must be a whole number ≥ 1")
  if (!Number.isInteger(perHour) || perHour < 1) errors.push("--per-hour must be a whole number ≥ 1")
  if (perSender > MAX_PER_SENDER) warnings.push(`--per-sender ${perSender} is capped at ${MAX_PER_SENDER} by the server`)
  if (perHour > MAX_PER_HOUR) warnings.push(`--per-hour ${perHour} is capped at ${MAX_PER_HOUR} by the server`)

  if (errors.length) return { errors, warnings }

  const lane: LaneConfig = { enabled: true, page, collection }
  if (Object.keys(aliases).length) lane.aliases = aliases
  if (Object.keys(set).length) lane.set = set
  if (requireAny.length) lane.require_any = requireAny
  if (origins.length) lane.origins = origins
  if (refPrefix) lane.ref_prefix = refPrefix
  lane.per_sender = perSender
  lane.per_hour = perHour

  // Alert + staff settings: kept as they were unless an option names them.
  const split = (l: string[]) => l.flatMap((x) => String(x).split(",")).map((x) => x.trim()).filter(Boolean)
  let notify = prev.notify_emails ?? []
  if (opts.notify?.length) {
    const asked = split(opts.notify)
    notify = asked.length === 1 && asked[0].toLowerCase() === "none" ? [] : [...new Set(asked.map((e) => e.toLowerCase()))]
    for (const e of notify) if (!EMAIL.test(e)) errors.push(`--notify '${e}' is not an email address`)
    if (notify.length > MAX_NOTIFY) errors.push(`--notify takes at most ${MAX_NOTIFY} addresses`)
  }
  const notifyLink = (opts.notifyLink ?? prev.notify_link ?? "").trim()
  if (notifyLink && !/^https:\/\/(www\.)?heyiris\.io\/p\//.test(notifyLink)) errors.push("--notify-link must be a https://heyiris.io/p/… page")
  const staff = { ...(prev.staff_update ?? {}) }
  if (opts.statuses?.length) {
    const asked = split(opts.statuses).map((x) => x.toLowerCase())
    if (asked.length === 1 && asked[0] === "any") delete staff.statuses
    else {
      for (const st of asked) if (!STATUS.test(st)) errors.push(`--statuses '${st}' must be lowercase letters, digits, - or _`)
      staff.statuses = [...new Set(asked)]
    }
  }
  if (errors.length) return { errors, warnings }
  if (notify.length) lane.notify_emails = notify
  if (notifyLink) lane.notify_link = notifyLink
  if (Object.keys(staff).length) lane.staff_update = staff
  return { lane, errors, warnings }
}

/**
 * The settings blob to send: every other key kept, only `public_submit` replaced. The schema
 * update endpoint replaces settings WHOLESALE, so sending just the lane would erase an
 * onboarding flow, a row policy or anything else living there.
 */
export function mergeSettings(current: unknown, lane: LaneConfig | null): Record<string, unknown> {
  const base = current && typeof current === "object" && !Array.isArray(current) ? { ...(current as Record<string, unknown>) } : {}
  if (lane === null) {
    const prev = base.public_submit
    if (prev && typeof prev === "object") base.public_submit = { ...(prev as object), enabled: false }
    return base
  }
  base.public_submit = lane
  return base
}

export function laneUrl(irisApi: string, page: string, collection: string): string {
  return `${irisApi.replace(/\/+$/, "")}/api/v1/app-data/${encodeURIComponent(page)}/${encodeURIComponent(collection)}`
}

/** A copy-paste snippet for a hand-written page: posts the record, shows the server's reference. */
export function fetchSnippet(path: string, fields: string[]): string {
  const sample = fields.slice(0, 3).map((f) => `${f}: form.${f}.value`).join(", ")
  return [
    `fetch("${path}", {`,
    `  method: "POST",`,
    `  headers: { "Content-Type": "application/json", Accept: "application/json" },`,
    `  body: JSON.stringify({ ${sample}${sample ? ", " : ""}website: form.website.value /* hidden honeypot */ }),`,
    `}).then((r) => r.json()).then((b) => b.success && alert("Received: " + b.data.submission_ref))`,
  ].join("\n")
}

/**
 * What `test` concluded from posting the honeypot probe. The probe is a submission whose hidden
 * `website` field is filled: a live lane answers 201 and saves NOTHING; no lane falls through to
 * the ordinary app-data write, which wants a session.
 */
export function readProbe(status: number, body: any): { live: boolean; message: string } {
  if (status === 201 && body?.success === true && body?.data && body.data.id == null) {
    return { live: true, message: "Lane is live — it answered the probe and saved nothing." }
  }
  if (status === 401) return { live: false, message: "No lane answered: the page/collection is not a declared lane (or the dataset is not opted in)." }
  if (status === 403 && body?.reason === "bad_origin") return { live: true, message: "Lane is live but refused this origin." }
  if (status === 429) return { live: true, message: "Lane is live but rate-limited this address — try again in a few minutes." }
  if (status === 201) return { live: true, message: "Lane answered 201 but returned a record id — the probe may have been SAVED. Check the dataset." }
  return { live: false, message: `Unexpected answer: HTTP ${status}${body?.error ? ` — ${body.error}` : ""}` }
}

// ── Working the queue (#192612) ─────────────────────────────────────────────────────────────

/** One line per queue row: reference, when, status, assignee, and who it is about. */
export function queueLine(r: Record<string, any>): string {
  const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || r.patient_name || r.name || "—"
  const when = String(r.submitted_at ?? r.created_at ?? r.last_activity ?? "").slice(0, 10) || "—"
  const ref = r.submission_ref ?? r.case_id ?? `#${r.id}`
  const status = r.review_status ?? r.stage_name ?? "—"
  return [String(r.id ?? "").padEnd(8), String(ref).padEnd(20), when.padEnd(11), String(status).padEnd(18), String(r.assigned_to ?? "").padEnd(12), name].join(" ")
}

/** The staff edit to send. Null when nothing was asked for. */
export function reviewPayload(opts: { status?: string; assign?: string; decision?: string; note?: string }): Record<string, string> | null {
  const out: Record<string, string> = {}
  if (opts.status !== undefined) out.review_status = String(opts.status).trim().toLowerCase()
  if (opts.assign !== undefined) out.assigned_to = String(opts.assign).trim()
  if (opts.decision !== undefined) out.decision = String(opts.decision).trim()
  if (opts.note !== undefined && String(opts.note).trim() !== "") out.note = String(opts.note).trim()
  return Object.keys(out).length ? out : null
}
