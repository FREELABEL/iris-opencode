import { describe, expect, test } from "bun:test"
import {
  sealAgent,
  normalizeBody,
  bodyMatches,
  isActive,
  findCouples,
  verbAllowed,
  coupleId,
  bodyForDevice,
  decide,
  actRecord,
  type Couple,
} from "./kinetic-couple"

const HASH = "sha256:" + "a".repeat(64)
const OTHER = "sha256:" + "b".repeat(64)
const NODE = "hive-node-studio"
const NOW = "2026-09-19T12:00:00.000Z"

const couple = (over: Partial<Couple> = {}): Couple => ({
  id: "cpl_test",
  agent: HASH,
  node: NODE,
  body: "camera:obsbot-tiny",
  allowlist: ["move", "preset"],
  policy: {},
  created_at: "2026-09-19T11:00:00.000Z",
  ...over,
})

const act = (over: Partial<Parameters<typeof decide>[0]> = {}) =>
  decide({
    actor: { kind: "agent", hash: HASH },
    node: NODE,
    body: "camera:obsbot-tiny",
    verb: "move",
    couples: [couple()],
    now: NOW,
    ...over,
  })

describe("the couple record", () => {
  test("a body name is class:instance, normalised", () => {
    expect(normalizeBody(" Camera:OBSBOT-Tiny ")).toBe("camera:obsbot-tiny")
    expect(normalizeBody("camera")).toBeNull()
    expect(normalizeBody("")).toBeNull()
    expect(normalizeBody(null)).toBeNull()
    expect(normalizeBody("camera:obsbot tiny")).toBeNull()
  })

  test("a class wildcard covers the class, and nothing outside it", () => {
    expect(bodyMatches("camera:*", "camera:obsbot-tiny")).toBe(true)
    expect(bodyMatches("camera:*", "obs:studio")).toBe(false)
    expect(bodyMatches("camera:obsbot-tiny", "camera:logitech")).toBe(false)
    expect(bodyMatches("camera:obsbot-tiny", "camera:obsbot-tiny")).toBe(true)
  })

  test("a device name becomes a stable body name", () => {
    expect(bodyForDevice("camera", "OBSBOT Tiny 2 (USB)")).toBe("camera:obsbot-tiny-2-usb")
    // the same device, typed differently, must not become a different body — that would revoke a
    // couple by accident and look like a broken guard
    expect(bodyForDevice("Camera", "  obsbot tiny  ")).toBe(bodyForDevice("camera", "OBSBOT Tiny"))
    expect(bodyForDevice("camera", "")).toBeNull()
    expect(bodyForDevice("", "OBSBOT")).toBeNull()
    expect(bodyForDevice("camera", "!!!")).toBeNull()
  })

  test("revoked, expired, and unreadable-expiry couples are all inactive", () => {
    expect(isActive(couple(), NOW)).toBe(true)
    expect(isActive(couple({ revoked_at: "2026-09-19T11:30:00.000Z" }), NOW)).toBe(false)
    expect(isActive(couple({ policy: { expires_at: "2026-09-19T11:59:00.000Z" } }), NOW)).toBe(false)
    expect(isActive(couple({ policy: { expires_at: "2026-09-19T12:30:00.000Z" } }), NOW)).toBe(true)
    // a date nobody can parse is not permission
    expect(isActive(couple({ policy: { expires_at: "whenever" } }), NOW)).toBe(false)
  })

  test("the allowlist is the verb list, and `*` blesses everything", () => {
    expect(verbAllowed(couple(), "move")).toBe(true)
    expect(verbAllowed(couple(), "MOVE")).toBe(true)
    expect(verbAllowed(couple(), "record")).toBe(false)
    expect(verbAllowed(couple({ allowlist: ["*"] }), "record")).toBe(true)
    expect(verbAllowed(couple({ allowlist: [] }), "move")).toBe(false)
  })

  test("an exact-body couple is considered before a wildcard one", () => {
    const wild = couple({ id: "cpl_wild", body: "camera:*", allowlist: ["*"] })
    const exact = couple({ id: "cpl_exact" })
    expect(findCouples([wild, exact], { agent: HASH, node: NODE, body: "camera:obsbot-tiny", now: NOW })[0]!.id).toBe("cpl_exact")
  })

  test("sealing is stable across key order, and changes when the agent changes", () => {
    expect(sealAgent({ name: "patrol", model: "nano" })).toBe(sealAgent({ model: "nano", name: "patrol" }))
    expect(sealAgent({ name: "patrol", model: "nano" })).not.toBe(sealAgent({ name: "patrol", model: "mini" }))
    expect(sealAgent({ a: 1 })).toMatch(/^sha256:[0-9a-f]{64}$/)
  })

  test("ids are short and unique enough to name in a refusal", () => {
    const ids = new Set(Array.from({ length: 200 }, () => coupleId()))
    expect(ids.size).toBeGreaterThan(190)
    expect(coupleId(0, () => 0)).toMatch(/^cpl_/)
  })
})

describe("the guard — an agent act", () => {
  test("a coupled hash may move the body its couple names", () => {
    const d = act()
    expect(d.decision).toBe("allow")
    expect(d.couple_id).toBe("cpl_test")
  })

  test("NO COUPLE, NO MOVE — this is the whole point", () => {
    const d = act({ couples: [] })
    expect(d.decision).toBe("deny")
    expect(d.reason).toContain("no couple")
  })

  test("an unsealed caller has no identity, so it cannot be coupled", () => {
    expect(act({ actor: { kind: "agent", hash: "" } }).decision).toBe("deny")
    expect(act({ actor: { kind: "agent", hash: "sha256:nothex" } }).decision).toBe("deny")
    // The stored-side check already makes this unreachable-by-match; the caller-side check is what
    // makes the refusal SAY so instead of "no couple binds …", which would send someone to write
    // a couple for a caller that can never hold one.
    expect(act({ actor: { kind: "agent", hash: "" } }).reason).toContain("unsealed")
    // a hash that is merely the wrong one is refused too
    expect(act({ actor: { kind: "agent", hash: OTHER } }).decision).toBe("deny")
  })

  test("a malformed couple cannot rescue an unsealed caller", () => {
    // Both halves broken: a couples file carrying `agent: ""` and a caller with no hash. Without
    // the identity check on BOTH sides these two match each other and the body moves.
    const junk = couple({ id: "cpl_junk", agent: "" as unknown as string, allowlist: ["*"] })
    expect(act({ actor: { kind: "agent", hash: "" }, couples: [junk] }).decision).toBe("deny")
    expect(act({ actor: { kind: "agent", hash: "sha256:nothex" }, couples: [couple({ agent: "sha256:nothex" })] }).decision).toBe("deny")
    expect(findCouples([junk], { agent: "", node: NODE, body: "camera:obsbot-tiny", now: NOW })).toEqual([])
  })

  test("a couple does not travel to another node, and the refusal says so", () => {
    const d = act({ node: "hive-node-laptop" })
    expect(d.decision).toBe("deny")
    expect(d.reason).toContain("another node")
  })

  test("a verb the allowlist never blessed is refused, naming what IS blessed", () => {
    const d = act({ verb: "record" })
    expect(d.decision).toBe("deny")
    expect(d.reason).toContain("move")
  })

  test("a revoked couple stops working immediately", () => {
    expect(act({ couples: [couple({ revoked_at: NOW })] }).decision).toBe("deny")
    expect(act({ couples: [couple({ revoked_at: NOW })] }).reason).toContain("revoked or expired")
  })

  test("the budget is a ceiling on ONE act, and the boundary is allowed", () => {
    const capped = [couple({ policy: { max_single_expense_cents: 50 } })]
    expect(act({ couples: capped, estimatedCents: 51 }).decision).toBe("deny")
    expect(act({ couples: capped, estimatedCents: 50 }).decision).toBe("allow")
    // no estimate cannot silently pass a cap it never compared against… it passes, so the
    // caller MUST estimate; this test exists to make that contract explicit.
    expect(act({ couples: capped }).decision).toBe("allow")
  })

  test("hitl is answered as hitl — the guard never confirms for the human", () => {
    const d = act({ couples: [couple({ policy: { hitl: true } })] })
    expect(d.decision).toBe("hitl")
    expect(d.couple_id).toBe("cpl_test")
  })

  test("one couple refusing does not veto another that allows", () => {
    const narrow = couple({ id: "cpl_narrow", allowlist: ["preset"] })
    const wide = couple({ id: "cpl_wide", body: "camera:*", allowlist: ["move"] })
    const d = act({ couples: [narrow, wide], verb: "move" })
    expect(d.decision).toBe("allow")
    expect(d.couple_id).toBe("cpl_wide")
  })

  test("garbage in is refused, never allowed — the guard fails CLOSED", () => {
    expect(act({ body: "camera" }).decision).toBe("deny")
    expect(act({ body: "" }).decision).toBe("deny")
    expect(act({ verb: "" }).decision).toBe("deny")
    expect(act({ verb: "rm -rf /" }).decision).toBe("deny")
    expect(act({ node: "" }).decision).toBe("deny")
    expect(act({ couples: [null as unknown as Couple] }).decision).toBe("deny")
  })
})

describe("the guard — an operator is not an agent", () => {
  test("an operator at a terminal may act on an unlocked node, recorded as unbound", () => {
    const d = act({ actor: { kind: "operator", who: "alex" }, couples: [] })
    expect(d.decision).toBe("allow")
    expect(d.unbound).toBe(true)
  })

  test("a locked node requires a couple from everyone", () => {
    const d = act({ actor: { kind: "operator" }, couples: [], enforceOperators: true })
    expect(d.decision).toBe("deny")
  })

  test("an operator act is never booked as the agent's", () => {
    const r = actRecord({ actor: { kind: "operator" }, node: NODE, body: "camera:obsbot-tiny", verb: "move", couples: [], now: NOW }, act({ actor: { kind: "operator" }, couples: [] }))
    expect(r.agent).toBeNull()
    expect(r.unbound).toBe(true)
  })
})

describe("the record written back", () => {
  test("a refusal is recorded as fully as an allow", () => {
    const req = { actor: { kind: "agent" as const, hash: HASH }, node: NODE, body: "camera:obsbot-tiny", verb: "record", couples: [couple()], now: NOW }
    const r = actRecord(req, decide(req), "run_42")
    expect(r.decision).toBe("deny")
    expect(r.agent).toBe(HASH)
    expect(r.run_id).toBe("run_42")
    expect(r.verb).toBe("record")
    expect(r.ts).toBe(NOW)
  })
})
