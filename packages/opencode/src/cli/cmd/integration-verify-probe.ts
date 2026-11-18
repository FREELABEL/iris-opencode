/**
 * The read-only call that PROVES a freshly-authorised integration works.
 *
 * WHY THIS REPLACES A LIST DIFF (#182697, and the Notion mess of 2026-08-27).
 *
 * `connect` used to decide success by diffing the connections list before and after the
 * browser step. A diff can only ever tell you a ROW CHANGED. It cannot tell you the
 * credential works, and every failure we have hit here comes from that gap:
 *
 *   - a repair OVERWRITES a row, so nothing looks new and success reads as failure
 *   - the callback can land just after a 60s poll gives up — a race decides the verdict
 *   - `status: "active"` is a CLAIM, not a test. Measured on Notion: rows marked active
 *     with credentials present whose Composio accounts were EXPIRED (HTTP 410)
 *   - a connection can be perfectly live and pointed at the WRONG ACCOUNT entirely — a
 *     personal workspace instead of the client's — and a diff is blind to that too
 *
 * A real call has none of those failure modes. It either returns data or it does not.
 *
 * EVERY PROBE HERE MUST BE READ-ONLY AND CHEAP. This runs against a person's live account
 * seconds after they granted access; it is the first thing we ever do with their
 * credential, and it must not create, modify, send or delete anything. Page sizes are 1.
 */
export interface VerifyProbe {
  action: string
  params: Record<string, unknown>
  /** Human phrase for the success line — "verified by <label>". */
  label: string
}

const PROBES: Record<string, VerifyProbe> = {
  gmail: { action: "read_emails", params: { max_results: 1 }, label: "reading 1 message" },
  "google-drive": { action: "search_files", params: { query: "a", limit: 1 }, label: "listing 1 file" },
  "google-calendar": { action: "get_events", params: { max_results: 1 }, label: "listing 1 event" },
  "google-docs": { action: "search_files", params: { query: "a", limit: 1 }, label: "listing 1 doc" },
  notion: { action: "search", params: { query: "" }, label: "searching 1 page" },
  slack: { action: "list_channels", params: { limit: 1 }, label: "listing 1 channel" },
  dropbox: { action: "list_files", params: { limit: 1 }, label: "listing 1 file" },
  github: { action: "get_profile", params: {}, label: "reading the profile" },
  canva: { action: "list_designs", params: {}, label: "listing 1 design" },
  "servis-ai": { action: "list_account_users", params: {}, label: "listing account users" },
}

/** The probe for a toolkit, or null when we have no read-only call we trust for it. */
export function verifyProbeFor(type: string): VerifyProbe | null {
  return PROBES[String(type ?? "").toLowerCase()] ?? null
}

/**
 * Did a real call succeed?
 *
 * Deliberately strict: only an explicit `success: true` counts. An error envelope, a
 * transport failure, or an empty body is NOT success — treating "no error" as proof is how
 * a 401 became a green check in the first place.
 */
export function isProbeSuccess(payload: unknown): boolean {
  if (!payload || typeof payload !== "object") return false
  return (payload as { success?: unknown }).success === true
}

/**
 * Distinguish "the credential is bad" from "we were not allowed to ask".
 *
 * A probe that fails because the CLI could not authenticate says nothing about the user's
 * new integration, and must never be reported as a failed authorisation — that conflation
 * is exactly what made `integrations:verify-execute` report 0 of 9 working (#182581).
 */
export function isProbeInconclusive(status: number | undefined, payload: unknown): boolean {
  if (status === 401 || status === 403 || status === 404) return true
  const err = String((payload as { error?: unknown })?.error ?? "").toLowerCase()
  return err.includes("authentication required") || err.includes("unauthenticated") || err.includes("forbidden")
}

/** A connection row as the store reader labels it. */
export interface ConnectionRow {
  id?: number | string | null
  type?: string | null
  status?: string | null
  store?: string
  inExecStore?: boolean
}

export type ConnectionVerdict = {
  state: "verified" | "expired" | "error" | "unavailable"
  reason?: string
  fix?: string
}

/**
 * The map key for a row's verdict. The two stores number their rows independently, so an id alone
 * collides: fl-api's Drive #11 wrote its result over iris-api's Gmail #11, which is how Gmail, and
 * types with no check at all, came to report a Drive probe's 404 (#191975).
 */
export function connectionKey(row: ConnectionRow): string {
  return `${row.store ?? "?"}:${row.id ?? `type:${row.type}`}`
}

/** Provider answers that mean the grant is dead, in the codes execute-direct itself keys on. */
const EXPIRED = /expired|revoked|invalid_grant|\b1820\b|ConnectedAccountNotFound/i

/**
 * What one real call said about one connection. Only an answer from the provider's side is
 * evidence about the integration: a 404, a 5xx, a timeout or our own 401 means we could not ask.
 */
export function classifyProbeAnswer(
  type: string,
  status: number | undefined,
  body: unknown,
  opts: { label?: string; id?: number | string | null } = {},
): ConnectionVerdict {
  if (isProbeSuccess(body)) return { state: "verified", reason: `read-only check passed: ${opts.label ?? "a read"}` }

  const b = (body ?? {}) as { error?: unknown; message?: unknown }
  const said = String(b.error ?? b.message ?? "").trim()
  if (status === 410 || EXPIRED.test(said)) {
    return { state: "expired", reason: said.slice(0, 160) || "the provider refused the grant", fix: `iris integrations connect ${type}` }
  }
  if (status === undefined || status === 408 || status === 429 || status >= 500 || isProbeInconclusive(status, body)) {
    return { state: "unavailable", reason: `the check got HTTP ${status ?? "no answer"}, which says nothing about the integration` }
  }
  // Refused, by the server or the provider, with a reason. A 2xx with no verdict is not a pass.
  if (!said) return { state: "unavailable", reason: `the check got HTTP ${status} with no verdict` }
  const account = opts.id ? ` --integration-id=${opts.id}` : ""
  return { state: "error", reason: said.slice(0, 160), fix: `iris integrations exec ${type} ${verifyProbeFor(type)?.action ?? ""}${account} --dry-run` }
}

/**
 * Check ONE connection through ITS OWN account. Returns null when there is nothing to check: a row
 * that is not active, or a type with no trusted read-only call.
 */
export async function checkConnection(
  row: ConnectionRow,
  exec: (body: Record<string, unknown>) => Promise<{ status: number; body: unknown }>,
): Promise<ConnectionVerdict | null> {
  const type = String(row.type ?? "").toLowerCase()
  const status = String(row.status ?? "").toLowerCase()
  if (status === "expired") {
    return { state: "expired", reason: "marked expired", fix: `iris integrations connect ${type}` }
  }
  const probe = verifyProbeFor(type)
  if (status !== "active" || !probe) return null
  if (row.inExecStore === false) {
    return { state: "unavailable", reason: "this row is in fl-api's store, which integrations exec does not read" }
  }
  const body: Record<string, unknown> = { integration: type, action: probe.action, params: probe.params }
  if (row.id) body.integration_id = row.id
  try {
    const r = await exec(body)
    return classifyProbeAnswer(type, r.status, r.body, { label: probe.label, id: row.id })
  } catch (e) {
    return { state: "unavailable", reason: `the check could not reach iris-api: ${e instanceof Error ? e.message : String(e)}`.slice(0, 160) }
  }
}

/** What the list prints for a row. Plain text and a tone, so it can be tested without a terminal. */
export function statusLabelFor(
  row: ConnectionRow,
  v: ConnectionVerdict | null,
): { text: string; tone: "good" | "bad" | "warn" | "dim"; detail?: string } {
  const withFix = (reason: string | undefined, fix: string | undefined) =>
    [reason, fix ? `run: ${fix}` : ""].filter(Boolean).join(" — ") || undefined
  if (v?.state === "verified") return { text: "[connected]", tone: "good", detail: v.reason }
  if (v?.state === "expired") return { text: "[expired]", tone: "bad", detail: withFix(v.reason, v.fix) }
  if (v?.state === "error") return { text: "[failed]", tone: "warn", detail: withFix(v.reason, v.fix) }
  if (v?.state === "unavailable") return { text: "[check unavailable]", tone: "dim", detail: v.reason }
  const status = String(row.status ?? "unknown")
  return { text: status === "active" ? "[active, not checked]" : `[${status}]`, tone: "dim" }
}
