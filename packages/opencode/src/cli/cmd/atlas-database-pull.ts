/**
 * SUPABASE → ATLAS, the pure half of `iris atlas:database pull` (#186475).
 *
 * X-ART decided their warehouse is Supabase (Postgres) and that the vector/intelligence layer is
 * IRIS, not Supabase (dev sync, 14 Sep, Atlas item #185408). That decision is the whole shape of
 * this prototype: we do NOT copy their warehouse, and we do not ask them to move it. We mirror the
 * few tables IRIS needs to reason over into an Atlas dataset, incrementally, keyed so that re-runs
 * merge instead of duplicating.
 *
 * Everything here is a pure function of its inputs: query building, row mapping, cursor advance and
 * schema inference. The runner (the pull command) does the network and the disk, so the parts that decide
 * WHAT gets copied can be tested without a database or a key.
 *
 * Reading is over PostgREST — the REST API every Supabase project exposes — so this needs no
 * Postgres driver, no connection string, and no inbound access to their database.
 */

export type Row = Record<string, unknown>

/** Postgres/PostgREST identifiers we are willing to interpolate. Anything else is refused. */
export const IDENT = /^[a-z_][a-z0-9_]*$/i

export function assertIdent(name: unknown, what: string): string {
  const s = String(name ?? "")
  if (!IDENT.test(s)) throw new Error(`unsafe ${what}: ${JSON.stringify(name)} — expected a plain identifier`)
  return s
}

/**
 * One page of rows, newer than the cursor, oldest first.
 *
 * ORDER MATTERS AND IS NOT DECORATION. Paging by a cursor only works if rows arrive in cursor
 * order; without `order=`, PostgREST may return them in any order and a page boundary would skip
 * rows silently — the kind of gap nobody notices until a number is wrong months later.
 */
export function buildQuery({ baseUrl, table, cursorField, since, limit = 500, select = "*" }: { baseUrl: string; table: string; cursorField: string; since?: string | null; limit?: number | string; select?: string }): string {
  const t = assertIdent(table, "table name")
  const c = assertIdent(cursorField, "cursor field")
  const url = new URL(`${String(baseUrl).replace(/\/+$/, "")}/rest/v1/${t}`)
  url.searchParams.set("select", select)
  url.searchParams.set("order", `${c}.asc`)
  // A limit of 0, a negative, or a non-number means "not specified" and falls back to the default.
  // It must never mean a literal 0: that would fetch nothing on every run, advance no cursor, and
  // report success — a mirror that is silently doing nothing looks exactly like one that is current.
  const n = Number(limit)
  const size = Number.isFinite(n) && n > 0 ? Math.min(10000, Math.floor(n)) : 500
  url.searchParams.set("limit", String(size))
  if (since) url.searchParams.set(c, `gt.${since}`)
  return url.toString()
}

/**
 * Rows → Atlas records.
 *
 * `external_id` is the source row's own id, so importing the same row twice updates it instead of
 * adding a second copy (`atlas:datasets import` upserts on external_id). A row with no id is
 * DROPPED rather than given a generated one: an invented key turns one row into a new record on
 * every run, which looks like growth and is duplication.
 */
export function toRecords(rows: Row[] | null | undefined, { idField = "id", table }: { idField?: string; table?: string } = {}): { records: Array<{ external_id: string; data: Row }>; skipped: Row[] } {
  const out: Array<{ external_id: string; data: Row }> = []
  const skipped: Row[] = []
  for (const row of rows ?? []) {
    const id = (row as any)?.[idField]
    if (id === undefined || id === null || String(id) === "") {
      skipped.push(row)
      continue
    }
    out.push({ external_id: `${table ? `${table}:` : ""}${id}`, data: row })
  }
  return { records: out, skipped }
}

/**
 * The cursor for the next run.
 *
 * NEVER GOES BACKWARDS. A late-arriving row with an older timestamp would otherwise rewind the
 * cursor and re-import everything after it — and an unparseable value would rewind it to nothing.
 * Returns the previous cursor unchanged when this page carries nothing newer.
 */
export function nextCursor(rows: Row[] | null | undefined, cursorField: string, previous: string | null = null): string | null {
  let best: string | null = previous
  let bestT = previous ? Date.parse(previous) : Number.NEGATIVE_INFINITY
  if (!Number.isFinite(bestT)) bestT = Number.NEGATIVE_INFINITY
  for (const row of rows ?? []) {
    const v = (row as any)?.[cursorField]
    if (v === undefined || v === null) continue
    const t = Date.parse(String(v))
    if (!Number.isFinite(t)) continue
    if (t > bestT) {
      bestT = t
      best = String(v)
    }
  }
  return best
}

/** Did this page fill the limit? Then there is more to fetch — the only honest "keep going" signal. */
export const hasMore = (rows: unknown, limit: number): boolean => Array.isArray(rows) && rows.length >= limit

const isIso = (v: unknown): boolean => typeof v === "string" && /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v) && Number.isFinite(Date.parse(v))

/**
 * A dataset schema inferred from real rows.
 *
 * Inference is a convenience for the FIRST run only, and it says so: a column that is null in every
 * sampled row is typed `text` because nothing observed says otherwise — stated, not hidden, so
 * nobody believes a guess was a reading.
 */
export function schemaFromRows(rows: Row[] | null | undefined, { max = 200 }: { max?: number } = {}): Array<{ key: string; label: string; type: string; inferred_from_nulls_only: boolean }> {
  const fields = new Map<string, { key: string; type: string | null; sawNull: boolean; label: string }>()
  const sample = (rows ?? []).slice(0, max)
  for (const row of sample) {
    for (const [key, value] of Object.entries(row ?? {})) {
      if (!IDENT.test(key)) continue
      const seen = fields.get(key) ?? { key, type: null, sawNull: false, label: key.replace(/_/g, " ") }
      if (value === null || value === undefined) seen.sawNull = true
      else {
        const t = typeof value === "number" ? "number" : typeof value === "boolean" ? "boolean" : isIso(value) ? "date" : "text"
        // A column that is ever text stays text: widening beats a type that rejects real rows.
        seen.type = seen.type === null || seen.type === t ? t : "text"
      }
      fields.set(key, seen)
    }
  }
  return [...fields.values()].map((f) => ({
    key: f.key,
    label: f.label,
    type: f.type ?? "text",
    inferred_from_nulls_only: f.type === null,
  }))
}

/** Never print a key. Used on every line this script logs. */
export function redact(text: unknown, secrets: Array<string | null | undefined> = []): string {
  let s = String(text ?? "")
  for (const secret of secrets) {
    const v = String(secret ?? "")
    if (v.length >= 8) s = s.split(v).join(`${v.slice(0, 4)}…redacted`)
  }
  return s
}

/**
 * What a run would do, said before it does it.
 *
 * A mirror that prints "done" tells you nothing about whether it copied 3 rows or 300,000, and the
 * difference is usually a misconfigured cursor.
 */
export function summarize({ table, fetched, records, skipped, from, to }: { table: string; fetched: number; records: number; skipped: number; from: string | null; to: string | null }) {
  return {
    table,
    fetched,
    imported: records,
    skipped_no_id: skipped,
    cursor_from: from ?? "(beginning)",
    cursor_to: to ?? from ?? "(unchanged)",
    advanced: Boolean(to && to !== from),
  }
}
