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
