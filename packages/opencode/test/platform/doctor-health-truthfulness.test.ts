/**
 * Regression tests: `iris doctor` must not lie about health (#178281, #178282, #178279)
 *
 * From a real client onboarding (Vanguard, user 5365) that produced 12 bug
 * reports. Three of them turned out to be the doctor misreporting rather than
 * anything actually broken:
 *
 *  - #178281 — every healthy AI provider reported as broken. The deep health
 *    probe UPGRADES status "key_valid" -> "billing_active" when the billing
 *    probe succeeds (fl-iris-api routes/api.php sets it on
 *    $probeRes->successful()). The doctor's allowlist was
 *    `status === "key_valid" || status === "ok"`, so a fully working key could
 *    never report OK — and the hint said "check API key", which was actively
 *    misleading.
 *
 *  - #178282 — Gmail reported "connected + verified" while the exec endpoints
 *    returned "Gmail integration is not connected for this user" (HTTP 500).
 *    The check treated ANY response other than 401/403 as success, conflating
 *    "endpoint reachable" with "integration connected".
 *
 *  - #178279 — "fl-api (raichu) -> The operation timed out" was reported as a
 *    client firewall problem. The endpoint actually takes 7-9s; the probe
 *    timeout was 5s. Reproduced from a second machine.
 */
import { describe, test, expect } from "bun:test"
import { aiProviderHealth, PLATFORM_PROBE_TIMEOUT_MS } from "../../src/cli/cmd/platform-doctor"
import { gmailHealthFromStatus } from "../../src/cli/cmd/platform-leads"

// ============================================================================
// #178281 — AI provider status truthfulness
// ============================================================================

describe("AI provider health (#178281)", () => {
  test("billing_active is HEALTHY — it means the billing probe succeeded", () => {
    // This is the exact regression. billing_active is the *best* state the
    // deep probe can report, and it was being rendered as a failure.
    expect(aiProviderHealth("billing_active").ok).toBe(true)
  })

  test("key_valid and ok remain healthy", () => {
    expect(aiProviderHealth("key_valid").ok).toBe(true)
    expect(aiProviderHealth("ok").ok).toBe(true)
  })

  test("genuinely broken statuses are still reported as broken", () => {
    for (const bad of [
      "invalid_key",
      "quota_exceeded",
      "payment_required",
      "billing_blocked",
      "http_400",
      "http_401",
      "unknown",
    ]) {
      expect(aiProviderHealth(bad).ok).toBe(false)
    }
  })

  test("a healthy provider gets no hint at all", () => {
    expect(aiProviderHealth("billing_active").hint).toBeUndefined()
    expect(aiProviderHealth("key_valid").hint).toBeUndefined()
  })

  test("hints are specific — billing problems must not say 'check API key'", () => {
    // The old code emitted "check API key" for every non-key_valid status,
    // which sent you down the wrong path for billing/quota failures.
    expect(aiProviderHealth("quota_exceeded").hint).toBeDefined()
    expect(aiProviderHealth("quota_exceeded").hint).not.toContain("check API key")
    expect(aiProviderHealth("payment_required").hint).not.toContain("check API key")

    // ...but a real key problem should still say so.
    expect(aiProviderHealth("http_401").hint).toContain("key")
  })
})

// ============================================================================
// #178282 — Gmail connection state truthfulness
// ============================================================================

describe("Gmail health check (#178282)", () => {
  test("a 500 'not connected' must NOT report verified", () => {
    // The exact reported contradiction: doctor said "connected + verified"
    // while exec said "Gmail integration is not connected for this user".
    const result = gmailHealthFromStatus(500)
    expect(result.ok).toBe(false)
    expect(result.status).not.toBe("verified")
  })

  test("2xx reports verified", () => {
    expect(gmailHealthFromStatus(200).ok).toBe(true)
    expect(gmailHealthFromStatus(200).status).toBe("verified")
  })

  test("401/403 reports an expired token with a reconnect hint", () => {
    for (const code of [401, 403]) {
      const result = gmailHealthFromStatus(code)
      expect(result.ok).toBe(false)
      expect(result.status).toBe("expired")
      expect(result.hint).toContain("connect")
    }
  })

  test("404 is indeterminate, not proof of a working integration", () => {
    // The probe hits lead 0, which never exists — so a 404 says nothing about
    // whether Gmail is connected. Claiming "verified" here was the bug.
    const result = gmailHealthFromStatus(404)
    expect(result.status).not.toBe("verified")
  })

  test("no status is silently treated as success", () => {
    // Guard against the old `return ok: true` catch-all reappearing.
    for (const code of [500, 502, 503, 400, 404, 418]) {
      expect(gmailHealthFromStatus(code).ok).toBe(false)
    }
  })
})

// ============================================================================
// #178279 — probe timeout must exceed real platform latency
// ============================================================================

describe("platform probe timeout (#178279)", () => {
  test("timeout comfortably exceeds observed 7-9s raichu latency", () => {
    // Measured: 7.19s / 9.05s / 8.68s against raichu.heyiris.io/api/health.
    // A 5s timeout produced a false "operation timed out" that was
    // misdiagnosed as the client's firewall.
    expect(PLATFORM_PROBE_TIMEOUT_MS).toBeGreaterThanOrEqual(15000)
  })
})
