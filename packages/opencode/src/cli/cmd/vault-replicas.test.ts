import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes } from "crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { syncDriveTargets, recordChecks, driveAlertRows, replicaRowId, type DriveEnv, type VaultCatalog, type TargetCheck } from "./vault-replicas"
import { buildIndex, sealManifest, openManifest, readSealed, heldBlobs, blobFile, folderSource, replicaDir, contentId, type VaultTarget } from "./vault-drives"
import { buildEntry, nextManifest, reassemble, generateVaultKey } from "./vault-core"
import { ReplicatedKeyStore, sealExport, openExport, type SecretStore } from "./replicated-vault-keys"

/**
 * #193363 — vault copies on drives, end to end without a network: placing onto a plugged-in drive,
 * a drive that is not plugged in (pending) catching up later on another machine, the key travelling
 * only wrapped, and the catalog rows (copies + alerts) that come out.
 */

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "iris-vr-test-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const A: VaultTarget = { kind: "drive", id: "fs:aaaa", label: "Backup A" }
const B: VaultTarget = { kind: "drive", id: "fs:bbbb", label: "Backup B" }
const SELF: VaultTarget = { kind: "machine", name: "laptop", self: true }
const META = { id: "v-1", name: "studio", created_at: "2026-11-13T00:00:00Z", replicas: 3, targets: [A, B, SELF], source_node: "laptop" }

/** Drives "plugged in" = present in this map. statfs: plenty of room unless set. */
function env(mounts: Record<string, string>, free = 10 * 1024 ** 3, size = 100 * 1024 ** 3): DriveEnv {
  return { resolveMount: (id) => mounts[id] ?? null, statfs: () => ({ free, size }) }
}

function memCatalog(drives: any[] = []): VaultCatalog & { tables: Record<string, Map<string, any>> } {
  const tables: Record<string, Map<string, any>> = { "drive-vaults": new Map(), "drive-kept": new Map(), drives: new Map(drives.map((d) => [d.external_id, d])), "drive-reads": new Map() }
  return {
    tables,
    drives: async () => [...tables.drives.values()],
    replicaRows: async () => [...tables["drive-vaults"].values()].map((data) => ({ data })),
    keptRows: async () => [...tables["drive-kept"].values()].map((data) => ({ data })),
    ensure: async () => {},
    upsert: async (schema, rows) => {
      let created = 0, updated = 0
      for (const r of rows) {
        const t = tables[schema]
        const cur = t.get(r.external_id)
        cur ? updated++ : created++
        t.set(r.external_id, { ...(cur ?? {}), ...r }) // Atlas import merges
      }
      return { created, updated, failed: 0 }
    },
  }
}

/** This machine's chunk store with one vault's files in it. */
function laptopVault(files: Record<string, Buffer>, key = generateVaultKey()) {
  const store = join(dir, "laptop", "vault", "v-1")
  const put: Record<string, any> = {}
  for (const [p, b] of Object.entries(files)) {
    const { entry, blobs } = buildEntry(key, b, { chunkSize: 1024 })
    put[p] = entry
    for (const x of blobs) { mkdirSync(join(store, "blobs", x.ref.id.slice(0, 2)), { recursive: true }); writeFileSync(blobFile(store, x.ref.id), x.bytes) }
  }
  const m = nextManifest(null, { put }, { vault_id: "v-1", author_node: "laptop", created_at: "2026-11-13T00:00:00Z" })
  return { key, m, store, index: buildIndex(key, m), sealed: sealManifest(key, m) }
}

describe("placement on drives", () => {
  test("plugged-in drive gets every chunk + index + sealed manifest; the unplugged one is pending", async () => {
    const v = laptopVault({ "Masters/song.wav": randomBytes(5000) })
    const mountA = join(dir, "mnt", "A")
    mkdirSync(mountA, { recursive: true })
    const checks = await syncDriveTargets({ meta: META, index: v.index, sealed: v.sealed, targets: META.targets, env: env({ "fs:aaaa": mountA }), sources: [folderSource("laptop", v.store)] })
    expect(checks.map((c) => [c.key, c.status])).toEqual([["drive:fs:aaaa", "ok"], ["drive:fs:bbbb", "pending"]])
    expect(checks[0].written).toBe(v.index.blobs.length)
    expect(checks[1].held).toBeNull()
    const d = replicaDir(mountA, "studio")
    expect(heldBlobs(d).size).toBe(v.index.blobs.length)
    expect(readSealed(d)!.seq).toBe(1)
  })
  test("free space is checked BEFORE anything is written", async () => {
    const v = laptopVault({ "big.bin": randomBytes(4000) })
    const mountA = join(dir, "mnt", "A")
    mkdirSync(mountA, { recursive: true })
    const checks = await syncDriveTargets({ meta: META, index: v.index, sealed: v.sealed, targets: [A], env: env({ "fs:aaaa": mountA }, 1024, 100 * 1024 ** 2), sources: [folderSource("laptop", v.store)] })
    expect(checks[0].status).toBe("no-room")
    expect(checks[0].note).toMatch(/headroom/)
    expect(existsSync(join(mountA, "_IRIS_VAULT"))).toBe(false)
  })
  test("a chunk corrupted on the drive is found and replaced from a good copy", async () => {
    const v = laptopVault({ "a.bin": randomBytes(3000) })
    const mountA = join(dir, "mnt", "A")
    mkdirSync(mountA, { recursive: true })
    const e = env({ "fs:aaaa": mountA })
    await syncDriveTargets({ meta: META, index: v.index, sealed: v.sealed, targets: [A], env: e, sources: [folderSource("laptop", v.store)] })
    const [id, len] = v.index.blobs[0]
    writeFileSync(blobFile(replicaDir(mountA, "studio"), id), randomBytes(len))
    const ro = await syncDriveTargets({ meta: META, index: v.index, sealed: null, targets: [A], env: e, sources: [], deep: true, readOnly: true })
    expect(ro[0].status).toBe("failing")
    const fixed = await syncDriveTargets({ meta: META, index: v.index, sealed: v.sealed, targets: [A], env: e, sources: [folderSource("laptop", v.store)], deep: true })
    expect(fixed[0]).toMatchObject({ status: "ok", written: 1 })
  })
})

describe("pending → catch-up on ANOTHER machine, and opening it there with the imported key", () => {
  test("Backup B, unplugged at put, is plugged into the studio machine: filled from Backup A, then readable with the imported key only", async () => {
    // laptop: put with A plugged in, B not
    const v = laptopVault({ "Masters/song.wav": randomBytes(6000), "notes.txt": Buffer.from("mix notes") })
    const mountA = join(dir, "mnt", "A")
    mkdirSync(mountA, { recursive: true })
    const put = await syncDriveTargets({ meta: META, index: v.index, sealed: v.sealed, targets: META.targets, env: env({ "fs:aaaa": mountA }), sources: [folderSource("laptop", v.store)] })
    expect(put.find((c) => c.key === "drive:fs:bbbb")!.status).toBe("pending")

    // studio machine: both drives plugged in there, no vault and no key. The catch-up copies
    // ciphertext only — it needs neither.
    const sA = join(dir, "studio-mnt", "A"), sB = join(dir, "studio-mnt", "B")
    rmSync(join(dir, "studio-mnt"), { recursive: true, force: true })
    mkdirSync(join(dir, "studio-mnt"), { recursive: true })
    // "unplug" A from the laptop and "plug" it into the studio machine
    require("fs").renameSync(mountA, sA)
    mkdirSync(sB, { recursive: true })
    const studio = env({ "fs:aaaa": sA, "fs:bbbb": sB })
    const repA = replicaDir(sA, "studio")
    const caught = await syncDriveTargets({ meta: META, index: v.index, sealed: readSealed(repA), targets: [B], env: studio, sources: [folderSource("Backup A", repA)] })
    expect(caught[0]).toMatchObject({ key: "drive:fs:bbbb", status: "ok", written: v.index.blobs.length })

    // The key travels only wrapped: exported under a passphrase on the laptop, wrapped again by the
    // studio machine's own key-wrapping key on import.
    const unavailable: SecretStore = { available: () => false, get: () => null, set: () => { throw new Error("none") } }
    const store = (name: string) => new ReplicatedKeyStore({
      irisDir: join(dir, name, ".iris"), nodeKeyFile: join(dir, name, "etc", "kek.key"), keychain: unavailable, libsecret: unavailable,
      forceBackend: "node-key",
      createNodeKey: (f, k) => { mkdirSync(join(f, ".."), { recursive: true }); writeFileSync(f, k.toString("base64") + "\n", { mode: 0o400 }); return true },
    })
    const laptopKeys = store("laptop")
    await laptopKeys.saveKey("v-1", v.key)
    const exported = sealExport({ vault_id: "v-1", key: (await laptopKeys.getKey("v-1"))!.toString("base64") }, "correct horse battery")
    expect(JSON.stringify(exported)).not.toContain(v.key.toString("base64"))
    const studioKeys = store("studio")
    expect(await studioKeys.getKey("v-1")).toBeNull()
    expect(() => openExport(exported, "wrong passphrase")).toThrow(/wrong passphrase/)
    await studioKeys.saveKey("v-1", Buffer.from(openExport(exported, "correct horse battery").key, "base64"))
    const wrapped = readFileSync(join(dir, "studio", ".iris", "vault-keys.wrapped.json"), "utf8")
    expect(wrapped.includes(v.key.toString("base64"))).toBe(false)

    // Read the file back from Backup B alone, with the key the studio machine unwraps.
    const key = (await studioKeys.getKey("v-1"))!
    const repB = replicaDir(sB, "studio")
    const man = openManifest(key, readSealed(repB)!)
    const blobs = new Map([...heldBlobs(repB)].map((id) => [id, readFileSync(blobFile(repB, id))]))
    expect(reassemble(key, man.entries["notes.txt"], blobs).toString()).toBe("mix notes")
    // …and NOT with another vault's key
    expect(() => openManifest(generateVaultKey(), readSealed(repB)!)).toThrow()
  })
})

describe("the catalog: rows per copy, kept files' holders and copies, drive alerts", () => {
  test("a check writes one row per target; pending never refreshes 'last verified'", async () => {
    const cat = memCatalog()
    const v = laptopVault({ "a.bin": randomBytes(10) })
    const held = new Set(v.index.blobs.map(([id]) => id))
    const at1 = new Date("2026-11-13T10:00:00Z")
    await recordChecks(cat, META, v.index, [
      { target: A, key: "drive:fs:aaaa", status: "ok", held, wanted: held.size, note: "" },
      { target: B, key: "drive:fs:bbbb", status: "ok", held, wanted: held.size, note: "" },
    ], "laptop", at1)
    await recordChecks(cat, META, v.index, [{ target: B, key: "drive:fs:bbbb", status: "pending", held: null, wanted: held.size, note: "not connected to this machine" }], "studio", new Date("2026-11-14T00:00:00Z"))
    const rowB = cat.tables["drive-vaults"].get(replicaRowId("v-1", "drive:fs:bbbb"))
    expect(rowB.last_verified_at).toBe("2026-11-13T10:00:00Z")
    expect(rowB.last_verified_on).toBe("laptop")
    expect(rowB).toMatchObject({ target_kind: "drive", drive_id: "fs:bbbb", vault_name: "studio", source_node: "laptop" })
  })

  test("kept files: holders recomputed by content id; a drive gone past the threshold drops the count and flags its source drive", async () => {
    const src = { external_id: "fs:src", label: "Studio" }
    const cat = memCatalog([src, { external_id: "fs:aaaa", label: "Backup A" }, { external_id: "fs:bbbb", label: "Backup B" }])
    const v = laptopVault({ "Studio/a.wav": Buffer.from("a"), "Studio/b.wav": Buffer.from("b") })
    const cidA = contentId(v.key, v.m.entries["Studio/a.wav"].plain_sha256)
    cat.tables["drive-kept"].set("k1", { external_id: "k1", drive_id: "fs:src", path: "a.wav", vault_id: "v-1", vault_name: "studio", content_id: cidA, target_copies: 3, held_by: "" })
    const all = new Set(v.index.blobs.map(([id]) => id))
    const full = (t: VaultTarget, key: string): TargetCheck => ({ target: t, key, status: "ok", held: all, wanted: all.size, note: "" })
    const t0 = new Date("2026-11-13T00:00:00Z")
    expect(await recordChecks(cat, META, v.index, [full(SELF, "machine:laptop"), full(A, "drive:fs:aaaa"), full(B, "drive:fs:bbbb")], "laptop", t0)).toEqual([])
    expect(cat.tables["drive-kept"].get("k1")).toMatchObject({ copies: 3, status: "safe", held_by: "drive:fs:aaaa\ndrive:fs:bbbb\nmachine:laptop" })
    expect(cat.tables.drives.get("fs:src")).toMatchObject({ kept_files: 1, kept_below_target: 0, copies_alert: "" })
    expect(cat.tables.drives.get("fs:aaaa").vault_replicas).toBe("studio: ok (verified 2026-11-13)")

    // 20 days on: laptop and A re-checked, B never plugged in again → B no longer counts.
    const t1 = new Date("2026-12-03T00:00:00Z")
    await recordChecks(cat, META, v.index, [full(SELF, "machine:laptop"), full(A, "drive:fs:aaaa"), { target: B, key: "drive:fs:bbbb", status: "pending", held: null, wanted: all.size, note: "" }], "laptop", t1)
    expect(cat.tables["drive-kept"].get("k1")).toMatchObject({ copies: 2, status: "below" })
    expect(cat.tables.drives.get("fs:src").copies_alert).toBe("1 of 1 kept file(s) below their minimum copies (vault studio) — run: iris vault status")
    // 20 days unseen is past both thresholds (missing 14d, lost-after 14d): the drive record says lost.
    expect(cat.tables.drives.get("fs:bbbb").vault_replicas).toBe("studio: lost (verified 2026-11-13)")

    // A replica that fails verification loses the content it can no longer prove.
    const t2 = new Date("2026-12-03T01:00:00Z")
    const chunkA = v.index.content.find((c) => c.cid === cidA)!.chunks[0]
    const broken = new Set([...all].filter((id) => id !== chunkA))
    await recordChecks(cat, META, v.index, [{ target: A, key: "drive:fs:aaaa", status: "failing", held: broken, wanted: all.size, note: "1 chunk failed" }], "laptop", t2)
    expect(cat.tables["drive-kept"].get("k1")).toMatchObject({ copies: 1, held_by: "drive:fs:bbbb\nmachine:laptop" })

    // B comes back and is verified: back above the minimum? laptop + B = 2 of 3 — still below.
    await recordChecks(cat, META, v.index, [full(B, "drive:fs:bbbb")], "studio", t2)
    expect(cat.tables["drive-kept"].get("k1")).toMatchObject({ copies: 2, status: "below" })
  })

  test("drive records are only rewritten when their alert changed", () => {
    const now = new Date("2026-11-13T00:00:00Z")
    const drives = [{ external_id: "fs:src", kept_files: 1, kept_below_target: 0, copies_alert: "", vault_replicas: "" }]
    const kept = [{ drive_id: "fs:src", path: "a", vault_id: "v-1", target_copies: 1, held_by: "machine:laptop" }]
    const rows = [{ vault_id: "v-1", target: "machine:laptop", status: "ok", last_verified_at: "2026-11-12T00:00:00Z" }]
    expect(driveAlertRows(drives, kept, rows, now)).toEqual([])
    expect(driveAlertRows(drives, kept, rows, new Date("2026-12-31T00:00:00Z"))[0]).toMatchObject({ external_id: "fs:src", kept_below_target: 1 })
  })
})

describe("free space on a Mac drive (Bun's statfs is wrong on macOS)", () => {
  test("df -kP is parsed, mount points with spaces included", () => {
    const { parseDfKP } = require("./vault-replicas")
    const out = "Filesystem 1024-blocks Used Available Capacity  Mounted on\n/dev/disk2      98304 2316     95988     3%    /Volumes/Backup B\n"
    expect(parseDfKP(out)).toEqual({ size: 98304 * 1024, free: 95988 * 1024 })
    expect(parseDfKP("garbage")).toBeNull()
  })
  test("a broken statfs (bsize 0) falls back to df; a sane one is used as is", async () => {
    const { statfsCompat } = await import("./platform-drives")
    const broken = { type: 0, bsize: 0, blocks: 4096, bfree: 2097152, bavail: 24576, files: 1, ffree: 1 } as any
    expect(statfsCompat("/x", () => broken, () => ({ free: 500, size: 1000 }))).toEqual({ bavail: 500, bsize: 1, blocks: 1000, bfree: 500 })
    const sane = { type: 0, bsize: 4096, blocks: 10, bfree: 5, bavail: 4, files: 1, ffree: 1 } as any
    expect(statfsCompat("/x", () => sane, () => null)).toEqual({ bavail: 4, bsize: 4096, blocks: 10, bfree: 5 })
  })
})
