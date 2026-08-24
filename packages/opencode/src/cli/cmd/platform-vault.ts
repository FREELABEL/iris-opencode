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
 *     key that lives only in ~/.iris/vault-keys.json (0600) on devices the operator owns.
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
import { requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { fetchNodes } from "./platform-hive-nodes"
import { resolveSshTarget, ensureSshUser, sshRun, pushFile, pullFile, shq, type SshTarget } from "./hive-tailscale"
import {
  buildEntry, reassemble, nextManifest, manifestDigest, normalizePath,
  choosePlacement, replicationHealth, generateVaultKey, sha256,
  type VaultManifest, type PlacementNode,
} from "./vault-core"
import { readFile, writeFile, mkdir, readdir } from "fs/promises"
import { existsSync, statSync } from "fs"
import { homedir } from "os"
import { join, dirname, basename } from "path"
import { randomUUID } from "crypto"

const VAULT_ROOT = join(homedir(), ".iris", "vault")
const KEYS_FILE = join(homedir(), ".iris", "vault-keys.json")

// ── local store ──────────────────────────────────────────────────────────────

const vaultDir = (id: string) => join(VAULT_ROOT, id)
const blobPath = (id: string, blobId: string) => join(vaultDir(id), "blobs", blobId.slice(0, 2), blobId)
/** Same layout on every node, so a remote path is derivable rather than negotiated. */
const remoteBlobPath = (id: string, blobId: string) => `~/.iris/vault/${id}/blobs/${blobId.slice(0, 2)}`

interface VaultMeta { id: string; name: string; created_at: string; replicas: number }

async function loadKeys(): Promise<Record<string, string>> {
  try { return JSON.parse(await readFile(KEYS_FILE, "utf-8")) } catch { return {} }
}

async function saveKey(vaultId: string, key: Buffer): Promise<void> {
  const keys = await loadKeys()
  keys[vaultId] = key.toString("base64")
  await mkdir(dirname(KEYS_FILE), { recursive: true })
  // 0600. The whole sovereignty claim reduces to this file staying on this machine.
  await writeFile(KEYS_FILE, JSON.stringify(keys, null, 2), { encoding: "utf-8", mode: 0o600 })
}

async function requireKey(vaultId: string): Promise<Buffer> {
  const k = (await loadKeys())[vaultId]
  if (!k) throw new Error(`no key for vault ${vaultId} on this machine. Keys never sync — copy ~/.iris/vault-keys.json to a device you own, by hand.`)
  return Buffer.from(k, "base64")
}

async function loadMeta(id: string): Promise<VaultMeta> {
  return JSON.parse(await readFile(join(vaultDir(id), "vault.json"), "utf-8"))
}

async function resolveVault(nameOrId: string): Promise<VaultMeta> {
  if (existsSync(join(vaultDir(nameOrId), "vault.json"))) return loadMeta(nameOrId)
  let ids: string[] = []
  try { ids = await readdir(VAULT_ROOT) } catch { /* none yet */ }
  for (const id of ids) {
    try {
      const m = await loadMeta(id)
      if (m.name === nameOrId) return m
    } catch { /* skip malformed */ }
  }
  throw new Error(`no vault named "${nameOrId}". Run: iris vault list`)
}

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
  const r = await sshRun(t, `ls ~/.iris/vault/${shq(vaultId).slice(1, -1)}/blobs/*/ 2>/dev/null | grep -E '^[0-9a-f]{64}$' || true`)
  return new Set(String(r.stdout).split("\n").map((s) => s.trim()).filter((s) => /^[0-9a-f]{64}$/.test(s)))
}

// ── commands ─────────────────────────────────────────────────────────────────

const CreateCommand = cmd({
  command: "create <name>",
  describe: "create a vault (generates a key that never leaves this machine)",
  builder: (y) => y
    .positional("name", { describe: "vault name", type: "string", demandOption: true })
    .option("replicas", { describe: "target replica count per file", type: "number", default: 2 })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const id = randomUUID()
    const meta: VaultMeta = { id, name: String(argv.name), created_at: new Date().toISOString(), replicas: Number(argv.replicas) || 2 }
    await mkdir(join(vaultDir(id), "blobs"), { recursive: true })
    await writeFile(join(vaultDir(id), "vault.json"), JSON.stringify(meta, null, 2), "utf-8")
    await saveKey(id, generateVaultKey())

    if (argv.json) { await writeJson({ ok: true, vault: meta }); return }
    console.log()
    console.log(`  ${success("✓")} vault ${bold(meta.name)}  ${dim(id)}`)
    console.log(`     ${dim(`target replicas: ${meta.replicas}`)}`)
    console.log(`     ${dim("key written to ~/.iris/vault-keys.json (0600) — it NEVER syncs.")}`)
    console.log(`     ${dim("Back it up by hand to a device you own. Lose it and the data is unreadable, by design.")}`)
    console.log()
  },
})

const ListCommand = cmd({
  command: "list",
  describe: "list vaults on this machine",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(argv) {
    let ids: string[] = []
    try { ids = await readdir(VAULT_ROOT) } catch { /* none */ }
    const keys = await loadKeys()
    const out: any[] = []
    for (const id of ids) {
      try {
        const m = await loadMeta(id)
        const man = await latestManifest(id)
        out.push({ ...m, files: man ? Object.keys(man.entries).length : 0, seq: man?.seq ?? 0, has_key: !!keys[id] })
      } catch { /* skip */ }
    }
    if (argv.json) { await writeJson({ ok: true, vaults: out }); return }
    console.log()
    if (out.length === 0) console.log(`  ${dim("No vaults. Create one: iris vault create <name>")}`)
    for (const v of out) {
      console.log(`  ${bold(v.name)}  ${dim(v.id)}`)
      console.log(`     ${dim(`${v.files} file(s) · manifest seq ${v.seq} · target ${v.replicas} replicas`)}${v.has_key ? "" : bold("  · NO KEY ON THIS MACHINE")}`)
    }
    console.log()
  },
})

const PutCommand = cmd({
  command: "put <vault> <path..>",
  describe: "add file(s): chunk, encrypt locally, replicate to your own nodes, verify",
  builder: (y) => y
    .positional("vault", { describe: "vault name or id", type: "string", demandOption: true })
    .positional("path", { describe: "local file(s)", type: "string", demandOption: true })
    .option("as", { describe: "path inside the vault (single file only)", type: "string" })
    .option("replicas", { describe: "override target replica count", type: "number" })
    .option("user", { describe: "ssh user on nodes", type: "string" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const meta = await resolveVault(String(argv.vault))
    const key = await requireKey(meta.id)
    const replicas = Number(argv.replicas ?? meta.replicas)
    const paths = ([] as string[]).concat(argv.path as any)

    // Capacity + liveness, measured now rather than assumed from the registry.
    const nodes = (await fetchNodes(userId)) as any[]
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

    if (argv.json) {
      await writeJson({ ok: results.every((r) => r.ok), results })
      if (!results.every((r) => r.ok)) process.exit(1)
      return
    }

    console.log()
    for (const r of results) {
      if (!r.ok) { console.log(`  ${dim("✗")} ${r.path}\n     ${r.error}`); continue }
      console.log(`  ${success("✓")} ${bold(r.vault_path)}  ${dim(`${r.size} bytes · ${r.chunks} chunk(s)`)}`)
      console.log(`     ${dim("sha256 " + r.plain_sha256)}`)
      const held = ["this machine", ...r.replicated_to]
      console.log(`     ${dim(`${r.copies}/${r.target_copies} copies · held by: ` + held.join(", "))}`)
      if (r.shortfall > 0) console.log(`     ${bold("UNDER-REPLICATED")} ${dim(r.placement)}`)
      if (r.failed_to.length) console.log(`     ${bold("push failed")} ${dim(r.failed_to.join(", "))}`)
    }
    console.log()
    if (results.some((r) => !r.ok)) process.exit(1)
  },
})

const GetCommand = cmd({
  command: "get <vault> <path>",
  describe: "retrieve a file, fetching missing chunks from your nodes and verifying end to end",
  builder: (y) => y
    .positional("vault", { type: "string", demandOption: true })
    .positional("path", { describe: "path inside the vault", type: "string", demandOption: true })
    .option("out", { describe: "output directory", type: "string", default: "." })
    .option("user", { type: "string" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const meta = await resolveVault(String(argv.vault))
    const key = await requireKey(meta.id)
    const man = await latestManifest(meta.id)
    const vpath = normalizePath(String(argv.path))
    const entry = man?.entries?.[vpath]
    if (!entry) { console.error(`\n  "${vpath}" is not in vault ${meta.name}. Run: iris vault ls ${meta.name}\n`); process.exit(1) }

    const blobs = new Map<string, Buffer>()
    const fetchedFrom: string[] = []
    const missing: string[] = []

    for (const c of entry.chunks) {
      const local = blobPath(meta.id, c.id)
      if (existsSync(local)) { blobs.set(c.id, await readFile(local)); continue }
      missing.push(c.id)
    }

    // Only reach for the mesh if something is genuinely absent locally.
    if (missing.length > 0) {
      const nodes = (await fetchNodes(userId)) as any[]
      for (const n of nodes) {
        if (missing.length === 0) break
        const t = await targetFor(n, argv)
        if (!t) continue
        const have = await remoteBlobIds(t, meta.id)
        for (const id of [...missing]) {
          if (!have.has(id)) continue
          const dest = blobPath(meta.id, id)
          await mkdir(dirname(dest), { recursive: true })
          const r = await pullFile(t, `~/.iris/vault/${meta.id}/blobs/${id.slice(0, 2)}/${id}`, dirname(dest))
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
      if (argv.json) await writeJson({ ok: false, path: vpath, error: String(e?.message ?? e) })
      else console.error(`\n  ${bold("CANNOT RESTORE")} ${vpath}\n  ${String(e?.message ?? e)}\n`)
      process.exit(1)
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
  },
})

const LsCommand = cmd({
  command: "ls <vault>",
  describe: "list files in a vault",
  builder: (y) => y.positional("vault", { type: "string", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(argv) {
    const meta = await resolveVault(String(argv.vault))
    const man = await latestManifest(meta.id)
    const entries = Object.entries(man?.entries ?? {})
    if (argv.json) { await writeJson({ ok: true, vault: meta.name, seq: man?.seq ?? 0, files: entries.map(([p, e]) => ({ path: p, ...e })) }); return }
    console.log()
    if (entries.length === 0) console.log(`  ${dim("empty vault (manifest read successfully — this is a real empty)")}`)
    for (const [p, e] of entries) console.log(`  ${bold(p)}  ${dim(`${e.size} bytes · ${e.chunks.length} chunk(s) · ${e.plain_sha256.slice(0, 12)}…`)}`)
    console.log()
    if (entries.length) console.log(`  ${entries.length} file(s) · manifest seq ${man?.seq}\n`)
  },
})

const StatusCommand = cmd({
  command: "status <vault>",
  describe: "replication health — ASKS each node what it holds, never a local ledger",
  builder: (y) => y
    .positional("vault", { type: "string", demandOption: true })
    .option("user", { type: "string" })
    .option("user-id", { type: "number" })
    .option("json", { type: "boolean", default: false }),
  async handler(argv) {
    await requireAuth()
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) process.exit(1)

    const meta = await resolveVault(String(argv.vault))
    const man = await latestManifest(meta.id)
    if (!man) { console.log(`\n  ${dim("vault is empty — nothing to replicate")}\n`); return }

    // Local blobs count as a replica held by this machine.
    const pins: Record<string, string[]> = {}
    for (const e of Object.values(man.entries)) {
      for (const c of e.chunks) if (existsSync(blobPath(meta.id, c.id))) (pins[c.id] ??= []).push("this machine")
    }

    const nodes = (await fetchNodes(userId)) as any[]
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
  },
})

const VaultCommand = cmd({
  command: "vault",
  describe: "sovereign device-owned storage — encrypted, replicated across YOUR nodes, no third party",
  builder: (y) => y
    .command(CreateCommand).command(ListCommand).command(PutCommand)
    .command(GetCommand).command(LsCommand).command(StatusCommand)
    .demandCommand(1, "Specify: create, list, put, get, ls, status"),
  async handler() {},
})

export const VaultCommandExport = VaultCommand
