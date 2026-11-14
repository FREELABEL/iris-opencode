/**
 * Where a REPLICATED vault's key lives on this machine (#193396).
 *
 * WHAT WAS WRONG. Every replicated vault's 256-bit key sat base64-encoded in
 * ~/.iris/vault-keys.json (mode 0600). Anything that can read the home directory — a backup, a
 * synced folder, a copied ~/.iris on an external drive, a script running as the user — got every
 * key, which made the chunk encryption decorative. Encrypted PHI vaults never had this problem:
 * their keys sit in the OS keystore, or behind a passphrase held only in memory.
 *
 * WHAT IT IS NOW. Each vault key is sealed (AES-256-GCM, AAD = the vault id) under one
 * key-wrapping key (KEK), in ~/.iris/vault-keys.wrapped.json. The wrapped file is useless on its
 * own. The KEK lives in exactly one place, chosen once per machine and pinned in the file:
 *
 *   keychain   macOS Keychain, service "iris-replicated-vault" (`security`, secret on stdin)
 *   libsecret  Linux Secret Service (GNOME Keyring / KWallet) via `secret-tool`, secret on stdin
 *   node-key   headless Linux: 32 random bytes in /etc/iris/vault-kek/<uid>.key — OUTSIDE the
 *              home directory, in a root-owned directory (created once with sudo), the file
 *              owned by the user and mode 0400. Not in home backups, synced folders, a copied
 *              ~/.iris, or an external drive's replica. Override the path: IRIS_VAULT_NODE_KEY_FILE.
 *   passphrase scrypt(N=2^17, r=8, p=1, 32-byte output, 16-byte random salt) of a passphrase the
 *              operator types (or pipes with --passphrase-stdin). Nothing on disk can open it.
 *
 * Choice order on first use: keychain (macOS) → libsecret (if a keyring answers) → node-key (if
 * it exists or `sudo -n` can create it) → passphrase (if one can be asked for). Force one with
 * IRIS_VAULT_KEY_BACKEND. Once chosen it is pinned: silently switching would orphan every key.
 *
 * MIGRATION. A plaintext vault-keys.json is wrapped on first use: keys sealed, written to a temp
 * file, fsynced, renamed into place, READ BACK and every key compared, and only then the plaintext
 * file is renamed aside, overwritten with random bytes, fsynced and unlinked. A crash at any point
 * leaves at least one complete copy of every key (see replicated-vault-keys.test.ts, which kills
 * the process at each step). A key file readable by group or others is refused outright.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto"
import fs from "fs"
import os from "os"
import path from "path"
import { execFileSync, spawnSync } from "child_process"
import { VaultUserError } from "./encrypted-vault-files"

export type KekBackend = "keychain" | "libsecret" | "node-key" | "passphrase"
export const BACKENDS: KekBackend[] = ["keychain", "libsecret", "node-key", "passphrase"]

export const PLAINTEXT_FILE = "vault-keys.json"
export const WRAPPED_FILE = "vault-keys.wrapped.json"
export const FORMAT = "iris-replicated-vault-keys"
export const EXPORT_FORMAT = "iris-replicated-vault-key-export"
/** Documented in the how-to. 2^17 × 8 × 128 B = 128 MiB of memory per guess. */
export const SCRYPT_PARAMS = { N: 2 ** 17, r: 8, p: 1 } as const
const SCRYPT_MAXMEM = 256 * 1024 * 1024
const KEYSTORE_SERVICE = "iris-replicated-vault"
const KEYSTORE_ACCOUNT = "kek"
const CHECK_PLAINTEXT = "iris-replicated-vault-keys:check:v1"
const LOCK_STALE_MS = 60_000

export interface Sealed { iv: string; tag: string; ct: string }

export interface WrappedDoc {
  format: typeof FORMAT
  v: 1
  backend: KekBackend
  node_key_file?: string
  kdf?: { alg: "scrypt"; N: number; r: number; p: number; salt: string }
  created_at: string
  check: Sealed
  keys: Record<string, Sealed>
}

/** A KEK held by the OS. get() returns null when there is none (or the keystore will not answer). */
export interface SecretStore {
  available(): boolean
  get(): Buffer | null
  set(key: Buffer): void
}

export interface KeyStoreFaults {
  /** Called after the temp file is written and fsynced, before it is renamed into place. */
  afterTmpWrite?(): void
  /** Called after the wrapped file is renamed into place, before it is verified. */
  afterRename?(): void
  /** Called after verification, after the plaintext is renamed aside, before it is shredded. */
  beforeShred?(): void
}

export interface KeyStoreOptions {
  /** The ~/.iris directory. */
  irisDir: string
  nodeKeyFile: string
  forceBackend?: KekBackend
  /** How to ask for a passphrase. Absent = no way to ask (no TTY, no --passphrase-stdin). */
  passphrase?: (confirm: boolean) => Promise<string>
  keychain: SecretStore
  libsecret: SecretStore
  /** Create the node key file. Returns false when it cannot (no root, no passwordless sudo). */
  createNodeKey: (file: string, key: Buffer) => boolean
  faults?: KeyStoreFaults
}

// ── crypto ───────────────────────────────────────────────────────────────────

export function seal(kek: Buffer, plaintext: Buffer, aad: string): Sealed {
  const iv = randomBytes(12)
  const c = createCipheriv("aes-256-gcm", kek, iv)
  c.setAAD(Buffer.from(aad))
  const ct = Buffer.concat([c.update(plaintext), c.final()])
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") }
}

export function unseal(kek: Buffer, s: Sealed, aad: string): Buffer {
  const d = createDecipheriv("aes-256-gcm", kek, Buffer.from(s.iv, "base64"))
  d.setAAD(Buffer.from(aad))
  d.setAuthTag(Buffer.from(s.tag, "base64"))
  return Buffer.concat([d.update(Buffer.from(s.ct, "base64")), d.final()])
}

const keyAad = (vaultId: string) => `iris-replicated-vault-key|v1|${vaultId}`
const CHECK_AAD = "iris-replicated-vault-key|v1|check"

export function passphraseKek(passphrase: string, salt: Buffer, p: { N: number; r: number; p: number } = SCRYPT_PARAMS): Buffer {
  if (!passphrase) throw new VaultUserError("an empty passphrase cannot protect vault keys")
  return scryptSync(passphrase.normalize("NFKC"), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: SCRYPT_MAXMEM })
}

// ── files ────────────────────────────────────────────────────────────────────

const modeStr = (m: number) => (m & 0o777).toString(8).padStart(3, "0")

/**
 * Refuse a key file anyone but its owner can read or write. The plaintext file with group/other
 * read is not migrated: its keys must be treated as already exposed, and wrapping them would
 * pretend otherwise. Returns false when the file does not exist.
 */
export function assertPrivate(file: string, label = file): boolean {
  let st: fs.Stats
  try { st = fs.lstatSync(file) } catch (e: any) { if (e?.code === "ENOENT") return false; throw e }
  if (process.platform === "win32") return true // ACLs, not modes
  if (st.isSymbolicLink()) throw new VaultUserError(`${label} is a symlink — refusing to read vault keys through it. Replace it with the real file (mode 0600).`)
  if (st.mode & 0o077) {
    throw new VaultUserError(
      `${label} is readable or writable by other users (mode ${modeStr(st.mode)}), so the vault keys in it may already be exposed. ` +
      `Fix: chmod 600 ${label}  — then re-run. Consider every vault whose key was in it compromised and move its files to a new vault.`,
    )
  }
  if (typeof process.getuid === "function" && st.uid !== process.getuid() && st.uid !== 0) {
    throw new VaultUserError(`${label} is owned by uid ${st.uid}, not by you — refusing to use it.`)
  }
  return true
}

function fsyncDir(dir: string) {
  if (process.platform === "win32") return
  try { const fd = fs.openSync(dir, "r"); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } } catch { /* best effort */ }
}

/** temp file (0600, O_EXCL) → write → fsync → rename → fsync dir. */
export function writeFileAtomic(file: string, data: string, faults?: KeyStoreFaults) {
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const tmp = `${file}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  const fd = fs.openSync(tmp, "wx", 0o600)
  try {
    fs.writeSync(fd, data)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  faults?.afterTmpWrite?.()
  fs.renameSync(tmp, file)
  fsyncDir(dir)
}

/** Overwrite with random bytes, fsync, unlink. On SSD/CoW filesystems the overwrite is best effort. */
export function shredFile(file: string) {
  let size = 0
  try { size = fs.statSync(file).size } catch { return }
  const fd = fs.openSync(file, "r+")
  try {
    if (size > 0) fs.writeSync(fd, randomBytes(size), 0, size, 0)
    fs.fsyncSync(fd)
  } finally { fs.closeSync(fd) }
  fs.unlinkSync(file)
  fsyncDir(path.dirname(file))
}

// ── OS keystores (same shape as iris-daemon lib/node-vault.js; secrets on stdin, never argv) ──

function hasCommand(cmd: string): boolean {
  try { execFileSync(process.platform === "win32" ? "where" : "which", [cmd], { stdio: "ignore" }); return true } catch { return false }
}

export const macKeychain: SecretStore = {
  available: () => process.platform === "darwin" && hasCommand("security"),
  get() {
    try {
      const out = execFileSync("security", ["find-generic-password", "-a", KEYSTORE_ACCOUNT, "-s", KEYSTORE_SERVICE, "-w"], { stdio: ["ignore", "pipe", "ignore"], timeout: 30_000 })
      const s = out.toString().trim()
      return s ? Buffer.from(s, "base64") : null
    } catch { return null }
  },
  set(key) {
    execFileSync("security", ["-i"], {
      input: `add-generic-password -U -a ${KEYSTORE_ACCOUNT} -s ${KEYSTORE_SERVICE} -l "IRIS replicated vault keys" -w ${key.toString("base64")}\n`,
      stdio: ["pipe", "ignore", "pipe"], timeout: 30_000,
    })
  },
}

export const linuxSecretService: SecretStore = {
  available: () => process.platform === "linux" && !!process.env.DBUS_SESSION_BUS_ADDRESS && hasCommand("secret-tool"),
  get() {
    try {
      const out = execFileSync("secret-tool", ["lookup", "service", KEYSTORE_SERVICE, "account", KEYSTORE_ACCOUNT], { stdio: ["ignore", "pipe", "ignore"], timeout: 10_000 })
      const s = out.toString().trim()
      return s ? Buffer.from(s, "base64") : null
    } catch { return null }
  },
  set(key) {
    // A timeout: on a headless box with a bus but no unlocked keyring, secret-tool can wait forever.
    execFileSync("secret-tool", ["store", "--label=IRIS replicated vault keys", "service", KEYSTORE_SERVICE, "account", KEYSTORE_ACCOUNT], {
      input: key.toString("base64"), stdio: ["pipe", "ignore", "pipe"], timeout: 10_000,
    })
  },
}

export function defaultNodeKeyFile(): string {
  if (process.env.IRIS_VAULT_NODE_KEY_FILE) return process.env.IRIS_VAULT_NODE_KEY_FILE
  const uid = typeof process.getuid === "function" ? process.getuid() : "user"
  return `/etc/iris/vault-kek/${uid}.key`
}

/**
 * The node key file: a root-owned 0755 directory (so the user cannot delete or swap the file
 * without sudo) holding a file owned by the user, mode 0400. Needs root once. Written via stdin.
 */
export function createNodeKeyWithSudo(file: string, key: Buffer, interactive = false): boolean {
  if (process.platform !== "linux" && process.platform !== "darwin") return false
  const uid = process.getuid?.()
  const gid = process.getgid?.()
  // Parent dirs 0755 (umask 022) so the user can reach the file; the file itself is made under 077.
  const script = 'set -e; umask 022; d=$(dirname "$1"); mkdir -p "$d"; chown root:root "$d"; chmod 755 "$d"; umask 077; ' +
    't="$1.tmp.$$"; cat > "$t"; chown "$2:$3" "$t"; chmod 400 "$t"; mv -f "$t" "$1"'
  const args = ["sh", "-c", script, "sh", file, String(uid), String(gid)]
  const r = uid === 0
    ? spawnSync(args[0], args.slice(1), { input: key.toString("base64") + "\n", stdio: ["pipe", "ignore", "pipe"] })
    : spawnSync("sudo", interactive ? args : ["-n", ...args], {
      input: key.toString("base64") + "\n",
      stdio: [ "pipe", "ignore", interactive ? "inherit" : "pipe"],
      timeout: interactive ? 120_000 : 15_000,
    })
  return r.status === 0
}

function readNodeKey(file: string): Buffer | null {
  if (!assertPrivate(file, file)) return null
  const k = Buffer.from(fs.readFileSync(file, "utf8").trim(), "base64")
  return k.length === 32 ? k : null
}

// ── the store ────────────────────────────────────────────────────────────────

export function defaultOptions(over: Partial<KeyStoreOptions> = {}): KeyStoreOptions {
  const forced = process.env.IRIS_VAULT_KEY_BACKEND as KekBackend | undefined
  if (forced && !BACKENDS.includes(forced)) throw new VaultUserError(`unknown IRIS_VAULT_KEY_BACKEND "${forced}" — one of: ${BACKENDS.join(", ")}`)
  return {
    irisDir: path.join(os.homedir(), ".iris"),
    nodeKeyFile: defaultNodeKeyFile(),
    forceBackend: forced,
    keychain: macKeychain,
    libsecret: linuxSecretService,
    createNodeKey: (f, k) => createNodeKeyWithSudo(f, k, false),
    ...over,
  }
}

export class ReplicatedKeyStore {
  readonly plainFile: string
  readonly wrappedFile: string
  private kek: Buffer | null = null
  /** A brand-new store's doc, built in memory by open() and not written until a key is saved. */
  private pendingDoc: WrappedDoc | null = null
  constructor(readonly o: KeyStoreOptions) {
    this.plainFile = path.join(o.irisDir, PLAINTEXT_FILE)
    this.wrappedFile = path.join(o.irisDir, WRAPPED_FILE)
  }

  // ---- reading without a KEK (names only) ----

  private readDoc(): WrappedDoc | null {
    if (!assertPrivate(this.wrappedFile, `~/.iris/${WRAPPED_FILE}`)) return null
    let doc: WrappedDoc
    try { doc = JSON.parse(fs.readFileSync(this.wrappedFile, "utf8")) } catch {
      throw new VaultUserError(`~/.iris/${WRAPPED_FILE} is not valid JSON — not touching it. Restore it from a backup or a key export.`)
    }
    if (doc.format !== FORMAT || doc.v !== 1 || !BACKENDS.includes(doc.backend)) {
      throw new VaultUserError(`~/.iris/${WRAPPED_FILE} is not a replicated-vault key file this CLI understands (format ${doc.format} v${doc.v})`)
    }
    return doc
  }

  private readPlain(): Record<string, string> | null {
    if (!assertPrivate(this.plainFile, `~/.iris/${PLAINTEXT_FILE}`)) return null
    let keys: any
    try { keys = JSON.parse(fs.readFileSync(this.plainFile, "utf8")) } catch {
      throw new VaultUserError(`~/.iris/${PLAINTEXT_FILE} is not valid JSON — not migrating it. Move it aside, or fix it, and re-run.`)
    }
    if (!keys || typeof keys !== "object" || Array.isArray(keys)) throw new VaultUserError(`~/.iris/${PLAINTEXT_FILE} is not a map of vault id → key — not migrating it`)
    return keys
  }

  /** Leftovers from an interrupted run: stale temp files (incomplete, never renamed) and plaintext
   *  copies already renamed aside for shredding (only ever renamed AFTER the wrapped copy verified). */
  private sweep() {
    let names: string[] = []
    try { names = fs.readdirSync(this.o.irisDir) } catch { return }
    for (const n of names) {
      const f = path.join(this.o.irisDir, n)
      if (n.startsWith(`${WRAPPED_FILE}.tmp-`)) { try { fs.unlinkSync(f) } catch { /* gone */ } }
      else if (n.startsWith(`${PLAINTEXT_FILE}.shred-`)) { try { shredFile(f) } catch { /* retried next run */ } }
    }
  }

  /** Vault ids with a key on this machine. Needs no KEK, never prompts, never migrates. */
  ids(): Set<string> {
    const ids = new Set<string>(Object.keys(this.readDoc()?.keys ?? {}))
    for (const id of Object.keys(this.readPlain() ?? {})) ids.add(id)
    return ids
  }

  status() {
    const doc = this.readDoc()
    const plain = this.readPlain()
    return {
      wrapped_file: this.wrappedFile,
      backend: doc?.backend ?? null,
      node_key_file: doc?.backend === "node-key" ? doc.node_key_file : undefined,
      kdf: doc?.kdf ? { alg: doc.kdf.alg, N: doc.kdf.N, r: doc.kdf.r, p: doc.kdf.p } : undefined,
      wrapped_keys: Object.keys(doc?.keys ?? {}).length,
      plaintext_file_present: !!plain,
      plaintext_keys: Object.keys(plain ?? {}).length,
    }
  }

  // ---- the KEK ----

  private async kekFor(doc: WrappedDoc): Promise<Buffer> {
    if (this.kek) return this.kek
    let kek: Buffer | null = null
    switch (doc.backend) {
      case "keychain": kek = this.o.keychain.get(); break
      case "libsecret": kek = this.o.libsecret.get(); break
      case "node-key": kek = readNodeKey(doc.node_key_file || this.o.nodeKeyFile); break
      case "passphrase": {
        if (!doc.kdf) throw new VaultUserError(`~/.iris/${WRAPPED_FILE} says passphrase but has no KDF parameters`)
        if (!this.o.passphrase) {
          throw new VaultUserError("replicated vault keys on this machine are protected by a passphrase — run this in a terminal, or pass --passphrase-stdin")
        }
        kek = passphraseKek(await this.o.passphrase(false), Buffer.from(doc.kdf.salt, "base64"), doc.kdf)
        break
      }
    }
    if (!kek || kek.length !== 32) {
      const where = doc.backend === "node-key" ? `the node key file ${doc.node_key_file}` : `the ${doc.backend}`
      throw new VaultUserError(`the key that unwraps replicated vault keys is missing from ${where}. Without it the wrapped keys cannot be opened — restore it, or import each vault from a key export (iris vault key import).`)
    }
    try {
      if (unseal(kek, doc.check, CHECK_AAD).toString() !== CHECK_PLAINTEXT) throw new Error("check mismatch")
    } catch {
      throw new VaultUserError(doc.backend === "passphrase"
        ? "wrong passphrase for this machine's replicated vault keys"
        : `the key in ${doc.backend} does not open ~/.iris/${WRAPPED_FILE} — it was replaced; restore the original or import from key exports`)
    }
    this.kek = kek
    return kek
  }

  private async newDoc(): Promise<WrappedDoc> {
    const now = new Date().toISOString()
    const make = (backend: KekBackend, kek: Buffer, extra: Partial<WrappedDoc> = {}): WrappedDoc => {
      this.kek = kek
      return { format: FORMAT, v: 1, backend, created_at: now, check: seal(kek, Buffer.from(CHECK_PLAINTEXT), CHECK_AAD), keys: {}, ...extra }
    }
    const tryStore = (s: SecretStore): Buffer | null => {
      if (!s.available()) return null
      const existing = s.get()
      if (existing && existing.length === 32) return existing
      const k = randomBytes(32)
      try { s.set(k) } catch { return null }
      const back = s.get()
      return back && back.equals(k) ? k : null
    }
    const order: KekBackend[] = this.o.forceBackend ? [this.o.forceBackend] : BACKENDS
    for (const b of order) {
      if (b === "keychain") { const k = tryStore(this.o.keychain); if (k) return make(b, k) }
      if (b === "libsecret") { const k = tryStore(this.o.libsecret); if (k) return make(b, k) }
      if (b === "node-key") {
        const f = this.o.nodeKeyFile
        let k = readNodeKey(f)
        if (!k) {
          const fresh = randomBytes(32)
          if (this.o.createNodeKey(f, fresh)) k = readNodeKey(f)
        }
        if (k) return make(b, k, { node_key_file: f })
      }
      if (b === "passphrase" && this.o.passphrase) {
        const salt = randomBytes(16)
        const pass = await this.o.passphrase(true)
        if (pass.length < 8) throw new VaultUserError("a vault-key passphrase must be at least 8 characters")
        return make(b, passphraseKek(pass, salt), { kdf: { alg: "scrypt", ...SCRYPT_PARAMS, salt: salt.toString("base64") } })
      }
    }
    throw new VaultUserError(
      this.o.forceBackend
        ? `IRIS_VAULT_KEY_BACKEND=${this.o.forceBackend} is not usable on this machine`
        : "nowhere safe to keep replicated vault keys on this machine: no OS keychain, no node key, and no terminal to ask for a passphrase. " +
          "Fix (once, as an admin): iris vault key setup --node-key   — or run this in a terminal to protect them with a passphrase.",
    )
  }

  private writeDoc(doc: WrappedDoc) {
    writeFileAtomic(this.wrappedFile, JSON.stringify(doc, null, 2) + "\n", this.o.faults)
    this.o.faults?.afterRename?.()
  }

  // ---- lock: two CLIs creating a KEK at once would each wrap under a different one ----

  private async withLock<T>(fn: () => Promise<T>): Promise<T> {
    fs.mkdirSync(this.o.irisDir, { recursive: true, mode: 0o700 })
    const lock = path.join(this.o.irisDir, "vault-keys.lock")
    const deadline = Date.now() + 30_000
    for (;;) {
      try {
        const fd = fs.openSync(lock, "wx", 0o600)
        try { fs.writeSync(fd, String(process.pid)) } finally { fs.closeSync(fd) }
        break
      } catch (e: any) {
        if (e?.code !== "EEXIST") throw e
        // Stale if its holder is dead (a crash or kill mid-migration) or it is old.
        let stale = false
        try {
          const pid = Number(fs.readFileSync(lock, "utf8").trim())
          if (pid > 0) { try { process.kill(pid, 0) } catch (k: any) { stale = k?.code === "ESRCH" } }
          if (Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS) stale = true
        } catch { continue }
        if (stale) { try { fs.unlinkSync(lock) } catch { /* raced */ } continue }
        if (Date.now() > deadline) throw new VaultUserError(`another iris process holds ${lock} — wait for it, or remove the file if none is running`)
        await new Promise((r) => setTimeout(r, 100))
      }
    }
    try { return await fn() } finally { try { fs.unlinkSync(lock) } catch { /* gone */ } }
  }

  /**
   * Bring the store to its wrapped form and return the open doc. Migrates a plaintext file if
   * there is one. Safe to re-run after a crash at any step.
   */
  async open(): Promise<{ doc: WrappedDoc; kek: Buffer; migrated: number }> {
    return this.withLock(async () => {
      this.sweep()
      const plain = this.readPlain()
      let doc = this.readDoc()
      if (!doc) {
        if (!plain) {
          // Nothing to write yet: the doc (and its KEK) is kept for saveKey, so a passphrase is
          // asked once and a keystore entry is minted once.
          doc = this.pendingDoc ?? (await this.newDoc())
          this.pendingDoc = doc
          return { doc, kek: this.kek!, migrated: 0 }
        }
        doc = await this.newDoc()
      }
      const kek = await this.kekFor(doc)
      if (!plain) return { doc, kek, migrated: 0 }

      // 1. seal what is not wrapped yet; refuse a disagreement rather than pick a winner
      let added = 0
      const want = new Map<string, Buffer>()
      for (const [id, b64] of Object.entries(plain)) {
        const key = Buffer.from(String(b64), "base64")
        want.set(id, key)
        if (doc.keys[id]) {
          const have = unseal(kek, doc.keys[id], keyAad(id))
          if (!have.equals(key)) {
            throw new VaultUserError(`vault ${id} has a different key in ~/.iris/${PLAINTEXT_FILE} than in ~/.iris/${WRAPPED_FILE} — not migrating. Export the wrapped one, move the plaintext file aside, and decide which is right.`)
          }
          continue
        }
        doc.keys[id] = seal(kek, key, keyAad(id))
        added++
      }
      // 2. write (temp → fsync → rename), even when nothing was added but the file was never written
      if (added > 0 || !fs.existsSync(this.wrappedFile)) this.writeDoc(doc)
      // 3. read back from disk and compare every key
      const onDisk = this.readDoc()
      if (!onDisk) throw new VaultUserError("wrapped key file vanished during migration — plaintext left in place")
      for (const [id, key] of want) {
        let got: Buffer
        try { got = unseal(kek, onDisk.keys[id], keyAad(id)) } catch { throw new VaultUserError(`migration check failed for vault ${id} — plaintext left in place`) }
        if (!got.equals(key)) throw new VaultUserError(`migration check failed for vault ${id} — plaintext left in place`)
      }
      // 4. only now: rename aside (atomic), then overwrite + unlink. A crash here leaves a
      //    .shred- file that the next run's sweep() finishes off — the wrapped copy is verified.
      const aside = `${this.plainFile}.shred-${randomBytes(4).toString("hex")}`
      fs.renameSync(this.plainFile, aside)
      this.o.faults?.beforeShred?.()
      shredFile(aside)
      return { doc: onDisk, kek, migrated: want.size }
    })
  }

  async getKey(vaultId: string): Promise<Buffer | null> {
    if (!this.ids().has(vaultId)) return null
    const { doc, kek } = await this.open()
    const s = doc.keys[vaultId]
    if (!s) return null
    try { return unseal(kek, s, keyAad(vaultId)) } catch {
      throw new VaultUserError(`the wrapped key for vault ${vaultId} does not authenticate — ~/.iris/${WRAPPED_FILE} was altered`)
    }
  }

  async saveKey(vaultId: string, key: Buffer): Promise<void> {
    await this.open()
    await this.withLock(async () => {
      const doc = this.readDoc() ?? this.pendingDoc ?? (await this.newDoc())
      const kek = await this.kekFor(doc)
      doc.keys[vaultId] = seal(kek, key, keyAad(vaultId))
      this.writeDoc(doc)
      this.pendingDoc = null
      const back = this.readDoc()!
      if (!unseal(kek, back.keys[vaultId], keyAad(vaultId)).equals(key)) throw new VaultUserError(`could not verify the wrapped key for vault ${vaultId}`)
    })
  }

  async ensure(): Promise<{ doc: WrappedDoc; migrated: number }> {
    const r = await this.open()
    if (!fs.existsSync(this.wrappedFile)) await this.withLock(async () => { if (!fs.existsSync(this.wrappedFile)) this.writeDoc(r.doc) })
    return { doc: this.readDoc()!, migrated: r.migrated }
  }
}

// ── export / import: moving ONE vault to another machine without an unwrapped key ─────────────

export interface ExportBundle {
  format: typeof EXPORT_FORMAT
  v: 1
  vault_id: string
  kdf: { alg: "scrypt"; N: number; r: number; p: number; salt: string }
  sealed: Sealed
}

export interface ExportPayload { vault_id: string; key: string; meta?: any; manifest?: any }

const exportAad = (id: string) => `iris-replicated-vault-key-export|v1|${id}`

export function sealExport(payload: ExportPayload, passphrase: string): ExportBundle {
  if (passphrase.length < 8) throw new VaultUserError("an export passphrase must be at least 8 characters")
  const salt = randomBytes(16)
  const kek = passphraseKek(passphrase, salt)
  return {
    format: EXPORT_FORMAT, v: 1, vault_id: payload.vault_id,
    kdf: { alg: "scrypt", ...SCRYPT_PARAMS, salt: salt.toString("base64") },
    sealed: seal(kek, Buffer.from(JSON.stringify(payload)), exportAad(payload.vault_id)),
  }
}

export function openExport(bundle: ExportBundle, passphrase: string): ExportPayload {
  if (bundle?.format !== EXPORT_FORMAT || bundle.v !== 1) throw new VaultUserError("not an IRIS replicated-vault key export")
  const kek = passphraseKek(passphrase, Buffer.from(bundle.kdf.salt, "base64"), bundle.kdf)
  let p: ExportPayload
  try { p = JSON.parse(unseal(kek, bundle.sealed, exportAad(bundle.vault_id)).toString()) } catch {
    throw new VaultUserError("wrong passphrase for this key export (or the file was altered)")
  }
  if (p.vault_id !== bundle.vault_id) throw new VaultUserError("key export is inconsistent (vault id mismatch)")
  return p
}
