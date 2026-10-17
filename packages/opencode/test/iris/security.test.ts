import { describe, expect, test } from "bun:test"
import { EMPTY_SECURITY, securityFrom } from "../../src/iris/platform"

/**
 * #189589 — Settings › Security reads fl-iris-api's GET /api/v6/security. The body below is
 * the shape SecurityController returns (fl-iris-api wt/189589-gate-proxy-rollout). If either
 * side renames a field, this fails here rather than rendering a panel of zeros that reads as
 * "Gate is off".
 */
const BODY = {
  data: {
    gate: {
      enabled: true,
      reason: "allowlisted",
      mode: "shadow",
      org: "iris",
      sensitivity: "balanced",
      categories: ["prompt_injection", "credential"],
      segments: ["tool", "user"],
      fail_open: true,
      provider: "Constellation Gate",
      explanation: "Gate screens what reaches the model on your account and records what it finds.",
      available_checks: ["prompt_injection", "pii", "phi", "credential"],
      sensitivities: ["strict", "balanced", "permissive"],
      stats: {
        window_days: 30,
        scanned: 12,
        clean: 10,
        flagged: 2,
        held: 0,
        errors: 0,
        reported_false: 1,
        reported_false_pct: 8.3,
        p50_latency_ms: 480,
        billable_tokens: 900,
      },
      recent: [
        {
          id: 41,
          at: "2026-10-15T20:00:00+00:00",
          segment: "tool",
          action: "flagged",
          mode: "shadow",
          verdict: "block",
          score: 0.98,
          reason_code: "prompt_injection",
          detected: [],
          sensitivity: "balanced",
          latency_ms: 512,
          cached: false,
          error_code: null,
          reported_false: true,
        },
      ],
    },
    phi_guard: { active: false, mode: "report", explanation: "None of your workspaces is marked as holding health data." },
  },
}

describe("securityFrom", () => {
  test("maps every field the panel renders", () => {
    const s = securityFrom(BODY)
    expect(s.gate.enabled).toBe(true)
    expect(s.gate.reason).toBe("allowlisted")
    expect(s.gate.failOpen).toBe(true)
    expect(s.gate.availableChecks).toContain("pii")
    expect(s.gate.stats.p50LatencyMs).toBe(480)
    expect(s.gate.stats.reportedFalsePct).toBe(8.3)
    expect(s.gate.recent[0]).toMatchObject({ id: 41, reasonCode: "prompt_injection", latencyMs: 512, reportedFalse: true })
    expect(s.phiGuard.active).toBe(false)
  })

  test("an empty or broken body maps to the empty state, never to a guessed one", () => {
    expect(securityFrom({})).toEqual(EMPTY_SECURITY)
    expect(securityFrom(null)).toEqual(EMPTY_SECURITY)
  })

  test("an unmeasured rate stays null, not 0%", () => {
    const body = structuredClone(BODY)
    ;(body.data.gate.stats as any).reported_false_pct = null
    expect(securityFrom(body).gate.stats.reportedFalsePct).toBeNull()
  })
})
