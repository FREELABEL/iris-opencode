/**
 * `iris org explain` verdict (#192421) — joining the cloud's gate report with this node's couples.
 */
import { describe, expect, test } from "bun:test"
import { kineticFor, verdict } from "./org-explain"
import { sealAgent, sealDefinition, type Couple } from "./kinetic-couple"

const NOW = "2026-11-05T12:00:00.000Z"
const AGENT = { id: 42, name: "Night Shift", model: "m", instructions: "be careful", config: { autonomy: "specialist", tools: ["http_request"] } }
const HASH = sealAgent(sealDefinition(AGENT))
const couple = (o: Partial<Couple> = {}): Couple => ({ id: "cpl_1", agent: HASH, node: "studio", body: "android:pixel", allowlist: ["run", "tap"], policy: {}, created_at: "2026-11-01T00:00:00.000Z", ...o })
const CLOUD_RED = { ok: false, failures: [{ code: "no_seat", detail: "no seat governs this agent" }], warnings: [{ code: "kinetic_unknown", detail: "node-local" }] }

describe("the hash is the one `iris kinetic seal --agent` makes", () => {
  test("ids and timestamps do not move it; config does (#192423)", () => {
    expect(sealAgent(sealDefinition({ ...AGENT, id: 99, updated_at: "x" }))).toBe(HASH)
    expect(sealAgent(sealDefinition({ ...AGENT, config: { ...AGENT.config, autonomy: "lead" } }))).not.toBe(HASH)
  })
})

describe("kineticFor asks decide(), the guard's own function", () => {
  test("an active couple's verbs are allowed, another node's and another agent's are not shown", () => {
    const k = kineticFor({ hash: HASH, node: "studio", couples: [couple(), couple({ id: "x", node: "other" }), couple({ id: "y", agent: "sha256:" + "0".repeat(64) })], acts: [], now: NOW })
    expect(k.couples.map((c) => c.couple_id)).toEqual(["cpl_1"])
    expect(k.couples[0].verbs).toEqual([
      expect.objectContaining({ verb: "run", decision: "allow" }),
      expect.objectContaining({ verb: "tap", decision: "allow" }),
    ])
  })

  test("an expired couple is shown as inactive, and its verbs as the guard decides them — refused", () => {
    const k = kineticFor({ hash: HASH, node: "studio", couples: [couple({ policy: { expires_at: "2026-11-01T00:00:00.000Z" } })], acts: [], now: NOW })
    expect(k.couples[0].active).toBe(false)
    expect(k.couples[0].verbs[0].decision).toBe("deny")
  })

  test("acts are counted for this agent, in the last 7 days only", () => {
    const acts = [
      { ts: "2026-11-04T00:00:00.000Z", agent: HASH, decision: "allow" },
      { ts: "2026-11-04T00:00:00.000Z", agent: HASH, decision: "deny" },
      { ts: "2026-10-01T00:00:00.000Z", agent: HASH, decision: "allow" },
      { ts: "2026-11-04T00:00:00.000Z", agent: "someone-else", decision: "allow" },
    ]
    expect(kineticFor({ hash: HASH, node: "studio", couples: [], acts, now: NOW }).acts_7d).toEqual({ allow: 1, deny: 1 })
  })
})

describe("the verdict", () => {
  test("today's red baseline stays red: no seat is a failure, whatever the node holds", () => {
    const v = verdict(CLOUD_RED, kineticFor({ hash: HASH, node: "studio", couples: [couple()], acts: [], now: NOW }))
    expect(v.ok).toBe(false)
    expect(v.failures.map((f) => f.code)).toEqual(["no_seat"])
  })

  test("the node replaces the cloud's 'kinetic unknown' — it is known here", () => {
    const v = verdict(CLOUD_RED, kineticFor({ hash: HASH, node: "studio", couples: [couple()], acts: [], now: NOW }))
    expect(v.warnings.map((w) => w.code)).not.toContain("kinetic_unknown")
    expect(verdict(CLOUD_RED, null).warnings.map((w) => w.code)).toContain("kinetic_unknown")
  })

  test("a clean cloud and a clean node pass", () => {
    expect(verdict({ ok: true, failures: [], warnings: [] }, kineticFor({ hash: HASH, node: "studio", couples: [couple()], acts: [], now: NOW })).ok).toBe(true)
  })

  test("a claim mismatch from the cloud is spelled out, not shown as a code", () => {
    const v = verdict({ ok: false, failures: [{ code: "claim_mismatch", effect: "egress", mode: "chat", claimed: "hold", actual: "run", tool: "http_request", source: null }], warnings: [] }, null)
    expect(v.failures[0].detail).toBe("egress in chat: the trust level says hold, the gate does run (http_request)")
  })
})
