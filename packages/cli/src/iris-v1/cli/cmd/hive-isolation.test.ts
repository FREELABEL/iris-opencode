import { describe, expect, test } from "bun:test"
import { describeIsolation } from "./hive-isolation"

describe("describeIsolation", () => {
  test("a node that CAN contain work says so quietly", () => {
    const l = describeIsolation({ available: true, detail: "docker 29.4.0" }, true)!
    expect(l.tone).toBe("muted")
    expect(l.detail).toBe("docker 29.4.0")
  })

  test("a node that CANNOT is warned about, with the reason", () => {
    // The case this whole change exists for. Measured on the live fleet: one node reporting
    // docker 29.4.0 and one reporting nothing, rendering identically.
    const l = describeIsolation(
      { available: false, reason: "container runtime installed but not running (start Docker/OrbStack)" },
      true,
    )!
    expect(l.tone).toBe("warn")
    expect(l.text).toContain("directly on this machine")
    expect(l.detail).toContain("not running")
  })

  test("a BROKEN probe is not the same as a missing runtime", () => {
    // `null` means we could not ask. Rendering that as "none" would send someone to install
    // Docker on a machine that already has it.
    const l = describeIsolation({ available: null, reason: "probe failed: timeout" }, true)!
    expect(l.tone).toBe("muted")
    expect(l.text).toContain("unknown")
    expect(l.text).not.toContain("none —")
  })

  test("an OLD daemon is not reported as unsandboxed", () => {
    const l = describeIsolation(undefined, true)!
    expect(l.tone).toBe("muted")
    expect(l.text).toContain("predates")
    expect(l.text).not.toContain("none —")
  })

  test("an offline node with no probe says nothing — its silence explains itself", () => {
    expect(describeIsolation(undefined, false)).toBeNull()
  })

  test("the states that DIFFER render differently, and none is empty", () => {
    // Four inputs, three renderings — and the collapse is deliberate. An explicit
    // `available: null` and a probe object with no `available` key both mean the same thing:
    // the probe is present and did not answer. Rendering those two apart would invent a
    // distinction the daemon does not make.
    //
    // What must NOT collapse is can / cannot / did-not-say. That is the whole point.
    const seen = new Set<string>()
    for (const p of [{ available: true }, { available: false }, { available: null }, {}]) {
      const l = describeIsolation(p as any, true)!
      expect(l.text.length).toBeGreaterThan(0)
      seen.add(l.text)
    }
    expect(seen.size).toBe(3)

    const can = describeIsolation({ available: true }, true)!
    const cannot = describeIsolation({ available: false }, true)!
    const dunno = describeIsolation({ available: null }, true)!
    expect(new Set([can.text, cannot.text, dunno.text]).size).toBe(3)
    expect(new Set([can.tone, cannot.tone]).size).toBe(2)
  })
})

type IsolationProbeLike = { available?: boolean | null; reason?: string | null; detail?: string | null }
