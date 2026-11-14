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
  replicaDir, parseIndex, effectiveCopies, splitList, fmt, SELF_WORDS, missingDays,
} from "./vault-drives"
import {
  type DriveEnv, type TargetCheck, type VaultCatalog, syncDriveTargets, recordChecks, replicaMetaFor, statusOf,
  formatChecks, mountedReplicaDirs, localReplicaDir, statfsOf,
} from "./vault-replicas"
import { resolveMount, openVaultCatalog } from "./platform-drives"
import {
  type PolicyFields, type Healed, type HealPlan, type Reach, policyOf, parseLostAfter, parseOnReturn, fmtDays, addSpares, removeSpare,
  assertSpare, activeHealed, mergeHealed, planHeal, readAuto, writeAuto, autoBlocked, acquireLock, filesTouched, catchupText,
  catchupLine, ago, keyOrSkip, unseenText,
} from "./vault-auto"
import { metaStamp, verifyReplica, fillReplica, writeBlob, blobFile, ensureReplica } from "./vault-drives"
import { replicaRowId, refreshDriveAlerts } from "./vault-replicas"
import { metered, type DrivesRun } from "./drives-telemetry"

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

type VaultMeta = {
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
} & PolicyFields

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
function namedCopies(meta: VaultMeta): VaultTarget[] {
  const ts = [...(meta.targets ?? [])]
  const src = meta.source_node ?? null
  if (src && !ts.some((t) => t.kind === "machine" && t.name.toLowerCase() === src.toLowerCase())) ts.unshift({ kind: "machine", name: src, self: src.toLowerCase() === hostname().toLowerCase() })
  return ts.map((t) => (t.kind === "machine" ? { ...t, self: t.name.toLowerCase() === hostname().toLowerCase() } : t))
}

/** namedCopies plus every spare that holds a rebuilt copy right now (#193363 follow-up: self-healing). */
function allTargets(meta: VaultMeta): VaultTarget[] {
  const ts = namedCopies(meta)
  for (const h of activeHealed(meta.healed)) {
    const sp = (meta.spares ?? []).find((t) => targetKey(t) === h.spare)
    if (sp && !ts.some((t) => targetKey(t) === h.spare)) ts.push(sp.kind === "machine" ? { ...sp, self: sp.name.toLowerCase() === hostname().toLowerCase() } : sp)
  }
  return ts
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
    .option("spare", { type: "string", describe: '(with --on) where a LOST copy may be rebuilt — these and nowhere else, e.g. --spare "Spare A,studio-mac"' })
    .option("lost-after", { type: "string", describe: "(with --on) a copy unseen this long counts as lost and is rebuilt on a spare (default 14d; h/d/w)" })
    .option("on-return", { type: "string", choices: ["keep", "retire"], describe: "(with --on) when a lost copy is verified again: keep both (default) or retire the spare's copy" })
    .option("auto", { type: "boolean", describe: "(with --on) catch up and heal automatically (default on; --no-auto turns it off for this vault)" })
    .option("bloq", { type: "number", describe: "advanced: the Drives board to use (default: your board named Drives)" })
    .option("encrypted", { type: "boolean", default: false, describe: "an encrypted PHI vault on this node: per-bloq, key in the OS keychain (or --passphrase)" })
    .option("bloq", { type: "string", describe: "(--encrypted) bind to this bloq: only its tasks can open the vault" })
    .option("node", { type: "string", describe: "(--encrypted) must be this machine — keys never travel" })
    .option("passphrase", { type: "boolean", default: false, describe: "(--encrypted) key from a passphrase; stays locked after restarts until unlocked" })
    .option("passphrase-stdin", { type: "boolean", default: false, describe: "(--encrypted) read the passphrase from stdin" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false })
    .example('$0 vault create studio --on "Backup A,Backup B,this-machine"', "three copies: two drives and this machine")
    .example('$0 vault create studio --on "Backup A,studio-mac" --replicas 2', "copies on a drive and another of your machines; flagged below 2")
    .example('$0 vault create studio --on "Backup A,Backup B,this-machine" --spare "Spare A"', "a copy unseen for 14 days is rebuilt on Spare A"),
  async handler(argv) {
    // One noun, two kinds. --encrypted (or any PHI-vault option) means a node-local, per-bloq
    // encrypted vault for patient-data task output; otherwise the replicated sovereign store.
    if (!argv.on && (argv.spare || argv["lost-after"] != null || argv["on-return"] != null || argv.auto != null)) {
      return vaultFail(new VaultUserError("--spare, --lost-after, --on-return and --auto go with --on: they are about copies in named places"), !!argv.json)
    }
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
        // Machines are listed from the account (one API call); none is dialled to create a vault.
        const targets = await resolvePlaces(String(argv.on), userId, catalog?.cat ?? null)
        const places = targets.length + (targets.some((t) => t.kind === "machine" && t.self) ? 0 : 1)
        meta.targets = targets
        meta.source_node = hostname()
        // #193363 follow-up: self-healing. Spares are named here or with iris vault spare add — never inferred.
        if (argv.spare) meta.spares = addSpares([], await resolvePlaces(String(argv.spare), userId, catalog?.cat ?? null), allTargets(meta))
        if (argv["lost-after"] != null) meta.lost_after_days = parseLostAfter(argv["lost-after"])
        if (argv["on-return"] != null) meta.on_return = parseOnReturn(argv["on-return"])
        if (argv.auto === false) meta.auto = false
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
      if (meta.targets.some((t) => t.kind === "drive")) console.log(`     ${dim(`A drive that is not plugged in when you put files catches up when it is plugged into any of your machines${meta.auto === false ? " (run iris vault sync there — automatic catch-up is off for this vault)" : " (the IRIS daemon does it; or run iris vault sync)"}.`)}`)
      const pol = policyOf(meta)
      console.log(`     ${dim(`lost after ${fmtDays(pol.lost_after_days)} unseen → rebuilt on: ${pol.spares.map(targetLabel).join(", ") || "nowhere (no spare named; add one: iris vault spare add " + meta.name + " <drive or machine>)"}`)}`)
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
      if (v.targets?.length) console.log(`     ${dim("copies on: " + allTargets(v).map(targetLabel).join(", "))}`)
      if (v.spares?.length) console.log(`     ${dim("spares (a lost copy is rebuilt here): " + v.spares.map(targetLabel).join(", "))}`)
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
export async function putToTargets(metaIn: VaultMeta, files: KeepFile[], argv: any): Promise<PutTargetsReport> {
  let meta = metaIn
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
  const cat = await openCatalog(userId, argv.bloq).catch((e) => { problems.push(`could not open your Drives catalog (${e?.message ?? e})`); return null })
  // Spares holding a rebuilt copy (a heal, maybe on another machine) get this put too.
  if (cat) meta = { ...meta, healed: mergeHealed(meta.healed ?? [], (await cat.cat.replicaRows().catch(() => [])).map(dataOf), meta.id) }
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
    console.log(`  ${dim("Pending drives catch up when plugged into any of your machines (the IRIS daemon does it; or run iris vault sync there)")}`)
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
async function statusTargets(metaIn: VaultMeta, argv: any) {
  let meta = metaIn
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
  const cat = await openCatalog(userId, argv.bloq).catch(() => null)
  const rows: any[] = cat ? (await cat.cat.replicaRows().catch(() => [])).map((r: any) => r?.data ?? r) : []
  meta = { ...meta, healed: mergeHealed(meta.healed ?? [], rows, meta.id) }
  const checks: TargetCheck[] = []
  const self = selfCheck(meta, index)
  if (self) checks.push(self)
  checks.push(...(await machineChecks(meta, index, argv, userId, false)))
  checks.push(...(await syncDriveTargets({ meta, index, sealed: null, targets: allTargets(meta), env: driveEnv, sources: [], deep: !!argv.deep, readOnly: true })))
  const now = new Date()
  // A target not checked here counts only when the catalog says it held everything at THIS seq, recently.
  const remembered = (key: string) => {
    const r = rows.find((x) => x.vault_id === meta.id && x.target === key)
    if (!r || r.status !== "ok" || Number(r.manifest_seq) < index!.seq) return false
    // A copy past the vault's lost-after does not count either (it is being, or waiting to be, rebuilt).
    return effectiveCopies([key], rows, meta.id, now, Math.min(missingDays(), policyOf(meta).lost_after_days)).copies === 1
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
  const heal = healSummary(meta, rows, checks, now)
  if (argv.json) {
    await writeJson({
      ok: atRisk.length === 0, vault: meta.name, target: meta.replicas, seq: man.seq, health, warnings: problems, heal,
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
  for (const l of heal.lost) console.log(`  ${bold("⚠ LOST")} ${name(l.target)} ${dim(`— ${unseenText(l.ms)}${l.alert ? ` · ${l.alert}` : " · run: iris vault heal"}`)}`)
  for (const h of heal.healed) console.log(`  ${dim(`↻ ${name(h.spare)} holds a rebuilt copy (for ${name(h.replaces)}, ${String(h.at).slice(0, 10)})${h.returned_at ? ` · ${name(h.replaces)} is back — both copies kept` : ""}`)}`)
  for (const c of heal.catchups) console.log(`  ${dim(`${name(c.target)}: ${c.line}`)}`)
  console.log(`  ${dim(`spares: ${heal.spares.join(", ") || "none"} · lost after ${heal.lost_after} unseen · on return: ${heal.on_return}${heal.auto ? "" : " · automatic catch-up OFF for this vault"}`)}`)
  for (const p of problems) console.log(`  ${bold("not recorded:")} ${dim(p)}`)
  console.log()
  if (atRisk.length) process.exit(1)
}

/** The self-healing view of a vault for status: lost copies, spare copies, last catch-ups. */
function healSummary(meta: VaultMeta, rows: any[], checks: TargetCheck[], now: Date) {
  const pol = policyOf(meta)
  const live = new Set(checks.filter((c) => c.status === "ok").map((c) => c.key))
  const plan = planHeal({
    vaultId: meta.id, createdAt: meta.created_at, copies: namedCopies(meta), policy: pol, healed: meta.healed ?? [], rows, now,
    seq: 0, liveOk: live, reach: () => ({ ok: false, why: "not checked by status" }),
  })
  const mine = rows.filter((r) => r.vault_id === meta.id)
  return {
    lost: plan.lost.map((l) => ({ target: l.key, days: l.days, ms: l.ms, alert: mine.find((r) => r.target === l.key)?.heal_alert || "" })),
    healed: activeHealed(meta.healed),
    catchups: mine.filter((r) => r.last_catchup_at).map((r) => ({ target: String(r.target), line: catchupLine(r, now), at: r.last_catchup_at })),
    spares: pol.spares.map(targetLabel), lost_after: fmtDays(pol.lost_after_days), on_return: pol.on_return, auto: pol.auto,
  }
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
  handler: metered("vault_catchup", async (argv: any, run: DrivesRun) => {
    try { await syncCli(argv, run, { auto: false, trigger: "manual" }) } catch (e) { await failSoft(e, !!argv.json) }
  }),
})

/** Like vaultFail, but returns (exit code 1) so the one usage event is still recorded and flushed. */
async function failSoft(e: unknown, json: boolean) {
  const msg = e instanceof Error ? e.message : String(e)
  process.stderr.write(`error: ${msg}\n`)
  if (json) await writeJson({ ok: false, error: msg })
  process.exitCode = 1
}

// ── a vault's settings, wherever they are (#193363 follow-up) ──────────────────────────────

const dataOf = (r: any) => r?.data ?? r
const stripReplica = (m: any): VaultMeta => {
  const { format: _f, v: _v, ...rest } = m ?? {}
  return rest as VaultMeta
}

/** Each vault's settings as its catalog rows carry them (the newest per vault). */
function metasFromRows(rows: any[]): Map<string, VaultMeta> {
  const out = new Map<string, VaultMeta>()
  for (const r of rows) {
    if (!r?.vault_policy) continue
    let m: any
    try { m = JSON.parse(String(r.vault_policy)) } catch { continue }
    if (!m || m.id !== r.vault_id || !Array.isArray(m.targets)) continue
    const cur = out.get(m.id)
    if (!cur || metaStamp(m) > metaStamp(cur)) out.set(m.id, stripReplica(m))
  }
  return out
}

/**
 * The newest of several views of one vault's settings (this machine's vault.json, a copy's
 * vault.json on a drive, the catalog), with every heal recorded in the catalog merged in.
 */
function newestMeta(id: string, cands: Array<VaultMeta | null | undefined>, rows: any[]): VaultMeta | null {
  const list = cands.filter((m): m is VaultMeta => !!m && m.id === id).map(stripReplica)
  if (!list.length) return null
  const best = list.reduce((a, b) => (metaStamp(b) > metaStamp(a) ? b : a))
  return { ...best, healed: mergeHealed(best.healed ?? [], rows, id) }
}

/** Every drive a vault may have a copy on: its named places and its spares. */
const driveTargetsOf = (meta: VaultMeta) => [...allTargets(meta), ...(meta.spares ?? [])].filter((t) => t.kind === "drive")
const mountedCopies = (meta: VaultMeta) => mountedReplicaDirs({ ...meta, targets: driveTargetsOf(meta) }, driveEnv)

/**
 * Save a vault's settings everywhere they live: this machine's vault.json (if the vault is here),
 * every copy plugged in here, and every catalog row of the vault (so a machine with only a drive
 * plugged in, no vault and no key, knows the spares and the lost-after too).
 */
async function publishMeta(meta: VaultMeta, cat: VaultCatalog | null): Promise<string[]> {
  const problems: string[] = []
  if (existsSync(join(vaultDir(meta.id), "vault.json"))) {
    const { format: _f, v: _v, ...local } = meta as any
    await writeFile(join(vaultDir(meta.id), "vault.json"), JSON.stringify(local, null, 2), "utf-8")
    const lr = localReplicaDir(vaultDir(meta.id))
    if (existsSync(join(lr, "vault.json"))) writeAtomic(join(lr, "vault.json"), JSON.stringify(replicaMetaFor(meta), null, 2) + "\n")
  }
  for (const { target, dir } of mountedCopies(meta)) {
    if (readReplicaMeta(dir)?.id !== meta.id) continue
    try { ensureReplica(dir, replicaMetaFor(meta)) } catch (e: any) { problems.push(`${targetLabel(target)}: ${e?.message ?? e}`) }
  }
  if (cat) {
    try {
      const rows = (await cat.replicaRows()).map(dataOf).filter((r: any) => r.vault_id === meta.id && r.target)
      const policy = JSON.stringify(replicaMetaFor(meta))
      if (rows.length) {
        const r = await cat.upsert("drive-vaults", rows.map((x: any) => ({ external_id: replicaRowId(meta.id, x.target), vault_id: meta.id, target: x.target, vault_policy: policy })))
        if (r.failed) problems.push(`${r.failed} catalog row(s) did not take the new settings`)
      }
    } catch (e: any) {
      problems.push(`could not save the vault's settings to your Drives catalog (${e?.message ?? e})`)
    }
  }
  return problems
}

/** The vault whose settings are changed here: it must be on this machine (made here, or key imported). */
async function localVaultOrFail(name: string): Promise<VaultMeta> {
  const meta = await findReplicated(name)
  if (!meta) throw new VaultUserError(`no vault named "${name}" on this machine — change a vault's settings on the machine it was made on, or one that imported its key (iris vault key import)`)
  if (!meta.targets?.length) throw new VaultUserError(`vault ${meta.name} was made without --on, so its copies have no named places to catch up or heal. Make one with: iris vault create <name> --on "<drive>,<drive>,this-machine"`)
  return meta
}

/** --on / --spare names → targets: cataloged drives by label or id, your machines by name. Only the account's lists are read. */
async function resolvePlaces(spec: string, userId: number, cat: VaultCatalog | null): Promise<VaultTarget[]> {
  const drives = cat ? await cat.drives() : []
  const words = String(spec).split(",").map((w) => w.trim().toLowerCase()).filter(Boolean)
  const needNodes = words.some((w) => !SELF_WORDS.includes(w) && w !== hostname().toLowerCase() && !drives.some((d: any) => String(d.label ?? "").toLowerCase() === w || String(d.external_id) === w))
  const nodes = needNodes ? ((await fetchNodes(userId)) as any[]) : []
  const ts = resolveOn(String(spec), { drives, nodes, self: hostname() })
  if (ts.some((t) => t.kind === "drive") && !cat) throw new VaultUserError("No drives cataloged yet — run: iris drives scan <drive or folder>")
  return ts
}

// ── the newest index of a vault that this machine can reach ────────────────────────────────

type IndexPick = { index: ReplicaIndex; sealed: SealedManifest | null; from: string } | { skip: string }

/**
 * The newest key-free index of a vault: this machine's, a copy plugged in here, or (only when
 * neither exists, or `dial` is forced) one of the vault's OWN named machines. If this machine holds
 * a newer manifest than any index (files put by an older CLI), the index is rebuilt with the key —
 * and when the key cannot be opened without a person here (auto), the vault is skipped with why.
 */
async function bestIndex(meta: VaultMeta, o: { auto: boolean; argv: any; userId: number; from?: string | null; forceRemote?: boolean }): Promise<IndexPick> {
  const id = meta.id
  const cands: Array<{ index: ReplicaIndex; sealed: SealedManifest | null; from: string }> = []
  const lr = localReplicaDir(vaultDir(id))
  const li = readReplicaIndex(lr)
  if (li && li.vault_id === id) cands.push({ index: li, sealed: readSealed(lr), from: "this machine" })
  for (const { target, dir } of mountedCopies(meta)) {
    const i = readReplicaIndex(dir)
    if (i && i.vault_id === id) cands.push({ index: i, sealed: readSealed(dir), from: targetLabel(target) })
  }
  if (!cands.length || o.forceRemote) {
    const names = o.from ? [o.from] : allTargets(meta).filter((t) => t.kind === "machine" && !t.self).map((t) => (t as any).name as string)
    for (const n of names) {
      const r = await remoteSource(n, id, o.argv, o.userId).catch(() => null)
      if (!r) continue
      const i = parseIndex(JSON.stringify(await remoteJson(r.t, id, "index.json")))
      if (i && i.vault_id === id) { cands.push({ index: i, sealed: await remoteJson(r.t, id, "manifest.sealed.json"), from: n }); break }
    }
  }
  let best = cands.sort((a, b) => b.index.seq - a.index.seq)[0] ?? null
  const man = existsSync(join(vaultDir(id), "manifests")) ? await latestManifest(id) : null
  if (man && man.seq > (best?.index.seq ?? 0)) {
    const why = `files were added on this machine that no copy's index lists yet (manifest ${man.seq}, index ${best?.index.seq ?? "none"}); rebuilding the index needs the vault key`
    const k = await keyOrSkip(() => (o.auto ? keyStoreNoPrompt() : keyStore(o.argv)).getKey(id), why)
    if ("skip" in k) {
      if (o.auto || !best) return { skip: k.skip }
    } else {
      const index = buildIndex(k.key, man)
      const sealed = sealManifest(k.key, man)
      writeLocalReplicaFiles(meta, index, sealed)
      best = { index, sealed, from: "this machine" }
    }
  }
  if (!best) return { skip: "no copy of this vault's index is reachable from here — pass --from <machine>" }
  return best
}

/** The key store with no way to ask a person anything: what the daemon's runs use. */
const keyStoreNoPrompt = () => new ReplicatedKeyStore(defaultOptions({ passphrase: undefined }))

// ── sync / automatic catch-up ──────────────────────────────────────────────────────────────

type SyncOpts = { auto: boolean; trigger: "mount" | "schedule" | "manual" }
type SyncVaultReport = {
  vault: string; id: string; ok: boolean; seq?: number; checks?: TargetCheck[]; problems: string[]
  error?: string; skipped?: string; files?: number; chunks?: number; text?: string
}

/**
 * Catch up every vault copy on the drives plugged in here (or one vault). The daemon calls this as
 * `iris vault auto run` when a drive is connected; a person calls it as `iris vault sync`. One sync
 * per vault at a time (a lock), never a prompt in auto mode.
 */
async function runSync(argv: any, userId: number, opts: SyncOpts): Promise<{ mounted: Map<string, string>; drives: any[]; report: SyncVaultReport[]; off?: string }> {
  const machine = readAuto()
  if (opts.auto && !machine.enabled) return { mounted: new Map(), drives: [], report: [], off: autoBlocked(machine, {})! }
  const cat = await openCatalog(userId, argv.bloq)
  if (!cat) throw new VaultUserError("No drives cataloged yet — run: iris drives scan <drive or folder>")
  const drives = await cat.cat.drives()
  const mounted = new Map<string, string>()
  for (const d of drives) {
    const m = resolveMount(String(d.external_id))
    if (m) mounted.set(String(d.external_id), m)
  }
  const rows: any[] = (await cat.cat.replicaRows()).map(dataOf)
  const fromCatalog = metasFromRows(rows)
  // Which vaults have a copy that belongs on a drive plugged in here — from this machine's vaults,
  // the catalog, and the copies already on the drives. Spares holding a rebuilt copy count.
  const want = new Map<string, { metas: VaultMeta[]; drives: Set<string>; source: string | null }>()
  const add = (id: string, driveId: string, meta: VaultMeta | null, source: string | null) => {
    const w = want.get(id) ?? { metas: [], drives: new Set<string>(), source: null }
    w.drives.add(driveId)
    if (meta) w.metas.push(meta)
    if (source && !w.source) w.source = source
    want.set(id, w)
  }
  let ids: string[] = []
  try { ids = await readdir(VAULT_ROOT) } catch {}
  for (const id of ids) {
    const m = await loadMeta(id).catch(() => null)
    if (!m) continue
    for (const t of allTargets({ ...m, healed: mergeHealed(m.healed ?? [], rows, m.id) })) if (t.kind === "drive" && mounted.has(t.id)) add(m.id, t.id, m, m.source_node ?? null)
  }
  for (const r of rows) {
    if (r.target_kind === "drive" && mounted.has(String(r.drive_id)) && r.role !== "spare-retired") add(String(r.vault_id), String(r.drive_id), fromCatalog.get(String(r.vault_id)) ?? null, r.source_node || null)
  }
  for (const [driveId, m] of mounted) for (const rep of replicasOnMount(m)) {
    const rm = stripReplica(rep.meta)
    if (allTargets({ ...rm, healed: mergeHealed(rm.healed ?? [], rows, rm.id) }).some((t) => t.kind === "drive" && t.id === driveId)) add(rm.id, driveId, rm, rm.source_node ?? null)
  }
  const only = argv.vault ? String(argv.vault) : null
  const report: SyncVaultReport[] = []
  let machineChanged = false
  for (const [id, w] of want) {
    const local = existsSync(join(vaultDir(id), "vault.json")) ? await loadMeta(id).catch(() => null) : null
    const nameHint = rows.find((r) => r.vault_id === id)?.vault_name
    const meta = newestMeta(id, [local, ...w.metas, fromCatalog.get(id)], rows)
    if (only && only !== id && only !== (meta?.name ?? nameHint)) continue
    const from = argv.from ? String(argv.from) : w.source && w.source.toLowerCase() !== hostname().toLowerCase() ? w.source : null
    if (!meta || !meta.targets) { report.push({ vault: nameHint ?? id, id, ok: false, problems: [], error: `cannot tell what this copy should hold — run on the machine that created it, or pass --from <machine>` }); continue }
    if (opts.auto) {
      const blocked = autoBlocked(machine, meta)
      if (blocked) { report.push({ vault: meta.name, id, ok: true, problems: [], skipped: blocked }); continue }
    }
    const lock = acquireLock(id, { what: opts.auto ? "automatic catch-up" : "sync" })
    if (!lock.ok) { report.push({ vault: meta.name, id, ok: true, problems: [], skipped: `another catch-up of this vault is already running here (${lock.holder})` }); continue }
    try {
      const pick = await bestIndex(meta, { auto: opts.auto, argv, userId, from, forceRemote: !!argv.from })
      if ("skip" in pick) { report.push({ vault: meta.name, id, ok: !opts.auto ? false : true, problems: [], ...(opts.auto ? { skipped: pick.skip } : { error: pick.skip }) }); continue }
      let remote: Awaited<ReturnType<typeof remoteSource>> = null
      const dial = async () => (remote ??= from ? await remoteSource(from, id, argv, userId) : null)
      const sources: BlobSource[] = []
      if (existsSync(join(vaultDir(id), "blobs"))) sources.push(folderSource("this machine", vaultDir(id)))
      for (const { target, dir } of mountedCopies(meta)) if (readReplicaMeta(dir)?.id === id) sources.push(folderSource(targetLabel(target), dir))
      // The source machine is asked only for chunks no plugged-in copy has.
      sources.push({ name: from ?? "source", read: async (cid) => { const r = await dial(); return r ? r.src.read(cid) : null } })
      const targets = allTargets(meta).filter((t) => t.kind === "drive" && w.drives.has(t.id))
      const checks = await syncDriveTargets({ meta, index: pick.index, sealed: pick.sealed, targets, env: driveEnv, sources, deep: !!argv.deep })
      const at = new Date()
      let files = 0
      let chunks = 0
      for (const c of checks) {
        const n = c.writtenIds?.length ?? 0
        if (!n) continue
        const f = filesTouched(pick.index, c.writtenIds!)
        files += f
        chunks += n
        c.row = { ...(c.row ?? {}), last_catchup: catchupText(f, n), last_catchup_at: at.toISOString().replace(/\.\d{3}Z$/, "Z") }
        console.error(`[vault ${opts.auto ? "auto" : "sync"}] ${meta.name} on ${targetLabel(c.target)}: ${catchupText(f, n)}`)
      }
      const problems = await recordChecks(cat.cat, meta, pick.index, checks, hostname(), at)
      const text = catchupText(files, chunks)
      if (chunks) {
        machine.last = { ...(machine.last ?? {}), [id]: { at: at.toISOString(), text, trigger: opts.trigger } }
        machineChanged = true
      }
      report.push({ vault: meta.name, id, ok: checks.every((c) => c.status === "ok"), seq: pick.index.seq, checks, problems, files, chunks, text })
    } catch (e: any) {
      report.push({ vault: meta.name, id, ok: false, problems: [], error: String(e?.message ?? e) })
    } finally {
      lock.release()
    }
  }
  if (machineChanged) { try { writeAuto({ ...readAuto(), last: machine.last }) } catch { /* status file only */ } }
  return { mounted, drives, report }
}

async function syncCli(argv: any, run: DrivesRun, opts: SyncOpts) {
  if (!(await requireAuth())) process.exit(1)
  const userId = await requireUserId(argv["user-id"] as number | undefined)
  if (!userId) process.exit(1)
  const { mounted, drives, report, off } = await runSync(argv, userId, opts)
  run.set({
    auto: opts.auto, trigger: opts.trigger, drives_count: mounted.size, vaults_count: report.length,
    files_caught_up: report.reduce((n, r) => n + (r.files ?? 0), 0), chunks_copied: report.reduce((n, r) => n + (r.chunks ?? 0), 0),
    skipped_count: report.filter((r) => r.skipped).length,
  })
  const ok = report.every((r) => r.ok)
  if (argv.json) {
    await writeJson({
      ok, ...(off ? { skipped: off } : {}), drives_here: [...mounted.keys()],
      vaults: report.map((r) => ({ ...r, checks: r.checks?.map((c: TargetCheck) => ({ target: c.key, label: targetLabel(c.target), status: c.status, held: c.held?.size ?? null, wanted: c.wanted, written: c.written ?? 0, note: c.note || undefined })) })),
    })
    if (!ok) process.exitCode = 1
    return
  }
  console.log()
  if (off) console.log(`  ${dim(off)}`)
  else if (!mounted.size) console.log(`  ${dim("No cataloged drive is plugged into this machine.")}`)
  else if (!report.length) console.log(`  ${dim(`No vault has a copy on the drive(s) plugged in here (${[...mounted.keys()].map((k) => drives.find((d) => String(d.external_id) === k)?.label ?? k).join(", ")}).`)}`)
  for (const r of report) {
    if (r.skipped) { console.log(`  ${dim("–")} ${bold(r.vault)}  ${dim("skipped: " + r.skipped)}`); continue }
    if (r.error) { console.log(`  ${dim("✗")} ${bold(r.vault)}  ${r.error}`); continue }
    for (const c of r.checks as TargetCheck[]) {
      const tag = c.status === "ok" ? success("✓") : dim("✗")
      console.log(`  ${tag} ${bold(r.vault)} on ${targetLabel(c.target)}  ${dim(`${c.held?.size ?? 0}/${c.wanted} chunks · ${c.written ? catchupText(filesTouchedFor(r, c), c.written) : "nothing to copy"} · manifest seq ${r.seq}`)}${c.note ? `  ${dim(c.note)}` : ""}`)
    }
    for (const p of r.problems) console.log(`     ${bold("not recorded:")} ${dim(p)}`)
  }
  console.log()
  if (!ok) process.exitCode = 1
}

const filesTouchedFor = (r: SyncVaultReport, c: TargetCheck) => {
  const m = /caught up (\d+) file/.exec(String(c.row?.last_catchup ?? ""))
  return m ? Number(m[1]) : 0
}

// ── iris vault auto: on/off, status, and the daemon's entry point ──────────────────────────

const AutoCommand = cmd({
  command: "auto <action> [vault]",
  describe: "automatic catch-up when a drive is plugged in, and the daily heal — on | off (this machine, or one vault) | status | run",
  builder: (y) => y
    .positional("action", { type: "string", choices: ["on", "off", "status", "run"], demandOption: true })
    .positional("vault", { type: "string", describe: "on/off for this vault only (on every machine); without it, this machine" })
    .option("trigger", { type: "string", choices: ["mount", "schedule", "manual"], default: "manual", describe: "(run) what started it — the daemon passes mount" })
    .option("bloq", { type: "number", describe: "advanced: the Drives board to use" })
    .option("user", { type: "string" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false })
    .example("$0 vault auto off", "this machine stops catching up and healing on its own (iris vault sync / heal still work)")
    .example("$0 vault auto off studio", "vault studio is never caught up or healed automatically, on any machine")
    .example("$0 vault auto status", "on or off, and the last catch-up of each vault")
    .epilogue("The IRIS daemon runs `iris vault auto run --trigger mount` when a drive is connected, and `iris vault heal --auto` once a day. Neither ever asks for anything: a step that needs the vault key is skipped and says why."),
  async handler(argv: any) {
    const action = String(argv.action)
    if (action === "run") return (autoRun as any)(argv)
    try {
      if (action === "status") return await autoStatus(argv)
      if (!argv.vault) {
        const st = readAuto()
        writeAuto({ ...st, enabled: action === "on", updated_at: new Date().toISOString() })
        if (argv.json) { await writeJson({ ok: true, machine: hostname(), enabled: action === "on" }); return }
        console.log(`\n  ${success("✓")} automatic catch-up and heal ${bold(action === "on" ? "ON" : "OFF")} on this machine ${dim(`(${hostname()})`)}`)
        console.log(`     ${dim(action === "on" ? "When a drive with a vault copy is plugged in, the IRIS daemon brings it up to date; lost copies are rebuilt on spares daily." : "Nothing runs on its own here. Catch up by hand: iris vault sync · heal by hand: iris vault heal")}\n`)
        return
      }
      const meta = await localVaultOrFail(String(argv.vault))
      if (!(await requireAuth())) process.exit(1)
      const userId = await requireUserId(argv["user-id"] as number | undefined)
      if (!userId) process.exit(1)
      const cat = await openCatalog(userId, argv.bloq).catch(() => null)
      const next: VaultMeta = { ...meta, updated_at: new Date().toISOString() }
      if (action === "on") delete next.auto
      else next.auto = false
      const problems = await publishMeta(next, cat?.cat ?? null)
      if (argv.json) { await writeJson({ ok: true, vault: meta.name, auto: action === "on", warnings: problems }); return }
      console.log(`\n  ${success("✓")} vault ${bold(meta.name)}: automatic catch-up and heal ${bold(action === "on" ? "ON" : "OFF")} ${dim("(every machine)")}`)
      for (const p of problems) console.log(`     ${bold("not saved:")} ${dim(p)}`)
      console.log()
    } catch (e) {
      await vaultFail(e, !!argv.json)
    }
  },
})

const autoRun = metered("vault_catchup", async (argv: any, run: DrivesRun) => {
  try { await syncCli(argv, run, { auto: true, trigger: (argv.trigger as SyncOpts["trigger"]) ?? "mount" }) } catch (e) { await failSoft(e, !!argv.json) }
})

async function autoStatus(argv: any) {
  const st = readAuto()
  let ids: string[] = []
  try { ids = await readdir(VAULT_ROOT) } catch {}
  const vaults: any[] = []
  for (const id of ids) {
    const m = await loadMeta(id).catch(() => null)
    if (!m?.targets?.length) continue
    const p = policyOf(m)
    vaults.push({ name: m.name, id, auto: p.auto, spares: p.spares.map(targetLabel), lost_after: fmtDays(p.lost_after_days), on_return: p.on_return, last_catchup: st.last?.[id] ?? null, last_heal: st.last_heal?.[id] ?? null })
  }
  if (argv.json) { await writeJson({ ok: true, machine: hostname(), enabled: st.enabled, vaults }); return }
  console.log()
  console.log(`  ${bold("Automatic catch-up and heal")} on ${hostname()}: ${st.enabled ? success("ON") : bold("OFF")}`)
  for (const v of vaults) {
    console.log(`  ${bold(v.name)}  ${dim(`${v.auto ? "auto on" : "auto OFF for this vault"} · lost after ${v.lost_after} · on return: ${v.on_return} · spares: ${v.spares.join(", ") || "none"}`)}`)
    if (v.last_catchup) console.log(`     ${dim(`last catch-up here: ${v.last_catchup.text}, ${ago(v.last_catchup.at)}`)}`)
    if (v.last_heal) console.log(`     ${dim(`last heal here: ${v.last_heal.text}, ${ago(v.last_heal.at)}`)}`)
  }
  if (!vaults.length) console.log(`  ${dim("No vault with named copies on this machine. Copies on drives plugged in here are still caught up.")}`)
  console.log()
}

// ── spares and policy ──────────────────────────────────────────────────────────────────────

const SpareCommand = cmd({
  command: "spare <action> <vault> [places]",
  describe: "the spare drives and machines a vault may rebuild a LOST copy on — and nowhere else (add | remove | list)",
  builder: (y) => y
    .positional("action", { type: "string", choices: ["add", "remove", "list"], demandOption: true })
    .positional("vault", { type: "string", demandOption: true })
    .positional("places", { type: "string", describe: 'drives (by their iris drives list name) and machines, comma-separated: "Spare A,studio-mac"' })
    .option("bloq", { type: "number", describe: "advanced: the Drives board to use" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false })
    .example('$0 vault spare add studio "Spare A"', "if a copy of studio is lost, rebuild it on Spare A")
    .example("$0 vault spare list studio", "the spares, in the order they are tried"),
  async handler(argv: any) {
    try {
      const meta = await localVaultOrFail(String(argv.vault))
      if (!(await requireAuth())) process.exit(1)
      const userId = await requireUserId(argv["user-id"] as number | undefined)
      if (!userId) process.exit(1)
      const cat = await openCatalog(userId, argv.bloq).catch(() => null)
      const rows = cat ? (await cat.cat.replicaRows().catch(() => [])).map(dataOf) : []
      meta.healed = mergeHealed(meta.healed ?? [], rows, meta.id)
      const action = String(argv.action)
      let next = meta
      if (action !== "list") {
        if (!argv.places) throw new VaultUserError(`name the spare(s): iris vault spare ${action} ${meta.name} "<drive or machine>,…"`)
        let spares = meta.spares ?? []
        if (action === "add") spares = addSpares(spares, await resolvePlaces(String(argv.places), userId, cat?.cat ?? null), allTargets(meta))
        else for (const w of String(argv.places).split(",").map((x) => x.trim()).filter(Boolean)) {
          const hit = spares.find((t) => [targetKey(t), t.kind === "drive" ? t.label : t.name, t.kind === "drive" ? t.id : t.name].some((x) => String(x).toLowerCase() === w.toLowerCase()))
          if (!hit) throw new VaultUserError(`"${w}" is not a spare of vault ${meta.name} (iris vault spare list ${meta.name})`)
          spares = removeSpare(spares, targetKey(hit), meta.healed)
        }
        next = { ...meta, spares, updated_at: new Date().toISOString() }
        if (!spares.length) delete next.spares
      }
      const problems = action === "list" ? [] : await publishMeta(next, cat?.cat ?? null)
      const p = policyOf(next)
      const holding = new Set(activeHealed(next.healed).map((h) => h.spare))
      if (argv.json) { await writeJson({ ok: true, vault: next.name, spares: p.spares.map((t) => ({ target: targetKey(t), label: targetLabel(t), holds_copy: holding.has(targetKey(t)) })), warnings: problems }); return }
      console.log()
      console.log(`  ${bold(next.name)}  ${dim(`spares, tried in this order — a lost copy is rebuilt on these and NOWHERE else`)}`)
      if (!p.spares.length) console.log(`  ${dim("none — a lost copy is only reported. Add one: iris vault spare add " + next.name + ' "<drive or machine>"')}`)
      for (const t of p.spares) console.log(`   · ${targetLabel(t)}${holding.has(targetKey(t)) ? dim("  (holds a rebuilt copy now)") : ""}`)
      console.log(`  ${dim(`lost after ${fmtDays(p.lost_after_days)} unseen · when a lost copy returns: ${p.on_return} · change: iris vault policy ${next.name}`)}`)
      for (const x of problems) console.log(`  ${bold("not saved:")} ${dim(x)}`)
      console.log()
    } catch (e) {
      await vaultFail(e, !!argv.json)
    }
  },
})

const PolicyCommand = cmd({
  command: "policy <vault>",
  describe: "when a copy counts as lost, and what happens when it comes back (shown without flags)",
  builder: (y) => y
    .positional("vault", { type: "string", demandOption: true })
    .option("lost-after", { type: "string", describe: "a copy unseen this long is LOST and rebuilt on a spare: 14d (default), 36h, 2w" })
    .option("on-return", { type: "string", choices: ["keep", "retire"], describe: "a lost copy is verified again: keep both (default) or retire the spare's copy" })
    .option("bloq", { type: "number", describe: "advanced: the Drives board to use" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false })
    .example("$0 vault policy studio --lost-after 7d", "rebuild a copy nobody has seen for a week")
    .example("$0 vault policy studio --on-return retire", "when the lost drive is back and verified, delete the spare's copy"),
  async handler(argv: any) {
    try {
      const meta = await localVaultOrFail(String(argv.vault))
      let next = meta
      let problems: string[] = []
      if (argv["lost-after"] != null || argv["on-return"] != null) {
        next = { ...meta, updated_at: new Date().toISOString() }
        if (argv["lost-after"] != null) next.lost_after_days = parseLostAfter(argv["lost-after"])
        if (argv["on-return"] != null) next.on_return = parseOnReturn(argv["on-return"])
        if (!(await requireAuth())) process.exit(1)
        const userId = await requireUserId(argv["user-id"] as number | undefined)
        if (!userId) process.exit(1)
        const cat = await openCatalog(userId, argv.bloq).catch(() => null)
        problems = await publishMeta(next, cat?.cat ?? null)
      }
      const p = policyOf(next)
      if (argv.json) { await writeJson({ ok: true, vault: next.name, lost_after_days: p.lost_after_days, on_return: p.on_return, auto: p.auto, spares: p.spares.map(targetLabel), warnings: problems }); return }
      console.log()
      console.log(`  ${bold(next.name)}`)
      console.log(`     lost after:   ${fmtDays(p.lost_after_days)} unseen ${dim("(rebuilt on a spare — never anywhere else)")}`)
      console.log(`     spares:       ${p.spares.map(targetLabel).join(", ") || dim("none — a lost copy is only reported")}`)
      console.log(`     on return:    ${p.on_return} ${dim(p.on_return === "keep" ? "(both copies stay and both count)" : "(the spare's copy is deleted once the returned copy is verified complete)")}`)
      console.log(`     automatic:    ${p.auto ? "on" : "OFF for this vault"} ${dim("(iris vault auto on|off " + next.name + ")")}`)
      for (const x of problems) console.log(`  ${bold("not saved:")} ${dim(x)}`)
      console.log()
    } catch (e) {
      await vaultFail(e, !!argv.json)
    }
  },
})

// ── heal: rebuild lost copies on the vault's own spares ────────────────────────────────────

type HealReport = {
  vault: string; id: string; dry_run: boolean; plan?: HealPlan; skipped?: string; error?: string
  rebuilt: Array<{ replaces: string; spare: string; ok: boolean; note: string; chunks: number }>
  retired: Array<{ spare: string; ok: boolean; note: string }>
  problems: string[]
}

const HealCommand = cmd({
  command: "heal [vault]",
  describe: "rebuild LOST vault copies (unseen past the vault's lost-after) on the spares you named for it — encrypted chunks only, verified; never on anything else",
  builder: (y) => y
    .positional("vault", { type: "string", describe: "only this vault (default: every vault this machine knows of)" })
    .option("dry-run", { type: "boolean", default: false, describe: "say what is lost and where it would be rebuilt; write nothing" })
    .option("auto", { type: "boolean", default: false, describe: "run by the daemon: respects iris vault auto off, never asks for anything" })
    .option("bloq", { type: "number", describe: "advanced: the Drives board to use" })
    .option("user", { type: "string" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false })
    .example("$0 vault heal --dry-run", "what is lost, and which spare would take it")
    .example("$0 vault heal studio", "rebuild studio's lost copies on its spares"),
  handler: metered("vault_heal", async (argv: any, run: DrivesRun) => {
    try { await healCli(argv, run) } catch (e) { await failSoft(e, !!argv.json) }
  }),
})

async function healCli(argv: any, run: DrivesRun) {
  if (!(await requireAuth())) process.exit(1)
  const userId = await requireUserId(argv["user-id"] as number | undefined)
  if (!userId) process.exit(1)
  const auto = !!argv.auto
  const dryRun = !!argv["dry-run"]
  const machine = readAuto()
  if (auto && !machine.enabled) {
    run.set({ auto, trigger: "schedule", skipped_count: 1 })
    if (argv.json) await writeJson({ ok: true, skipped: autoBlocked(machine, {}) })
    else console.log(`\n  ${dim(autoBlocked(machine, {})!)}\n`)
    return
  }
  const cat = await openCatalog(userId, argv.bloq)
  if (!cat) throw new VaultUserError("No drives cataloged yet — run: iris drives scan <drive or folder>")
  const rows: any[] = (await cat.cat.replicaRows()).map(dataOf)
  const fromCatalog = metasFromRows(rows)
  const metas = new Map<string, Array<VaultMeta | null>>()
  const push = (id: string, m: VaultMeta | null) => metas.set(id, [...(metas.get(id) ?? []), m])
  let ids: string[] = []
  try { ids = await readdir(VAULT_ROOT) } catch {}
  for (const id of ids) { const m = await loadMeta(id).catch(() => null); if (m?.targets?.length) push(id, m) }
  for (const [id, m] of fromCatalog) push(id, m)
  for (const d of await cat.cat.drives()) {
    const mnt = resolveMount(String(d.external_id))
    if (mnt) for (const rep of replicasOnMount(mnt)) push(rep.meta.id, stripReplica(rep.meta))
  }
  const only = argv.vault ? String(argv.vault) : null
  const reports: HealReport[] = []
  for (const [id, cands] of metas) {
    const meta = newestMeta(id, cands, rows)
    if (!meta?.targets?.length) continue
    if (only && only !== id && only !== meta.name) continue
    const base: HealReport = { vault: meta.name, id, dry_run: dryRun, rebuilt: [], retired: [], problems: [] }
    if (auto) {
      const b = autoBlocked(machine, meta)
      if (b) { reports.push({ ...base, skipped: b }); continue }
    }
    const lock = dryRun ? { ok: true as const, release: () => {} } : acquireLock(id, { what: "heal" })
    if (!lock.ok) { reports.push({ ...base, skipped: `a catch-up or heal of this vault is already running here (${lock.holder})` }); continue }
    try {
      reports.push(await healVault(meta, { ...base }, { argv, userId, cat: cat.cat, rows, auto, dryRun }))
    } catch (e: any) {
      reports.push({ ...base, error: String(e?.message ?? e) })
    } finally {
      lock.release()
    }
  }
  if (only && !reports.length) throw new VaultUserError(`no vault named "${only}" with named copies is known here (its machine, a copy plugged in here, or your Drives catalog)`)
  const lost = reports.reduce((n, r) => n + (r.plan?.lost.length ?? 0), 0)
  run.set({
    auto, dry_run: dryRun, trigger: auto ? "schedule" : "manual", vaults_count: reports.length, lost_count: lost,
    rebuilt_count: reports.reduce((n, r) => n + r.rebuilt.filter((x) => x.ok).length, 0),
    alerts_count: reports.reduce((n, r) => n + (r.plan?.alerts.length ?? 0), 0),
    chunks_copied: reports.reduce((n, r) => n + r.rebuilt.reduce((a, x) => a + x.chunks, 0), 0),
    skipped_count: reports.filter((r) => r.skipped).length,
  })
  if (!dryRun) {
    const st = readAuto()
    for (const r of reports) if (r.plan && (r.plan.lost.length || r.retired.length)) {
      st.last_heal = { ...(st.last_heal ?? {}), [r.id]: { at: new Date().toISOString(), text: healText(r) } }
    }
    try { writeAuto(st) } catch {}
  }
  const ok = reports.every((r) => !r.error && r.rebuilt.every((x) => x.ok) && !(r.plan?.alerts.length))
  if (argv.json) {
    await writeJson({ ok, dry_run: dryRun, vaults: reports })
    if (!ok) process.exitCode = 1
    return
  }
  console.log()
  if (!reports.length) console.log(`  ${dim("No vault with named copies is known here.")}`)
  for (const r of reports) {
    if (r.skipped) { console.log(`  ${dim("–")} ${bold(r.vault)}  ${dim("skipped: " + r.skipped)}`); continue }
    if (r.error) { console.log(`  ${dim("✗")} ${bold(r.vault)}  ${r.error}`); continue }
    const p = r.plan!
    if (!p.lost.length && !p.returned.length) { console.log(`  ${success("✓")} ${bold(r.vault)}  ${dim("no copy lost")}`); continue }
    for (const l of p.lost) console.log(`  ${dim("✗")} ${bold(r.vault)} copy on ${labelOf(r, l.key)} LOST ${dim(`(${unseenText(l.ms)})`)}`)
    for (const b of p.rebuild) {
      const done = r.rebuilt.find((x) => x.spare === b.spare)
      console.log(`     ${r.dry_run ? dim("would rebuild") : done?.ok ? success("✓ rebuilt") : bold("✗ rebuild failed")} ${dim(`on ${labelOf(r, b.spare)} (for ${labelOf(r, b.replaces)})${done ? ` · ${done.chunks} chunk(s) copied${done.note ? " · " + done.note : ""}` : ""}`)}`)
    }
    for (const a of p.alerts) console.log(`     ${bold("⚠ not rebuilt")} ${dim(`${labelOf(r, a.replaces)}: ${a.why}`)}`)
    for (const x of p.returned) console.log(`     ${success("↩")} ${dim(`${labelOf(r, x.key)} is back — its spare ${labelOf(r, x.spare)} ${p.retire.some((y) => y.spare === x.spare) ? "is retired" : "keeps its copy (on return: keep)"}`)}`)
    for (const x of r.retired) console.log(`     ${dim(`${labelOf(r, x.spare)} retired: ${x.ok ? "its copy deleted" : x.note}`)}`)
    for (const x of r.problems) console.log(`     ${bold("not recorded:")} ${dim(x)}`)
  }
  console.log()
  if (!ok) process.exitCode = 1
}

const labelOf = (r: HealReport & { labels?: Record<string, string> }, k: string) => r.labels?.[k] ?? k.replace(/^(drive|machine):/, "")

function healText(r: HealReport): string {
  const ok = r.rebuilt.filter((x) => x.ok).length
  const parts = [`${r.plan?.lost.length ?? 0} lost`]
  if (ok) parts.push(`${ok} rebuilt`)
  if (r.plan?.alerts.length) parts.push(`${r.plan.alerts.length} with no spare`)
  if (r.retired.length) parts.push(`${r.retired.filter((x) => x.ok).length} spare(s) retired`)
  return parts.join(", ")
}

/** A partial catalog row for one copy of a vault (Atlas import merges it into the existing row). */
function rowPatch(meta: VaultMeta, t: VaultTarget | undefined, key: string, fields: Record<string, any>) {
  return {
    external_id: replicaRowId(meta.id, key), vault_id: meta.id, vault_name: meta.name, target: key,
    target_kind: key.startsWith("drive:") ? "drive" : "machine",
    ...(t ? { target_label: t.kind === "drive" ? t.label : t.name, drive_id: t.kind === "drive" ? t.id : "" } : {}),
    ...fields,
  }
}

async function healVault(meta: VaultMeta, rep: HealReport, ctx: { argv: any; userId: number; cat: VaultCatalog; rows: any[]; auto: boolean; dryRun: boolean }): Promise<HealReport> {
  const pol = policyOf(meta)
  const now = new Date()
  const at = now.toISOString().replace(/\.\d{3}Z$/, "Z")
  const labels: Record<string, string> = {}
  for (const t of [...allTargets(meta), ...pol.spares]) labels[targetKey(t)] = targetLabel(t)
  ;(rep as any).labels = labels
  // From the catalog alone first: nothing lost and nothing back → done, without dialling anything.
  const pre = planHeal({
    vaultId: meta.id, createdAt: meta.created_at, copies: namedCopies(meta), policy: pol, healed: meta.healed ?? [],
    rows: ctx.rows, now, seq: Number.MAX_SAFE_INTEGER, reach: () => ({ ok: false, why: "not checked yet" }),
  })
  const anyBack = activeHealed(meta.healed).length > 0
  if (!pre.lost.length && !anyBack) { rep.plan = pre; return rep }
  const pick = await bestIndex(meta, { auto: ctx.auto, argv: ctx.argv, userId: ctx.userId })
  if ("skip" in pick) return { ...rep, skipped: pick.skip }
  const index = pick.index
  const lens = new Map(index.blobs)
  const wanted = index.blobs.map(([id]) => id)
  const needFrom = (have: Set<string>) => wanted.reduce((n, id) => n + (have.has(id) ? 0 : lens.get(id) ?? 0), 0)

  // What is verifiable from here right now: this machine's copy, and copies on drives plugged in here.
  const checks: TargetCheck[] = []
  const self = selfCheck(meta, index)
  if (self) checks.push(self)
  checks.push(...(await syncDriveTargets({ meta, index, sealed: null, targets: allTargets(meta), env: driveEnv, sources: [], readOnly: true })))
  const live = new Set(checks.filter((c) => c.status === "ok").map((c) => c.key))

  // Can each SPARE take a copy now? Only the vault's own spares are looked at (and dialled).
  let nodes: any[] | null = null
  const reachMap = new Map<string, Reach>()
  const busy = new Set(allTargets(meta).map(targetKey))
  for (const s of pol.spares) {
    const k = targetKey(s)
    if (busy.has(k)) continue
    if (s.kind === "drive") {
      const mnt = resolveMount(s.id)
      if (!mnt) { reachMap.set(k, { ok: false, why: "not plugged into this machine" }); continue }
      const need = needFrom(heldBlobs(replicaDir(mnt, meta.name)))
      const st = statfsOf(mnt)
      const plan = planPlacement([{ target: s, reachable: true, freeBytes: st?.free ?? null, sizeBytes: st?.size ?? null, needBytes: need }])
      reachMap.set(k, plan.noRoom.length ? { ok: false, why: plan.noRoom[0].why } : { ok: true })
    } else if (s.name.toLowerCase() === hostname().toLowerCase()) {
      const need = needFrom(heldBlobs(vaultDir(meta.id)))
      const st = statfsOf(homedir())
      const plan = planPlacement([{ target: s, reachable: true, freeBytes: st?.free ?? null, needBytes: need }])
      reachMap.set(k, plan.noRoom.length ? { ok: false, why: plan.noRoom[0].why } : { ok: true })
    } else {
      nodes ??= ((await fetchNodes(ctx.userId).catch(() => [])) as any[])
      const n = nodes.find((x) => (s.id && String(x.id) === String(s.id)) || String(x.name).toLowerCase() === s.name.toLowerCase())
      const st = n ? await targetFor(n, ctx.argv) : null
      if (!st) { reachMap.set(k, { ok: false, why: n ? "not reachable now" : "no longer one of your machines" }); continue }
      const plan = planPlacement([{ target: s, reachable: true, freeBytes: await freeBytes(st), needBytes: needFrom(await remoteBlobIds(st, meta.id)) }])
      reachMap.set(k, plan.noRoom.length ? { ok: false, why: plan.noRoom[0].why } : { ok: true })
    }
  }
  const plan = planHeal({
    vaultId: meta.id, createdAt: meta.created_at, copies: namedCopies(meta), policy: pol, healed: meta.healed ?? [],
    rows: ctx.rows, now, seq: index.seq, liveOk: live, reach: (s) => reachMap.get(targetKey(s)) ?? { ok: false, why: "not checked" },
  })
  rep.plan = plan
  if (ctx.dryRun) return rep

  // Chunk sources: this machine, copies plugged in here, then the vault's OWN machines that are not lost.
  const lost = new Set(plan.lost.map((l) => l.key))
  const sources: BlobSource[] = []
  if (existsSync(join(vaultDir(meta.id), "blobs"))) sources.push(folderSource("this machine", vaultDir(meta.id)))
  for (const { target, dir } of mountedCopies(meta)) if (readReplicaMeta(dir)?.id === meta.id && !lost.has(targetKey(target))) sources.push(folderSource(targetLabel(target), dir))
  for (const t of allTargets(meta)) {
    if (t.kind !== "machine" || t.self || lost.has(targetKey(t))) continue
    let r: Awaited<ReturnType<typeof remoteSource>> | undefined
    sources.push({ name: t.name, read: async (id) => { if (r === undefined) r = await remoteSource(t.name, meta.id, ctx.argv, ctx.userId).catch(() => null); return r ? r.src.read(id) : null } })
  }

  const patches: any[] = []
  const healed = (meta.healed ?? []).map((h) => ({ ...h })) // copies: compared with meta.healed below
  const unseen = (k: string) => unseenText(plan.lost.find((l) => l.key === k)?.ms ?? -1)
  const tByKey = (k: string) => [...allTargets(meta), ...pol.spares].find((t) => targetKey(t) === k)
  for (const b of plan.rebuild) {
    const spare = assertSpare(pol.spares, b.spare) // the guard: nothing but a named spare is ever written to
    const c = await fillSpare(meta, spare, pick, sources, ctx)
    const ok = c.status === "ok"
    rep.rebuilt.push({ replaces: b.replaces, spare: b.spare, ok, note: c.note, chunks: c.written ?? 0 })
    if (ok) {
      healed.push({ spare: b.spare, replaces: b.replaces, at })
      c.row = { role: "spare", replaces: b.replaces, healed_at: at, returned_at: "", retired_at: "", heal_alert: "" }
      patches.push(rowPatch(meta, tByKey(b.replaces), b.replaces, { heal_alert: `lost (${unseen(b.replaces)}) — rebuilt on ${labels[b.spare]} ${at.slice(0, 10)}` }))
    } else {
      patches.push(rowPatch(meta, tByKey(b.replaces), b.replaces, { heal_alert: `lost (${unseen(b.replaces)}) — rebuilding on ${labels[b.spare]} failed: ${c.note || c.status}` }))
    }
    checks.push(c)
  }
  for (const a of plan.alerts) patches.push(rowPatch(meta, tByKey(a.replaces), a.replaces, { heal_alert: `lost (${unseen(a.replaces)}) — ${a.why}` }))
  for (const x of plan.returned) {
    const h = healed.find((y) => y.spare === x.spare && !y.retired_at)
    if (h && !h.returned_at) h.returned_at = at
    patches.push(rowPatch(meta, tByKey(x.key), x.key, { heal_alert: "" }))
    patches.push(rowPatch(meta, tByKey(x.spare), x.spare, { returned_at: h?.returned_at ?? at }))
  }
  for (const x of plan.retire) {
    const spare = assertSpare(pol.spares, x.spare)
    const r = await retireSpare(meta, spare, ctx)
    rep.retired.push({ spare: x.spare, ok: r.ok, note: r.note })
    if (!r.ok) continue
    const h = healed.find((y) => y.spare === x.spare && !y.retired_at)
    if (h) h.retired_at = at
    patches.push(rowPatch(meta, spare, x.spare, { role: "spare-retired", retired_at: at, status: "pending", note: `retired: ${labels[x.replaces]} is back` }))
  }
  // A copy that is no longer lost loses its old alert.
  for (const r of ctx.rows) if (r.vault_id === meta.id && r.heal_alert && !lost.has(r.target) && !patches.some((p) => p.target === r.target && "heal_alert" in p)) patches.push(rowPatch(meta, tByKey(r.target), r.target, { heal_alert: "" }))

  const changed = JSON.stringify(healed) !== JSON.stringify(meta.healed ?? [])
  const next: VaultMeta = changed ? { ...meta, healed, updated_at: new Date().toISOString() } : meta
  rep.problems.push(...(await recordChecks(ctx.cat, next, index, checks.filter((c) => !plan.retire.some((x) => x.spare === c.key)), hostname(), now)))
  if (patches.length) {
    try {
      const r = await ctx.cat.upsert("drive-vaults", patches)
      if (r.failed) rep.problems.push(`${r.failed} heal note(s) could not be saved`)
    } catch (e: any) {
      rep.problems.push(`could not save heal notes (${e?.message ?? e})`)
    }
  }
  if (changed) rep.problems.push(...(await publishMeta(next, ctx.cat)))
  // The alerts land on the drive records too (the lost drive's own record says so).
  try {
    const kept = (await ctx.cat.keptRows()).map(dataOf)
    const rows = (await ctx.cat.replicaRows()).map(dataOf)
    rep.problems.push(...(await refreshDriveAlerts(ctx.cat, kept, rows, now)))
  } catch { /* recorded above when it matters */ }
  return rep
}

/** Fill one spare from `sources`: every chunk hash-checked before it is stored. Encrypted chunks only — no key here. */
async function fillSpare(meta: VaultMeta, spare: VaultTarget, pick: { index: ReplicaIndex; sealed: SealedManifest | null }, sources: BlobSource[], ctx: { argv: any; userId: number }): Promise<TargetCheck> {
  const key = targetKey(spare)
  const wanted = pick.index.blobs.map(([id]) => id)
  if (spare.kind === "drive") {
    const [c] = await syncDriveTargets({ meta, index: pick.index, sealed: pick.sealed, targets: [spare], env: driveEnv, sources })
    return c ?? { target: spare, key, status: "pending", held: null, wanted: wanted.length, note: "not plugged into this machine" }
  }
  if (spare.name.toLowerCase() === hostname().toLowerCase()) {
    const dir = vaultDir(meta.id)
    await mkdir(join(dir, "blobs"), { recursive: true })
    const fill = await fillReplica(dir, wanted, sources.filter((s) => s.name !== "this machine"))
    const lr = localReplicaDir(dir)
    writeAtomic(join(lr, "vault.json"), JSON.stringify(replicaMetaFor(meta), null, 2) + "\n")
    writeReplicaIndex(lr, pick.index, pick.sealed)
    const v = verifyReplica(dir, pick.index, false)
    return {
      target: { ...spare, self: true }, key, status: statusOf(wanted.length, v.held.size, v.corrupt.length), held: v.held, wanted: wanted.length,
      written: fill.written.length, writtenIds: fill.written, note: [fill.missing.length ? `${fill.missing.length} chunk(s) not found on any source` : "", fill.errors[0] ?? ""].filter(Boolean).join("; "),
    }
  }
  const nodes = (await fetchNodes(ctx.userId)) as any[]
  const n = nodes.find((x) => (spare.id && String(x.id) === String(spare.id)) || String(x.name).toLowerCase() === spare.name.toLowerCase())
  const st = n ? await targetFor(n, ctx.argv) : null
  if (!st) return { target: spare, key, status: "pending", held: null, wanted: wanted.length, note: "not reachable now" }
  let have = await remoteBlobIds(st, meta.id)
  const stage = mkdtempSync(join(tmpdir(), "iris-vault-heal-"))
  const written: string[] = []
  let note = ""
  try {
    // Stage one chunk at a time (ciphertext, named by its hash), push it, remove it.
    for (const id of wanted) {
      if (have.has(id)) continue
      let got: Buffer | null = null
      for (const s of sources) {
        const b = await s.read(id)
        if (b && sha256(b) === id) { got = b; break }
      }
      if (!got) { note = "some chunks were not found on any source"; continue }
      writeBlob(stage, id, got)
      const r = await pushFile(st, blobFile(stage, id), remoteBlobPath(meta.id, id))
      rmSync(blobFile(stage, id), { force: true })
      if (!r.ok) { note = `push failed: ${r.error ?? "unknown"}`; break }
      written.push(id)
    }
    const rdir = join(stage, "replica")
    writeAtomic(join(rdir, "vault.json"), JSON.stringify(replicaMetaFor(meta), null, 2) + "\n")
    writeReplicaIndex(rdir, pick.index, pick.sealed)
    for (const f of ["vault.json", "index.json", "manifest.sealed.json"]) if (existsSync(join(rdir, f))) await pushFile(st, join(rdir, f), remoteVaultPath(meta.id, "replica"))
  } finally {
    rmSync(stage, { recursive: true, force: true })
  }
  have = await remoteBlobIds(st, meta.id)
  const held = new Set(wanted.filter((id) => have.has(id)))
  return { target: spare, key, status: statusOf(wanted.length, held.size, 0), held, wanted: wanted.length, written: written.length, writtenIds: written, note }
}

/** Delete a spare's copy (policy retire). Only the vault's own folders; only where IRIS can reach it. */
async function retireSpare(meta: VaultMeta, spare: VaultTarget, ctx: { argv: any; userId: number }): Promise<{ ok: boolean; note: string }> {
  if (namedCopies(meta).some((t) => targetKey(t) === targetKey(spare))) return { ok: false, note: "it is also a named copy of this vault — not deleted" }
  if (spare.kind === "drive") {
    const mnt = resolveMount(spare.id)
    if (!mnt) return { ok: false, note: "not plugged into this machine — retired when it is (iris vault heal there)" }
    const dir = replicaDir(mnt, meta.name)
    if (readReplicaMeta(dir)?.id !== meta.id) return { ok: true, note: "no copy there" }
    rmSync(dir, { recursive: true, force: true })
    return { ok: true, note: "" }
  }
  if (spare.name.toLowerCase() === hostname().toLowerCase()) {
    rmSync(join(vaultDir(meta.id), "blobs"), { recursive: true, force: true })
    rmSync(localReplicaDir(vaultDir(meta.id)), { recursive: true, force: true })
    return { ok: true, note: "" }
  }
  const nodes = (await fetchNodes(ctx.userId)) as any[]
  const n = nodes.find((x) => (spare.id && String(x.id) === String(spare.id)) || String(x.name).toLowerCase() === spare.name.toLowerCase())
  const st = n ? await targetFor(n, ctx.argv) : null
  if (!st) return { ok: false, note: "not reachable now — retired at a later heal" }
  const r = await sshRun(st, `rm -rf ${shqPath(remoteVaultPath(meta.id, "blobs"))} ${shqPath(remoteVaultPath(meta.id, "replica"))}`)
  return r.ok ? { ok: true, note: "" } : { ok: false, note: `could not delete: ${String(r.stderr ?? "").trim().slice(0, 120)}` }
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
      console.log(`\n  ${success("✓")} vault ${bold(p.meta?.name ?? p.vault_id)}  ${dim(`key wrapped by ${st.backend} on this machine`)}\n     ${dim("iris vault get reads chunks from this machine, a copy on a drive plugged in here, then your other machines")}\n`)
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
    .command(AutoCommand).command(HealCommand).command(SpareCommand).command(PolicyCommand)
    .command(NodeVaultCommands.lock).command(NodeVaultCommands.unlock).command(NodeVaultCommands.destroy)
    .command(KeyCommand)
    .option("json", { type: "boolean", default: false }),
  // `iris vault` / `iris vaults` with no subcommand lists them.
  async handler(argv) {
    return (ListCommand as any).handler(argv)
  },
})

export const VaultCommandExport = VaultCommand
