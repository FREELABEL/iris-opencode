/**
 * Files in an encrypted PHI vault — `iris hive vault put|get|ls|status` for the vaults that
 * `iris hive vault create --encrypted` makes (#192914).
 *
 * WHY THIS LOADS THE DAEMON'S MODULE INSTEAD OF REIMPLEMENTING IT. An encrypted vault is the
 * daemon's: its format (per-object file keys sealed under the vault key, 1 MiB AES-256-GCM chunks
 * whose AAD binds vault, object, index and a FINAL flag) and its key handling (OS keystore, or a
 * passphrase) live in iris-daemon lib/encrypted-vault.js. A second copy of that crypto here would
 * be a second place for it to be wrong, and a format that drifts from the one PHI tasks write.
 * So this runs the installed daemon's own module, on THIS machine — the same hand-off as
 * hive-node-vault.ts and the daemon's own `iris-daemon vaults export`.
 *
 * KEYS NEVER TRAVEL. Nothing here makes a network call with vault data or a key: put encrypts
 * locally with the vault's key from this machine's keystore, and get decrypts locally. An
 * encrypted vault does not replicate; `status` says so rather than pretending it does.
 */

import { createRequire } from "module"
import { existsSync, statSync } from "fs"
import { createHash } from "crypto"
import { readFile, mkdir } from "fs/promises"
import { homedir } from "os"
import { join, basename } from "path"

/** A failure the user caused or can fix — printed as one sentence, never with a stack. */
export class VaultUserError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "VaultUserError"
  }
}

/** The subset of iris-daemon lib/encrypted-vault.js this file uses. */
export interface EncryptedVaultModule {
  getEntry(name: string): any
  isLocked(entry: any): boolean
  unlock(name: string, passphrase?: string | null): any
  summary(entry: any): any
  putFile(entry: any, src: string, meta?: Record<string, any>): Promise<{ fileId: string; size: number }>
  readObject(entry: any, id: string): Promise<{ meta: any; data: Buffer }>
  /** Newer daemons only — streams instead of holding the file in memory. */
  sha256Object?(entry: any, id: string): Promise<string>
  shredObject(entry: any, id: string): number
  listFiles(name: string): Promise<Array<{ file_id: string; name: string | null; kind: string; size: number; created_at: string }>>
  exportObject(entry: any, id: string, outPath: string): Promise<any>
  retentionDays?(): number
}

export function encryptedVaultModulePath(home = homedir()): string {
  return join(home, ".iris", "bridge", "lib", "encrypted-vault.js")
}

/** The installed daemon's vault module, or null when this machine has no daemon. */
export function loadEncryptedVaultModule(path = encryptedVaultModulePath()): EncryptedVaultModule | null {
  if (!existsSync(path)) return null
  try {
    const mod = createRequire(import.meta.url)(path)
    if (typeof mod?.getEntry !== "function" || typeof mod?.putFile !== "function") return null
    return mod as EncryptedVaultModule
  } catch {
    return null
  }
}

/** The vault's registry entry, or null if no encrypted vault on this node has that name. */
export function findEncryptedVault(mod: EncryptedVaultModule | null, name: string): any | null {
  if (!mod) return null
  try {
    return mod.getEntry(name)
  } catch {
    return null
  }
}

export interface OpenOptions {
  /** Lock state as the running daemon reports it (null: daemon not reachable). */
  daemonLocked?: boolean | null
  /** Supplies a passphrase for a passphrase vault; absent means none can be asked for. */
  passphrase?: () => Promise<string>
}

/**
 * Make the vault's key available to THIS process, or refuse with one sentence saying how to fix it.
 * Never unlocks a vault the user locked: locked means "no one opens it", including us.
 */
export async function openForUse(mod: EncryptedVaultModule, entry: any, opts: OpenOptions = {}): Promise<any> {
  const name = entry.name
  if (entry.locked || opts.daemonLocked === true) {
    throw new VaultUserError(`vault "${name}" is locked — unlock it first: iris hive vault unlock ${name}`)
  }
  if (entry.key_source === "passphrase" && mod.isLocked(entry)) {
    // A passphrase vault's key lives only in the memory of the process that unlocked it (the
    // daemon). This short-lived process proves it may open the vault the same way: the passphrase.
    if (!opts.passphrase) {
      throw new VaultUserError(`vault "${name}" is passphrase-protected — run this in a terminal, or pass --passphrase-stdin`)
    }
    try {
      mod.unlock(name, await opts.passphrase())
    } catch (e: any) {
      throw new VaultUserError(e?.message || `could not unlock vault "${name}"`)
    }
  }
  return mod.getEntry(name)
}

const sha256Hex = (buf: Buffer) => createHash("sha256").update(buf).digest("hex")

/** Path inside the vault: forward slashes, no leading slash, no "..". */
export function vaultName(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/").filter((s) => s && s !== ".")
  if (!parts.length || parts.includes("..")) throw new VaultUserError(`"${p}" is not a valid path inside a vault`)
  return parts.join("/")
}

export interface PutResult {
  ok: boolean
  path: string
  vault_path?: string
  file_id?: string
  size?: number
  sha256?: string
  error?: string
}

/**
 * Encrypt each file into the vault, then read it back and compare SHA-256 with the source. A file
 * that does not verify is crypto-shredded and reported as failed — never left half-written.
 */
export async function encryptedPut(
  mod: EncryptedVaultModule,
  entry: any,
  files: Array<{ src: string; as?: string }>,
): Promise<PutResult[]> {
  const out: PutResult[] = []
  for (const f of files) {
    if (!existsSync(f.src) || !statSync(f.src).isFile()) {
      out.push({ ok: false, path: f.src, error: "no such local file" })
      continue
    }
    const vpath = vaultName(f.as ?? basename(f.src))
    const before = sha256Hex(await readFile(f.src))
    const { fileId, size } = await mod.putFile(entry, f.src, { name: vpath, kind: "file", tag: "cli-put" })
    // Read back through the vault's own decrypt path — what `get` will return — not the source.
    const after = mod.sha256Object
      ? await mod.sha256Object(entry, fileId)
      : sha256Hex((await mod.readObject(entry, fileId)).data)
    if (after !== before) {
      mod.shredObject(entry, fileId)
      out.push({ ok: false, path: f.src, vault_path: vpath, error: "read-back did not match the source (sha256) — nothing kept" })
      continue
    }
    out.push({ ok: true, path: f.src, vault_path: vpath, file_id: fileId, size, sha256: after })
  }
  return out
}

/** Files in the vault, oldest first. Needs the key: names are sealed inside each object. */
export async function encryptedLs(mod: EncryptedVaultModule, entry: any) {
  const files = await mod.listFiles(entry.name)
  return files.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
}

/**
 * Decrypt one file to `outDir`. `path` matches a vault path (the newest copy wins when the same
 * path was put more than once) or a file id.
 */
export async function encryptedGet(mod: EncryptedVaultModule, entry: any, path: string, outDir: string) {
  const files = await encryptedLs(mod, entry)
  const want = path.replace(/\\/g, "/").replace(/^\/+/, "")
  const hit = files.filter((f) => f.name === want || f.file_id === path).pop()
  if (!hit) throw new VaultUserError(`"${path}" is not in vault ${entry.name}. Run: iris hive vault ls ${entry.name}`)
  await mkdir(outDir, { recursive: true })
  const dest = join(outDir, basename(hit.name || hit.file_id))
  await mod.exportObject(entry, hit.file_id, dest)
  const data = await readFile(dest)
  return { path: hit.name || hit.file_id, file_id: hit.file_id, out: dest, size: data.length, sha256: sha256Hex(data) }
}
