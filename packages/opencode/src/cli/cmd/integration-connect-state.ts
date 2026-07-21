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
 * Crucially, an unchanged pre-existing connection is NOT success — that was the
 * bug: re-authorising a broken integration always matched the very row the user
 * was trying to repair.
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

  for (const row of after) {
    if (!matchesType(row, type) || !isActive(row)) continue

    const id = row?.id ? String(row.id) : null
    const prior = id ? previousById.get(id) : undefined

    // Brand-new connection, or one that just transitioned into active.
    if (!prior || !isActive(prior)) return row
  }

  return null
}

/** Snapshot helper — normalises the various shapes the integrations endpoint returns. */
export function extractConnections(payload: any): ConnectionRow[] {
  const rows = payload?.connections ?? payload?.data ?? []

  return Array.isArray(rows) ? rows : []
}
