/**
 * The I/O half of vault replicas on drives (#193363): put chunks on a mounted drive, check what a
 * replica holds, and record the result in the user's Drives catalog in Atlas.
 *
 * Atlas holds the CATALOG — which vault has a copy where, verified when, which kept file is held
 * by whom — never bytes and never a key. Bytes stay on the user's own drives and machines.
 * Everything here takes its world as arguments (DriveEnv, VaultCatalog) so the tests run it
 * against folders and an in-memory catalog.
 */

import fs from "fs"
import path from "path"
import { spawnSync } from "child_process"
import {
  type VaultTarget, type ReplicaIndex, type ReplicaMeta, type SealedManifest, type BlobSource, type ReplicaRow, type KeptRow,
  targetKey, targetLabel, replicaDir, ensureReplica, writeReplicaIndex, heldBlobs, fillReplica, verifyReplica, blobFile,
  planPlacement, holdersOf, mergeHeldBy, effectiveCopies, keptAlerts, alertText, splitList, missingDays, REPLICA_FORMAT,
} from "./vault-drives"

export type DriveEnv = {
  /** where this drive is mounted on THIS machine, or null (not connected here) */
  resolveMount(driveId: string): string | null
  statfs(p: string): { free: number; size: number } | null
}

/**
 * Free and total bytes of the filesystem holding `p`. `df -kP` first wherever there is one: Bun's
 * fs.statfsSync returns shifted fields on macOS (bsize 0, blocks = the block size), which read as
 * "0 bytes free" for every Mac drive. statfsSync is the fallback (Windows), and only when sane.
 */
export function statfsOf(p: string, run: (cmd: string, args: string[]) => string | null = dfRun): { free: number; size: number } | null {
  if (process.platform !== "win32") {
    const parsed = parseDfKP(run("df", ["-kP", p]) ?? "")
    if (parsed) return parsed
  }
  try {
    const st = fs.statfsSync(p)
    const bs = Number(st.bsize)
    if (!(bs > 0)) return null
    return { free: Number(st.bavail) * bs, size: Number(st.blocks) * bs }
  } catch {
    return null
  }
}

function dfRun(cmd: string, args: string[]): string | null {
  try {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 15_000 })
    return r.status === 0 ? String(r.stdout ?? "") : null
  } catch {
    return null
  }
}

/** POSIX `df -kP` output → bytes. Columns: filesystem, 1024-blocks, used, available, capacity, mount. */
export function parseDfKP(out: string): { free: number; size: number } | null {
  const line = out.trim().split("\n").filter(Boolean).pop() ?? ""
  const m = line.match(/\s(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s/)
  if (!m) return null
  const size = Number(m[1]) * 1024
  const free = Number(m[3]) * 1024
  return Number.isFinite(size) && Number.isFinite(free) && size > 0 ? { free, size } : null
}

export type CheckStatus = "ok" | "partial" | "pending" | "no-room" | "failing"

export type TargetCheck = {
  target: VaultTarget
  key: string
  status: CheckStatus
  /** chunks verified present now; null = not checked this time (pending) */
  held: Set<string> | null
  wanted: number
  note: string
  written?: number
  mount?: string | null
}

export function statusOf(wanted: number, held: number, corrupt: number): CheckStatus {
  if (corrupt > 0) return "failing"
  return held >= wanted ? "ok" : "partial"
}

export type VaultLike = { id: string; name: string; created_at: string; replicas: number; targets?: VaultTarget[]; source_node?: string | null }

export function replicaMetaFor(meta: VaultLike): ReplicaMeta {
  return {
    format: REPLICA_FORMAT, v: 1, id: meta.id, name: meta.name, created_at: meta.created_at,
    replicas: meta.replicas, targets: meta.targets ?? [], source_node: meta.source_node ?? null,
  }
}

/**
 * Bring each drive target that is plugged into THIS machine up to `index`: free-space check first,
 * then copy the chunks it lacks from `sources` (each one hash-checked on the way in and read back
 * on the drive), write the index + sealed manifest, verify. A drive that is not plugged in here is
 * `pending`; nothing about it is assumed.
 */
export async function syncDriveTargets(o: {
  meta: VaultLike
  index: ReplicaIndex
  sealed: SealedManifest | null
  targets: VaultTarget[]
  env: DriveEnv
  sources: BlobSource[]
  deep?: boolean
  /** status only: verify, never write */
  readOnly?: boolean
}): Promise<TargetCheck[]> {
  const out: TargetCheck[] = []
  const wanted = o.index.blobs.length
  const lens = new Map(o.index.blobs)
  for (const t of o.targets) {
    if (t.kind !== "drive") continue
    const key = targetKey(t)
    const mount = o.env.resolveMount(t.id)
    if (!mount) {
      out.push({ target: t, key, status: "pending", held: null, wanted, note: "not connected to this machine", mount: null })
      continue
    }
    const dir = replicaDir(mount, o.meta.name)
    if (o.readOnly) {
      const v = verifyReplica(dir, o.index, !!o.deep)
      out.push({ target: t, key, status: statusOf(wanted, v.held.size, v.corrupt.length), held: v.held, wanted, mount,
        note: v.corrupt.length ? `${v.corrupt.length} chunk(s) failed verification` : v.missing.length ? `${v.missing.length} chunk(s) missing — run: iris vault sync` : "" })
      continue
    }
    // Chunks that fail a check are removed first, so the fill below replaces them from a good copy.
    const before = verifyReplica(dir, o.index, !!o.deep)
    for (const id of before.corrupt) fs.rmSync(blobFile(dir, id), { force: true })
    const have = heldBlobs(dir)
    const needBytes = o.index.blobs.reduce((n, [id]) => n + (have.has(id) ? 0 : lens.get(id) ?? 0), 0)
    const st = o.env.statfs(mount)
    const plan = planPlacement([{ target: t, reachable: true, freeBytes: st?.free ?? null, sizeBytes: st?.size ?? null, needBytes }])
    if (plan.noRoom.length) {
      const v = verifyReplica(dir, o.index, false)
      out.push({ target: t, key, status: "no-room", held: v.held, wanted, note: plan.noRoom[0].why, mount })
      continue
    }
    try {
      ensureReplica(dir, replicaMetaFor(o.meta))
    } catch (e: any) {
      out.push({ target: t, key, status: "failing", held: new Set(), wanted, note: String(e?.message ?? e), mount })
      continue
    }
    const fill = await fillReplica(dir, o.index.blobs.map(([id]) => id), o.sources)
    writeReplicaIndex(dir, o.index, o.sealed)
    const v = verifyReplica(dir, o.index, false)
    const notes: string[] = []
    if (fill.missing.length) notes.push(`${fill.missing.length} chunk(s) not found on any source you can reach from here`)
    if (fill.errors.length) notes.push(fill.errors[0])
    out.push({
      target: t, key, status: statusOf(wanted, v.held.size, v.corrupt.length), held: v.held, wanted, mount,
      written: fill.written.length, note: notes.join("; "),
    })
  }
  return out
}

// ── the catalog in Atlas ───────────────────────────────────────────────────────────────────

export type ImportResult = { created: number; updated: number; failed: number }

export type VaultCatalog = {
  drives(): Promise<any[]>
  replicaRows(): Promise<any[]>
  keptRows(): Promise<any[]>
  /** upsert by external_id (Atlas import merges into an existing record) */
  upsert(schema: "drive-vaults" | "drive-kept" | "drives" | "drive-reads", rows: any[]): Promise<ImportResult>
  /** make sure a dataset exists on the board ("already exists" is fine) */
  ensure(slug: string): Promise<void>
}

export const replicaRowId = (vaultId: string, key: string) => `${vaultId}|${key}`
export const keptRowId = (vaultId: string, driveId: string, rel: string) => `${vaultId}|${driveId}:${rel}`

export function replicaRow(meta: VaultLike, c: TargetCheck, seq: number, host: string, at: string) {
  return {
    external_id: replicaRowId(meta.id, c.key),
    vault_id: meta.id, vault_name: meta.name, target: c.key, target_kind: c.target.kind, target_label: targetLabel(c.target),
    drive_id: c.target.kind === "drive" ? c.target.id : "",
    status: c.status, blobs_held: c.held ? c.held.size : undefined, blobs_wanted: c.wanted, manifest_seq: seq,
    replicas: meta.replicas, source_node: meta.source_node ?? "",
    // A pending check proves nothing about the copy, so it never refreshes "last verified".
    ...(c.held ? { last_verified_at: at, last_verified_on: host } : {}),
    note: c.note || "",
  }
}

const dataOf = (r: any) => r?.data ?? r

/**
 * Record what a check found: one drive-vaults row per target checked, then every kept file of the
 * vault gets its holders and copy count recomputed, then the drive records get their alert. Returns
 * a sentence per thing that could not be saved (empty = all saved).
 */
export async function recordChecks(
  cat: VaultCatalog,
  meta: VaultLike,
  index: ReplicaIndex | null,
  checks: TargetCheck[],
  host: string,
  now: Date,
): Promise<string[]> {
  const problems: string[] = []
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z")
  const seq = index?.seq ?? 0
  try {
    await cat.ensure("drive-vaults")
    // "Not plugged in here" says nothing about a copy that was verified somewhere: such a row keeps
    // its last real status and date (and goes "missing" with time, in effectiveCopies).
    const before: any[] = (await cat.replicaRows().catch(() => [])).map(dataOf)
    const verifiedBefore = (k: string) => before.some((r) => r.vault_id === meta.id && r.target === k && r.last_verified_at)
    const rows = checks.filter((c) => c.held || !verifiedBefore(c.key)).map((c) => clean(replicaRow(meta, c, seq, host, at)))
    const r = rows.length ? await cat.upsert("drive-vaults", rows) : { created: 0, updated: 0, failed: 0 }
    if (r.failed) problems.push(`${r.failed} vault copy row(s) could not be saved`)
  } catch (e: any) {
    problems.push(`could not save the vault copies to your Drives catalog (${e?.message ?? e})`)
    return problems
  }
  let replicaRows: ReplicaRow[] = []
  let kept: any[] = []
  try {
    replicaRows = (await cat.replicaRows()).map(dataOf)
    kept = (await cat.keptRows()).map(dataOf)
  } catch (e: any) {
    problems.push(`could not read kept files back from your Drives catalog (${e?.message ?? e})`)
    return problems
  }
  // Holders checked now, with what they hold. A pending target was not checked.
  const checked = new Set(checks.filter((c) => c.held).map((c) => c.key))
  const holders = new Map(checks.filter((c) => c.held && c.status !== "failing").map((c) => [c.key, c.held!]))
  // A failing replica: its intact chunks still count. Corrupt ones were excluded from `held`.
  for (const c of checks) if (c.held && c.status === "failing") holders.set(c.key, c.held)
  const byCid = new Map((index?.content ?? []).map((x) => [x.cid, x.chunks]))
  const keptUpdates: any[] = []
  for (const k of kept) {
    if (k.vault_id !== meta.id || k.status === "removed") continue
    const chunks = byCid.get(String(k.content_id ?? ""))
    if (!chunks) continue
    const heldBy = mergeHeldBy(splitList(k.held_by), checked, holdersOf(chunks, holders))
    const e = effectiveCopies(heldBy, replicaRows, meta.id, now)
    const status = e.copies >= Number(k.target_copies || meta.replicas) ? "safe" : "below"
    const next = { ...k, held_by: heldBy.join("\n"), copies: e.copies, status, checked_at: at }
    if (next.held_by !== k.held_by || next.copies !== k.copies || next.status !== k.status || checked.size) {
      keptUpdates.push(next)
      Object.assign(k, next)
    }
  }
  if (keptUpdates.length) {
    try {
      const r = await cat.upsert("drive-kept", keptUpdates.map(clean))
      if (r.failed) problems.push(`${r.failed} kept-file row(s) could not be updated`)
    } catch (e: any) {
      problems.push(`could not update kept files (${e?.message ?? e})`)
    }
  }
  problems.push(...(await refreshDriveAlerts(cat, kept, replicaRows, now)))
  return problems
}

/** The alert + replica summary on each drive's own Atlas record, written only when it changed. */
export async function refreshDriveAlerts(cat: VaultCatalog, kept: any[], replicaRows: ReplicaRow[], now: Date, drivesIn?: any[]): Promise<string[]> {
  let drives: any[]
  try {
    drives = drivesIn ?? (await cat.drives())
  } catch (e: any) {
    return [`could not read your drives to update their alerts (${e?.message ?? e})`]
  }
  const rows = driveAlertRows(drives, kept, replicaRows, now)
  if (!rows.length) return []
  try {
    const r = await cat.upsert("drives", rows)
    return r.failed ? [`${r.failed} drive record(s) could not be updated`] : []
  } catch (e: any) {
    return [`could not update the drive records (${e?.message ?? e})`]
  }
}

/** Partial drive records (merge) whose kept-file alert or vault-copy summary changed. */
export function driveAlertRows(drives: any[], kept: KeptRow[], replicaRows: ReplicaRow[], now: Date, days = missingDays()): any[] {
  const alerts = keptAlerts(kept, replicaRows, now, days)
  const out: any[] = []
  for (const d of drives) {
    const id = String(d.external_id)
    const a = alerts.get(id)
    const mine = (replicaRows as any[]).filter((r) => r.drive_id === id || r.target === `drive:${id}`)
    const summary = mine
      .map((r) => {
        const at = r.last_verified_at ? Date.parse(String(r.last_verified_at)) : NaN
        const stale = !Number.isFinite(at) || now.getTime() - at > days * 86_400_000
        const word = r.status === "ok" && stale ? "missing" : r.status
        return `${r.vault_name ?? r.vault_id}: ${word}${r.last_verified_at ? ` (verified ${String(r.last_verified_at).slice(0, 10)})` : ""}`
      })
      .sort()
      .join("\n")
    const next = { kept_files: a?.kept ?? 0, kept_below_target: a?.below.length ?? 0, copies_alert: alertText(a), vault_replicas: summary }
    const same = Number(d.kept_files ?? 0) === next.kept_files && Number(d.kept_below_target ?? 0) === next.kept_below_target &&
      String(d.copies_alert ?? "") === next.copies_alert && String(d.vault_replicas ?? "") === next.vault_replicas
    if (!same) out.push({ external_id: id, ...next })
  }
  return out
}

function clean<T extends Record<string, any>>(r: T): T {
  for (const k of Object.keys(r)) if (r[k] === undefined) delete r[k]
  return r
}

/** "Backup A ✓ · studio-mac ✓ · Backup B pending (not connected to this machine)" */
export function formatChecks(checks: TargetCheck[]): string {
  return checks
    .map((c) => {
      const name = targetLabel(c.target)
      if (c.status === "ok") return `${name} ✓`
      return `${name} ${c.status}${c.note ? ` (${c.note})` : ""}`
    })
    .join(" · ")
}

/** Where a drive's replica of a vault is, if that drive is plugged in here. */
export function mountedReplicaDirs(meta: VaultLike, env: DriveEnv): Array<{ target: VaultTarget; dir: string }> {
  const out: Array<{ target: VaultTarget; dir: string }> = []
  for (const t of meta.targets ?? []) {
    if (t.kind !== "drive") continue
    const m = env.resolveMount(t.id)
    if (m) out.push({ target: t, dir: replicaDir(m, meta.name) })
  }
  return out
}

export const localReplicaDir = (vaultDir: string) => path.join(vaultDir, "replica")
