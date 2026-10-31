/**
 * DATASET RECORDS, ROUND TRIP (#189972) — the local copy of an Atlas dataset that `pull`, `push`
 * and `sync` keep in step with the server, and that the Hive daemon syncs in the background.
 *
 * Pure planning only: what to do given the server's changes, the local files and the last synced
 * versions ("bases"). The commands do the I/O. The rules, each one because the alternative loses
 * someone's edit:
 *
 *   1. A PULL NEVER OVERWRITES A LOCAL EDIT. An edited record is merged field by field against its
 *      base (three-way). A field both sides changed differently keeps the LOCAL value and is named
 *      as a conflict; the record is then held back from push until the conflict is cleared.
 *   2. ABSENCE IS NOT DELETION. A record file that is missing is unmentioned, not condemned; push
 *      deletes it on the server only with --prune.
 *   3. A PUSH NAMES ITS BASE. Every update carries the revision it was made against; the server
 *      refuses it (409) if the record moved since, and the fix is pull (merge) then push.
 *   4. THE FEED MAY REPEAT. A change at a revision already held is skipped, so reading the same
 *      change twice does nothing.
 */

export type Data = Record<string, unknown>

/** One entry from GET /v1/atlas/datasets/{slug}/changes. */
export type Change =
  | { id: number; revision: number; deleted: true; external_id?: string | null }
  | { id: number; revision: number; deleted: false; status: string; data: Data; external_id?: string | null }

/** A record file on disk. id is null for a record written locally and never published. */
export interface LocalRecord {
  id: number | null
  file: string
  status: string
  data: Data
}

/** The server's version of a record as of the last sync — what both sides changed FROM. */
export interface Base {
  id: number
  revision: number
  status: string
  data: Data
}

export type RecordState = "local-only" | "synced" | "modified" | "behind" | "diverged" | "deleted-locally"

/** Canonical JSON: key order does not make two values different. */
export function canon(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.keys(x as Data)
          .sort()
          .map((k) => [k, norm((x as Data)[k])]),
      )
    }
    return x
  }
  return JSON.stringify(norm(v))
}

const same = (a: unknown, b: unknown) => canon(a) === canon(b)
const ABSENT = Symbol("absent")

/** Three-way merge of two records' data against their common base, field by field. */
export function merge3(base: Data, local: Data, remote: Data): { merged: Data; conflicts: string[] } {
  const merged: Data = {}
  const conflicts: string[] = []
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort()
  for (const k of keys) {
    const b = k in base ? base[k] : ABSENT
    const l = k in local ? local[k] : ABSENT
    const r = k in remote ? remote[k] : ABSENT
    let out: unknown
    if (same(l, r)) out = l
    else if (same(l, b)) out = r // only the server changed it
    else if (same(r, b)) out = l // only you changed it
    else {
      out = l // both changed it differently: yours stays, and it is named
      conflicts.push(k)
    }
    if (out !== ABSENT) merged[k] = out
  }
  return { merged, conflicts }
}

// Status (active/archived) is the server's: the update endpoint does not take it, so a local
// copy follows it and only `data` is merged and pushed.
const content = (r: { data: Data }) => canon(r.data)

export function recordState(local: LocalRecord | undefined, base: Base | undefined, remoteRevision?: number): RecordState {
  if (local && local.id === null) return "local-only"
  if (!local) return "deleted-locally"
  if (!base) return "local-only"
  const edited = content(local) !== content(base)
  const behind = remoteRevision !== undefined && remoteRevision > base.revision
  if (edited && behind) return "diverged"
  if (behind) return "behind"
  return edited ? "modified" : "synced"
}

export type PullAction =
  | { id: number; action: "write"; local: Data; status: string; base: Base }
  | { id: number; action: "merge"; local: Data; status: string; base: Base; conflicts: string[] }
  | { id: number; action: "remove" }
  | { id: number; action: "keep-deleted-remotely" }
  | { id: number; action: "skip" }

export function planPull(changes: Change[], locals: LocalRecord[], bases: Base[]): PullAction[] {
  const localById = new Map(locals.filter((l) => l.id !== null).map((l) => [l.id as number, l]))
  const baseById = new Map(bases.map((b) => [b.id, b]))
  const out: PullAction[] = []
  for (const c of changes) {
    const b = baseById.get(c.id)
    const l = localById.get(c.id)
    if (b && c.revision <= b.revision) {
      out.push({ id: c.id, action: "skip" })
      continue
    }
    const edited = !!(l && b && content(l) !== content(b))
    if (c.deleted) {
      out.push({ id: c.id, action: edited ? "keep-deleted-remotely" : "remove" })
      continue
    }
    const nextBase: Base = { id: c.id, revision: c.revision, status: c.status, data: c.data }
    let act: Extract<PullAction, { action: "write" | "merge" }>
    if (!edited || !l || !b) {
      act = { id: c.id, action: "write", local: c.data, status: c.status, base: nextBase }
    } else {
      const m = merge3(b.data, l.data, c.data)
      act = { id: c.id, action: "merge", local: m.merged, status: c.status, base: nextBase, conflicts: m.conflicts }
    }
    out.push(act)
    // A later entry for the same id in this page builds on this one.
    baseById.set(c.id, nextBase)
    if (l) localById.set(c.id, { ...l, status: act.status, data: act.local })
  }
  return out
}

export type PushAction =
  | { action: "create"; file: string; data: Data }
  | { action: "update"; id: number; file: string; data: Data; status: string; baseRevision: number }
  | { action: "delete"; id: number; baseRevision: number }
  | { action: "blocked"; id: number; reason: string }

export function planPush(locals: LocalRecord[], bases: Base[], opts: { prune: boolean; conflicted: number[] }): PushAction[] {
  const baseById = new Map(bases.map((b) => [b.id, b]))
  const conflicted = new Set(opts.conflicted)
  const seen = new Set<number>()
  const out: PushAction[] = []
  for (const l of locals) {
    if (l.id === null) {
      out.push({ action: "create", file: l.file, data: l.data })
      continue
    }
    seen.add(l.id)
    const b = baseById.get(l.id)
    if (!b || content(l) === content(b)) continue
    if (conflicted.has(l.id)) {
      out.push({ action: "blocked", id: l.id, reason: "unresolved conflict" })
      continue
    }
    out.push({ action: "update", id: l.id, file: l.file, data: l.data, status: l.status, baseRevision: b.revision })
  }
  if (opts.prune) {
    for (const b of bases) if (!seen.has(b.id)) out.push({ action: "delete", id: b.id, baseRevision: b.revision })
  }
  return out
}
