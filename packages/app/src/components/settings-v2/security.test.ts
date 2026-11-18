import { describe, expect, test } from "bun:test"
import { checkChips, eventTime, eventView, gateStatusView, keySourceLabel, modeView, platformTiles, rolloutSentence, statTiles, type SecurityState } from "./security"

const STATE: SecurityState = {
  measured: true,
  gate: {
    enabled: true,
    reason: "allowlisted",
    explanation: "Gate screens what reaches the model on your account and records what it finds.",
    mode: "shadow",
    org: "iris",
    sensitivity: "balanced",
    categories: ["prompt_injection", "credential"],
    segments: ["tool", "user"],
    failOpen: true,
    availableChecks: ["prompt_injection", "pii", "phi", "credential"],
    sensitivities: ["strict", "balanced", "permissive"],
    stats: {
      windowDays: 30,
      scanned: 1284,
      clean: 1267,
      flagged: 12,
      held: 5,
      errors: 0,
      reportedFalse: 1,
      reportedFalsePct: 0.1,
      p50LatencyMs: 480,
      billableTokens: 90000,
    },
    recent: [],
  },
  phiGuard: { active: false, mode: "report", explanation: "" },
}

describe("gateStatusView", () => {
  test("could-not-ask is Unknown, never Off", () => {
    expect(gateStatusView(undefined, false)).toMatchObject({ label: "Unknown", tone: "unknown" })
    expect(gateStatusView({ ...STATE, measured: false, reason: "iris-api 502" }, false).description).toContain("not the same as Gate being off")
  })

  test("shadow reads as watching, enforce as on", () => {
    expect(gateStatusView(STATE, false).label).toBe("On · watching")
    expect(gateStatusView({ ...STATE, gate: { ...STATE.gate, mode: "enforce" } }, false).label).toBe("On")
  })

  test("off for health data is a warning that carries the server's reason", () => {
    const s = { ...STATE, gate: { ...STATE.gate, enabled: false, reason: "phi_no_baa", explanation: "…health data…" } }
    expect(gateStatusView(s, false)).toMatchObject({ label: "Off", tone: "warn", description: "…health data…" })
  })
})

test("modeView says what enforce does to a turn", () => {
  expect(modeView("enforce").description).toContain("removed before the model reads it")
  expect(modeView("shadow").title).toBe("Watching only")
})

test("checkChips lists every check, marks the ones on, and says why health data is off", () => {
  const chips = checkChips(STATE.gate.availableChecks, STATE.gate.categories)
  expect(chips.map((c) => c.on)).toEqual([true, false, false, true])
  expect(chips.find((c) => c.name === "phi")?.note).toContain("BAA")
})

describe("statTiles", () => {
  test("flagged counts holds too, and the median is in seconds", () => {
    const t = statTiles(STATE.gate.stats)
    expect(t[0].value).toBe("1,284")
    expect(t[1]).toMatchObject({ value: "17", hint: "5 held before the model read them" })
    expect(t[3].value).toBe("0.48s")
  })

  test("an unmeasured rate is a dash, not 0%", () => {
    const t = statTiles({ ...STATE.gate.stats, scanned: 0, reportedFalsePct: null, p50LatencyMs: null })
    expect(t[2].value).toBe("—")
    expect(t[3].value).toBe("—")
  })
})

describe("eventView", () => {
  const base = {
    id: 1, at: null, segment: "tool", action: "flagged", mode: "shadow", verdict: "block", score: 0.98,
    reasonCode: "prompt_injection", detected: [], sensitivity: "balanced", latencyMs: 500, cached: false,
    errorCode: null, reportedFalse: false,
  }

  test("a flag can be reported once; a clean pass cannot", () => {
    expect(eventView(base)).toMatchObject({ label: "Flagged", source: "Tool result", reportable: true })
    expect(eventView({ ...base, reportedFalse: true }).reportable).toBe(false)
    expect(eventView({ ...base, action: "clean", reasonCode: null, score: 0.02 }).reportable).toBe(false)
  })

  test("a scan Gate could not run says the call went through", () => {
    const v = eventView({ ...base, action: "error", errorCode: "unreachable", score: null, reasonCode: null })
    expect(v.label).toBe("Not scanned")
    expect(v.detail).toContain("the call went through")
  })
})

test("eventTime shows a time today and a date otherwise", () => {
  const now = new Date("2026-10-15T20:00:00")
  expect(eventTime("2026-10-15T15:04:00", now)).toMatch(/3:04/)
  expect(eventTime("2026-10-02T15:04:00", now)).toBe("Oct 2")
  expect(eventTime(null, now)).toBe("")
})

describe("admin view", () => {
  test("the rollout reads as one sentence, and health data is always named", () => {
    expect(rolloutSentence({ enabled: true, mode: "shadow", percent: 5, newUserDays: 14, tiers: [], allowUsers: 1 })).toBe(
      "Watching only — new accounts for their first 14 days, 5% of everyone else, 1 named account. Anyone who works with health data is always left out.",
    )
    expect(rolloutSentence({ enabled: false, mode: "shadow", percent: 5, newUserDays: 14, tiers: [], allowUsers: 1 })).toContain("kill switch")
    expect(rolloutSentence(null)).toContain("screens no one")
  })

  test("the key source names the connector, or the problem with it", () => {
    expect(keySourceLabel("integration:140")).toBe("saved Gate connector #140")
    expect(keySourceLabel("integration:140:not_a_gate_connector")).toBe("connector problem (not_a_gate_connector)")
    expect(keySourceLabel("none")).toBe("no key")
  })

  test("platform tiles count holds as flags and say when Gate didn't answer", () => {
    const t = platformTiles({ scanned: 3, clean: 1, flagged: 1, held: 1, errors: 0, accounts: 2, cached: 1, p50Ms: 760, p95Ms: 900, billableTokens: 76, reportedFalsePct: null })
    expect(t[1]).toMatchObject({ value: "2", hint: "1 held" })
    expect(t[2]).toMatchObject({ value: "0.76s", hint: "p95 0.90s" })
    expect(t[3].hint).toBe("Gate answered every time")
  })
})
