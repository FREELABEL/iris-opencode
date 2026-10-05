import { describe, expect, test } from "bun:test"
import { scanForSecrets, collectTools, PORTABLE, DROPPED } from "./platform-agents-export"

/**
 * The scanner's whole job is to fire. A "no secrets found" line that could never say
 * anything else is the guard-reports-success-by-never-running shape this repo keeps
 * finding, so these plant each class and assert it is caught.
 */
describe("scanForSecrets", () => {
  test("catches an api key field", () => {
    expect(scanForSecrets('{"api_key":"sk-live-9s8d7f6g5h4j3k2l"}').length).toBeGreaterThan(0)
  })
  test("catches a bearer header", () => {
    expect(scanForSecrets("Authorization: Bearer eyJhbGciOiJIUzI1NiJ9abc").length).toBeGreaterThan(0)
  })
  test("catches an email address", () => {
    expect(scanForSecrets("escalate to ops@example.com").some((h) => h.startsWith("email"))).toBe(true)
  })
  test("catches a private key block", () => {
    expect(scanForSecrets("-----BEGIN RSA PRIVATE KEY-----").length).toBeGreaterThan(0)
  })
  test("catches a long opaque token", () => {
    expect(scanForSecrets('{"x":"AKIAIOSFODNN7EXAMPLEAKIAIOSFODNN7EXAMPLE"}').length).toBeGreaterThan(0)
  })
  test("stays quiet on an ordinary prompt", () => {
    expect(scanForSecrets("You are a helpful chief of staff. Summarise the week.")).toEqual([])
  })
})

describe("collectTools", () => {
  test("merges every place an allowlist is stored, dedupes and sorts", () => {
    expect(
      collectTools({
        settings: { integrations: ["b", "a"], agentIntegrations: [{ type: "c" }], heartbeat_tools: ["a"] },
        config: { tools: ["d"] },
      }),
    ).toEqual(["a", "b", "c", "d"])
  })
  test("survives an agent with no tools anywhere", () => {
    expect(collectTools({})).toEqual([])
  })
})

describe("field classification", () => {
  test("no field is both portable and dropped", () => {
    const dropped = new Set(Object.values(DROPPED).flat())
    expect(PORTABLE.filter((k) => dropped.has(k))).toEqual([])
  })
  test("instance-only fields are never portable", () => {
    for (const k of ["user_id", "bloq_id", "stripe_price_id", "total_revenue_cents", "health"]) {
      expect(PORTABLE).not.toContain(k as any)
    }
  })
})
