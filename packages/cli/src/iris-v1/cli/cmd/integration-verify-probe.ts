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
  "google-drive": { action: "search_files", params: { query: "a", pageSize: 1 }, label: "listing 1 file" },
  "google-calendar": { action: "get_events", params: { max_results: 1 }, label: "listing 1 event" },
  "google-docs": { action: "search_files", params: { query: "a", pageSize: 1 }, label: "listing 1 doc" },
  notion: { action: "search", params: { query: "", page_size: 1 }, label: "searching 1 page" },
  slack: { action: "list_channels", params: { limit: 1 }, label: "listing 1 channel" },
  dropbox: { action: "list_files", params: { limit: 1 }, label: "listing 1 file" },
  github: { action: "get_profile", params: {}, label: "reading the profile" },
  canva: { action: "list_designs", params: { limit: 1 }, label: "listing 1 design" },
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
