import { describe, expect, test } from "bun:test"
import { allowanceDockState } from "./allowance-dock-state"

const now = new Date("2026-10-20T12:00:00Z")
const plan = (over: object = {}) => ({
  measured: true,
  fraction: 1.2,
  tokensUsed: 12_400_000,
  resetsAt: "2026-10-26T00:00:00Z",
  ...over,
})

describe("allowanceDockState — the bar above the composer (#190087)", () => {
  test("out of allowance: the dock says so, with tokens, and is the gold 'paused on you' state", () => {
    const s = allowanceDockState(plan(), now)!
    expect(s.tone).toBe("out")
    expect(s.title).toBe("Out of allowance · 12.4M tokens used this week")
    expect(s.percent).toBe(100)
    expect(s.resets).toStartWith("Resets ")
  })

  test("from 90%: a warning, not the out state", () => {
    const s = allowanceDockState(plan({ fraction: 0.93 }), now)!
    expect(s.tone).toBe("warning")
    expect(s.title).toBe("93% of this week's allowance used · 12.4M tokens")
  })

  test("below 90%, unmeasured or uncapped: no dock at all", () => {
    expect(allowanceDockState(plan({ fraction: 0.5 }), now)).toBeNull()
    expect(allowanceDockState(plan({ measured: false }), now)).toBeNull()
    expect(allowanceDockState(plan({ fraction: null }), now)).toBeNull()
    expect(allowanceDockState(undefined, now)).toBeNull()
  })

  test("no token count yet: the words alone, never a dollar figure", () => {
    expect(allowanceDockState(plan({ tokensUsed: null }), now)!.title).toBe("Out of allowance")
    expect(JSON.stringify(allowanceDockState(plan(), now))).not.toContain("$")
  })
})
