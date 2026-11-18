import { describe, expect, test } from "bun:test"
import { afterEach, mock } from "bun:test"
import { EMPTY_SECURITY, securityFrom, setGateChoice } from "../../src/iris/platform"

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
      choice: null,
      can_change: true,
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

describe("the person's own switch (#191083)", () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test("maps choice and can_change; anything else is no choice and locked", () => {
    expect(securityFrom(BODY).gate).toMatchObject({ choice: null, canChange: true })
    const on = structuredClone(BODY) as any
    on.data.gate.choice = "on"
    expect(securityFrom(on).gate.choice).toBe("on")
    on.data.gate.choice = "yes"
    delete on.data.gate.can_change
    expect(securityFrom(on).gate).toMatchObject({ choice: null, canChange: false })
  })

  test("PUT on/off, DELETE to follow the rollout — and the answer is the server's re-decided state", async () => {
    const calls: { method: string; body: unknown; url: string }[] = []
    globalThis.fetch = mock(async (url: string, init: RequestInit) => {
      calls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(String(init.body)) : null })
      const after = structuredClone(BODY) as any
      after.data.gate.choice = "off"
      after.data.gate.enabled = false
      after.data.gate.reason = "user_off"
      return new Response(JSON.stringify(after), { status: 200 })
    }) as any

    const r = await setGateChoice(false, { token: "t" })
    await setGateChoice(true, { token: "t" })
    await setGateChoice(null, { token: "t" })

    expect(calls.map((c) => [c.method, c.body])).toEqual([
      ["PUT", { enabled: false }],
      ["PUT", { enabled: true }],
      ["DELETE", null],
    ])
    expect(calls[0].url).toEndWith("/api/v6/security/gate")
    expect(r.measured).toBe(true)
    expect(r.data.gate).toMatchObject({ enabled: false, reason: "user_off", choice: "off" })
  })

  test("a refusal is unmeasured and carries the server's explanation, never a guessed state", async () => {
    globalThis.fetch = mock(
      async () =>
        new Response(JSON.stringify({ error: "locked", reason: "phi_no_baa", explanation: "Gate is off for your account because you work with health data." }), {
          status: 409,
        }),
    ) as any

    const r = await setGateChoice(true, { token: "t" })

    expect(r.measured).toBe(false)
    expect(r.reason).toContain("health data")
    expect(r.data).toEqual(EMPTY_SECURITY)
  })
})
