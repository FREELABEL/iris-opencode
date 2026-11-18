import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  parseLostAfter, fmtDays, parseOnReturn, policyOf, addSpares, removeSpare, assertSpare, mergeHealed, planHeal, lastSeen,
  readAuto, writeAuto, autoBlocked, acquireLock, filesTouched, catchupText, ago, catchupLine, keyOrSkip,
  DEFAULT_LOST_AFTER_DAYS, unseenText, type Healed, type VaultPolicy,
} from "./vault-auto"
import { targetKey, buildIndex, replicaDir, heldBlobs, folderSource, writeBlob, readReplicaMeta, ensureReplica, REPLICA_FORMAT, type VaultTarget } from "./vault-drives"
import { syncDriveTargets, driveAlertRows, copyWord, replicaMetaFor, type DriveEnv } from "./vault-replicas"
import { buildEntry, nextManifest, generateVaultKey, reassemble } from "./vault-core"
import { ReplicatedKeyStore, type SecretStore } from "./replicated-vault-keys"

/**
 * #193363 follow-up — vault copies that look after themselves: catch-up on plug-in (the CLI half:
 * on/off, the lock, the status line, never a prompt) and self-healing (lost-after, spares only,
 * dry run, a copy that comes back). The daemon half (mount detection, debounce) is tested in
 * FREELABEL/iris-daemon tests/vault-auto.test.js.
 */

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "iris-va-test-")) })
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const A: VaultTarget = { kind: "drive", id: "fs:aaaa", label: "Backup A" }
const B: VaultTarget = { kind: "drive", id: "fs:bbbb", label: "Backup B" }
const S1: VaultTarget = { kind: "drive", id: "fs:5555", label: "Spare 1" }
const S2: VaultTarget = { kind: "machine", name: "studio-mac", id: "n7" }
const LAPTOP: VaultTarget = { kind: "machine", name: "laptop", self: true }
const COPIES = [LAPTOP, A, B]
const T0 = "2026-11-01T00:00:00Z"
const day = (n: number) => new Date(Date.parse(T0) + n * 86_400_000)
const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z")
const row = (t: VaultTarget, verified: Date | null, over: Record<string, any> = {}) => ({
  vault_id: "v-1", target: targetKey(t), status: "ok", manifest_seq: 1, ...(verified ? { last_verified_at: iso(verified) } : {}), ...over,
})
const pol = (over: Partial<VaultPolicy> = {}): VaultPolicy => ({ ...policyOf({}), spares: [S1, S2], ...over })
const ok = () => ({ ok: true as const })

describe("the policy and its defaults", () => {
  test("defaults: lost after 14 days, keep both on return, automatic on, no spares", () => {
    expect(policyOf({})).toEqual({ lost_after_days: 14, on_return: "keep", auto: true, spares: [] })
    expect(DEFAULT_LOST_AFTER_DAYS).toBe(14)
    expect(policyOf({ lost_after_days: 3, on_return: "retire", auto: false }).on_return).toBe("retire")
    expect(policyOf({ lost_after_days: -2 }).lost_after_days).toBe(14)
  })
  test("--lost-after: m, h, d, w, bare days; nonsense and extremes refused", () => {
    expect(parseLostAfter("14d")).toBe(14)
    expect(parseLostAfter("36h")).toBe(1.5)
    expect(parseLostAfter("2w")).toBe(14)
    expect(parseLostAfter("7")).toBe(7)
    expect(parseLostAfter("1h")).toBeCloseTo(1 / 24)
    expect(() => parseLostAfter("soon")).toThrow(/duration like 14d/)
    expect(parseLostAfter("2m")).toBeCloseTo(2 / 1440)
    expect(fmtDays(2 / 1440)).toBe("2m")
    expect(() => parseLostAfter("0d")).toThrow(/at least 1m/)
    expect(() => parseLostAfter("20000d")).toThrow(/at most/)
    expect(fmtDays(14)).toBe("2w")
    expect(fmtDays(1.5)).toBe("1.5d")
    expect(fmtDays(1 / 24)).toBe("1h")
    expect([unseenText(16 * 86_400_000), unseenText(3 * 3_600_000 + 5), unseenText(4 * 60_000), unseenText(-1)]).toEqual(["unseen 16 days", "unseen 3 h", "unseen 4 min", "never seen"])
  })
  test("--on-return: keep or retire only", () => {
    expect(parseOnReturn("Retire")).toBe("retire")
    expect(() => parseOnReturn("delete")).toThrow(/keep .* or retire/)
  })
})

describe("spares: named by the user, the only places a lost copy is rebuilt", () => {
  test("a spare cannot be a place that already holds a copy; duplicates collapse; order is kept", () => {
    expect(addSpares([], [S2, S1, S2], COPIES).map(targetKey)).toEqual(["machine:studio-mac", "drive:fs:5555"])
    expect(() => addSpares([], [A], COPIES)).toThrow(/already holds a copy/)
  })
  test("a spare holding a rebuilt copy cannot be removed until that copy is retired", () => {
    const healed: Healed[] = [{ spare: "drive:fs:5555", replaces: "drive:fs:bbbb", at: iso(day(20)) }]
    expect(() => removeSpare([S1, S2], "drive:fs:5555", healed)).toThrow(/holds a rebuilt copy/)
    expect(removeSpare([S1, S2], "machine:studio-mac", healed).map(targetKey)).toEqual(["drive:fs:5555"])
    expect(removeSpare([S1], "drive:fs:5555", [{ ...healed[0], retired_at: iso(day(30)) }])).toEqual([])
    expect(() => removeSpare([S1], "drive:fs:9999")).toThrow(/not a spare/)
  })
  test("assertSpare refuses any target that is not one of THIS vault's spares", () => {
    expect(assertSpare([S1, S2], "drive:fs:5555")).toEqual(S1)
    expect(() => assertSpare([S1, S2], "drive:fs:7777")).toThrow(/not a spare you named/)
    expect(() => assertSpare([S1, S2], "machine:someone-elses-box")).toThrow(/not a spare you named/)
    expect(() => assertSpare([], "drive:fs:5555")).toThrow(/refusing to rebuild/)
  })
})

describe("lost: unseen past the vault's lost-after", () => {
  const rows = [row(LAPTOP, day(19)), row(A, day(19)), row(B, day(4))]
  test("Backup B last verified 16 days ago: lost at the 14-day default, not at 21 days", () => {
    const p = planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol(), healed: [], rows, now: day(20), seq: 1, reach: ok })
    expect(p.lost).toEqual([{ key: "drive:fs:bbbb", days: 16, ms: 16 * 86_400_000 }])
    expect(planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol({ lost_after_days: 21 }), healed: [], rows, now: day(20), seq: 1, reach: ok }).lost).toEqual([])
  })
  test("--lost-after 1h (a test setting) makes a copy unseen for 2 hours lost", () => {
    const r = [row(LAPTOP, day(20)), row(A, day(20)), row(B, new Date(day(20).getTime() - 2 * 3_600_000))]
    const p = planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol({ lost_after_days: 1 / 24 }), healed: [], rows: r, now: day(20), seq: 1, reach: ok })
    expect(p.lost.map((l) => l.key)).toEqual(["drive:fs:bbbb"])
  })
  test("a copy never verified counts from the vault's creation; one verified in this run is never lost", () => {
    expect(lastSeen("drive:fs:bbbb", [], "v-1", T0)).toBe(Date.parse(T0))
    const p = planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol(), healed: [], rows: [row(LAPTOP, day(19)), row(A, day(19))], now: day(20), seq: 1, liveOk: new Set(["drive:fs:aaaa"]), reach: ok })
    expect(p.lost).toEqual([{ key: "drive:fs:bbbb", days: 20, ms: 20 * 86_400_000 }])
    const live = planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol(), healed: [], rows: [row(LAPTOP, day(19)), row(A, day(19))], now: day(20), seq: 1, liveOk: new Set(["drive:fs:bbbb"]), reach: ok })
    expect(live.lost).toEqual([])
  })
  test("rows of another vault never count", () => {
    expect(lastSeen("drive:fs:bbbb", [{ ...row(B, day(19)), vault_id: "other" }], "v-1", null)).toBeNaN()
  })
})

describe("heal plan: spares only, in order, alert when none can take it", () => {
  const rows = [row(LAPTOP, day(19)), row(A, day(19)), row(B, day(2))]
  const base = { vaultId: "v-1", createdAt: T0, copies: COPIES, healed: [] as Healed[], rows, now: day(20), seq: 1 }
  test("the first spare that is reachable with room takes it", () => {
    const p = planHeal({ ...base, policy: pol(), reach: (s) => (targetKey(s) === "drive:fs:5555" ? { ok: false, why: "not plugged into this machine" } : { ok: true }) })
    expect(p.rebuild).toEqual([{ replaces: "drive:fs:bbbb", spare: "machine:studio-mac" }])
    expect(p.alerts).toEqual([])
  })
  test("NEVER an unnamed place: every other machine/drive being reachable changes nothing", () => {
    // reach answers yes for anything; only S1/S2 are ever asked, and with no spares nothing is proposed.
    const asked: string[] = []
    const p = planHeal({ ...base, policy: pol({ spares: [] }), reach: (s) => { asked.push(targetKey(s)); return { ok: true } } })
    expect(p.rebuild).toEqual([])
    expect(asked).toEqual([])
    expect(p.alerts).toEqual([{ replaces: "drive:fs:bbbb", why: expect.stringMatching(/no spare named for this vault/) }])
    const p2 = planHeal({ ...base, policy: pol(), reach: (s) => { asked.push(targetKey(s)); return { ok: true } } })
    for (const r of p2.rebuild) expect(["drive:fs:5555", "machine:studio-mac"]).toContain(r.spare)
    expect(asked.every((k) => ["drive:fs:5555", "machine:studio-mac"].includes(k))).toBe(true)
  })
  test("no spare with room or reachable → alert only, with each spare's reason", () => {
    const p = planHeal({ ...base, policy: pol(), reach: (s) => ({ ok: false, why: targetKey(s) === "drive:fs:5555" ? "needs 2.0 GiB plus 40.0 MiB headroom, has 1.0 GiB free" : "not reachable now" }) })
    expect(p.rebuild).toEqual([])
    expect(p.alerts[0].why).toBe("no spare can take it now: Spare 1 needs 2.0 GiB plus 40.0 MiB headroom, has 1.0 GiB free; studio-mac not reachable now")
  })
  test("two copies lost, one spare: one rebuilt, the other alerted; a spare is never used twice", () => {
    const p = planHeal({ ...base, rows: [row(LAPTOP, day(19)), row(A, day(1)), row(B, day(1))], policy: pol({ spares: [S1] }), reach: ok })
    expect(p.rebuild).toEqual([{ replaces: "drive:fs:aaaa", spare: "drive:fs:5555" }])
    expect(p.alerts.map((a) => a.replaces)).toEqual(["drive:fs:bbbb"])
    expect(p.alerts[0].why).toMatch(/Spare 1 already holds a copy/)
  })
  test("a lost copy already stood in for by a healthy spare is not rebuilt again (idempotent heal)", () => {
    const healed: Healed[] = [{ spare: "drive:fs:5555", replaces: "drive:fs:bbbb", at: iso(day(17)) }]
    const p = planHeal({ ...base, healed, rows: [...rows, row(S1, day(19))], policy: pol(), reach: ok })
    expect(p.lost.map((l) => l.key)).toEqual(["drive:fs:bbbb"])
    expect(p.rebuild).toEqual([])
    expect(p.alerts).toEqual([])
  })
  test("dry run is the same plan: planning writes nothing, it only reads rows and asks reach()", () => {
    const frozen = JSON.stringify(rows)
    planHeal({ ...base, policy: pol(), reach: ok })
    expect(JSON.stringify(rows)).toBe(frozen)
  })
})

describe("a lost copy comes back", () => {
  const healed: Healed[] = [{ spare: "drive:fs:5555", replaces: "drive:fs:bbbb", at: iso(day(17)) }]
  const rowsBack = [row(LAPTOP, day(25)), row(A, day(25)), row(S1, day(25)), row(B, day(25), { manifest_seq: 3 })]
  test("keep (default): the return is noted, nothing is retired, and both copies count", () => {
    const p = planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol(), healed, rows: rowsBack, now: day(26), seq: 3, reach: ok })
    expect(p.returned).toEqual([{ key: "drive:fs:bbbb", spare: "drive:fs:5555" }])
    expect(p.retire).toEqual([])
    expect(p.lost).toEqual([])
  })
  test("retire: the spare is retired — only once the returned copy is verified complete at the CURRENT manifest", () => {
    const p = planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol({ on_return: "retire" }), healed, rows: rowsBack, now: day(26), seq: 3, reach: ok })
    expect(p.retire).toEqual([{ spare: "drive:fs:5555", replaces: "drive:fs:bbbb" }])
    const behind = rowsBack.map((r) => (r.target === "drive:fs:bbbb" ? { ...r, manifest_seq: 2 } : r))
    expect(planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol({ on_return: "retire" }), healed, rows: behind, now: day(26), seq: 3, reach: ok }).retire).toEqual([])
    const failing = rowsBack.map((r) => (r.target === "drive:fs:bbbb" ? { ...r, status: "failing" } : r))
    expect(planHeal({ vaultId: "v-1", createdAt: T0, copies: COPIES, policy: pol({ on_return: "retire" }), healed, rows: failing, now: day(26), seq: 3, reach: ok }).retire).toEqual([])
  })
  test("heals recorded on another machine are merged from the catalog; a retire sticks", () => {
    const rows = [{ vault_id: "v-1", target: "drive:fs:5555", role: "spare", replaces: "drive:fs:bbbb", healed_at: iso(day(17)) }]
    expect(mergeHealed([], rows, "v-1")).toEqual([{ spare: "drive:fs:5555", replaces: "drive:fs:bbbb", at: iso(day(17)), returned_at: null, retired_at: null }])
    const local: Healed[] = [{ spare: "drive:fs:5555", replaces: "drive:fs:bbbb", at: iso(day(17)), retired_at: iso(day(26)) }]
    expect(mergeHealed(local, rows, "v-1")[0].retired_at).toBe(iso(day(26)))
    // a newer heal of the same spare (used again after the retire) wins
    const again = [{ ...rows[0], healed_at: iso(day(40)), replaces: "drive:fs:aaaa" }]
    expect(mergeHealed(local, again, "v-1")[0]).toMatchObject({ replaces: "drive:fs:aaaa", retired_at: null })
    expect(mergeHealed([], [{ ...rows[0], vault_id: "other" }], "v-1")).toEqual([])
    // a retire recorded on another machine reaches this one through the catalog row
    const retiredRow = [{ ...rows[0], role: "spare-retired", retired_at: iso(day(26)) }]
    expect(mergeHealed([{ spare: "drive:fs:5555", replaces: "drive:fs:bbbb", at: iso(day(17)) }], retiredRow, "v-1")[0].retired_at).toBe(iso(day(26)))
  })
})

describe("rebuilding on a spare drive: encrypted chunks from a surviving copy, verified, no key", () => {
  test("Backup B lost; Spare 1 is filled from Backup A's copy — only ciphertext moves, and it still opens with the key", async () => {
    const key = generateVaultKey()
    const files: Record<string, Buffer> = { "song.wav": Buffer.alloc(5000, 7), "notes.txt": Buffer.from("lyrics") }
    const put: Record<string, any> = {}
    const blobs = new Map<string, Buffer>()
    for (const [p, b] of Object.entries(files)) {
      const { entry, blobs: bs } = buildEntry(key, b, { chunkSize: 1024 })
      put[p] = entry
      for (const x of bs) blobs.set(x.ref.id, x.bytes)
    }
    const man = nextManifest(null, { put }, { vault_id: "v-1", author_node: "laptop", created_at: T0 })
    const index = buildIndex(key, man)
    const mA = join(dir, "A"), mS = join(dir, "S1")
    mkdirSync(mS)
    const meta = { id: "v-1", name: "studio", created_at: T0, replicas: 3, targets: [A, B], source_node: "laptop", spares: [S1] }
    for (const [id, b] of blobs) writeBlob(replicaDir(mA, "studio"), id, b)
    ensureReplica(replicaDir(mA, "studio"), replicaMetaFor(meta))
    // The plan: B lost, S1 named → rebuild on S1. assertSpare is the gate in front of the write.
    const plan = planHeal({ vaultId: "v-1", createdAt: T0, copies: [LAPTOP, A, B], policy: policyOf(meta), healed: [], rows: [row(LAPTOP, day(19)), row(A, day(19)), row(B, day(2))], now: day(20), seq: 1, reach: ok })
    expect(plan.rebuild).toEqual([{ replaces: "drive:fs:bbbb", spare: "drive:fs:5555" }])
    const spare = assertSpare(meta.spares, plan.rebuild[0].spare)
    const env: DriveEnv = { resolveMount: (id) => (id === "fs:aaaa" ? mA : id === "fs:5555" ? mS : null), statfs: () => ({ free: 10 * 1024 ** 3, size: 100 * 1024 ** 3 }) }
    const [c] = await syncDriveTargets({ meta, index, sealed: null, targets: [spare], env, sources: [folderSource("Backup A", replicaDir(mA, "studio"))] })
    expect(c.status).toBe("ok")
    expect(c.written).toBe(blobs.size)
    // Nothing but ciphertext: no plaintext on the spare, and the chunks are exactly A's.
    expect([...heldBlobs(replicaDir(mS, "studio"))].sort()).toEqual([...blobs.keys()].sort())
    for (const id of heldBlobs(replicaDir(mS, "studio"))) expect(readFileSync(join(replicaDir(mS, "studio"), "blobs", id.slice(0, 2), id)).includes(Buffer.from("lyrics"))).toBe(false)
    expect(readReplicaMeta(replicaDir(mS, "studio"))?.spares?.map(targetKey)).toEqual(["drive:fs:5555"])
    // …and with the key (elsewhere), the spare alone restores the file.
    const got = new Map([...heldBlobs(replicaDir(mS, "studio"))].map((id) => [id, readFileSync(join(replicaDir(mS, "studio"), "blobs", id.slice(0, 2), id))]))
    expect(reassemble(key, man.entries["notes.txt"], got).toString()).toBe("lyrics")
  })
  test("a copy's settings on a drive are never rolled back by a machine holding older ones", () => {
    const d = join(dir, "X", "_IRIS_VAULT", "studio")
    const newer = { ...replicaMetaFor({ id: "v-1", name: "studio", created_at: T0, replicas: 3, targets: [A], spares: [S1] }), updated_at: iso(day(5)) }
    ensureReplica(d, newer as any)
    ensureReplica(d, { format: REPLICA_FORMAT, v: 1, id: "v-1", name: "studio", created_at: T0, replicas: 3, targets: [A] } as any)
    expect(readReplicaMeta(d)?.spares?.length).toBe(1)
  })
})

describe("the alerts land on the drive record and in the views", () => {
  test("a lost copy reads LOST; its heal alert and the last catch-up are on the drive's record", () => {
    const now = day(20)
    const reps: any[] = [
      { vault_id: "v-1", vault_name: "studio", target: "drive:fs:bbbb", drive_id: "fs:bbbb", status: "ok", last_verified_at: iso(day(2)), lost_after_days: 14, heal_alert: "lost (unseen 18 day(s)) — no spare can take it now: Spare 1 not plugged into this machine" },
      { vault_id: "v-1", vault_name: "studio", target: "drive:fs:aaaa", drive_id: "fs:aaaa", status: "ok", last_verified_at: iso(day(19)), last_catchup: "caught up 3 files (12 chunks)", last_catchup_at: iso(new Date(now.getTime() - 120_000)) },
    ]
    expect(copyWord(reps[0], now)).toBe("lost")
    expect(copyWord(reps[1], now)).toBe("ok")
    expect(copyWord({ ...reps[0], lost_after_days: 30 }, now)).toBe("missing")
    expect(copyWord({ status: "pending" }, now)).toBe("pending")
    const out = driveAlertRows([{ external_id: "fs:bbbb" }, { external_id: "fs:aaaa" }], [], reps, now)
    expect(out.find((r) => r.external_id === "fs:bbbb")).toMatchObject({ vault_replicas: "studio: lost (verified 2026-11-03)", vault_alert: expect.stringMatching(/^studio: lost \(unseen 18 day\(s\)\) — no spare/) })
    expect(out.find((r) => r.external_id === "fs:aaaa")).toMatchObject({ vault_catchup: "studio: caught up 3 files (12 chunks) · 2026-11-20 23:58 UTC" })
    expect(catchupLine(reps[1], now)).toBe("caught up 3 files, 2 min ago")
  })
})

describe("automatic catch-up: on/off, one at a time, the status line", () => {
  test("on by default; `iris vault auto off` on this machine, or --no-auto on the vault, blocks it with how to turn it on", () => {
    const f = join(dir, "vault-auto.json")
    expect(readAuto(f).enabled).toBe(true)
    writeAuto({ enabled: false }, f)
    expect(readAuto(f).enabled).toBe(false)
    expect(autoBlocked(readAuto(f), {})).toMatch(/off on this machine \(turn on: iris vault auto on\)/)
    expect(autoBlocked({ enabled: true }, { auto: false })).toMatch(/off for this vault/)
    expect(autoBlocked({ enabled: true }, {})).toBeNull()
    writeFileSync(f, "{broken")
    expect(readAuto(f).enabled).toBe(true)
  })
  test("one sync per vault: a second one is refused while the first holds the lock; released → free again", () => {
    const d = join(dir, "locks")
    const a = acquireLock("v-1", { dir: d, pid: 111, isAlive: () => true })
    expect(a.ok).toBe(true)
    const b = acquireLock("v-1", { dir: d, pid: 222, isAlive: () => true, what: "automatic catch-up" })
    expect(b).toMatchObject({ ok: false, holder: expect.stringMatching(/process 111/) })
    expect(acquireLock("v-2", { dir: d, pid: 222 }).ok).toBe(true) // another vault is independent
    if (a.ok) a.release()
    expect(acquireLock("v-1", { dir: d, pid: 222, isAlive: () => true }).ok).toBe(true)
  })
  test("a lock left by a dead process, or older than the stale limit, is taken over", () => {
    const d = join(dir, "locks")
    expect(acquireLock("v-1", { dir: d, pid: 111 }).ok).toBe(true)
    expect(acquireLock("v-1", { dir: d, pid: 222, isAlive: () => false }).ok).toBe(true)
    expect(acquireLock("v-3", { dir: d, pid: 333, now: 0 }).ok).toBe(true)
    expect(acquireLock("v-3", { dir: d, pid: 444, isAlive: () => true, now: 7 * 3_600_000 }).ok).toBe(true)
  })
  test("the status line counts files, not chunks, and says how long ago", () => {
    const index = { content: [{ cid: "c1", size: 1, chunks: ["a", "b"] }, { cid: "c2", size: 1, chunks: ["c"] }, { cid: "c3", size: 1, chunks: ["d"] }] }
    expect(filesTouched(index, ["a", "b", "c"])).toBe(2)
    expect(filesTouched(index, [])).toBe(0)
    expect(catchupText(2, 3)).toBe("caught up 2 files (3 chunks)")
    expect(catchupText(1, 1, ["laptop"])).toBe("caught up 1 file (1 chunk) from laptop")
    expect(catchupText(0, 0)).toBe("up to date")
    const now = new Date("2026-11-13T12:00:00Z")
    expect(ago("2026-11-13T11:58:00Z", now)).toBe("2 min ago")
    expect(ago("2026-11-13T11:59:40Z", now)).toBe("just now")
    expect(ago("2026-11-10T12:00:00Z", now)).toBe("3 days ago")
    expect(ago(null, now)).toBe("never")
  })
})

describe("never a prompt without a person: a step that needs the key is skipped with why", () => {
  const unavailable: SecretStore = { available: () => false, get: () => null, set: () => { throw new Error("no keystore") } }
  test("keys behind a passphrase + no way to ask → a plain skip at once, not a hang", async () => {
    const irisDir = join(dir, ".iris")
    const o = { irisDir, nodeKeyFile: join(dir, "none", "node.key"), keychain: unavailable, libsecret: unavailable, createNodeKey: () => false }
    await new ReplicatedKeyStore({ ...o, passphrase: async () => "long enough pass" }).saveKey("v-1", generateVaultKey())
    const t0 = Date.now()
    const r = await keyOrSkip(() => new ReplicatedKeyStore({ ...o }).getKey("v-1"), "the index is behind")
    expect(Date.now() - t0).toBeLessThan(2000)
    expect("skip" in r && r.skip).toMatch(/^the index is behind, and the key cannot be opened without a person here \(.*passphrase.*\) — skipped/)
  })
  test("no key on this machine → skipped, naming where to run it instead", async () => {
    const r = await keyOrSkip(async () => null, "the index is behind")
    expect("skip" in r && r.skip).toMatch(/no key for the vault — skipped/)
    const k = generateVaultKey()
    expect(await keyOrSkip(async () => k, "x")).toEqual({ key: k })
  })
})
