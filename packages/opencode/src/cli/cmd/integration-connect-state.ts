/**
 * Connection-state comparison for `iris integrations connect` (#171182).
 *
 * Kept as a pure module so the success/failure decision is unit-testable
 * without a browser, an OAuth round-trip, or a live API.
 */

export interface ConnectionRow {
  id?: string
  type?: string
  integration_type?: string
  name?: string
  status?: string
  /** Composio account behind this row. A re-authorisation mints a NEW one — see below. */
  connected_account_id?: string
}

function rowType(row: ConnectionRow): string {
  return String(row?.type ?? row?.integration_type ?? "").toLowerCase()
}

function isActive(row: ConnectionRow): boolean {
  return String(row?.status ?? "").toLowerCase() === "active"
}

function matchesType(row: ConnectionRow, type: string): boolean {
  const wanted = type.toLowerCase()
  if (rowType(row) === wanted) return true

  // Fall back to the display name only when no explicit type is present, so a
  // connection named e.g. "Gmail backup" still matches, but a typed row of a
  // different integration never does.
  return rowType(row) === "" && String(row?.name ?? "").toLowerCase().includes(wanted)
}

/**
 * Decide whether an authorisation actually succeeded.
 *
 * Returns the connection that proves it, or null. Success means one of:
 *   - a connection of this type exists now that did not exist before, and it is active
 *   - a connection that existed before is now active when it previously was not
 *
 *   - a connection kept its row and its active status, but the CREDENTIAL behind it
 *     changed — i.e. `connected_account_id` is one we had not seen for this type
 *
 * Crucially, an unchanged pre-existing connection is NOT success — that was the
 * bug: re-authorising a broken integration always matched the very row the user
 * was trying to repair.
 *
 * THE THIRD CASE IS WHY REPAIRS USED TO REPORT FAILURE (Emily, 2026-08-28).
 * `iris integrations connect gmail --yes` OVERWRITES the existing record rather than
 * creating one. So the row keeps its id, and `status` was already "active" — the local
 * status is a claim about a connection, not a test of it, and a dead credential sits at
 * "active" indefinitely (measured on Notion: rows marked active whose Composio accounts
 * were EXPIRED). Neither of the first two cases can fire, so a user who authorised
 * successfully in the browser was told:
 *
 *     No new connection detected — authorization did not complete
 *
 * ...which is the exact false negative the #171182 fix traded a false positive for.
 * Reconnecting always mints a NEW Composio connected-account id, so that id — not the
 * row id and not the status — is the thing that actually proves a fresh authorisation.
 */
export function detectNewConnection(
  before: ConnectionRow[] | undefined,
  after: ConnectionRow[] | undefined,
  type: string,
): ConnectionRow | null {
  if (!Array.isArray(after)) return null
  const previous = Array.isArray(before) ? before : []

  const previousById = new Map<string, ConnectionRow>()
  for (const row of previous) {
    if (row?.id) previousById.set(String(row.id), row)
  }

  // Every credential we had for this type BEFORE. An id absent from this set can only
  // have arrived from an authorisation that just happened.
  const priorAccounts = new Set<string>()
  for (const row of previous) {
    if (!matchesType(row, type)) continue
    const acct = row?.connected_account_id ? String(row.connected_account_id) : ""
    if (acct) priorAccounts.add(acct)
  }

  for (const row of after) {
    if (!matchesType(row, type) || !isActive(row)) continue

    const id = row?.id ? String(row.id) : null
    const prior = id ? previousById.get(id) : undefined

    // Brand-new connection, or one that just transitioned into active.
    if (!prior || !isActive(prior)) return row

    // Same row, still active — but a credential we had never seen. That is an overwrite
    // (`--yes`), the shape a REPAIR takes, and it is real success.
    const acct = row?.connected_account_id ? String(row.connected_account_id) : ""
    if (acct && !priorAccounts.has(acct)) return row
  }

  return null
}

/** Snapshot helper — normalises the various shapes the integrations endpoint returns. */
export function extractConnections(payload: any): ConnectionRow[] {
  const rows = payload?.connections ?? payload?.data ?? []

  return Array.isArray(rows) ? rows : []
}

/**
 * Should `connect` just print the authorize URL and stop?
 *
 * #182693. Without a terminal nobody can answer a prompt, see a browser we opened, or watch
 * a poll spinner for an authorisation they have no way to perform — so the URL is the only
 * useful output. `--print-url` already did exactly that; it simply was not the default in the
 * one situation that needs it, which is how a user in IRIS Desktop asked an agent to connect
 * an integration and got back nothing at all.
 */
export function shouldPrintUrlOnly(opts: { printUrl?: boolean; isTTY?: boolean }): boolean {
  return Boolean(opts.printUrl) || !opts.isTTY
}
