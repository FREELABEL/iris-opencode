import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  canonicalize,
  contentHash,
  readManifest,
  writeManifest,
  readPolicy,
  writePolicy,
  isGranted,
  pinItem,
  unpinItem,
  previousHash,
  parseDuration,
  pinAgeMs,
  driftReport,
  blobPath,
  treeRelPath,
  slug,
} from "./platform-atlas-store"

/**
 * The local Atlas store (epic #184607).
 *
 * Every test here exists because the corresponding mistake would be INVISIBLE in
 * a demo: a hash that moves when nothing changed, a manifest that reads as empty
 * when it is damaged, a seal that opens when it cannot be parsed. Those all look
 * like a working system right up until someone asks "what did this machine know?"
 */

const ITEM = {
  title: "Denial risk rules",
  content_format: "markdown",
  content: "# Rules\n\nDeny when the payer has not responded in 30 days.\n",
  updated_at: "2026-09-01T10:00:00Z",
  context: { bloq: { name: "Pathways" }, list: { name: "Policies" } },
}

describe("identity — ADR-01, a bare id is not an address", () => {
  test("two pulls of an unchanged item produce the SAME hash", () => {
    expect(contentHash({ ...ITEM })).toBe(contentHash({ ...ITEM }))
  })

  /**
   * The load-bearing one. If updated_at were in the hash, a cosmetic re-save would
   * look identical to a content change, every fleet refresh would be a rollout of
   * nothing, and operators would learn to click through the diff.
   */
  test("a re-save that changes NOTHING but updated_at does not change identity", () => {
    const resaved = { ...ITEM, updated_at: "2026-09-11T23:00:00Z" }
    expect(contentHash(resaved)).toBe(contentHash(ITEM))
  })

  test("changing one character of the body changes identity", () => {
    const edited = { ...ITEM, content: ITEM.content.replace("30 days", "45 days") }
    expect(contentHash(edited)).not.toBe(contentHash(ITEM))
  })

  test("the title is part of identity — the same body under a new title is a different item state", () => {
    expect(contentHash({ ...ITEM, title: "Denial risk rules (v2)" })).not.toBe(contentHash(ITEM))
  })

  test("markdown and html with identical bytes are NOT the same thing", () => {
    // An agent follows one and must treat the other as data. Collapsing them
    // would let a format flip ship silently.
    expect(contentHash({ ...ITEM, content_format: "html" })).not.toBe(contentHash(ITEM))
  })

  test("object content hashes stably regardless of key order", () => {
    const a = { ...ITEM, content: { text: "hello", dataset: null } }
    const b = { ...ITEM, content: { dataset: null, text: "hello" } }
    expect(contentHash(a)).toBe(contentHash(b))
  })

  test("canonicalize never includes the pull timestamp or the source url", () => {
    expect(canonicalize(ITEM)).not.toContain("2026-09-01")
    expect(canonicalize(ITEM)).not.toContain("heyiris")
  })
})

describe("the store on disk", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "atlas-store-"))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const uuid = "11111111-2222-3333-4444-555555555555"

  test("pinning writes an immutable blob, a readable tree file, a manifest entry, and a log line", () => {
    const { pin, sha, previous } = pinItem(home, uuid, ITEM, "rendered A")
    expect(previous).toBeNull()
    expect(existsSync(blobPath(home, sha))).toBe(true)
    expect(existsSync(join(home, pin.path))).toBe(true)
    expect(pin.path).toBe(treeRelPath(ITEM, uuid))
    expect(readManifest(home).pins[uuid].sha256).toBe(sha)
  })

  test("re-pinning an unchanged item is a no-op change, not a new version", () => {
    const first = pinItem(home, uuid, ITEM, "rendered A")
    const second = pinItem(home, uuid, ITEM, "rendered A")
    expect(second.sha).toBe(first.sha)
    expect(second.previous).toBe(first.sha)
    expect(previousHash(home, uuid)).toBe(first.sha)
  })

  test("both versions survive an update — rollback is a pointer move, not a refetch", () => {
    const v1 = pinItem(home, uuid, ITEM, "rendered v1")
    const edited = { ...ITEM, content: ITEM.content.replace("30 days", "45 days") }
    const v2 = pinItem(home, uuid, edited, "rendered v2", { op: "update" })

    expect(v2.sha).not.toBe(v1.sha)
    expect(existsSync(blobPath(home, v1.sha))).toBe(true) // the OLD one is still there
    expect(existsSync(blobPath(home, v2.sha))).toBe(true)
    expect(previousHash(home, uuid)).toBe(v1.sha)
  })

  test("revoking drops the grant but does NOT delete history", () => {
    const { sha } = pinItem(home, uuid, ITEM, "rendered A")
    const revoked = unpinItem(home, uuid)
    expect(revoked?.uuid).toBe(uuid)
    expect(readManifest(home).pins[uuid]).toBeUndefined()
    expect(existsSync(blobPath(home, sha))).toBe(true)
  })

  /**
   * A manifest that failed to parse is NOT an empty manifest. Returning `{}` there
   * reports "nothing is granted" for a machine that holds everything — which is
   * the absent-vs-equal confusion this whole epic exists to refuse.
   */
  test("a DAMAGED manifest throws rather than reading as empty", () => {
    writeFileSync(join(home, "manifest.json"), "{not json", "utf8")
    expect(() => readManifest(home)).toThrow(/unreadable/i)
  })

  test("a missing manifest is genuinely empty — absence and damage are different", () => {
    expect(Object.keys(readManifest(home).pins)).toHaveLength(0)
  })
})

describe("the seal — deny by default", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "atlas-seal-"))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const granted = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
  const denied = "ffffffff-0000-1111-2222-333333333333"

  test("a machine granted {A} does not consider B granted", () => {
    pinItem(home, granted, ITEM, "rendered")
    expect(isGranted(home, granted)).toBe(true)
    expect(isGranted(home, denied)).toBe(false)
  })

  test("no policy file means NOT sealed — the seal is opt-in and says so", () => {
    expect(readPolicy(home).sealed).toBe(false)
  })

  /**
   * Fail closed. A seal that silently means "open" when its own file is corrupt is
   * a control that disappears exactly when something is wrong with the machine.
   */
  test("an UNREADABLE policy fails CLOSED", () => {
    writeFileSync(join(home, "policy.json"), "{{{", "utf8")
    expect(readPolicy(home).sealed).toBe(true)
  })

  test("sealing and unsealing round-trip", () => {
    writePolicy(home, { sealed: true, sealed_at: new Date().toISOString() })
    expect(readPolicy(home).sealed).toBe(true)
    writePolicy(home, { sealed: false })
    expect(readPolicy(home).sealed).toBe(false)
  })
})

describe("drift — two directions a single count would hide", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "atlas-drift-"))
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const uuid = "11111111-2222-3333-4444-555555555555"

  test("clean store reports no drift in either direction", () => {
    pinItem(home, uuid, ITEM, "rendered")
    const d = driftReport(home)
    expect(d.declaredMissing).toHaveLength(0)
    expect(d.undeclaredFiles).toHaveLength(0)
  })

  test("granted but NOT held is drift", () => {
    const { pin } = pinItem(home, uuid, ITEM, "rendered")
    rmSync(join(home, pin.path))
    expect(driftReport(home).declaredMissing.map((p) => p.uuid)).toEqual([uuid])
  })

  test("held but NOT granted is drift too — the leak direction", () => {
    pinItem(home, uuid, ITEM, "rendered")
    mkdirSync(join(home, "tree", "somewhere"), { recursive: true })
    writeFileSync(join(home, "tree", "somewhere", "smuggled.md"), "content C", "utf8")
    expect(driftReport(home).undeclaredFiles).toEqual([join("tree", "somewhere", "smuggled.md")])
  })
})

describe("the stale-gate — an instrument that can say no", () => {
  test("durations parse in the units an operator would actually type", () => {
    expect(parseDuration("7d")).toBe(7 * 86400e3)
    expect(parseDuration("36h")).toBe(36 * 3600e3)
    expect(parseDuration("90m")).toBe(90 * 60e3)
    expect(parseDuration("2w")).toBe(2 * 604800e3)
    expect(parseDuration("30")).toBe(30 * 86400e3) // bare number = days
  })

  test("an unparseable duration is null, never silently zero or infinity", () => {
    // Zero would fail every pin; infinity would pass every pin. Both are worse
    // than refusing to answer.
    expect(parseDuration("soon")).toBeNull()
    expect(parseDuration("")).toBeNull()
    expect(parseDuration(undefined)).toBeNull()
  })

  test("pin age is measured from when THIS machine pulled, not from the server's revised date", () => {
    const now = new Date("2026-09-11T00:00:00Z")
    const pin: any = {
      uuid: "x",
      title: "t",
      bloq: null,
      list: null,
      sha256: "abc",
      revised: "2026-01-01T00:00:00Z", // old on the server…
      pulled_at: "2026-09-10T00:00:00Z", // …but pulled yesterday
      path: "tree/x.md",
    }
    expect(pinAgeMs(pin, now)).toBe(86400e3)
  })

  test("an unparseable pulled_at is infinitely old, not brand new", () => {
    const pin: any = { pulled_at: "whenever", path: "x" }
    expect(pinAgeMs(pin, new Date())).toBe(Number.POSITIVE_INFINITY)
  })
})

describe("tree paths", () => {
  test("mirror the cloud structure, and stay unique when two items share a title", () => {
    const a = treeRelPath(ITEM, "11111111-2222-3333-4444-555555555555")
    const b = treeRelPath(ITEM, "99999999-2222-3333-4444-555555555555")
    expect(a).toContain(join("tree", "pathways", "policies"))
    expect(a).not.toBe(b)
  })

  test("an unfiled item still lands somewhere nameable", () => {
    expect(treeRelPath({ title: "loose" }, "11111111-2222-3333-4444-555555555555")).toContain(
      join("tree", "unfiled", "unlisted"),
    )
  })

  test("slug never returns empty — an empty path segment would collapse the tree", () => {
    expect(slug("", "fallback")).toBe("fallback")
    expect(slug("!!!", "fallback")).toBe("fallback")
  })
})
