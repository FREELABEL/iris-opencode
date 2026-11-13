/**
 * Vault replicas on the user's own drives (#193363, epic #192914 "Drives × Vaults × Hive").
 *
 *   iris vault create studio --on "Backup A,Backup B,this-machine" --replicas 3
 *
 * A replicated vault's copies can now live on external drives as well as on Hive machines. A
 * drive is named the way the Drives catalog names it (its label, or its id `fs:<uuid>` / volume
 * serial / `dir:<host>:<path>`), because that id is what lets ANY of the user's machines recognise
 * the drive when it is plugged in there.
 *
 * ── WHAT IS ON A DRIVE ─────────────────────────────────────────────────────────────────────
 *
 *   <mount>/_IRIS_VAULT/<vault name>/
 *     vault.json            id, name, targets, minimum copies — no key, no file names
 *     index.json            manifest seq, every chunk id + length, and per file a CONTENT ID
 *     manifest.sealed.json  the manifest (file names, sizes, plaintext sha256) sealed with the
 *                           vault key (AES-256-GCM, AAD = vault id + seq)
 *     blobs/ab/<sha256>     the encrypted chunks, named by the sha256 of their ciphertext
 *
 * Nothing on the drive opens without the vault key, and the key is never written there: it stays
 * wrapped on each machine that holds it (#193396). Another of the user's machines reads the drive
 * after `iris vault key import` (a passphrase-sealed export) — the only way a key travels.
 *
 * ── COUNTING COPIES WITHOUT THE KEY ────────────────────────────────────────────────────────
 *
 * Chunks are addressed by the sha256 of their ciphertext, so any holder proves what it holds by
 * hashing — no key. A file's content id is HMAC-SHA256(K_cid, plaintext sha256), K_cid derived
 * from the vault key (HKDF). Holders and the catalog compare content ids, never plaintext hashes,
 * so a replica index reveals nothing about what the files are, and the same file in two vaults
 * does not correlate. The machine that keeps a file (it has the key) writes the content id next to
 * the catalog row, which is how the catalog counts copies by content.
 *
 * Pure where it can be; the filesystem calls are the drive's own (a mounted drive is a local
 * path). Network lives in platform-vault.ts.
 */

import fs from "fs"
import path from "path"
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes } from "crypto"
import { VaultUserError } from "./encrypted-vault-files"
import type { VaultManifest } from "./vault-core"

export const REPLICA_DIR = "_IRIS_VAULT"
export const REPLICA_FORMAT = "iris-vault-replica"
export const INDEX_FORMAT = "iris-vault-replica-index"
export const SEALED_FORMAT = "iris-vault-sealed-manifest"
const HEX64 = /^[0-9a-f]{64}$/

// ── targets ───────────────────────────────────────────────────────────────────────────────

export type VaultTarget =
  | { kind: "drive"; id: string; label: string }
  | { kind: "machine"; name: string; id?: string | null; self?: boolean }

/** One stable string per target: "drive:<drive id>" / "machine:<name>". The catalog keys rows by it. */
export function targetKey(t: VaultTarget): string {
  return t.kind === "drive" ? `drive:${t.id}` : `machine:${t.name.toLowerCase()}`
}

export function targetLabel(t: VaultTarget): string {
  return t.kind === "drive" ? t.label : t.self ? `${t.name} (this machine)` : t.name
}

export const SELF_WORDS = ["this-machine", "this machine", "local", "here"]

export type OnContext = {
  drives: Array<{ external_id: string; label?: string | null }>
  nodes: Array<{ id: string | number; name: string }>
  /** this machine's hostname */
  self: string
}

const norm = (s: string) => s.trim().toLowerCase()

/**
 * `--on "Backup A,Backup B,studio-mac"` → targets. Exact names only (case-insensitive): a fuzzy
 * match could put a copy of someone's files on the wrong drive. `drive:` / `machine:` settle a name
 * that is both. This machine is "this-machine" or its own hostname.
 */
export function resolveOn(spec: string | string[], ctx: OnContext): VaultTarget[] {
  const items = ([] as string[]).concat(spec).flatMap((s) => String(s).split(",")).map((s) => s.trim()).filter(Boolean)
  if (!items.length) throw new VaultUserError('--on needs at least one drive or machine, e.g. --on "Backup A,this-machine"')
  const out: VaultTarget[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    let want: "drive" | "machine" | null = null
    let name = raw
    const m = raw.match(/^(drive|machine):(.+)$/i)
    if (m) { want = m[1].toLowerCase() as "drive" | "machine"; name = m[2].trim() }
    const drive = want === "machine" ? undefined : ctx.drives.find((d) => norm(String(d.label ?? "")) === norm(name) || String(d.external_id) === name)
    const isSelf = SELF_WORDS.includes(norm(name)) || norm(name) === norm(ctx.self)
    const node = want === "drive" || isSelf ? undefined : ctx.nodes.find((n) => norm(n.name) === norm(name) || String(n.id) === name)
    if (drive && (node || isSelf) && !want) {
      throw new VaultUserError(`"${raw}" is the name of a drive AND a machine — say which: drive:${name} or machine:${name}`)
    }
    let t: VaultTarget
    if (drive) t = { kind: "drive", id: String(drive.external_id), label: String(drive.label ?? drive.external_id) }
    else if (isSelf && want !== "drive") t = { kind: "machine", name: ctx.self, self: true }
    else if (node) t = { kind: "machine", name: node.name, id: String(node.id) }
    else {
      const kind = want === "drive" ? "cataloged drive" : want === "machine" ? "machine of yours" : "cataloged drive or machine of yours"
      throw new VaultUserError(
        `"${raw}" is not a ${kind}. Drives: catalog one first with iris drives scan <drive> (iris drives list shows them); machines: iris hive nodes.`,
      )
    }
    const k = targetKey(t)
    if (seen.has(k)) throw new VaultUserError(`"${raw}" is listed twice in --on`)
    seen.add(k)
    out.push(t)
  }
  return out
}

// ── placement: free space first, and an unplugged drive is pending, not failed ────────────────

export type TargetState = {
  target: VaultTarget
  /** drive: connected to THIS machine; machine: reached over the mesh (always true for self) */
  reachable: boolean
  /** free bytes where the chunks go; null = unknown, and unknown is never treated as room */
  freeBytes: number | null
  /** total size of that filesystem, for the margin; null = unknown */
  sizeBytes?: number | null
  /** bytes this target still needs (chunks it does not hold yet) */
  needBytes: number
}

/**
 * Headroom left after a write. Machines keep 1 GiB (choosePlacement's rule). A drive keeps 2% of
 * its size, at least 16 MiB and at most 1 GiB — a 64 GB stick should not need a free gigabyte to
 * hold a 1 MB file, and a full backup drive should not be filled to the last block.
 */
export function marginFor(t: TargetState): number {
  const GiB = 1024 ** 3
  if (t.target.kind !== "drive") return GiB
  if (t.sizeBytes == null || !(t.sizeBytes > 0)) return GiB
  return Math.min(GiB, Math.max(16 * 1024 ** 2, Math.round(t.sizeBytes * 0.02)))
}

export type Placement = {
  write: string[]
  /** not connected / not reachable now: catches up later (iris vault sync on the machine it is plugged into) */
  pending: Array<{ key: string; why: string }>
  /** reachable but no room (or room unknown): nothing written there */
  noRoom: Array<{ key: string; why: string }>
}

export function planPlacement(states: TargetState[]): Placement {
  const out: Placement = { write: [], pending: [], noRoom: [] }
  for (const s of states) {
    const key = targetKey(s.target)
    if (!s.reachable) {
      out.pending.push({ key, why: s.target.kind === "drive" ? "not connected to this machine" : "not reachable now" })
      continue
    }
    if (s.needBytes === 0) { out.write.push(key); continue } // nothing new to write; still refresh its index
    if (s.freeBytes == null) { out.noRoom.push({ key, why: "free space unknown (unknown is not treated as room)" }); continue }
    const margin = marginFor(s)
    if (s.freeBytes - s.needBytes < margin) {
      out.noRoom.push({ key, why: `needs ${fmt(s.needBytes)} plus ${fmt(margin)} headroom, has ${fmt(s.freeBytes)} free` })
      continue
    }
    out.write.push(key)
  }
  return out
}

export function fmt(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MiB`
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`
  return `${n} B`
}

// ── content ids, sealed manifest, index ────────────────────────────────────────────────────

/** K_cid = HKDF-SHA256(vault key, info "iris-vault-content-id/v1"). Distinct from the chunk key's use. */
export function contentKey(vaultKey: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", vaultKey, Buffer.from("iris-vault"), Buffer.from("iris-vault-content-id/v1"), 32))
}

/** The id a file's content is counted by: same file + same vault → same id; nothing else about it. */
export function contentId(vaultKey: Buffer, plainSha256: string): string {
  return createHmac("sha256", contentKey(vaultKey)).update(plainSha256).digest("hex")
}

export type SealedManifest = { format: typeof SEALED_FORMAT; v: 1; vault_id: string; seq: number; iv: string; tag: string; ct: string }

const manifestAad = (id: string, seq: number) => Buffer.from(`${SEALED_FORMAT}|v1|${id}|${seq}`)

export function sealManifest(vaultKey: Buffer, m: VaultManifest): SealedManifest {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", vaultKey, iv)
  c.setAAD(manifestAad(m.vault_id, m.seq))
  const ct = Buffer.concat([c.update(Buffer.from(JSON.stringify(m))), c.final()])
  return { format: SEALED_FORMAT, v: 1, vault_id: m.vault_id, seq: m.seq, iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }
}

export function openManifest(vaultKey: Buffer, s: SealedManifest): VaultManifest {
  if (s?.format !== SEALED_FORMAT || s.v !== 1) throw new VaultUserError("not an IRIS sealed vault manifest")
  let m: VaultManifest
  try {
    const d = createDecipheriv("aes-256-gcm", vaultKey, Buffer.from(s.iv, "base64"))
    d.setAAD(manifestAad(s.vault_id, s.seq))
    d.setAuthTag(Buffer.from(s.tag, "base64"))
    m = JSON.parse(Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()]).toString())
  } catch {
    throw new VaultUserError("this vault's key does not open the manifest on that drive (wrong vault, or the file was altered)")
  }
  if (m.vault_id !== s.vault_id || m.seq !== s.seq) throw new VaultUserError("sealed manifest is inconsistent (vault id or seq mismatch)")
  return m
}

export type ReplicaIndex = {
  format: typeof INDEX_FORMAT
  v: 1
  vault_id: string
  seq: number
  /** [chunk id, ciphertext length], sorted by id, each once */
  blobs: Array<[string, number]>
  /** one per file: content id, plaintext size, chunk ids in order */
  content: Array<{ cid: string; size: number; chunks: string[] }>
}

export function buildIndex(vaultKey: Buffer, m: VaultManifest): ReplicaIndex {
  const lens = new Map<string, number>()
  const content: ReplicaIndex["content"] = []
  const seenCid = new Set<string>()
  for (const e of Object.values(m.entries)) {
    for (const c of e.chunks) lens.set(c.id, c.len)
    const cid = contentId(vaultKey, e.plain_sha256)
    if (seenCid.has(cid)) continue // the same content under two names is one content
    seenCid.add(cid)
    content.push({ cid, size: e.size, chunks: [...e.chunks].sort((a, b) => a.n - b.n).map((c) => c.id) })
  }
  return {
    format: INDEX_FORMAT, v: 1, vault_id: m.vault_id, seq: m.seq,
    blobs: [...lens.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    content: content.sort((a, b) => (a.cid < b.cid ? -1 : 1)),
  }
}

export function parseIndex(text: string): ReplicaIndex | null {
  try {
    const i = JSON.parse(text)
    if (i?.format !== INDEX_FORMAT || i.v !== 1 || !Array.isArray(i.blobs) || !Array.isArray(i.content)) return null
    if (!i.blobs.every((b: any) => Array.isArray(b) && HEX64.test(String(b[0])) && Number.isFinite(b[1]))) return null
    return i
  } catch {
    return null
  }
}

// ── a replica folder (on a drive, or a machine's own ~/.iris/vault/<id>/replica) ─────────────

export type ReplicaMeta = {
  format: typeof REPLICA_FORMAT
  v: 1
  id: string
  name: string
  created_at: string
  /** minimum copies before a kept file is flagged */
  replicas: number
  targets: VaultTarget[]
  /** the machine the vault was created on — where a catch-up fetches missing chunks by default */
  source_node?: string | null
}

export function replicaDir(mount: string, vaultName: string): string {
  return path.join(mount, REPLICA_DIR, vaultName)
}

export const blobFile = (dir: string, id: string) => path.join(dir, "blobs", id.slice(0, 2), id)

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T
  } catch {
    return null
  }
}

/** Write via a temp file + fsync + rename, so a drive pulled mid-write never leaves half a file under the real name. */
export function writeAtomic(file: string, data: Buffer | string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.part-${randomBytes(4).toString("hex")}`
  const fd = fs.openSync(tmp, "w", 0o600)
  try {
    fs.writeSync(fd, typeof data === "string" ? Buffer.from(data) : data)
    fs.fsyncSync(fd)
  } finally {
    fs.closeSync(fd)
  }
  fs.renameSync(tmp, file)
}

export function readReplicaMeta(dir: string): ReplicaMeta | null {
  const m = readJson<ReplicaMeta>(path.join(dir, "vault.json"))
  return m && m.format === REPLICA_FORMAT && typeof m.id === "string" ? m : null
}

export function readReplicaIndex(dir: string): ReplicaIndex | null {
  try {
    return parseIndex(fs.readFileSync(path.join(dir, "index.json"), "utf8"))
  } catch {
    return null
  }
}

export function readSealed(dir: string): SealedManifest | null {
  const s = readJson<SealedManifest>(path.join(dir, "manifest.sealed.json"))
  return s && s.format === SEALED_FORMAT ? s : null
}

/** Make the folder, refusing a DIFFERENT vault that already uses this name on the drive. */
export function ensureReplica(dir: string, meta: ReplicaMeta) {
  const cur = readReplicaMeta(dir)
  if (cur && cur.id !== meta.id) {
    throw new VaultUserError(`${dir} already holds a different vault named "${meta.name}" (${cur.id}) — not mixing them. Rename one vault.`)
  }
  fs.mkdirSync(path.join(dir, "blobs"), { recursive: true })
  if (!cur || JSON.stringify(cur) !== JSON.stringify(meta)) writeAtomic(path.join(dir, "vault.json"), JSON.stringify(meta, null, 2) + "\n")
}

/** Index + sealed manifest, newest wins: an older writer never rolls a replica back. */
export function writeReplicaIndex(dir: string, index: ReplicaIndex, sealed: SealedManifest | null): boolean {
  const cur = readReplicaIndex(dir)
  if (cur && cur.vault_id === index.vault_id && cur.seq > index.seq) return false
  if (sealed) writeAtomic(path.join(dir, "manifest.sealed.json"), JSON.stringify(sealed) + "\n")
  writeAtomic(path.join(dir, "index.json"), JSON.stringify(index) + "\n")
  return true
}

/** Chunk ids present (by name). Says nothing about whether they are intact — see verifyReplica. */
export function heldBlobs(dir: string): Set<string> {
  const out = new Set<string>()
  let subs: string[] = []
  try { subs = fs.readdirSync(path.join(dir, "blobs")) } catch { return out }
  for (const s of subs) {
    if (!/^[0-9a-f]{2}$/.test(s)) continue
    let names: string[] = []
    try { names = fs.readdirSync(path.join(dir, "blobs", s)) } catch { continue }
    for (const n of names) if (HEX64.test(n) && n.startsWith(s)) out.add(n)
  }
  return out
}

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex")

/**
 * Store one chunk and read it back. The name IS the hash, so a chunk that does not hash to its
 * name is never stored, from any source — a corrupt source cannot poison a replica.
 */
export function writeBlob(dir: string, id: string, bytes: Buffer) {
  if (!HEX64.test(id)) throw new Error(`not a chunk id: ${id}`)
  if (sha256(bytes) !== id) throw new Error(`chunk ${id.slice(0, 12)}… does not match its id — not stored`)
  const file = blobFile(dir, id)
  writeAtomic(file, bytes)
  if (sha256(fs.readFileSync(file)) !== id) {
    fs.rmSync(file, { force: true })
    throw new Error(`chunk ${id.slice(0, 12)}… read back wrong from ${dir} — removed`)
  }
}

export type BlobSource = { name: string; read: (id: string) => Buffer | null | Promise<Buffer | null> }

/** A local folder holding chunks in the blobs/ab/<id> layout (this machine's store, or another mounted replica). */
export function folderSource(name: string, dir: string): BlobSource {
  return {
    name,
    read: (id) => {
      try { return fs.readFileSync(blobFile(dir, id)) } catch { return null }
    },
  }
}

export type FillResult = { written: string[]; missing: string[]; sources: string[]; errors: string[] }

/** Copy the chunks `dir` lacks from the first source that has a good copy of each. */
export async function fillReplica(dir: string, wanted: Iterable<string>, sources: BlobSource[]): Promise<FillResult> {
  const have = heldBlobs(dir)
  const res: FillResult = { written: [], missing: [], sources: [], errors: [] }
  for (const id of wanted) {
    if (have.has(id)) continue
    let done = false
    for (const s of sources) {
      const b = await s.read(id)
      if (!b) continue
      if (sha256(b) !== id) { res.errors.push(`${s.name} has a corrupt copy of ${id.slice(0, 12)}…`); continue }
      try {
        writeBlob(dir, id, b)
        done = true
        if (!res.sources.includes(s.name)) res.sources.push(s.name)
        break
      } catch (e: any) {
        res.errors.push(String(e?.message ?? e))
        break // the destination failed; another source will not fix that
      }
    }
    ;(done ? res.written : res.missing).push(id)
  }
  return res
}

export type Verified = { held: Set<string>; missing: string[]; corrupt: string[] }

/**
 * What a replica actually holds. Shallow: the file exists and has the indexed length. Deep: its
 * sha256 is recomputed (no key needed). A corrupt chunk is NOT held.
 */
export function verifyReplica(dir: string, index: Pick<ReplicaIndex, "blobs">, deep: boolean): Verified {
  const held = new Set<string>()
  const missing: string[] = []
  const corrupt: string[] = []
  for (const [id, len] of index.blobs) {
    const f = blobFile(dir, id)
    let st: fs.Stats
    try { st = fs.statSync(f) } catch { missing.push(id); continue }
    if (st.size !== len || (deep && sha256(fs.readFileSync(f)) !== id)) { corrupt.push(id); continue }
    held.add(id)
  }
  return { held, missing, corrupt }
}

/** Every vault replica on a mounted drive: [name, folder, meta]. */
export function replicasOnMount(mount: string): Array<{ name: string; dir: string; meta: ReplicaMeta }> {
  const root = path.join(mount, REPLICA_DIR)
  let names: string[] = []
  try { names = fs.readdirSync(root) } catch { return [] }
  const out: Array<{ name: string; dir: string; meta: ReplicaMeta }> = []
  for (const n of names) {
    const dir = path.join(root, n)
    const meta = readReplicaMeta(dir)
    if (meta) out.push({ name: n, dir, meta })
  }
  return out
}

// ── copies, counted by content ─────────────────────────────────────────────────────────────

/** Which holders have EVERY chunk of one content (a partial copy restores nothing, so it does not count). */
export function holdersOf(chunks: readonly string[], holders: ReadonlyMap<string, Set<string>>): string[] {
  const out: string[] = []
  for (const [k, set] of holders) if (chunks.every((c) => set.has(c))) out.push(k)
  return out.sort()
}

/**
 * A kept file's holders after a check of some targets: holders that were checked are replaced by
 * what the check found; holders not checked this time keep their last result (their freshness is
 * judged by effectiveCopies).
 */
export function mergeHeldBy(previous: readonly string[], checked: ReadonlySet<string>, nowHolding: readonly string[]): string[] {
  return [...new Set([...previous.filter((k) => !checked.has(k)), ...nowHolding])].sort()
}

export type ReplicaRow = {
  vault_id: string
  target: string
  target_label?: string
  status?: string
  last_verified_at?: string | null
}

/** Days a copy may go unchecked before it stops counting. IRIS_VAULT_MISSING_DAYS overrides. */
export function missingDays(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env.IRIS_VAULT_MISSING_DAYS)
  return Number.isFinite(n) && n > 0 ? n : 14
}

/**
 * How many copies of a kept file count right now. A holder counts when its replica was last
 * verified within `days` and was not failing. A drive nobody has plugged in for longer than that
 * is reported missing and its copy is not counted — so the file is flagged before the gap is real.
 */
export function effectiveCopies(
  heldBy: readonly string[],
  rows: readonly ReplicaRow[],
  vaultId: string,
  now: Date,
  days = missingDays(),
): { copies: number; counted: string[]; stale: string[]; failing: string[] } {
  const counted: string[] = []
  const stale: string[] = []
  const failing: string[] = []
  for (const k of heldBy) {
    const r = rows.find((x) => x.vault_id === vaultId && x.target === k)
    const at = r?.last_verified_at ? Date.parse(String(r.last_verified_at)) : NaN
    if (r?.status === "failing") { failing.push(k); continue }
    if (!Number.isFinite(at) || now.getTime() - at > days * 86_400_000) { stale.push(k); continue }
    counted.push(k)
  }
  return { copies: counted.length, counted, stale, failing }
}

export type KeptRow = {
  drive_id: string
  drive_label?: string
  path: string
  vault_id: string
  vault_name?: string
  target_copies: number
  held_by?: string
  status?: string
  sha256?: string
  content_id?: string
}

export const splitList = (s: unknown) => String(s ?? "").split("\n").map((x) => x.trim()).filter(Boolean)

/** Per source drive: how many kept files, and which are below their vault's minimum right now. */
export function keptAlerts(kept: readonly KeptRow[], rows: readonly ReplicaRow[], now: Date, days = missingDays()) {
  const out = new Map<string, { kept: number; below: Array<{ path: string; vault: string; copies: number; target: number; stale: string[]; failing: string[] }> }>()
  for (const k of kept) {
    if (k.status === "removed") continue
    const e = effectiveCopies(splitList(k.held_by), rows, k.vault_id, now, days)
    const d = out.get(k.drive_id) ?? { kept: 0, below: [] }
    d.kept++
    if (e.copies < Number(k.target_copies || 1)) {
      d.below.push({ path: k.path, vault: k.vault_name ?? k.vault_id, copies: e.copies, target: Number(k.target_copies || 1), stale: e.stale, failing: e.failing })
    }
    out.set(k.drive_id, d)
  }
  return out
}

/** The one-line alert written on the drive's Atlas record ("" = all kept files at their minimum). */
export function alertText(a: { kept: number; below: Array<{ vault: string }> } | undefined): string {
  if (!a || !a.below.length) return ""
  const vaults = [...new Set(a.below.map((b) => b.vault))].sort().join(", ")
  return `${a.below.length} of ${a.kept} kept file(s) below their minimum copies (vault ${vaults}) — run: iris vault status`
}
