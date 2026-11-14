import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { randomBytes, createHash } from "crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  resolveOn, targetKey, planPlacement, marginFor, contentId, sealManifest, openManifest, buildIndex, parseIndex,
  replicaDir, ensureReplica, writeReplicaIndex, readReplicaIndex, readSealed, heldBlobs, writeBlob, fillReplica, folderSource,
  verifyReplica, blobFile, replicasOnMount, holdersOf, mergeHeldBy, effectiveCopies, keptAlerts, alertText, REPLICA_FORMAT,
  type ReplicaMeta,
} from "./vault-drives"
import { buildEntry, nextManifest, reassemble, generateVaultKey, type VaultManifest } from "./vault-core"
import { walk } from "./drives-core"

/** #193363 — vault copies on the user's own drives: targets, placement, the replica folder, copy counts. */

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "iris-vd-test-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")
const DRIVES = [
  { external_id: "fs:1111-aaaa", label: "Backup A" },
  { external_id: "fs:2222-bbbb", label: "Backup B" },
  { external_id: "dir:laptop:/Users/me/Projects", label: "Projects" },
]
const NODES = [{ id: "n1", name: "studio-mac" }, { id: "n2", name: "Backup B" }]

function vault(files: Record<string, Buffer>, key = generateVaultKey()) {
  const put: Record<string, any> = {}
  const blobs = new Map<string, Buffer>()
  for (const [p, b] of Object.entries(files)) {
    const { entry, blobs: bs } = buildEntry(key, b, { chunkSize: 1024 })
    put[p] = entry
    for (const x of bs) blobs.set(x.ref.id, x.bytes)
  }
  const m = nextManifest(null, { put }, { vault_id: "v-1", author_node: "laptop", created_at: "2026-11-13T00:00:00Z" })
  return { key, m, blobs }
}
const meta = (over: Partial<ReplicaMeta> = {}): ReplicaMeta => ({
  format: REPLICA_FORMAT, v: 1, id: "v-1", name: "studio", created_at: "2026-11-13T00:00:00Z", replicas: 3,
  targets: [{ kind: "drive", id: "fs:1111-aaaa", label: "Backup A" }], source_node: "laptop", ...over,
})

describe("--on: drives and machines by their exact names", () => {
  test("drive labels, drive ids, this machine and Hive machines resolve; order is kept", () => {
    const t = resolveOn("backup a, fs:2222-bbbb ,this-machine,studio-mac", { drives: DRIVES.slice(0, 1).concat(DRIVES[2]).concat({ external_id: "fs:2222-bbbb", label: "Spare" }), nodes: NODES, self: "laptop" })
    expect(t.map(targetKey)).toEqual(["drive:fs:1111-aaaa", "drive:fs:2222-bbbb", "machine:laptop", "machine:studio-mac"])
    expect(t[2]).toMatchObject({ kind: "machine", self: true })
  })
  test("the machine's own hostname means this machine", () => {
    expect(resolveOn("LAPTOP", { drives: DRIVES, nodes: NODES, self: "laptop" })[0]).toMatchObject({ kind: "machine", self: true })
  })
  test("unknown, fuzzy and duplicate names are refused — a copy never lands on a guessed drive", () => {
    const ctx = { drives: DRIVES, nodes: NODES, self: "laptop" }
    expect(() => resolveOn("Backup", ctx)).toThrow(/not a cataloged drive or machine/)
    expect(() => resolveOn("Backup A,backup a", ctx)).toThrow(/listed twice/)
    expect(() => resolveOn("", ctx)).toThrow(/at least one/)
  })
  test("a name that is a drive AND a machine must be disambiguated", () => {
    const ctx = { drives: DRIVES, nodes: NODES, self: "laptop" }
    expect(() => resolveOn("Backup B", ctx)).toThrow(/drive AND a machine/)
    expect(resolveOn("drive:Backup B", ctx)[0]).toMatchObject({ kind: "drive", id: "fs:2222-bbbb" })
    expect(resolveOn("machine:Backup B", ctx)[0]).toMatchObject({ kind: "machine", id: "n2" })
  })
})

describe("placement: free space first; unplugged is pending", () => {
  const A = { kind: "drive", id: "fs:1", label: "A" } as const
  test("a drive not plugged in is pending, never failed and never assumed", () => {
    const p = planPlacement([{ target: A, reachable: false, freeBytes: null, needBytes: 10 }])
    expect(p.pending).toEqual([{ key: "drive:fs:1", why: "not connected to this machine" }])
    expect(p.write).toEqual([])
  })
  test("unknown free space is not room", () => {
    expect(planPlacement([{ target: A, reachable: true, freeBytes: null, needBytes: 10 }]).noRoom[0].why).toMatch(/unknown/)
  })
  test("a drive keeps 2% headroom (16 MiB..1 GiB); a machine keeps 1 GiB", () => {
    expect(marginFor({ target: A, reachable: true, freeBytes: 0, sizeBytes: 64e9, needBytes: 0 })).toBe(1024 ** 3)
    expect(marginFor({ target: A, reachable: true, freeBytes: 0, sizeBytes: 100 * 1024 ** 2, needBytes: 0 })).toBe(16 * 1024 ** 2)
    expect(marginFor({ target: A, reachable: true, freeBytes: 0, sizeBytes: 10e9, needBytes: 0 })).toBe(200_000_000)
    expect(marginFor({ target: { kind: "machine", name: "m" }, reachable: true, freeBytes: 0, needBytes: 0 })).toBe(1024 ** 3)
  })
  test("no room → nothing written there, with the numbers", () => {
    const p = planPlacement([{ target: A, reachable: true, freeBytes: 20 * 1024 ** 2, sizeBytes: 100 * 1024 ** 2, needBytes: 5 * 1024 ** 2 }])
    expect(p.write).toEqual([])
    expect(p.noRoom[0].why).toMatch(/needs 5\.0 MiB plus 16\.0 MiB headroom, has 20\.0 MiB free/)
    const ok = planPlacement([{ target: A, reachable: true, freeBytes: 30 * 1024 ** 2, sizeBytes: 100 * 1024 ** 2, needBytes: 5 * 1024 ** 2 }])
    expect(ok.write).toEqual(["drive:fs:1"])
  })
  test("nothing new to write is fine even when full (the index is still refreshed)", () => {
    expect(planPlacement([{ target: A, reachable: true, freeBytes: 0, sizeBytes: 1e9, needBytes: 0 }]).write).toEqual(["drive:fs:1"])
  })
})

describe("content ids and the sealed manifest: countable without the key, readable only with it", () => {
  test("content id: same file + same vault → same id; another vault → another id; it is not the plaintext hash", () => {
    const k1 = generateVaultKey(), k2 = generateVaultKey()
    const h = sha(Buffer.from("master.wav"))
    expect(contentId(k1, h)).toBe(contentId(k1, h))
    expect(contentId(k1, h)).not.toBe(contentId(k2, h))
    expect(contentId(k1, h)).not.toBe(h)
  })
  test("the sealed manifest opens with the vault key only, and its seq cannot be swapped", () => {
    const { key, m } = vault({ "a.txt": Buffer.from("hello") })
    const s = sealManifest(key, m)
    expect(JSON.stringify(s)).not.toContain("a.txt")
    expect(openManifest(key, s)).toEqual(m)
    expect(() => openManifest(generateVaultKey(), s)).toThrow(/does not open/)
    expect(() => openManifest(key, { ...s, seq: s.seq + 1 })).toThrow(/does not open/)
  })
  test("the index names chunks and content ids — no file names, no plaintext hashes", () => {
    const { key, m } = vault({ "Masters/song.wav": randomBytes(3000), "copy.wav": Buffer.from("x"), "dupe.wav": Buffer.from("x") })
    const i = buildIndex(key, m)
    const text = JSON.stringify(i)
    expect(text).not.toContain("song.wav")
    for (const e of Object.values(m.entries)) expect(text).not.toContain(e.plain_sha256)
    expect(i.content.length).toBe(2) // the same content under two names is one content
    expect(i.blobs.length).toBe(new Set(Object.values(m.entries).flatMap((e) => e.chunks.map((c) => c.id))).size)
    expect(parseIndex(text)).toEqual(i)
    expect(parseIndex('{"format":"x"}')).toBeNull()
  })
})

describe("the replica folder on a drive", () => {
  test("layout: _IRIS_VAULT/<vault>/ with vault.json, index, sealed manifest, blobs/ab/<sha256>", async () => {
    const { key, m, blobs } = vault({ "a.bin": randomBytes(2500) })
    const store = join(dir, "store")
    for (const [id, b] of blobs) { mkdirSync(join(store, "blobs", id.slice(0, 2)), { recursive: true }); writeFileSync(blobFile(store, id), b) }
    const d = replicaDir(join(dir, "drive"), "studio")
    expect(d).toBe(join(dir, "drive", "_IRIS_VAULT", "studio"))
    ensureReplica(d, meta())
    const idx = buildIndex(key, m)
    const fill = await fillReplica(d, idx.blobs.map(([id]) => id), [folderSource("laptop", store)])
    writeReplicaIndex(d, idx, sealManifest(key, m))
    expect(fill.written.length).toBe(3)
    expect(readReplicaIndex(d)).toEqual(idx)
    expect(readSealed(d)!.seq).toBe(1)
    expect(heldBlobs(d)).toEqual(new Set(blobs.keys()))
    expect(replicasOnMount(join(dir, "drive")).map((r) => r.meta.id)).toEqual(["v-1"])
    // read back with the key alone: the drive is a complete copy
    const back = new Map([...heldBlobs(d)].map((id) => [id, readFileSync(blobFile(d, id))]))
    const man = openManifest(key, readSealed(d)!)
    expect(reassemble(key, man.entries["a.bin"], back).equals(reassemble(key, m.entries["a.bin"], blobs))).toBe(true)
  })
  test("no key on the drive: no 32-byte key in any form in any file", async () => {
    const { key, m, blobs } = vault({ "a.bin": randomBytes(500) })
    const d = replicaDir(join(dir, "drive"), "studio")
    ensureReplica(d, meta())
    for (const [id, b] of blobs) writeBlob(d, id, b)
    writeReplicaIndex(d, buildIndex(key, m), sealManifest(key, m))
    const all: string[] = []
    const walkAll = (p: string) => { for (const n of readdirSync(p, { withFileTypes: true })) n.isDirectory() ? walkAll(join(p, n.name)) : all.push(readFileSync(join(p, n.name)).toString("latin1")) }
    walkAll(d)
    for (const t of all) {
      expect(t.includes(key.toString("base64"))).toBe(false)
      expect(t.includes(key.toString("hex"))).toBe(false)
      expect(t.includes(key.toString("latin1"))).toBe(false)
    }
  })
  test("a different vault with the same name on the drive is refused, not mixed", () => {
    const d = replicaDir(join(dir, "drive"), "studio")
    ensureReplica(d, meta())
    expect(() => ensureReplica(d, meta({ id: "v-2" }))).toThrow(/different vault/)
  })
  test("an older writer never rolls a replica's index back", () => {
    const k = generateVaultKey()
    const d = join(dir, "r")
    mkdirSync(d)
    const m1 = vault({ a: Buffer.from("1") }, k).m
    const m2 = nextManifest(m1, { put: { b: buildEntry(k, Buffer.from("2")).entry } }, { vault_id: "v-1", author_node: "x", created_at: "t" })
    expect(writeReplicaIndex(d, buildIndex(k, m2), null)).toBe(true)
    expect(writeReplicaIndex(d, buildIndex(k, m1), null)).toBe(false)
    expect(readReplicaIndex(d)!.seq).toBe(2)
  })
  test("a chunk that does not hash to its name is never stored, from any source", async () => {
    const d = join(dir, "r")
    const good = randomBytes(100)
    const id = sha(good)
    expect(() => writeBlob(d, id, randomBytes(100))).toThrow(/does not match/)
    const bad = { name: "bad", read: () => randomBytes(100) }
    const fill = await fillReplica(d, [id], [bad, { name: "good", read: () => good }])
    expect(fill.written).toEqual([id])
    expect(fill.sources).toEqual(["good"])
    expect(fill.errors[0]).toMatch(/bad has a corrupt copy/)
  })
  test("verify: missing and corrupt chunks are not held; deep re-hashes, shallow checks name + length", () => {
    const d = join(dir, "r")
    const a = randomBytes(64), b = randomBytes(64), c = randomBytes(64)
    for (const x of [a, b]) writeBlob(d, sha(x), x)
    writeFileSync(blobFile(d, sha(b)), Buffer.from(randomBytes(64))) // same length, wrong bytes
    const idx = { blobs: [[sha(a), 64], [sha(b), 64], [sha(c), 64]] as Array<[string, number]> }
    const shallow = verifyReplica(d, idx, false)
    expect(shallow.held.size).toBe(2)
    expect(shallow.missing).toEqual([sha(c)])
    const deep = verifyReplica(d, idx, true)
    expect([...deep.held]).toEqual([sha(a)])
    expect(deep.corrupt).toEqual([sha(b)])
  })
  test("a drive scan never catalogs the vault folder", () => {
    const root = join(dir, "drive")
    mkdirSync(join(root, "_IRIS_VAULT", "studio", "blobs", "ab"), { recursive: true })
    writeFileSync(join(root, "_IRIS_VAULT", "studio", "blobs", "ab", "ab" + "0".repeat(62)), "x")
    writeFileSync(join(root, "song.wav"), "y")
    expect([...walk(root, { store: join(dir, "nostore") })].map((e) => e.rel)).toEqual(["song.wav"])
  })
})

describe("copies, counted by content, and the alert", () => {
  const now = new Date("2026-11-20T00:00:00Z")
  const rows = [
    { vault_id: "v-1", target: "drive:fs:A", status: "ok", last_verified_at: "2026-11-19T00:00:00Z" },
    { vault_id: "v-1", target: "drive:fs:B", status: "ok", last_verified_at: "2026-10-01T00:00:00Z" }, // not seen for 50 days
    { vault_id: "v-1", target: "machine:laptop", status: "ok", last_verified_at: "2026-11-20T00:00:00Z" },
    { vault_id: "v-1", target: "machine:studio", status: "failing", last_verified_at: "2026-11-20T00:00:00Z" },
  ]
  test("a holder must hold EVERY chunk — a partial copy restores nothing", () => {
    const h = new Map([["a", new Set(["1", "2"])], ["b", new Set(["1"])]])
    expect(holdersOf(["1", "2"], h)).toEqual(["a"])
  })
  test("a check replaces what it checked and keeps the rest", () => {
    expect(mergeHeldBy(["drive:fs:A", "drive:fs:B"], new Set(["drive:fs:A"]), [])).toEqual(["drive:fs:B"])
    expect(mergeHeldBy(["drive:fs:B"], new Set(["drive:fs:A"]), ["drive:fs:A"])).toEqual(["drive:fs:A", "drive:fs:B"])
  })
  test("a drive missing past the threshold does not count; never-verified does not count", () => {
    const e = effectiveCopies(["drive:fs:A", "drive:fs:B", "machine:laptop", "machine:nowhere"], rows, "v-1", now, 14)
    expect(e.copies).toBe(2)
    expect(e.stale).toEqual(["drive:fs:B", "machine:nowhere"])
    expect(effectiveCopies(["drive:fs:B"], rows, "v-1", now, 60).copies).toBe(1) // a longer threshold counts it
  })
  test("kept files below their minimum are flagged per source drive, with a sentence for its record", () => {
    const kept = [
      { drive_id: "fs:SRC", path: "a.wav", vault_id: "v-1", vault_name: "studio", target_copies: 3, held_by: "drive:fs:A\ndrive:fs:B\nmachine:laptop" },
      { drive_id: "fs:SRC", path: "b.wav", vault_id: "v-1", vault_name: "studio", target_copies: 2, held_by: "drive:fs:A\nmachine:laptop" },
      { drive_id: "fs:SRC", path: "gone.wav", vault_id: "v-1", target_copies: 3, held_by: "", status: "removed" },
    ]
    const a = keptAlerts(kept, rows, now, 14).get("fs:SRC")!
    expect(a.kept).toBe(2)
    expect(a.below).toEqual([{ path: "a.wav", vault: "studio", copies: 2, target: 3, stale: ["drive:fs:B"] }])
    expect(alertText(a)).toBe("1 of 2 kept file(s) below their minimum copies (vault studio) — run: iris vault status")
    expect(alertText({ kept: 2, below: [] })).toBe("")
  })
})
