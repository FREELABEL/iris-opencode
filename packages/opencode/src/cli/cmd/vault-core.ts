/**
 * IRIS Vault — a sovereign, device-owned content store.
 *
 * WHY THIS EXISTS. There is already plenty of storage in this system: `cloud:upload` puts a
 * file on the CDN, `atlas files` attaches it to a bloq, `bloq-sync` pushes it to Drive or
 * Dropbox. Every one of those puts the bytes on a third party's disk.
 *
 * That rules them out for a whole category of data this org actually handles. `clients/` is
 * gitignored ON PURPOSE because there is no BAA covering it. PHI cannot go to OpenAI. Tailscale
 * itself has no BAA. So today the answer to "where does this live" is frequently *don't store
 * it*, which is how a controller mapping representing two days of work survived only as an
 * untracked working tree on one laptop.
 *
 * A vault is the alternative: bytes at rest ONLY on machines the operator owns, encrypted
 * before they ever leave the machine that created them.
 *
 * ── THE PROPERTY THAT MAKES "SOVEREIGN" MEAN SOMETHING ──────────────────────────────────
 *
 * Blobs are addressed by the sha256 of their CIPHERTEXT, not their plaintext. That single
 * choice buys three things at once:
 *
 *   1. A holding node can VERIFY the integrity of what it stores — recompute the hash, compare
 *      to the id — WITHOUT holding the key. Replication does not require trust.
 *   2. The store deduplicates on ciphertext, so identical plaintext under the SAME vault key
 *      dedupes, while the same plaintext in a different vault does not collide. Cross-vault
 *      correlation by hash is not possible.
 *   3. An operator can prove a blob is intact in an audit without ever decrypting it, which is
 *      exactly what a PHI custodian needs to be able to do.
 *
 * The vault key never leaves the device that holds it. A node can therefore be a replica for
 * data it is not cleared to read — which is what makes a cheap always-on node safe.
 *
 * ── WHAT THIS MODULE IS NOT ─────────────────────────────────────────────────────────────
 *
 * No network, no filesystem, no process state. Every function here is pure so the rules can be
 * tested without a mesh, and so a live run cannot quietly redefine what "replicated" means.
 * Transport lives in hive-tailscale.ts; orchestration in platform-vault.ts.
 */

import { createHash, randomBytes, createCipheriv, createDecipheriv, timingSafeEqual } from "crypto"

/** AES-256-GCM. 12-byte nonce is the GCM standard; 16-byte tag is the default. */
const ALGO = "aes-256-gcm"
const NONCE_LEN = 12
const TAG_LEN = 16

/**
 * Default chunk size, 4 MiB.
 *
 * Big enough that a 57KB mapping is one chunk and the manifest stays small; small enough that a
 * large file re-uploads only the parts that changed, and that a transfer interrupted on a
 * sleeping laptop resumes at a sane granularity.
 */
export const DEFAULT_CHUNK_SIZE = 4 * 1024 * 1024

export interface VaultChunkRef {
  /** sha256 of the CIPHERTEXT — the blob's address, verifiable without the key. */
  id: string
  /** Index within the file, so reassembly cannot depend on map ordering. */
  n: number
  /** Ciphertext length in bytes (nonce + body + tag). */
  len: number
}

export interface VaultEntry {
  /** Plaintext size, for reporting. */
  size: number
  /** sha256 of the PLAINTEXT — lets a holder of the key verify a reassembly end to end. */
  plain_sha256: string
  chunks: VaultChunkRef[]
  /** Source mtime, ISO. Advisory: conflict resolution never depends on clocks. */
  mtime?: string | null
}

export interface VaultManifest {
  vault_id: string
  /** Monotonic. Manifests are APPEND-ONLY; a new state is a new manifest, never an edit. */
  seq: number
  /** Digest of the previous manifest, so history is a chain and a gap is detectable. */
  parent: string | null
  created_at: string
  author_node: string
  entries: Record<string, VaultEntry>
}

export interface EncryptedChunk {
  ref: VaultChunkRef
  /** nonce ‖ ciphertext ‖ tag — self-contained, so a blob file needs no sidecar. */
  bytes: Buffer
}

// ── content addressing ───────────────────────────────────────────────────────

export function sha256(buf: Buffer | Uint8Array | string): string {
  return createHash("sha256").update(buf as any).digest("hex")
}

/**
 * Split a buffer into fixed-size pieces.
 *
 * An EMPTY file yields ZERO chunks, deliberately — an empty file is a real thing a person can
 * store, and it must round-trip. Callers must not treat "no chunks" as "no entry".
 */
export function chunkBuffer(buf: Buffer, chunkSize: number = DEFAULT_CHUNK_SIZE): Buffer[] {
  if (chunkSize <= 0) throw new Error("chunkSize must be positive")
  const out: Buffer[] = []
  for (let i = 0; i < buf.length; i += chunkSize) out.push(buf.subarray(i, Math.min(i + chunkSize, buf.length)))
  return out
}

// ── encryption ───────────────────────────────────────────────────────────────

/** A fresh 256-bit vault key. This value never leaves the device that generates it. */
export function generateVaultKey(): Buffer {
  return randomBytes(32)
}

/**
 * Encrypt one chunk.
 *
 * A RANDOM nonce per chunk, never a counter derived from the chunk index: two different files
 * would otherwise reuse the same (key, nonce) pair at the same index, and nonce reuse under
 * GCM is catastrophic — it leaks the XOR of the plaintexts and forges the authenticator.
 * The cost is 12 bytes per chunk.
 */
export function encryptChunk(key: Buffer, plaintext: Buffer, n: number): EncryptedChunk {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes")
  const nonce = randomBytes(NONCE_LEN)
  const cipher = createCipheriv(ALGO, key, nonce)
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const bytes = Buffer.concat([nonce, body, tag])
  return { ref: { id: sha256(bytes), n, len: bytes.length }, bytes }
}

/**
 * Decrypt one chunk, verifying the blob's ADDRESS before spending any work on it.
 *
 * Two independent checks, and both matter: the sha256 says the bytes are the ones that were
 * stored (catches a corrupted or substituted blob without the key being involved), and the GCM
 * tag says they were produced by someone holding the key (catches a forged blob that happens to
 * hash correctly because the attacker chose it). Either failing is a hard error — a store that
 * returns "probably your data" is worse than one that returns nothing.
 */
export function decryptChunk(key: Buffer, bytes: Buffer, expectId?: string): Buffer {
  if (key.length !== 32) throw new Error("vault key must be 32 bytes")
  if (expectId) {
    const actual = sha256(bytes)
    const a = Buffer.from(actual)
    const b = Buffer.from(expectId)
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      throw new Error(`blob integrity failure: expected ${expectId.slice(0, 12)}…, stored bytes hash to ${actual.slice(0, 12)}…`)
    }
  }
  if (bytes.length < NONCE_LEN + TAG_LEN) throw new Error("blob too short to be a valid chunk")
  const nonce = bytes.subarray(0, NONCE_LEN)
  const tag = bytes.subarray(bytes.length - TAG_LEN)
  const body = bytes.subarray(NONCE_LEN, bytes.length - TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, nonce)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(body), decipher.final()])
}

// ── entries ──────────────────────────────────────────────────────────────────

/** Encrypt a whole file into an entry plus the blobs to store. */
export function buildEntry(
  key: Buffer,
  plaintext: Buffer,
  opts: { chunkSize?: number; mtime?: string | null } = {},
): { entry: VaultEntry; blobs: EncryptedChunk[] } {
  const pieces = chunkBuffer(plaintext, opts.chunkSize ?? DEFAULT_CHUNK_SIZE)
  const blobs = pieces.map((p, i) => encryptChunk(key, p, i))
  return {
    entry: {
      size: plaintext.length,
      plain_sha256: sha256(plaintext),
      chunks: blobs.map((b) => b.ref),
      mtime: opts.mtime ?? null,
    },
    blobs,
  }
}

/**
 * Reassemble a file, verifying the PLAINTEXT digest at the end.
 *
 * Chunks are ordered by `n`, never by the order the caller happened to fetch them in — blobs
 * arrive from several nodes concurrently and arrival order is not content order. Getting this
 * wrong produces a file that is the right length, hashes wrong, and looks fine in a directory
 * listing.
 */
export function reassemble(key: Buffer, entry: VaultEntry, blobs: Map<string, Buffer>): Buffer {
  const ordered = [...entry.chunks].sort((a, b) => a.n - b.n)
  const parts: Buffer[] = []
  for (const ref of ordered) {
    const bytes = blobs.get(ref.id)
    if (!bytes) throw new Error(`missing blob ${ref.id.slice(0, 12)}… (chunk ${ref.n}) — the file cannot be reassembled`)
    parts.push(decryptChunk(key, bytes, ref.id))
  }
  const out = Buffer.concat(parts)
  const got = sha256(out)
  if (got !== entry.plain_sha256) {
    throw new Error(`reassembly digest mismatch: expected ${entry.plain_sha256.slice(0, 12)}…, got ${got.slice(0, 12)}…`)
  }
  return out
}

// ── manifests ────────────────────────────────────────────────────────────────

/**
 * Canonical digest of a manifest.
 *
 * Keys are sorted so two processes building the same state agree on the hash. Without this the
 * parent chain would break purely on JSON key ordering, and a "history gap" would be reported
 * where none exists.
 */
export function manifestDigest(m: VaultManifest): string {
  const canon = JSON.stringify(m, Object.keys(m).sort())
  return sha256(canon)
}

/** Build the next manifest in the chain. Never mutates the previous one. */
export function nextManifest(
  prev: VaultManifest | null,
  changes: { put?: Record<string, VaultEntry>; remove?: string[] },
  meta: { vault_id: string; author_node: string; created_at: string },
): VaultManifest {
  const entries: Record<string, VaultEntry> = { ...(prev?.entries ?? {}) }
  for (const [p, e] of Object.entries(changes.put ?? {})) entries[normalizePath(p)] = e
  for (const p of changes.remove ?? []) delete entries[normalizePath(p)]
  return {
    vault_id: meta.vault_id,
    seq: (prev?.seq ?? 0) + 1,
    parent: prev ? manifestDigest(prev) : null,
    created_at: meta.created_at,
    author_node: meta.author_node,
    entries,
  }
}

/**
 * Normalise a vault path.
 *
 * Vault paths are always relative and POSIX. A leading slash, a backslash or a `..` segment
 * would let a `get` write outside the output directory — the same class of hole the
 * execute-script endpoint guards against with its "plain name" check.
 */
export function normalizePath(p: string): string {
  const cleaned = String(p).replace(/\\/g, "/").replace(/^\/+/, "")
  const parts: string[] = []
  for (const seg of cleaned.split("/")) {
    if (seg === "" || seg === ".") continue
    if (seg === "..") throw new Error(`vault path may not contain "..": ${p}`)
    parts.push(seg)
  }
  if (parts.length === 0) throw new Error(`empty vault path: ${p}`)
  return parts.join("/")
}

// ── placement & health ───────────────────────────────────────────────────────

export interface PlacementNode {
  name: string
  online: boolean
  /** Free bytes, or null when unknown. Unknown is NOT treated as room. */
  freeBytes: number | null
}

/**
 * Choose which nodes should hold a blob.
 *
 * CAPACITY-AWARE BY NECESSITY, not by elegance: MacBookPro is at 98% disk with 11 GiB free.
 * A naive "replicate everywhere" policy would fill it and take the node down, so placement
 * prefers the most headroom and refuses a node that cannot fit the payload with margin.
 *
 * A node whose free space is UNKNOWN is not eligible. Unknown is not room — assuming otherwise
 * is the same error as a presence probe answering a question about access.
 */
export function choosePlacement(
  nodes: PlacementNode[],
  replicas: number,
  payloadBytes: number,
  marginBytes = 1 * 1024 * 1024 * 1024,
): { chosen: string[]; shortfall: number; reason: string } {
  const eligible = nodes
    .filter((n) => n.online && n.freeBytes !== null && n.freeBytes - payloadBytes >= marginBytes)
    .sort((a, b) => (b.freeBytes ?? 0) - (a.freeBytes ?? 0))
  const chosen = eligible.slice(0, Math.max(1, replicas)).map((n) => n.name)
  const shortfall = Math.max(0, Math.max(1, replicas) - chosen.length)
  const offline = nodes.filter((n) => !n.online).length
  const unknown = nodes.filter((n) => n.online && n.freeBytes === null).length
  const tooFull = nodes.filter((n) => n.online && n.freeBytes !== null && n.freeBytes - payloadBytes < marginBytes).length
  return {
    chosen,
    shortfall,
    reason: shortfall === 0
      ? `placed on ${chosen.length} node(s)`
      : `WANTED ${replicas} replica(s), placed ${chosen.length}. ${offline} offline, ${tooFull} without room, ${unknown} with unknown capacity (unknown is not treated as room).`,
  }
}

export interface PathHealth {
  path: string
  size: number
  /** Distinct nodes holding EVERY chunk of this path. */
  fullyHeldBy: string[]
  /** Nodes holding some but not all chunks — a partial replica restores nothing on its own. */
  partiallyHeldBy: string[]
  replicas: number
  target: number
  atRisk: boolean
}

/**
 * Replication health per path.
 *
 * A node counts as a replica ONLY if it holds every chunk. A partial copy restores nothing, and
 * counting it would produce exactly the reassuring-but-false number this whole system keeps
 * getting caught by — "2 of 2 replicas" over a file that cannot actually be recovered.
 */
export function replicationHealth(
  manifest: VaultManifest,
  pins: Record<string, string[]>,
  target: number,
): PathHealth[] {
  return Object.entries(manifest.entries).map(([path, entry]) => {
    const perNode = new Map<string, number>()
    for (const c of entry.chunks) {
      for (const node of pins[c.id] ?? []) perNode.set(node, (perNode.get(node) ?? 0) + 1)
    }
    const need = entry.chunks.length
    const full: string[] = []
    const partial: string[] = []
    for (const [node, held] of perNode) (held >= need ? full : partial).push(node)
    // An empty file has zero chunks and therefore cannot be "held" anywhere. It is recoverable
    // from the manifest alone, so it is never at risk.
    const atRisk = need > 0 && full.length < target
    return { path, size: entry.size, fullyHeldBy: full.sort(), partiallyHeldBy: partial.sort(), replicas: full.length, target, atRisk }
  })
}
