import { describe, test, expect } from "bun:test"
import { aiProviderHealth } from "../src/cli/cmd/platform-doctor"

/**
 * AI provider health interpretation in `iris doctor` (#178281).
 *
 * The doctor accepted only "key_valid"/"ok" and labelled everything else
 * "check API key" — including `billing_active`, which is the server's BEST
 * state (routes/api.php:218 sets it when a real 1-token completion succeeds).
 * So working keys reported as broken, and running the deeper probe made the
 * result look worse.
 *
 * That is not cosmetic. This exact output — "OPENAI billing_active (check API
 * key)" — is what produced a wrong root cause on #178291.
 */

describe("healthy statuses are reported healthy", () => {
  test("billing_active is the STRONGEST state, not a warning — the reported bug", () => {
    const r = aiProviderHealth("billing_active")
    expect(r.ok).toBe(true)
    expect(r.hint).toBeUndefined()
    expect(r.detail).toContain("completion succeeded")
  })

  test("key_valid stays healthy", () => {
    expect(aiProviderHealth("key_valid").ok).toBe(true)
  })

  test("ok stays healthy", () => {
    expect(aiProviderHealth("ok").ok).toBe(true)
  })

  test("the deeper probe never looks worse than the shallow one", () => {
    // key_valid = models endpoint answered. billing_active = a real completion
    // succeeded. If deep ever ranks below shallow, the check is inverted.
    expect(aiProviderHealth("billing_active").ok).toBe(true)
    expect(aiProviderHealth("key_valid").ok).toBe(true)
  })
})

describe("failures get the action that actually fixes them", () => {
  test("quota exhaustion is about credits, not the key", () => {
    const r = aiProviderHealth("quota_exceeded")
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/credit|quota|limit/i)
    expect(r.hint).not.toMatch(/check API key/i)
  })

  test("payment_required is about billing, not the key", () => {
    const r = aiProviderHealth("payment_required")
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/payment|billing/i)
    expect(r.hint).not.toMatch(/check API key/i)
  })

  test("billing_blocked names the account, not the key", () => {
    const r = aiProviderHealth("billing_blocked")
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/blocked|billing/i)
  })

  test("rate_limited is transient and says so", () => {
    const r = aiProviderHealth("rate_limited")
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/transient|retry/i)
    expect(r.hint).not.toMatch(/check API key/i)
  })

  test("a missing key says so plainly", () => {
    expect(aiProviderHealth("missing").hint).toMatch(/no API key/i)
    expect(aiProviderHealth("not_configured").hint).toMatch(/no API key/i)
  })
})

describe("HTTP statuses are classified, not lumped together", () => {
  test("401/403 really are key problems", () => {
    expect(aiProviderHealth("http_401").hint).toMatch(/check API key/i)
    expect(aiProviderHealth("http_403").hint).toMatch(/check API key/i)
  })

  test("400 is a rejected request, not a bad key — this is gemini's live status", () => {
    const r = aiProviderHealth("http_400")
    expect(r.ok).toBe(false)
    expect(r.hint).not.toMatch(/check API key/i)
    expect(r.hint).toMatch(/rejected/i)
  })

  test("5xx is the provider's problem, and says so", () => {
    const r = aiProviderHealth("http_503")
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/outage|not your key/i)
  })
})

describe("robustness", () => {
  test("an unknown status fails closed rather than reading as healthy", () => {
    const r = aiProviderHealth("something_new_from_the_server")
    expect(r.ok).toBe(false)
    expect(r.hint).toMatch(/unrecognised/i)
  })

  test("the server's message is surfaced when present — it is the actionable part", () => {
    const r = aiProviderHealth("quota_exceeded", "You exceeded your current quota")
    expect(r.detail).toContain("You exceeded your current quota")
  })

  test("never throws on odd input", () => {
    expect(() => aiProviderHealth("")).not.toThrow()
    expect(() => aiProviderHealth(undefined as unknown as string)).not.toThrow()
  })
})

describe("the live production statuses, as of 2026-08-02", () => {
  test("openai and xai read healthy; gemini reads unhealthy for the right reason", () => {
    // GET https://heyiris.io/api/health?deep=true returned:
    //   ai_openai {"status":"billing_active","billing":"ok"}
    //   ai_xai    {"status":"billing_active","billing":"ok"}
    //   ai_gemini {"status":"http_400"}
    expect(aiProviderHealth("billing_active").ok).toBe(true)  // was ✗ "check API key"
    expect(aiProviderHealth("http_400").ok).toBe(false)       // genuinely broken
  })
})
