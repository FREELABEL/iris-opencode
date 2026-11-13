/**
 * `iris vault` — a sovereign, device-owned store (see vault-core.ts for the model).
 *
 * WHAT IS ACTUALLY NEW HERE IS SMALL, AND THAT IS THE POINT. Almost everything a distributed
 * store needs already existed and was measured this week:
 *
 *   identity + pairing      mesh PSK, operator/peer tiers          (coding-agent-bridge 9a1821d)
 *   node registry + liveness heartbeat, `iris hive nodes`
 *   capacity                 `iris hive doctor` already reads disk headroom      (#182019)
 *   byte transport           `iris hive fs` — staged, sha256 BOTH ends, TCC-aware (#182013)
 *
 * This file is the wiring: chunk, encrypt, place, replicate, verify. The bytes ride the
 * Tailscale rail because that is the only rail measured to carry them intact — the cloud task
 * transport returns a PTY scrape and scored 6/8 on its own selftest (#182004, #182018).
 *
 * ── PHI / SOVEREIGNTY POSTURE, STATED SO IT CAN BE AUDITED ──────────────────────────────
 *
 *   - Plaintext NEVER leaves the machine that created it. Chunks are encrypted locally with a
 *     key that lives only on devices the operator owns, wrapped at rest by the OS keychain, a
 *     node key outside the home directory, or a passphrase (#193396, replicated-vault-keys.ts).
 *   - No third party is in the byte path. No CDN, no S3, no Drive. Device to device only.
 *   - A replica node stores ciphertext addressed by its own hash, so it can prove its copy is
 *     intact without being able to read it. Replication does not imply clearance.
 *   - `status` ASKS THE NODES what they hold. It does not read a local ledger of what we
 *     believe we sent. A backup product that reports from its own optimism is the exact defect
 *     this codebase has spent the week removing.
 *
 * NOT YET, and deliberately not claimed: multi-writer conflict handling (single-writer only),
 * key escrow/recovery, and always-on availability. Each is called out in `status`.
 */

import { cmd } from "./cmd"
import { NodeVaultCommands, daemonVaultLocked, readPassphrase } from "./platform-hive-vaults"
import {
  VaultUserError, loadEncryptedVaultModule, findEncryptedVault, openForUse,
  encryptedPut, encryptedLs, encryptedGet, type EncryptedVaultModule,
} from "./encrypted-vault-files"
import { requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { fetchNodes } from "./platform-hive-nodes"
import { resolveSshTarget, ensureSshUser, sshRun, pushFile, pullFile, shq, shqPath, detectLocalNodeId, type SshTarget } from "./hive-tailscale"
import {
  buildEntry, reassemble, nextManifest, manifestDigest, normalizePath,
  choosePlacement, replicationHealth, generateVaultKey, sha256,
  type VaultManifest, type PlacementNode,
} from "./vault-core"
import { ReplicatedKeyStore, defaultOptions, sealExport, openExport, createNodeKeyWithSudo, defaultNodeKeyFile, BACKENDS, type KekBackend } from "./replicated-vault-keys"
import { readFile, writeFile, mkdir, readdir } from "fs/promises"
import { existsSync, statSync, mkdtempSync, rmSync, readFileSync } from "fs"
import { homedir, hostname, tmpdir } from "os"
import { join, dirname, basename } from "path"
import { randomUUID } from "crypto"
import {
  type VaultTarget, type ReplicaIndex, type SealedManifest, type BlobSource,
  resolveOn, targetKey, targetLabel, buildIndex, sealManifest, openManifest, contentId, writeReplicaIndex, writeAtomic,
  readReplicaIndex, readReplicaMeta, readSealed, heldBlobs, folderSource, planPlacement, holdersOf, replicasOnMount,
  replicaDir, parseIndex, effectiveCopies, splitList, fmt, SELF_WORDS,
} from "./vault-drives"
import {
  type DriveEnv, type TargetCheck, type VaultCatalog, syncDriveTargets, recordChecks, replicaMetaFor, statusOf,
  formatChecks, mountedReplicaDirs, localReplicaDir, statfsOf,
} from "./vault-replicas"
import { resolveMount, openVaultCatalog } from "./platform-drives"

const VAULT_ROOT = join(homedir(), ".iris", "vault")
const KEYS_FILE = join(homedir(), ".iris", "vault-keys.json")

// ── local store ──────────────────────────────────────────────────────────────

const vaultDir = (id: string) => join(VAULT_ROOT, id)
const blobPath = (id: string, blobId: string) => join(vaultDir(id), "blobs", blobId.slice(0, 2), blobId)
/** Same layout on every node, so a remote path is derivable rather than negotiated. */
/**
 * Where vaults live on your OTHER machines — the same layout everywhere. IRIS_VAULT_REMOTE_DIR
 * (set on the asking machine) names another folder there: a custom install, or a test that must
 * not touch the real ~/.iris on another machine.
 */
const remoteRoot = () => (process.env.IRIS_VAULT_REMOTE_DIR || "~/.iris/vault").replace(/\/+$/, "")
const remoteVaultPath = (id: string, ...rest: string[]) => [remoteRoot(), id, ...rest].join("/")
const remoteBlobPath = (id: string, blobId: string) => remoteVaultPath(id, "blobs", blobId.slice(0, 2))

interface VaultMeta {
  id: string
  name: string
  created_at: string
  /** the minimum number of copies (TOTAL, this machine included) */
  replicas: number
  /** #193363: where copies go — drives and machines named with --on. Absent = the original
   *  behaviour: copies spread over whichever of your machines have room. */
  targets?: VaultTarget[]
  /** the machine the vault was created on (catch-up fetches from it by default) */
  source_node?: string | null
}

/**
 * Replicated-vault keys are wrapped at rest (#193396): sealed under a key held by the OS keychain,
 * a node key outside the home directory, or a passphrase — never plaintext in ~/.iris. A plaintext
 * ~/.iris/vault-keys.json from an older CLI is migrated on first use. See replicated-vault-keys.ts.
 */
function keyStore(argv: any = {}): ReplicatedKeyStore {
  const fromStdin = !!argv["passphrase-stdin"]
  return new ReplicatedKeyStore(defaultOptions({
    passphrase: fromStdin || process.stdin.isTTY ? (confirm) => readPassphrase(confirm && !fromStdin, fromStdin) : undefined,
  }))
}

async function requireKey(vaultId: string, argv: any = {}): Promise<Buffer> {
  const k = await keyStore(argv).getKey(vaultId)
  if (!k) throw new VaultUserError(`no key for vault ${vaultId} on this machine. Keys never sync — on the machine that has it run: iris vault key export <vault> --out <file>, then here: iris vault key import <file>`)
  return k
}

// ── copies on drives and named machines (#193363) ───────────────────────────────────────────

const driveEnv: DriveEnv = { resolveMount: (id) => resolveMount(id), statfs: (p) => statfsOf(p) }

async function openCatalog(userId: number, bloqFlag: unknown): Promise<{ bloq: number; cat: VaultCatalog } | null> {
  return openVaultCatalog(userId, bloqFlag)
}

/** This machine as a target: the --on entry that is this machine, or a synthesized one. */
function selfTarget(meta: VaultMeta): VaultTarget {
  const me = hostname()
  const named = (meta.targets ?? []).find((t) => t.kind === "machine" && (t.name.toLowerCase() === me.toLowerCase()))
  return named ?? { kind: "machine", name: me, self: true }
}

/** Every place a copy belongs: the --on targets, plus the machine the vault was created on. */
function allTargets(meta: VaultMeta): VaultTarget[] {
  const ts = [...(meta.targets ?? [])]
  const src = meta.source_node ?? null
  if (src && !ts.some((t) => t.kind === "machine" && t.name.toLowerCase() === src.toLowerCase())) ts.unshift({ kind: "machine", name: src, self: src.toLowerCase() === hostname().toLowerCase() })
  return ts.map((t) => (t.kind === "machine" ? { ...t, self: t.name.toLowerCase() === hostname().toLowerCase() } : t))
}

/** The index this machine can build (needs the key) or the one last written next to the vault. */
function currentIndex(meta: VaultMeta, man: VaultManifest | null, key: Buffer | null): ReplicaIndex | null {
  if (man && key) return buildIndex(key, man)
  const i = readReplicaIndex(localReplicaDir(vaultDir(meta.id)))
  return i && i.vault_id === meta.id ? i : null
}

/** Write vault.json + index + sealed manifest next to this machine's chunks — the files a replica carries. */
function writeLocalReplicaFiles(meta: VaultMeta, index: ReplicaIndex, sealed: SealedManifest | null) {
  const dir = localReplicaDir(vaultDir(meta.id))
  writeAtomic(join(dir, "vault.json"), JSON.stringify(replicaMetaFor(meta), null, 2) + "\n")
  writeReplicaIndex(dir, index, sealed)
}

/**
 * A drive replica written by a newer put (on another machine) has a newer manifest. With the key,
 * adopt it — so a machine that imported the vault key reads files put after the export.
 */
async function adoptNewerManifest(meta: VaultMeta, key: Buffer, man: VaultManifest | null): Promise<{ man: VaultManifest | null; from?: string }> {
  let best = man
  let from: string | undefined
  for (const { target, dir } of mountedReplicaDirs(meta, driveEnv)) {
    const sealed = readSealed(dir)
    if (!sealed || sealed.vault_id !== meta.id || sealed.seq <= (best?.seq ?? 0)) continue
    best = openManifest(key, sealed)
    from = targetLabel(target)
  }
  if (best && best !== man) await writeManifest(meta.id, best)
  return { man: best, from }
}

async function loadMeta(id: string): Promise<VaultMeta> {
  return JSON.parse(await readFile(join(vaultDir(id), "vault.json"), "utf-8"))
}

async function findReplicated(nameOrId: string): Promise<VaultMeta | null> {
  if (existsSync(join(vaultDir(nameOrId), "vault.json"))) return loadMeta(nameOrId)
  let ids: string[] = []
  try { ids = await readdir(VAULT_ROOT) } catch { /* none yet */ }
  for (const id of ids) {
    try {
      const m = await loadMeta(id)
      if (m.name === nameOrId) return m
    } catch { /* skip malformed */ }
  }
  return null
}

/**
 * One name, two kinds: a replicated vault (this file) or an encrypted PHI vault on THIS node
 * (#192912 — `put` used to look only at replicated vaults, so a vault `list` showed could not be
 * filled). When a name exists as both, neither silently wins: the command refuses and asks for
 * --replicated or --encrypted, because putting PHI into the wrong kind is not reversible.
 */
type AnyVault =
  | { kind: "replicated"; meta: VaultMeta }
  | { kind: "encrypted"; entry: any; mod: EncryptedVaultModule }

export type VaultKind = "replicated" | "encrypted"

/** Which kind the flags ask for: --encrypted / --replicated (both is a mistake). */
export function kindFromFlags(argv: { encrypted?: boolean; replicated?: boolean }): VaultKind | undefined {
  if (argv.encrypted && argv.replicated) throw new VaultUserError("pass --encrypted or --replicated, not both")
  if (argv.encrypted) return "encrypted"
  if (argv.replicated) return "replicated"
  return undefined
}

async function resolveAnyVault(nameOrId: string, want?: VaultKind): Promise<AnyVault> {
  const meta = want === "encrypted" ? null : await findReplicated(nameOrId)
  const mod = want === "replicated" ? null : loadEncryptedVaultModule()
  const entry = findEncryptedVault(mod, nameOrId)
  if (meta && mod && entry) {
    throw new VaultUserError(
      `"${nameOrId}" is the name of a replicated vault AND an encrypted PHI vault on this machine — say which: --replicated or --encrypted`,
    )
  }
  if (meta) return { kind: "replicated", meta }
  if (mod && entry) return { kind: "encrypted", entry, mod }
  if (want === "encrypted" && !loadEncryptedVaultModule()) {
    throw new VaultUserError(`no encrypted vault named "${nameOrId}": the IRIS daemon is not installed on this machine (encrypted vaults live in it). Run: iris bridge start`)
  }
  const kind = want ? `${want} ` : ""
  throw new VaultUserError(`no ${kind}vault named "${nameOrId}" on this machine. Run: iris hive vault list`)
}

/** Open an encrypted vault for this process, refusing a locked one with how to fix it. */
async function openEncrypted(v: { entry: any; mod: EncryptedVaultModule }, argv: any) {
  const fromStdin = !!argv["passphrase-stdin"]
  return openForUse(v.mod, v.entry, {
    daemonLocked: await daemonVaultLocked(v.entry.name),
    passphrase: fromStdin || process.stdin.isTTY ? () => readPassphrase(false, fromStdin) : undefined,
  })
}

/**
 * Every failure of these commands ends here: one plain sentence on stderr and exit 1. With --json
 * stdout also gets one JSON object (and nothing else), so a script can read either stream. Before
 * #192912 an unknown vault name reached the top-level handler and came out on STDOUT as
 * "Unexpected error" plus a dump of the minified bundle, with stderr empty.
 */
async function vaultFail(e: unknown, json: boolean): Promise<never> {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`error: ${msg}\n`)
  if (json) await writeJson({ ok: false, error: msg })
  process.exit(1)
}

/** --encrypted / --replicated on put|get|ls|status: only needed when one name is both kinds. */
const KIND_OPTIONS = {
  encrypted: { type: "boolean", describe: "the encrypted PHI vault of this name (only needed if a replicated vault has the same name)" },
  replicated: { type: "boolean", describe: "the replicated vault of this name (only needed if an encrypted vault has the same name)" },
} as const

async function latestManifest(id: string): Promise<VaultManifest | null> {
  const dir = join(vaultDir(id), "manifests")
  let files: string[] = []
  try { files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort() } catch { return null }
  if (files.length === 0) return null
  return JSON.parse(await readFile(join(dir, files[files.length - 1]), "utf-8"))
}

async function writeManifest(id: string, m: VaultManifest): Promise<void> {
  const dir = join(vaultDir(id), "manifests")
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, String(m.seq).padStart(6, "0") + ".json"), JSON.stringify(m, null, 2), "utf-8")
}

// ── mesh ─────────────────────────────────────────────────────────────────────

async function targetFor(node: { id: string; name: string }, argv: any): Promise<SshTarget | null> {
  const r = await resolveSshTarget(node.id, node.name, { user: argv.user as string | undefined })
  if ("error" in r) return null
  const t = await ensureSshUser(node.id, r)
  return "error" in t ? null : t
}

/** Free bytes on a node's home filesystem. Returns null when it cannot be determined — and
 *  choosePlacement treats null as "not room", never as room. */
async function freeBytes(t: SshTarget): Promise<number | null> {
  const r = await sshRun(t, "df -k \"$HOME\" | awk 'NR==2{print $4}'")
  if (!r.ok) return null
  const kb = Number(String(r.stdout).trim())
  return Number.isFinite(kb) && kb > 0 ? kb * 1024 : null
}

/**
 * Ask a node which blobs it ACTUALLY holds.
 *
 * Deliberately a live query rather than a local pin ledger. A store that reports replication
 * from its own record of what it believes it sent cannot distinguish "replicated" from "we
 * tried once" — and that distinction is the entire value of the feature.
 */
async function remoteBlobIds(t: SshTarget, vaultId: string): Promise<Set<string>> {
  const r = await sshRun(t, `ls ${shqPath(remoteVaultPath(vaultId, "blobs"))}/*/ 2>/dev/null | grep -E '^[0-9a-f]{64}$' || true`)
  return new Set(String(r.stdout).split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{64}$/.test(s)))
}

// ── commands ─────────────────────────────────────────────────────────────────

const CreateCommand = cmd({
  command: "create <name>",
  describe: "create a vault — replicated across your machines, or with --encrypted a PHI vault on THIS node",
  builder: (y) => y
    .positional("name", { describe: "vault name", type: "string", demandOption: true })
    .option("replicas", { describe: "minimum copies of each file, this machine included (default 2; with --on: every place listed plus this machine)", type: "number" })
    .option("on", { type: "string", describe: 'put copies on THESE drives and machines, e.g. --on "Backup A,Backup B,this-machine" (drives by their iris drives list name)' })
    .option("bloq", { type: "number", describe: "advanced: the Drives board to use (default: your board named Drives)" })
    .option("encrypted", { type: "boolean", default: false, describe: "an encrypted PHI vault on this node: per-bloq, key in the OS keychain (or --passphrase)" })
    .option("bloq", { type: "string", describe: "(--encrypted) bind to this bloq: only its tasks can open the vault" })
    .option("node", { type: "string", describe: "(--encrypted) must be this machine — keys never travel" })
    .option("passphrase", { type: "boolean", default: false, describe: "(--encrypted) key from a passphrase; stays locked after restarts until unlocked" })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "(--encrypted) read the passphrase from stdin" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false })
    .example('$0 vault create studio --on "Backup A,Backup B,this-machine"', "three copies: two drives and this machine")
    .example('$0 vault create studio --on "Backup A,studio-mac" --replicas 2', "copies on a drive and another of your machines; flagged below 2"),
  async handler(argv) {
    // One noun, two kinds. --encrypted (or any PHI-vault option) means a node-local, per-bloq
    // encrypted vault for patient-data task output; otherwise the replicated sovereign store.
    if (argv.on && (argv.encrypted || argv.passphrase || argv.node)) {
      return vaultFail(new VaultUserError("--on is for replicated vaults: an encrypted PHI vault never leaves the node it is on, so it has no copies on drives"), !!argv.json)
    }
    // --bloq names the Drives board when --on is given; otherwise it binds a PHI vault to a bloq.
    if (argv.encrypted || (argv.bloq && !argv.on) || argv.passphrase || argv["passphrase-stdin"] || argv.node) {
      return (NodeVaultCommands.create as any).handler({ ...argv, encrypted: true })
    }
    const id = randomUUID()
    const meta: VaultMeta = { id, name: String(argv.name), created_at: new Date().toISOString(), replicas: Number(argv.replicas) || 2 }
    let catalog: { bloq: number; cat: VaultCatalog } | null = null
    if (argv.on) {
      try {
        if (await findReplicated(meta.name)) throw new VaultUserError(`a vault named "${meta.name}" already exists on this machine — choose another name`)
        if (!(await requireAuth())) process.exit(1)
        const userId = await requireUserId(argv["user-id"] as number | undefined)
        if (!userId) process.exit(1)
        catalog = await openCatalog(userId, argv.bloq)
        const drives = catalog ? await catalog.cat.drives() : []
        const words = String(argv.on).split(",").map((w) => w.trim().toLowerCase())
        const needNodes = words.some((w) => w && !SELF_WORDS.includes(w) && w !== hostname().toLowerCase() && !drives.some((d: any) => String(d.label ?? "").toLowerCase() === w || String(d.external_id) === w))
        // Machines are listed from the account (one API call); none is dialled to create a vault.
        const nodes = needNodes ? ((await fetchNodes(userId)) as any[]) : []
        const targets = resolveOn(String(argv.on), { drives, nodes, self: hostname() })
        if (targets.some((t) => t.kind === "drive") && !catalog) throw new VaultUserError("No drives cataloged yet — run: iris drives scan <drive or folder>")
        const places = targets.length + (targets.some((t) => t.kind === "machine" && t.self) ? 0 : 1)
        meta.targets = targets
        meta.source_node = hostname()
        meta.replicas = argv.replicas != null ? Number(argv.replicas) : places
        if (!(meta.replicas >= 1)) throw new VaultUserError("--replicas must be at least 1")
        if (meta.replicas > places) {
          throw new VaultUserError(`--replicas ${meta.replicas} can never be reached: --on names ${targets.length} place(s), and with this machine that is ${places} copies at most`)
        }
      } catch (e) {
        return vaultFail(e, !!argv.json)
      }
    }
    // Key first: a vault with no safe place for its key is refused before anything is written.
    const store = keyStore(argv)
    let where: ReturnType<ReplicatedKeyStore["status"]>
    try {
      await store.saveKey(id, generateVaultKey())
      where = store.status()
    } catch (e) {
      return vaultFail(e, !!argv.json)
    }
    await mkdir(join(vaultDir(id), "blobs"), { recursive: true })
    await writeFile(join(vaultDir(id), "vault.json"), JSON.stringify(meta, null, 2), "utf-8")
    // The catalog learns where copies belong now, so a drive plugged into ANOTHER of your machines
    // is recognised as this vault's (pending) copy before anything is put.
    const problems = catalog && meta.targets
      ? await recordChecks(catalog.cat, meta, null, allTargets(meta).map((t) => ({ target: t, key: targetKey(t), status: "pending", held: null, wanted: 0, note: "no files yet" })), hostname(), new Date())
      : []

    if (argv.json) { await writeJson({ ok: true, vault: meta, key_backend: where.backend, ...(problems.length ? { warnings: problems } : {}) }); return }
    console.log()
    console.log(`  ${success("✓")} vault ${bold(meta.name)}  ${dim(id)}`)
    if (meta.targets) {
      console.log(`     copies on: ${allTargets(meta).map(targetLabel).join(", ")}  ${dim(`(minimum ${meta.replicas})`)}`)
      console.log(`     ${dim("A drive that is not plugged in when you put files catches up later: plug it into any of your machines and run iris vault sync.")}`)
      for (const p of problems) console.log(`     ${bold("not saved to your Drives catalog:")} ${dim(p)}`)
    } else console.log(`     ${dim(`target replicas: ${meta.replicas}`)}`)
    console.log(`     ${dim(`key wrapped by ${where.backend} in ~/.iris/vault-keys.wrapped.json — it NEVER syncs.`)}`)
    console.log(`     ${dim(`Back it up: iris vault key export ${meta.name} --out <file> (passphrase-sealed). Lose it and the data is unreadable, by design.`)}`)
    console.log()
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "list vaults: replicated and encrypted PHI vaults on this machine (--all: every node)",
  builder: (y) => y
    .option("all", { type: "boolean", default: false, describe: "encrypted vaults on every node you own, as last reported" })
    .option("node", { type: "string", describe: "encrypted vaults on this node (implies --all)" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    if (argv.all || argv.node) return (NodeVaultCommands.list as any).handler(argv)
    try { await listReplicated(argv) } catch (e) { return vaultFail(e, !!argv.json) }
    // Encrypted PHI vaults live in the local daemon. If it isn't running there is nothing to
    // show for that kind; the replicated listing above still stands.
    if (!argv.json) {
      console.log(`  ${bold("Encrypted PHI vaults (this node)")}`)
      await (NodeVaultCommands.list as any).handler({ ...argv, _embedded: true })
      console.log()
    }
  },
})

async function listReplicated(argv: any) {
  {
    let ids: string[] = []
    try { ids = await readdir(VAULT_ROOT) } catch { /* none */ }
    const keys = keyStore(argv).ids()
    const out: any[] = []
    for (const id of ids) {
      try {
        const m = await loadMeta(id)
        const man = await latestManifest(id)
        out.push({ ...m, files: man ? Object.keys(man.entries).length : 0, seq: man?.seq ?? 0, has_key: keys.has(id) })
      } catch { /* skip */ }
    }
    if (argv.json) { await writeJson({ ok: true, vaults: out }); return }
    console.log()
    if (out.length === 0) console.log(`  ${dim("No replicated vaults. Create one: iris vault create <name>  (or --encrypted for a PHI vault)")}`)
    for (const v of out) {
      console.log(`  ${bold(v.name)}  ${dim(v.id)}`)
      console.log(`     ${dim(`${v.files} file(s) · manifest seq ${v.seq} · target ${v.replicas} replicas`)}${v.has_key ? "" : bold("  · NO KEY ON THIS MACHINE")}`)
    }
    console.log()
  }
}

const PutCommand = cmd({
  command: "put <vault> <path..>",
  describe: "add file(s): chunk, encrypt locally, replicate to your own nodes, verify",
  builder: (y) => y.options(KIND_OPTIONS)
    .positional("vault", { describe: "vault name or id", type: "string", demandOption: true })
    .positional("path", { describe: "local file(s)", type: "string", demandOption: true })
    .option("as", { describe: "path inside the vault (single file only)", type: "string" })
    .option("replicas", { describe: "override target replica count", type: "number" })
    .option("to", { describe: "place copies only on these nodes (name or id; repeatable)", type: "string", array: true })
    .option("user", { describe: "ssh user on nodes", type: "string" })
    .option("user-id", { type: "number" })
    .option("bloq", { type: "number", describe: "advanced: the Drives board copies are recorded on (default: your board named Drives)" })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "(passphrase PHI vault) read its passphrase from stdin" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      const v = await resolveAnyVault(String(argv.vault), kindFromFlags(argv as any))
      if (v.kind === "encrypted") return await putEncrypted(v, argv)
      if (v.meta.targets?.length) return await putTargetsCli(v.meta, argv)
      await putReplicated(v.meta, argv)
    } catch (e) {
      await vaultFail(e, !!argv.json)
    }
  },
})

/**
 * Encrypted PHI vault: encrypt on THIS machine with the vault's own key, store, read it back and
 * compare SHA-256. Nothing leaves the node — an encrypted vault does not replicate.
 */
async function putEncrypted(v: { entry: any; mod: EncryptedVaultModule }, argv: any) {
  const paths = ([] as string[]).concat(argv.path as any)
  if (argv.as && paths.length > 1) throw new VaultUserError("--as names one file; pass a single path with it")
  const entry = await openEncrypted(v, argv)
  const results = await encryptedPut(v.mod, entry, paths.map((p) => ({ src: p, as: paths.length === 1 && argv.as ? String(argv.as) : undefined })))
  const ok = results.every((r) => r.ok)
  if (argv.json) {
    for (const r of results) if (!r.ok) process.stderr.write(`error: ${r.path}: ${r.error}\n`)
    await writeJson({ ok, vault: entry.name, encrypted: true, results })
    if (!ok) process.exit(1)
    return
  }
  console.log()
  for (const r of results) {
    if (!r.ok) { process.stderr.write(`error: ${r.path}: ${r.error}\n`); continue }
    console.log(`  ${success("✓")} ${bold(r.vault_path!)}  ${dim(`${r.size} bytes · encrypted in ${entry.name}`)}`)
    console.log(`     ${dim("sha256 " + r.sha256 + " — read back and verified")}`)
  }
  console.log(`  ${dim("Encrypted PHI vault: stays on this node, never replicated" + (argv.replicas != null ? " (--replicas ignored)" : "") + ".")}`)
  if (entry.phi) console.log(`  ${dim(`PHI working copies are crypto-shredded after ${v.mod.retentionDays?.() ?? 30} days.`)}`)
  console.log()
  if (!ok) process.exit(1)
}

async function putReplicated(meta: VaultMeta, argv: any) {
  {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const key = await requireKey(meta.id, argv)
    const replicas = Number(argv.replicas ?? meta.replicas)
    const paths = ([] as string[]).concat(argv.path as any)

    // Capacity + liveness, measured now rather than assumed from the registry.
    const allNodes = (await fetchNodes(userId)) as any[]
    // This machine is already copy one. Dialling it as a peer fails and then reads as
    // "could not reach", for a node that is right here.
    const selfId = await detectLocalNodeId(allNodes)
    const only = ([] as string[]).concat((argv.to as any) ?? []).map(String)
    const nodes = allNodes.filter((n) => String(n.id) !== selfId && (only.length === 0 || only.includes(String(n.name)) || only.includes(String(n.id))))
    if (only.length && nodes.length === 0) throw new VaultUserError(`--to matched no other node: ${only.join(", ")}`)
    const cand: Array<PlacementNode & { node: any; t: SshTarget }> = []
    for (const n of nodes) {
      const t = await targetFor(n, argv)
      if (!t) continue
      cand.push({ name: n.name, online: n.connection_status === "online", freeBytes: await freeBytes(t), node: n, t })
    }

    const put: Record<string, any> = {}
    const results: any[] = []

    for (const p of paths) {
      if (!existsSync(p)) { results.push({ ok: false, path: p, error: "no such local file" }); continue }
      const buf = await readFile(p)
      const vpath = normalizePath(paths.length === 1 && argv.as ? String(argv.as) : basename(p))
      const { entry, blobs } = buildEntry(key, buf, { mtime: statSync(p).mtime.toISOString() })

      // 1. store locally — this device is always replica zero
      for (const b of blobs) {
        const dest = blobPath(meta.id, b.ref.id)
        await mkdir(dirname(dest), { recursive: true })
        await writeFile(dest, b.bytes)
      }

      // 2. place on OTHER nodes.
      //
      // `replicas` is a TOTAL copy count and this machine is already copy one, so we ask the
      // mesh for replicas-1. Getting this wrong is not cosmetic: `put` was reporting
      // "wanted 2, placed 1" for a file that `status` then correctly called 2/2, because one
      // counted remote placements and the other counted total holders. That is exactly the
      // defect filed as #182091 (three definitions of MAX_CONCURRENT), reproduced inside a
      // single feature — so the number is defined once, here, as TOTAL.
      const remoteWanted = Math.max(0, replicas - 1)
      const placement = remoteWanted === 0
        ? { chosen: [] as string[], shortfall: 0, reason: "local only (target 1 copy)" }
        : choosePlacement(cand, remoteWanted, buf.length)
      const pushed: string[] = []
      const failed: string[] = []
      for (const name of placement.chosen) {
        const c = cand.find((x) => x.name === name)!
        let allOk = true
        for (const b of blobs) {
          const r = await pushFile(c.t, blobPath(meta.id, b.ref.id), remoteBlobPath(meta.id, b.ref.id))
          if (!r.ok) { allOk = false; break }
        }
        ;(allOk ? pushed : failed).push(name)
      }

      put[vpath] = entry
      results.push({
        ok: true, path: p, vault_path: vpath, size: buf.length,
        plain_sha256: entry.plain_sha256, chunks: blobs.length,
        replicated_to: pushed, failed_to: failed,
        placement: placement.reason, shortfall: placement.shortfall,
        copies: 1 + pushed.length, target_copies: replicas,
      })
    }

    if (Object.keys(put).length > 0) {
      const prev = await latestManifest(meta.id)
      const m = nextManifest(prev, { put }, { vault_id: meta.id, author_node: "local", created_at: new Date().toISOString() })
      await writeManifest(meta.id, m)
    }

    for (const r of results) if (!r.ok) process.stderr.write(`error: ${r.path}: ${r.error}\n`)
    if (argv.json) {
      await writeJson({ ok: results.every((r) => r.ok), results })
      if (!results.every((r) => r.ok)) process.exit(1)
      return
    }

    console.log()
    for (const r of results) {
      if (!r.ok) continue // already on stderr
      console.log(`  ${success("✓")} ${bold(r.vault_path)}  ${dim(`${r.size} bytes · ${r.chunks} chunk(s)`)}`)
      console.log(`     ${dim("sha256 " + r.plain_sha256)}`)
      const held = ["this machine", ...r.replicated_to]
      console.log(`     ${dim(`${r.copies}/${r.target_copies} copies · held by: ` + held.join(", "))}`)
      if (r.shortfall > 0) console.log(`     ${bold("UNDER-REPLICATED")} ${dim(r.placement)}`)
      if (r.failed_to.length) console.log(`     ${bold("push failed")} ${dim(r.failed_to.join(", "))}`)
    }
    console.log()
    if (results.some((r) => !r.ok)) process.exit(1)
  }
}

// ── put, for a vault whose copies are named (--on) (#193363) ───────────────────────────────

/** The vault `iris drives keep` puts into: a replicated vault with named copies, or why not. */
export async function keepVault(name: string): Promise<VaultMeta | string> {
  const meta = await findReplicated(name)
  if (!meta) {
    const enc = findEncryptedVault(loadEncryptedVaultModule(), name)
    return enc
      ? `"${name}" is an encrypted PHI vault — it never leaves this node, so it cannot hold copies on your drives. Use a vault made with: iris vault create <name> --on "<drive>,<drive>,this-machine"`
      : `no vault named "${name}" on this machine. Make one: iris vault create ${name} --on "<drive>,<drive>,this-machine"`
  }
  if (!meta.targets?.length) return `vault ${meta.name} spreads its copies over whichever machines have room, so its copies cannot be counted per place. Keep into a vault made with --on: iris vault create <name> --on "<drive>,<drive>,this-machine"`
  return meta
}

export type KeepFile = { src: string; as?: string }
export type PutTargetsReport = {
  vault: string
  seq: number
  results: Array<{ ok: boolean; path: string; vault_path?: string; size?: number; plain_sha256?: string; chunks?: number; content_id?: string; held_by?: string[]; copies?: number; error?: string }>
  checks: TargetCheck[]
  problems: string[]
  replicas: number
}

/** The machine targets other than this one: push (put/sync) or just ask (status). Only these are dialled. */
async function machineChecks(meta: VaultMeta, index: ReplicaIndex, argv: any, userId: number, push: boolean): Promise<TargetCheck[]> {
  const remote = allTargets(meta).filter((t): t is Extract<VaultTarget, { kind: "machine" }> => t.kind === "machine" && !t.self)
  if (!remote.length) return []
  const wanted = index.blobs.map(([id]) => id)
  const lens = new Map(index.blobs)
  const out: TargetCheck[] = []
  let nodes: any[]
  try {
    nodes = (await fetchNodes(userId)) as any[]
  } catch (e: any) {
    return remote.map((t) => ({ target: t, key: targetKey(t), status: "pending", held: null, wanted: wanted.length, note: `could not list your machines (${e?.message ?? e})` }))
  }
  for (const t of remote) {
    const key = targetKey(t)
    const n = nodes.find((x) => (t.id && String(x.id) === String(t.id)) || String(x.name).toLowerCase() === t.name.toLowerCase())
    const st = n ? await targetFor(n, argv) : null
    if (!st) { out.push({ target: t, key, status: "pending", held: null, wanted: wanted.length, note: n ? "not reachable now" : "no longer one of your machines" }); continue }
    let have = await remoteBlobIds(st, meta.id)
    let note = ""
    if (push) {
      const need = wanted.filter((id) => !have.has(id))
      const needBytes = need.reduce((a, id) => a + (lens.get(id) ?? 0), 0)
      const plan = need.length ? planPlacement([{ target: t, reachable: true, freeBytes: await freeBytes(st), needBytes }]) : { noRoom: [] as any[] }
      if (plan.noRoom.length) {
        const held = new Set(wanted.filter((id) => have.has(id)))
        out.push({ target: t, key, status: "no-room", held, wanted: wanted.length, note: plan.noRoom[0].why })
        continue
      }
      for (const id of need) {
        const r = await pushFile(st, blobPath(meta.id, id), remoteBlobPath(meta.id, id))
        if (!r.ok) { note = `push failed: ${r.error ?? "unknown"}`; break }
      }
      for (const f of ["vault.json", "index.json", "manifest.sealed.json"]) {
        const lf = join(localReplicaDir(vaultDir(meta.id)), f)
        if (existsSync(lf)) await pushFile(st, lf, remoteVaultPath(meta.id, "replica"))
      }
      have = await remoteBlobIds(st, meta.id)
    }
    const held = new Set(wanted.filter((id) => have.has(id)))
    out.push({ target: t, key, status: statusOf(wanted.length, held.size, 0), held, wanted: wanted.length, note: note || (held.size < wanted.length ? `${wanted.length - held.size} chunk(s) missing` : "") })
  }
  return out
}

function selfCheck(meta: VaultMeta, index: ReplicaIndex): TargetCheck | null {
  const self = allTargets(meta).find((t) => t.kind === "machine" && t.self)
  if (!self) return null
  const have = heldBlobs(vaultDir(meta.id))
  const held = new Set(index.blobs.map(([id]) => id).filter((id) => have.has(id)))
  return { target: self, key: targetKey(self), status: statusOf(index.blobs.length, held.size, 0), held, wanted: index.blobs.length, note: "" }
}

/** Sources a drive replica is filled from on this machine: its own chunk store, then other plugged-in copies. */
function localSources(meta: VaultMeta): BlobSource[] {
  const out: BlobSource[] = [folderSource("this machine", vaultDir(meta.id))]
  for (const { target, dir } of mountedReplicaDirs(meta, driveEnv)) out.push(folderSource(targetLabel(target), dir))
  return out
}

/**
 * Encrypt on this machine, then put the chunks on every named place that is reachable: this
 * machine's store, each drive plugged in here (free space checked first), each named machine over
 * the mesh. A drive that is not plugged in is pending; nothing is assumed about it. The result is
 * recorded in the Drives catalog.
 */
export async function putToTargets(meta: VaultMeta, files: KeepFile[], argv: any): Promise<PutTargetsReport> {
  if (!(await requireAuth())) process.exit(1)
  const userId = await requireUserId(argv["user-id"] as number | undefined)
  if (!userId) process.exit(1)
  const key = await requireKey(meta.id, argv)
  const put: Record<string, any> = {}
  const results: PutTargetsReport["results"] = []
  for (const f of files) {
    if (!existsSync(f.src) || !statSync(f.src).isFile()) { results.push({ ok: false, path: f.src, error: "no such local file" }); continue }
    const size = statSync(f.src).size
    if (size > 2 ** 31 - 1) { results.push({ ok: false, path: f.src, error: `${fmt(size)} is over the 2 GiB a vault file can be today` }); continue }
    const buf = await readFile(f.src)
    const vpath = normalizePath(f.as ?? basename(f.src))
    const { entry, blobs } = buildEntry(key, buf, { mtime: statSync(f.src).mtime.toISOString() })
    for (const b of blobs) {
      const dest = blobPath(meta.id, b.ref.id)
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, b.bytes)
    }
    put[vpath] = entry
    results.push({ ok: true, path: f.src, vault_path: vpath, size: buf.length, plain_sha256: entry.plain_sha256, chunks: blobs.length, content_id: contentId(key, entry.plain_sha256) })
  }
  let man = await latestManifest(meta.id)
  ;({ man } = await adoptNewerManifest(meta, key, man))
  if (Object.keys(put).length) {
    man = nextManifest(man, { put }, { vault_id: meta.id, author_node: hostname(), created_at: new Date().toISOString() })
    await writeManifest(meta.id, man)
  }
  const checks: TargetCheck[] = []
  const problems: string[] = []
  if (man) {
    const index = buildIndex(key, man)
    const sealed = sealManifest(key, man)
    writeLocalReplicaFiles(meta, index, sealed)
    const self = selfCheck(meta, index)
    if (self) checks.push(self)
    checks.push(...(await machineChecks(meta, index, argv, userId, true)))
    checks.push(...(await syncDriveTargets({ meta, index, sealed, targets: allTargets(meta), env: driveEnv, sources: localSources(meta) })))
    const holders = new Map(checks.filter((c) => c.held).map((c) => [c.key, c.held!]))
    for (const r of results) {
      if (!r.ok) continue
      const e = man.entries[r.vault_path!]
      r.held_by = holdersOf([...e.chunks].sort((a, b) => a.n - b.n).map((c) => c.id), holders)
      r.copies = r.held_by.length
    }
    const cat = await openCatalog(userId, argv.bloq).catch((e) => { problems.push(`could not open your Drives catalog (${e?.message ?? e})`); return null })
    if (cat) problems.push(...(await recordChecks(cat.cat, meta, index, checks, hostname(), new Date())))
    else if (!problems.length) problems.push("no Drives board on this account — copies were made but not recorded (run iris drives scan on a drive first)")
  }
  return { vault: meta.name, seq: man?.seq ?? 0, results, checks, problems, replicas: meta.replicas }
}

async function putTargetsCli(meta: VaultMeta, argv: any) {
  const paths = ([] as string[]).concat(argv.path as any)
  if (argv.as && paths.length > 1) throw new VaultUserError("--as names one file; pass a single path with it")
  if (argv.to) throw new VaultUserError(`vault ${meta.name} has its copies named (--on at create); --to does not apply`)
  const r = await putToTargets(meta, paths.map((p) => ({ src: p, as: paths.length === 1 && argv.as ? String(argv.as) : undefined })), argv)
  printPutTargets(r, !!argv.json)
}

function printPutTargets(r: PutTargetsReport, json: boolean) {
  const ok = r.results.every((x) => x.ok)
  for (const x of r.results) if (!x.ok) process.stderr.write(`error: ${x.path}: ${x.error}\n`)
  if (json) {
    void writeJson({
      ok, vault: r.vault, seq: r.seq, results: r.results, warnings: r.problems,
      copies: r.checks.map((c) => ({ target: c.key, label: targetLabel(c.target), status: c.status, held: c.held?.size ?? null, wanted: c.wanted, note: c.note || undefined })),
    }).then(() => { if (!ok) process.exit(1) })
    return
  }
  console.log()
  for (const x of r.results) {
    if (!x.ok) continue
    const under = (x.copies ?? 0) < r.replicas
    console.log(`  ${success("✓")} ${bold(x.vault_path!)}  ${dim(`${x.size} bytes · ${x.chunks} chunk(s) · sha256 ${x.plain_sha256!.slice(0, 16)}…`)}`)
    console.log(`     ${under ? bold(`${x.copies}/${r.replicas} copies`) : dim(`${x.copies}/${r.replicas} copies`)} ${dim("· held by: " + (x.held_by!.map((k) => labelFor(r.checks, k)).join(", ") || "NOBODY"))}`)
  }
  console.log(`  ${dim(formatChecks(r.checks))}`)
  if (r.checks.some((c) => c.status === "pending" && c.target.kind === "drive"))
    console.log(`  ${dim("Pending drives catch up when plugged into any of your machines: iris vault sync")}`)
  for (const p of r.problems) console.log(`  ${bold("not recorded:")} ${dim(p)}`)
  console.log()
  if (!ok) process.exit(1)
}

const labelFor = (checks: TargetCheck[], key: string) => {
  const c = checks.find((x) => x.key === key)
  return c ? targetLabel(c.target) : key.replace(/^(drive|machine):/, "")
}

const GetCommand = cmd({
  command: "get <vault> <path>",
  describe: "retrieve a file, fetching missing chunks from your nodes and verifying end to end",
  builder: (y) => y.options(KIND_OPTIONS)
    .positional("vault", { type: "string", demandOption: true })
    .positional("path", { describe: "path inside the vault", type: "string", demandOption: true })
    .option("out", { describe: "output directory", type: "string", default: "." })
    .option("from", { describe: "fetch missing chunks only from these nodes (name or id; repeatable)", type: "string", array: true })
    .option("user", { type: "string" })
    .option("user-id", { type: "number" })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "(passphrase PHI vault) read its passphrase from stdin" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      const v = await resolveAnyVault(String(argv.vault), kindFromFlags(argv as any))
      if (v.kind === "encrypted") {
        const entry = await openEncrypted(v, argv)
        const r = await encryptedGet(v.mod, entry, String(argv.path), String(argv.out))
        if (argv.json) { await writeJson({ ok: true, encrypted: true, ...r }); return }
        console.log()
        console.log(`  ${success("✓")} ${bold(r.out)}  ${dim(`${r.size} bytes · decrypted on this machine`)}`)
        console.log(`     ${dim("sha256 " + r.sha256 + " — every chunk authenticated (AES-256-GCM)")}`)
        console.log(`     ${dim("This is plaintext of a PHI vault — delete it when you are done.")}`)
        console.log()
        return
      }
      await getReplicated(v.meta, argv)
    } catch (e) {
      await vaultFail(e, !!argv.json)
    }
  },
})

async function getReplicated(meta: VaultMeta, argv: any) {
  {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const key = await requireKey(meta.id, argv)
    // A drive replica plugged in here may carry a newer manifest (put from another machine).
    const { man } = await adoptNewerManifest(meta, key, await latestManifest(meta.id))
    const vpath = normalizePath(String(argv.path))
    const entry = man?.entries?.[vpath]
    if (!entry) throw new VaultUserError(`"${vpath}" is not in vault ${meta.name}. Run: iris hive vault ls ${meta.name}`)

    const blobs = new Map<string, Buffer>()
    const fetchedFrom: string[] = []
    const missing: string[] = []

    for (const c of entry.chunks) {
      const local = blobPath(meta.id, c.id)
      if (existsSync(local)) { blobs.set(c.id, await readFile(local)); continue }
      missing.push(c.id)
    }

    // Then a copy on a drive plugged into this machine (#193363) — no network at all.
    for (const { target, dir } of mountedReplicaDirs(meta, driveEnv)) {
      for (const id of [...missing]) {
        const b = await folderSource(targetLabel(target), dir).read(id)
        if (!b) continue
        blobs.set(id, b)
        missing.splice(missing.indexOf(id), 1)
        if (!fetchedFrom.includes(targetLabel(target))) fetchedFrom.push(targetLabel(target))
      }
    }

    // Only reach for the mesh if something is genuinely absent locally. A vault with named copies
    // asks only its named machines (never probes the rest), unless --from says otherwise.
    const named = allTargets(meta).filter((t) => t.kind === "machine" && !t.self).map((t) => (t as any).name as string)
    if (missing.length > 0 && (!meta.targets || argv.from || named.length)) {
      const allNodes = (await fetchNodes(userId)) as any[]
      const selfId = await detectLocalNodeId(allNodes)
      const only = ([] as string[]).concat((argv.from as any) ?? (meta.targets ? named : [])).map(String)
      const nodes = allNodes.filter((n) => String(n.id) !== selfId && (only.length === 0 || only.includes(String(n.name)) || only.includes(String(n.id))))
      for (const n of nodes) {
        if (missing.length === 0) break
        const t = await targetFor(n, argv)
        if (!t) continue
        const have = await remoteBlobIds(t, meta.id)
        for (const id of [...missing]) {
          if (!have.has(id)) continue
          const dest = blobPath(meta.id, id)
          await mkdir(dirname(dest), { recursive: true })
          const r = await pullFile(t, remoteVaultPath(meta.id, "blobs", id.slice(0, 2), id), dirname(dest))
          if (r.ok) {
            blobs.set(id, await readFile(dest))
            missing.splice(missing.indexOf(id), 1)
            if (!fetchedFrom.includes(n.name)) fetchedFrom.push(n.name)
          }
        }
      }
    }

    let out: Buffer
    try {
      out = reassemble(key, entry, blobs)
    } catch (e: any) {
      throw new VaultUserError(`cannot restore ${vpath}: ${String(e?.message ?? e)}`)
    }

    await mkdir(String(argv.out), { recursive: true })
    const dest = join(String(argv.out), basename(vpath))
    await writeFile(dest, out)

    if (argv.json) { await writeJson({ ok: true, path: vpath, out: dest, size: out.length, sha256: sha256(out), fetched_from: fetchedFrom }); return }
    console.log()
    console.log(`  ${success("✓")} ${bold(dest)}  ${dim(`${out.length} bytes`)}`)
    console.log(`     ${dim("sha256 " + sha256(out) + " — matches the manifest")}`)
    if (fetchedFrom.length) console.log(`     ${dim("chunks fetched from: " + fetchedFrom.join(", "))}`)
    console.log()
  }
}

const LsCommand = cmd({
  command: "ls <vault>",
  describe: "list files in a vault",
  builder: (y) => y.options(KIND_OPTIONS)
    .positional("vault", { type: "string", demandOption: true })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "(passphrase PHI vault) read its passphrase from stdin" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      const v = await resolveAnyVault(String(argv.vault), kindFromFlags(argv as any))
      if (v.kind === "encrypted") {
        const entry = await openEncrypted(v, argv)
        const files = await encryptedLs(v.mod, entry)
        if (argv.json) { await writeJson({ ok: true, vault: entry.name, encrypted: true, files }); return }
        console.log()
        if (files.length === 0) console.log(`  ${dim("empty encrypted vault")}`)
        for (const f of files) console.log(`  ${bold(f.name || f.file_id)}  ${dim(`${f.size} bytes · ${f.kind} · ${f.created_at} · ${f.file_id}`)}`)
        console.log()
        if (files.length) console.log(`  ${files.length} file(s) · encrypted on this node\n`)
        return
      }
      await lsReplicated(v.meta, argv)
    } catch (e) {
      await vaultFail(e, !!argv.json)
    }
  },
})

async function lsReplicated(meta: VaultMeta, argv: any) {
  {
    const man = await latestManifest(meta.id)
    const entries = Object.entries(man?.entries ?? {})
    if (argv.json) { await writeJson({ ok: true, vault: meta.name, seq: man?.seq ?? 0, files: entries.map(([p, e]) => ({ path: p, ...e })) }); return }
    console.log()
    if (entries.length === 0) console.log(`  ${dim("empty vault (manifest read successfully — this is a real empty)")}`)
    for (const [p, e] of entries) console.log(`  ${bold(p)}  ${dim(`${e.size} bytes · ${e.chunks.length} chunk(s) · ${e.plain_sha256.slice(0, 12)}…`)}`)
    console.log()
    if (entries.length) console.log(`  ${entries.length} file(s) · manifest seq ${man?.seq}\n`)
  }
}

const StatusCommand = cmd({
  command: "status <vault>",
  describe: "replication health — ASKS each node what it holds, never a local ledger",
  builder: (y) => y.options(KIND_OPTIONS)
    .positional("vault", { type: "string", demandOption: true })
    .option("deep", { type: "boolean", default: false, describe: "re-hash every chunk on the drives plugged in here (slow on big vaults; no key needed)" })
    .option("bloq", { type: "number", describe: "advanced: the Drives board copies are recorded on" })
    .option("user", { type: "string" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      const v = await resolveAnyVault(String(argv.vault), kindFromFlags(argv as any))
      if (v.kind === "encrypted") {
        // Needs no key: name, binding, lock state and counts are plaintext in the registry.
        const s = v.mod.summary(v.entry)
        const daemonLocked = await daemonVaultLocked(s.name)
        const locked = daemonLocked ?? s.locked
        if (argv.json) { await writeJson({ ok: true, ...s, locked, replicated: false }); return }
        console.log()
        console.log(`  ${bold(s.name)}  ${dim(`encrypted PHI vault · bloq ${s.bloq_id ?? "-"} · ${locked ? "locked" : "unlocked"} · key:${s.key_source}`)}`)
        console.log(`     ${dim(`${s.files} file(s) · ${s.bytes} bytes · last write ${s.last_write_at ?? "never"}`)}`)
        console.log(`  ${dim("Held by this node only — encrypted vaults never replicate; their keys never leave this machine.")}`)
        console.log()
        return
      }
      if (v.meta.targets?.length) return await statusTargets(v.meta, argv)
      await statusReplicated(v.meta, argv)
    } catch (e) {
      await vaultFail(e, !!argv.json)
    }
  },
})

async function statusReplicated(meta: VaultMeta, argv: any) {
  {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const man = await latestManifest(meta.id)
    if (!man) { console.log(`\n  ${dim("vault is empty — nothing to replicate")}\n`); return }

    // Local blobs count as a replica held by this machine.
    const pins: Record<string, string[]> = {}
    for (const e of Object.values(man.entries)) {
      for (const c of e.chunks) if (existsSync(blobPath(meta.id, c.id))) (pins[c.id] ??= []).push("this machine")
    }

    const allNodes = (await fetchNodes(userId)) as any[]
    const selfId = await detectLocalNodeId(allNodes)
    const nodes = allNodes.filter((n) => String(n.id) !== selfId)
    const unreachable: string[] = []
    for (const n of nodes) {
      const t = await targetFor(n, argv)
      if (!t) { unreachable.push(n.name); continue }
      const have = await remoteBlobIds(t, meta.id)
      for (const e of Object.values(man.entries)) {
        for (const c of e.chunks) if (have.has(c.id)) (pins[c.id] ??= []).push(n.name)
      }
    }

    const health = replicationHealth(man, pins, meta.replicas)
    const atRisk = health.filter((h) => h.atRisk)

    if (argv.json) {
      await writeJson({ ok: atRisk.length === 0, vault: meta.name, target: meta.replicas, unreachable, health })
      if (atRisk.length) process.exit(1)
      return
    }

    console.log()
    console.log(`  ${bold(meta.name)}  ${dim(`target ${meta.replicas} replicas · manifest seq ${man.seq}`)}`)
    console.log()
    for (const h of health) {
      const tag = h.atRisk ? dim("✗") : success("✓")
      console.log(`  ${tag} ${bold(h.path)}  ${dim(`${h.replicas}/${h.target} replicas`)}`)
      console.log(`     ${dim("held by: " + (h.fullyHeldBy.join(", ") || "NOBODY"))}`)
      // A partial holder is named but never counted — it restores nothing on its own.
      if (h.partiallyHeldBy.length) console.log(`     ${dim("partial (does NOT count): " + h.partiallyHeldBy.join(", "))}`)
    }
    console.log()
    if (unreachable.length) console.log(`  ${dim(`could not reach: ${unreachable.join(", ")} — their copies are UNKNOWN, not absent`)}`)
    console.log(`  ${health.length - atRisk.length}/${health.length} file(s) at target replication`)
    // Say what this does not yet do, rather than letting silence imply it does.
    console.log(`  ${dim("single-writer only · no key escrow · availability follows your devices being awake")}`)
    console.log()
    if (atRisk.length) process.exit(1)
  }
}

/**
 * Health of a vault with named copies: this machine and each named machine are ASKED, each drive
 * plugged in here is read (and with --deep re-hashed). A drive that is not plugged in here counts
 * only if the catalog says it was verified complete at this manifest, recently.
 */
async function statusTargets(meta: VaultMeta, argv: any) {
  if (!(await requireAuth())) process.exit(1)
  const userId = await requireUserId(argv["user-id"] as number | undefined)
  if (!userId) process.exit(1)
  let man = await latestManifest(meta.id)
  let index = currentIndex(meta, null, null)
  if (!man || !index || index.seq < man.seq || mountedReplicaDirs(meta, driveEnv).some(({ dir }) => (readReplicaIndex(dir)?.seq ?? 0) > (man?.seq ?? 0))) {
    const key = await requireKey(meta.id, argv)
    ;({ man } = await adoptNewerManifest(meta, key, man))
    index = man ? buildIndex(key, man) : null
    if (man && index) writeLocalReplicaFiles(meta, index, sealManifest(key, man))
  }
  if (!man || !index) { console.log(`\n  ${dim("vault is empty — nothing to replicate")}\n`); return }
  const checks: TargetCheck[] = []
  const self = selfCheck(meta, index)
  if (self) checks.push(self)
  checks.push(...(await machineChecks(meta, index, argv, userId, false)))
  checks.push(...(await syncDriveTargets({ meta, index, sealed: null, targets: allTargets(meta), env: driveEnv, sources: [], deep: !!argv.deep, readOnly: true })))
  const cat = await openCatalog(userId, argv.bloq).catch(() => null)
  const rows: any[] = cat ? (await cat.cat.replicaRows().catch(() => [])).map((r: any) => r?.data ?? r) : []
  const now = new Date()
  // A target not checked here counts only when the catalog says it held everything at THIS seq, recently.
  const remembered = (key: string) => {
    const r = rows.find((x) => x.vault_id === meta.id && x.target === key)
    if (!r || r.status !== "ok" || Number(r.manifest_seq) < index!.seq) return false
    return effectiveCopies([key], rows, meta.id, now).copies === 1
  }
  const holders = new Map(checks.filter((c) => c.held).map((c) => [c.key, c.held!]))
  const health = Object.entries(man.entries).map(([p, e]) => {
    const chunks = [...e.chunks].sort((a, b) => a.n - b.n).map((c) => c.id)
    const live = holdersOf(chunks, holders)
    const remote = checks.filter((c) => !c.held && remembered(c.key)).map((c) => c.key)
    const copies = chunks.length === 0 ? Math.max(1, live.length) : live.length + remote.length
    return { path: p, size: e.size, verified_now: live, from_catalog: remote, copies, target: meta.replicas, atRisk: copies < meta.replicas }
  })
  const problems = cat ? await recordChecks(cat.cat, meta, index, checks, hostname(), now) : ["no Drives board on this account — nothing recorded"]
  const atRisk = health.filter((h) => h.atRisk)
  if (argv.json) {
    await writeJson({
      ok: atRisk.length === 0, vault: meta.name, target: meta.replicas, seq: man.seq, health, warnings: problems,
      copies: checks.map((c) => ({ target: c.key, label: targetLabel(c.target), status: c.status, held: c.held?.size ?? null, wanted: c.wanted, note: c.note || undefined })),
    })
    if (atRisk.length) process.exit(1)
    return
  }
  const name = (k: string) => labelFor(checks, k)
  console.log()
  console.log(`  ${bold(meta.name)}  ${dim(`minimum ${meta.replicas} copies · manifest seq ${man.seq}`)}`)
  console.log(`  ${dim(formatChecks(checks))}`)
  console.log()
  for (const h of health) {
    console.log(`  ${h.atRisk ? dim("✗") : success("✓")} ${bold(h.path)}  ${dim(`${h.copies}/${h.target} copies`)}`)
    if (h.verified_now.length) console.log(`     ${dim("verified now: " + h.verified_now.map(name).join(", "))}`)
    if (h.from_catalog.length) console.log(`     ${dim("not plugged in here, verified complete recently: " + h.from_catalog.map(name).join(", "))}`)
  }
  console.log()
  console.log(`  ${health.length - atRisk.length}/${health.length} file(s) at their minimum copies${argv.deep ? "" : dim(" (drives checked by name and size; --deep re-hashes)")}`)
  for (const p of problems) console.log(`  ${bold("not recorded:")} ${dim(p)}`)
  console.log()
  if (atRisk.length) process.exit(1)
}

// ── sync: catch up the copies on drives plugged into THIS machine (#193363) ─────────────────

/** A machine of yours as a chunk source, over ssh; each chunk is hash-checked before it is stored. */
async function remoteSource(name: string, vaultId: string, argv: any, userId: number): Promise<{ src: BlobSource; t: SshTarget } | null> {
  const nodes = (await fetchNodes(userId)) as any[]
  const n = nodes.find((x) => String(x.name).toLowerCase() === name.toLowerCase() || String(x.id) === name)
  if (!n) return null
  const t = await targetFor(n, argv)
  if (!t) return null
  const stage = mkdtempSync(join(tmpdir(), "iris-vault-sync-"))
  return {
    t,
    src: {
      name: n.name,
      read: async (id) => {
        const r = await pullFile(t, remoteVaultPath(vaultId, "blobs", id.slice(0, 2), id), stage)
        if (!r.ok) return null
        try { return readFileSync(join(stage, id)) } catch { return null } finally { rmSync(join(stage, id), { force: true }) }
      },
    },
  }
}

async function remoteJson(t: SshTarget, vaultId: string, file: string): Promise<any | null> {
  const r = await sshRun(t, `cat ${shqPath(remoteVaultPath(vaultId, "replica", file))} 2>/dev/null`)
  if (!r.ok) return null
  try { return JSON.parse(String(r.stdout)) } catch { return null }
}

const SyncCommand = cmd({
  command: "sync [vault]",
  describe: "catch up vault copies on the drives plugged into THIS machine (chunks come from here, another plugged-in copy, or --from one of your machines)",
  builder: (y) => y
    .positional("vault", { type: "string", describe: "only this vault (default: every vault with a copy on a drive plugged in here)" })
    .option("from", { type: "string", describe: "the machine to fetch missing chunks from (default: the machine the vault was created on)" })
    .option("deep", { type: "boolean", default: false, describe: "re-hash every chunk already on the drive; a bad one is replaced" })
    .option("bloq", { type: "number", describe: "advanced: the Drives board to use" })
    .option("user", { type: "string" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false })
    .example("$0 vault sync", "plugged a backup drive in: bring every vault copy on it up to date")
    .example("$0 vault sync studio --from studio-mac", "fetch what is missing from that machine"),
  async handler(argv) {
    try { await syncCli(argv) } catch (e) { await vaultFail(e, !!argv.json) }
  },
})

async function syncCli(argv: any) {
  if (!(await requireAuth())) process.exit(1)
  const userId = await requireUserId(argv["user-id"] as number | undefined)
  if (!userId) process.exit(1)
  const cat = await openCatalog(userId, argv.bloq)
  if (!cat) throw new VaultUserError("No drives cataloged yet — run: iris drives scan <drive or folder>")
  const drives = await cat.cat.drives()
  const mounted = new Map<string, string>()
  for (const d of drives) {
    const m = resolveMount(String(d.external_id))
    if (m) mounted.set(String(d.external_id), m)
  }
  const rows: any[] = (await cat.cat.replicaRows()).map((r: any) => r?.data ?? r)
  // Which vaults have a copy that belongs on a drive plugged in here — from this machine's vaults,
  // the catalog, and the copies already on the drives.
  const want = new Map<string, { meta: any | null; drives: Set<string>; source: string | null }>()
  const add = (id: string, driveId: string, meta: any | null, source: string | null) => {
    const w = want.get(id) ?? { meta: null, drives: new Set<string>(), source: null }
    w.drives.add(driveId)
    if (meta && !w.meta) w.meta = meta
    if (source && !w.source) w.source = source
    want.set(id, w)
  }
  let ids: string[] = []
  try { ids = await readdir(VAULT_ROOT) } catch {}
  for (const id of ids) {
    const m = await loadMeta(id).catch(() => null)
    for (const t of m?.targets ?? []) if (t.kind === "drive" && mounted.has(t.id)) add(m!.id, t.id, m, m!.source_node ?? null)
  }
  for (const r of rows) if (r.target_kind === "drive" && mounted.has(String(r.drive_id))) add(String(r.vault_id), String(r.drive_id), null, r.source_node || null)
  for (const [driveId, m] of mounted) for (const rep of replicasOnMount(m)) {
    if (rep.meta.targets.some((t) => t.kind === "drive" && t.id === driveId)) add(rep.meta.id, driveId, rep.meta, rep.meta.source_node ?? null)
  }
  const only = argv.vault ? String(argv.vault) : null
  const report: any[] = []
  for (const [id, w] of want) {
    let meta: any = w.meta ?? (existsSync(join(vaultDir(id), "vault.json")) ? await loadMeta(id) : null)
    const nameHint = rows.find((r) => r.vault_id === id)?.vault_name
    if (only && only !== id && only !== (meta?.name ?? nameHint)) continue
    const from = argv.from ? String(argv.from) : w.source && w.source.toLowerCase() !== hostname().toLowerCase() ? w.source : null
    let remote: Awaited<ReturnType<typeof remoteSource>> = null
    const dial = async () => (remote ??= from ? await remoteSource(from, id, argv, userId) : null)
    // The newest index any reachable copy has: this machine, a plugged-in copy, or the source machine.
    const cands: Array<{ index: ReplicaIndex; sealed: SealedManifest | null; meta?: any }> = []
    const li = readReplicaIndex(localReplicaDir(vaultDir(id)))
    if (li) cands.push({ index: li, sealed: readSealed(localReplicaDir(vaultDir(id))) })
    for (const [, m] of mounted) for (const rep of replicasOnMount(m)) {
      if (rep.meta.id !== id) continue
      const i = readReplicaIndex(rep.dir)
      if (i) cands.push({ index: i, sealed: readSealed(rep.dir), meta: rep.meta })
      if (!meta) meta = rep.meta
    }
    if (!cands.length || argv.from) {
      const r = await dial()
      if (r) {
        const i = parseIndex(JSON.stringify(await remoteJson(r.t, id, "index.json")))
        if (i && i.vault_id === id) cands.push({ index: i, sealed: await remoteJson(r.t, id, "manifest.sealed.json"), meta: await remoteJson(r.t, id, "vault.json") })
        if (!meta) meta = cands[cands.length - 1]?.meta ?? null
      }
    }
    if (!meta || !meta.targets) { report.push({ vault: nameHint ?? id, ok: false, error: `cannot tell what this copy should hold — run on the machine that created it, or pass --from <machine>` }); continue }
    const best = cands.filter((c) => c.index.vault_id === id).sort((a, b) => b.index.seq - a.index.seq)[0]
    if (!best) { report.push({ vault: meta.name, ok: false, error: from ? `${from} did not answer with this vault's index` : "no copy of this vault's index is reachable — pass --from <machine>" }); continue }
    const sources: BlobSource[] = []
    if (existsSync(join(vaultDir(id), "blobs"))) sources.push(folderSource("this machine", vaultDir(id)))
    for (const [driveId, m] of mounted) {
      const dir = replicaDir(m, meta.name)
      if (readReplicaMeta(dir)?.id === id) sources.push(folderSource(drives.find((d) => String(d.external_id) === driveId)?.label ?? driveId, dir))
    }
    // The source machine is asked only for chunks no plugged-in copy has.
    sources.push({ name: from ?? "source", read: async (cid) => { const r = await dial(); return r ? r.src.read(cid) : null } })
    const targets = (meta.targets as VaultTarget[]).filter((t) => t.kind === "drive" && w.drives.has(t.id))
    const checks = await syncDriveTargets({ meta, index: best.index, sealed: best.sealed, targets, env: driveEnv, sources, deep: !!argv.deep })
    const problems = await recordChecks(cat.cat, meta, best.index, checks, hostname(), new Date())
    report.push({ vault: meta.name, ok: checks.every((c) => c.status === "ok"), seq: best.index.seq, checks, problems })
  }
  if (argv.json) {
    await writeJson({ ok: report.every((r) => r.ok), drives_here: [...mounted.keys()], vaults: report.map((r) => ({ ...r, checks: r.checks?.map((c: TargetCheck) => ({ target: c.key, label: targetLabel(c.target), status: c.status, held: c.held?.size ?? null, wanted: c.wanted, written: c.written ?? 0, note: c.note || undefined })) })) })
    if (!report.every((r) => r.ok)) process.exit(1)
    return
  }
  console.log()
  if (!mounted.size) console.log(`  ${dim("No cataloged drive is plugged into this machine.")}`)
  else if (!report.length) console.log(`  ${dim(`No vault has a copy on the drive(s) plugged in here (${[...mounted.keys()].map((k) => drives.find((d) => String(d.external_id) === k)?.label ?? k).join(", ")}).`)}`)
  for (const r of report) {
    if (r.error) { console.log(`  ${dim("✗")} ${bold(r.vault)}  ${r.error}`); continue }
    for (const c of r.checks as TargetCheck[]) {
      const tag = c.status === "ok" ? success("✓") : dim("✗")
      console.log(`  ${tag} ${bold(r.vault)} on ${targetLabel(c.target)}  ${dim(`${c.held?.size ?? 0}/${c.wanted} chunks · ${c.written ?? 0} copied now · manifest seq ${r.seq}`)}${c.note ? `  ${dim(c.note)}` : ""}`)
    }
    for (const p of r.problems) console.log(`     ${bold("not recorded:")} ${dim(p)}`)
  }
  console.log()
  if (!report.every((r) => r.ok)) process.exit(1)
}

// ── keys (#193396) ───────────────────────────────────────────────────────────

const KeyStatusCommand = cmd({
  command: "status",
  describe: "where this machine keeps replicated-vault keys (never prints a key)",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      const st = keyStore(argv).status()
      if (argv.json) { await writeJson({ ok: true, ...st }); return }
      console.log()
      console.log(`  ${bold("Replicated vault keys")}  ${dim(st.wrapped_file)}`)
      console.log(`     ${dim(`wrapped by: ${st.backend ?? "(not set up yet — chosen on first use)"}${st.node_key_file ? ` · ${st.node_key_file}` : ""}${st.kdf ? ` · scrypt N=${st.kdf.N} r=${st.kdf.r} p=${st.kdf.p}` : ""}`)}`)
      console.log(`     ${dim(`${st.wrapped_keys} wrapped key(s)`)}`)
      if (st.plaintext_file_present) console.log(`     ${bold(`plaintext ~/.iris/vault-keys.json present (${st.plaintext_keys} key(s)) — run: iris vault key setup`)}`)
      console.log()
    } catch (e) { await vaultFail(e, !!argv.json) }
  },
})

const KeySetupCommand = cmd({
  command: "setup",
  describe: "wrap replicated-vault keys now (migrates a plaintext ~/.iris/vault-keys.json); --node-key for headless Linux",
  builder: (y) => y
    .option("node-key", { type: "boolean", default: false, describe: "create this machine's node key (/etc/iris/vault-kek/<uid>.key, outside $HOME; asks for sudo once)" })
    .option("backend", { type: "string", choices: BACKENDS as unknown as string[], describe: "force where the wrapping key lives (only before first use)" })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "(passphrase backend) read the passphrase from stdin" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      if (argv["node-key"]) {
        const file = defaultNodeKeyFile()
        const { existsSync: ex } = await import("fs")
        if (!ex(file)) {
          const { randomBytes } = await import("crypto")
          if (!createNodeKeyWithSudo(file, randomBytes(32), true)) throw new VaultUserError(`could not create ${file} — this needs sudo once`)
        }
      }
      const fromStdin = !!argv["passphrase-stdin"]
      const store = new ReplicatedKeyStore(defaultOptions({
        ...(argv.backend ? { forceBackend: argv.backend as KekBackend } : argv["node-key"] ? { forceBackend: "node-key" as KekBackend } : {}),
        passphrase: fromStdin || process.stdin.isTTY ? (confirm) => readPassphrase(confirm && !fromStdin, fromStdin) : undefined,
      }))
      const r = await store.ensure()
      const st = store.status()
      if (argv.json) { await writeJson({ ok: true, migrated: r.migrated, ...st }); return }
      console.log()
      console.log(`  ${success("✓")} replicated-vault keys wrapped by ${bold(String(st.backend))}${st.node_key_file ? dim(` (${st.node_key_file})`) : ""}`)
      console.log(`     ${dim(`${st.wrapped_keys} key(s) in ~/.iris/vault-keys.wrapped.json`)}`)
      if (r.migrated) console.log(`     ${dim(`migrated ${r.migrated} key(s) from plaintext ~/.iris/vault-keys.json — verified, then that file was shredded`)}`)
      console.log()
    } catch (e) { await vaultFail(e, !!argv.json) }
  },
})

const KeyExportCommand = cmd({
  command: "export <vault>",
  describe: "seal one replicated vault's key (plus its manifest) under a passphrase, to restore it on another machine you own",
  builder: (y) => y
    .positional("vault", { type: "string", demandOption: true })
    .option("out", { type: "string", demandOption: true, describe: "file to write (mode 0600)" })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "read the export passphrase (line 1) — and the key passphrase, if this machine uses one (line 2) — from stdin" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      const meta = await findReplicated(String(argv.vault))
      if (!meta) throw new VaultUserError(`no replicated vault named "${argv.vault}" on this machine`)
      const fromStdin = !!argv["passphrase-stdin"]
      // One stdin, possibly two passphrases: read it once, hand out lines.
      const lines = fromStdin ? (await Bun.stdin.text()).split("\n").map((l) => l.replace(/\r$/, "")) : []
      const store = new ReplicatedKeyStore(defaultOptions({
        passphrase: fromStdin ? async () => lines[1] ?? "" : process.stdin.isTTY ? (c) => readPassphrase(c, false) : undefined,
      }))
      const key = await store.getKey(meta.id)
      if (!key) throw new VaultUserError(`no key for vault ${meta.name} on this machine`)
      if (!fromStdin) process.stderr.write("Choose a passphrase for this export (asked again on import).\n")
      const pass = fromStdin ? lines[0] : await readPassphrase(true, false)
      const bundle = sealExport({ vault_id: meta.id, key: key.toString("base64"), meta, manifest: await latestManifest(meta.id) }, pass)
      await writeFile(String(argv.out), JSON.stringify(bundle, null, 2) + "\n", { mode: 0o600 })
      if (argv.json) { await writeJson({ ok: true, vault: meta.name, id: meta.id, out: String(argv.out) }); return }
      console.log(`\n  ${success("✓")} ${bold(String(argv.out))}  ${dim(`key for ${meta.name}, sealed with scrypt + AES-256-GCM`)}\n     ${dim(`on the other machine: iris vault key import ${basename(String(argv.out))}`)}\n`)
    } catch (e) { await vaultFail(e, !!argv.json) }
  },
})

const KeyImportCommand = cmd({
  command: "import <file>",
  describe: "restore a replicated vault from a key export: its key (wrapped on this machine) and manifest",
  builder: (y) => y
    .positional("file", { type: "string", demandOption: true })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "read the export passphrase (line 1) — and this machine's key passphrase, if it uses one (line 2) — from stdin" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    try {
      let bundle: any
      try { bundle = JSON.parse(await readFile(String(argv.file), "utf-8")) } catch { throw new VaultUserError(`cannot read ${argv.file} as a key export`) }
      const fromStdin = !!argv["passphrase-stdin"]
      const lines = fromStdin ? (await Bun.stdin.text()).split("\n").map((l) => l.replace(/\r$/, "")) : []
      const pass = fromStdin ? lines[0] : await readPassphrase(false, false)
      const p = openExport(bundle, pass)
      const store = new ReplicatedKeyStore(defaultOptions({
        passphrase: fromStdin ? async () => lines[1] ?? "" : process.stdin.isTTY ? (c) => readPassphrase(c, false) : undefined,
      }))
      const existing = await store.getKey(p.vault_id)
      const key = Buffer.from(p.key, "base64")
      if (existing && !existing.equals(key)) throw new VaultUserError(`this machine already holds a DIFFERENT key for vault ${p.vault_id} — not overwriting it`)
      if (!existing) await store.saveKey(p.vault_id, key)
      if (p.meta && !existsSync(join(vaultDir(p.vault_id), "vault.json"))) {
        await mkdir(join(vaultDir(p.vault_id), "blobs"), { recursive: true })
        await writeFile(join(vaultDir(p.vault_id), "vault.json"), JSON.stringify(p.meta, null, 2), "utf-8")
      }
      if (p.manifest) {
        const cur = await latestManifest(p.vault_id)
        if (!cur || cur.seq < p.manifest.seq) await writeManifest(p.vault_id, p.manifest)
      }
      const st = store.status()
      if (argv.json) { await writeJson({ ok: true, id: p.vault_id, name: p.meta?.name, backend: st.backend, files: Object.keys(p.manifest?.entries ?? {}).length }); return }
      console.log(`\n  ${success("✓")} vault ${bold(p.meta?.name ?? p.vault_id)}  ${dim(`key wrapped by ${st.backend} on this machine`)}\n     ${dim("missing chunks are fetched from your nodes on: iris vault get")}\n`)
    } catch (e) { await vaultFail(e, !!argv.json) }
  },
})

const KeyCommand = cmd({
  command: "key",
  aliases: ["keys"],
  describe: "replicated-vault keys: where they live (status), wrap/migrate (setup), move one to another machine (export/import)",
  builder: (y) => y.command(KeyStatusCommand).command(KeySetupCommand).command(KeyExportCommand).command(KeyImportCommand).demandCommand(1),
  async handler() {},
})

const VaultCommand = cmd({
  command: "vault",
  aliases: ["vaults"],
  describe: "your vaults — replicated storage across YOUR nodes, and encrypted per-bloq PHI vaults (iris vaults = list)",
  builder: (y) => y
    .command(CreateCommand).command(ListCommand).command(PutCommand)
    .command(GetCommand).command(LsCommand).command(StatusCommand).command(SyncCommand)
    .command(NodeVaultCommands.lock).command(NodeVaultCommands.unlock).command(NodeVaultCommands.destroy)
    .command(KeyCommand)
    .option("json", { type: "boolean", default: false }),
  // `iris vault` / `iris vaults` with no subcommand lists them.
  async handler(argv) {
    return (ListCommand as any).handler(argv)
  },
})

export const VaultCommandExport = VaultCommand
