/**
 * Reading the integration stores — a pure module, deliberately free of imports so it can
 * be unit-tested without booting the CLI. See integration-stores.test.ts (#184152).
 *
 * THERE ARE TWO INTEGRATION STORES. fl-api and iris-api each keep their own `integrations`
 * table and both serve /api/v1/users/{id}/integrations. Only iris-api's rows can be
 * resolved by `execute-direct`, which is where every `integrations exec` call lands.
 *
 * So "which store holds this row" is not bookkeeping — it decides whether the connection
 * you are being shown can actually be used.
 */

export interface StoreRef {
  label: string
  base: string
  /**
   * Does `execute-direct` READ this store? Only iris-api's.
   *
   * Deliberately not called "executable". A row absent from this store certainly cannot
   * be resolved by exec; a row present in it is NOT thereby proven to work — it can still
   * lack a Composio account id and 400. Claiming otherwise would be the same overclaim
   * this module exists to remove.
   */
  inExecStore: boolean
}

export interface StoreRow {
  [k: string]: any
  store: string
  inExecStore: boolean
}

export interface StoreReadResult {
  /** Null ONLY when every store failed — a failed lookup, never an empty account. */
  rows: StoreRow[] | null
  /** Set when every store failed. */
  failure: string | null
  /** Stores that could not be read, when at least one other succeeded. */
  unreachable: string[]
  /** Rows in a store `execute-direct` does not read — exec cannot resolve these. */
  unreachableByExecCount: number
}

/** Extract the row array from the several envelope shapes these endpoints return. */
export function rowsFromEnvelope(body: any): any[] {
  const candidate = body?.connections ?? body?.data ?? body
  return Array.isArray(candidate) ? [...candidate] : []
}

/**
 * Read every store and label what came back.
 *
 * `read` is the only IO. It resolves to {ok, status, body} or throws, exactly as a fetch
 * wrapper does.
 */
export async function readIntegrationStores(
  stores: StoreRef[],
  read: (base: string) => Promise<{ ok: boolean; status: number; body?: any }>,
): Promise<StoreReadResult> {
  const rows: StoreRow[] = []
  const unreachable: string[] = []

  for (const store of stores) {
    try {
      const res = await read(store.base)
      if (!res.ok) {
        unreachable.push(`${store.label} (HTTP ${res.status})`)
        continue
      }
      for (const row of rowsFromEnvelope(res.body)) {
        rows.push({ ...row, store: store.label, inExecStore: store.inExecStore })
      }
    } catch (e) {
      unreachable.push(`${store.label} (${e instanceof Error ? e.message : String(e)})`)
    }
  }

  // Every store failed. This is a failed lookup and must never render as "none connected" —
  // that false negative is what sends people to re-run `connect`, and an abandoned OAuth
  // retry is the dominant cause of dead connections in the audit (#181228).
  if (unreachable.length === stores.length) {
    return {
      rows: null,
      failure: `could not reach any integration store: ${unreachable.join(", ")}`,
      unreachable,
      unreachableByExecCount: 0,
    }
  }

  return {
    rows,
    failure: null,
    unreachable,
    unreachableByExecCount: rows.filter((r) => !r.inExecStore).length,
  }
}

export interface StatusDisagreement {
  type: string
  /** store label -> the statuses that store reports for this type */
  byStore: Record<string, string[]>
}

/**
 * Find integration types that BOTH stores hold but disagree about.
 *
 * This is the instrument that was missing on 2026-09-08. Measured that day for one user:
 *
 *   iris-api (iris_db) gmail id=11, id=116, +2 more  -> ALL status=expired
 *   fl-api             gmail id=3, id=14             -> both status=active
 *
 * `execute-direct` runs on iris-api and filters `status='active'`, so it matched nothing and
 * answered "No active 'gmail' connection found". `list-connected` read fl-api, saw active, and
 * showed Gmail as connected. Neither was lying about its own database — and because no surface
 * ever compared them, the contradiction was invisible for weeks while the advised remedy
 * (`iris connect`) minted more rows.
 *
 * A connection that is simultaneously active and expired depending on which database you ask is
 * the single most confusing state this layer can produce. It is a second face of #182615, whose
 * first face was rows present in one database and absent from the other.
 *
 * Reporting it does not repair the split. It stops the split from being silent, which the
 * integration epic (#182330) argues has to come first: "while they are broken you cannot trust
 * any reading you take of the integration layer."
 */
export function findStatusDisagreements(rows: StoreRow[]): StatusDisagreement[] {
  const byType = new Map<string, Map<string, Set<string>>>()

  for (const row of rows) {
    const type = String(row.type ?? "").toLowerCase()
    if (!type) continue
    const status = String(row.status ?? "unknown").toLowerCase()
    if (!byType.has(type)) byType.set(type, new Map())
    const stores = byType.get(type)!
    if (!stores.has(row.store)) stores.set(row.store, new Set())
    stores.get(row.store)!.add(status)
  }

  const out: StatusDisagreement[] = []
  for (const [type, stores] of byType) {
    // Only a type present in MORE THAN ONE store can disagree across stores.
    if (stores.size < 2) continue
    const distinct = new Set<string>()
    for (const set of stores.values()) for (const s of set) distinct.add(s)
    if (distinct.size < 2) continue

    const byStore: Record<string, string[]> = {}
    for (const [label, set] of stores) byStore[label] = [...set].sort()
    out.push({ type, byStore })
  }
  return out.sort((a, b) => a.type.localeCompare(b.type))
}

/** One line a human can act on, naming both readings. */
export function describeDisagreement(d: StatusDisagreement): string {
  const parts = Object.entries(d.byStore)
    .map(([store, statuses]) => `${store}=${statuses.join("/")}`)
    .join("  vs  ")
  return `${d.type}: ${parts}`
}
