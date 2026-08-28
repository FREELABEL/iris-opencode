import { describe, expect, test } from "bun:test"
import { verifyProbeFor, isProbeSuccess, isProbeInconclusive } from "./integration-verify-probe"

/**
 * Post-authorize verification, replacing a list diff that could not tell whether a
 * credential actually worked. Every failure this week came from that gap:
 *
 *   - a repair overwrites a row, so nothing looks new and success reads as failure (#182697)
 *   - the callback can land just after the 60s poll gives up — a race decides the verdict
 *   - `status: "active"` is a claim: Notion rows sat at active with EXPIRED credentials
 *   - a live connection can point at the wrong account entirely (a personal workspace)
 */
describe("verifyProbeFor", () => {
  test("returns a read-only probe for the integrations people actually connect", () => {
    for (const t of ["gmail", "google-drive", "google-calendar", "notion", "slack"]) {
      expect(verifyProbeFor(t)).not.toBeNull()
    }
  })

  test("is case-insensitive", () => {
    expect(verifyProbeFor("Gmail")?.action).toBe("read_emails")
  })

  test("every probe asks for the smallest possible page — this runs on a live account", () => {
    for (const t of ["gmail", "google-drive", "notion", "slack", "dropbox", "canva"]) {
      const p = verifyProbeFor(t)!
      const sizes = Object.entries(p.params)
        .filter(([k]) => /limit|size|max|results/i.test(k))
        .map(([, v]) => v)
      for (const v of sizes) expect(v).toBe(1)
    }
  })

  test("no probe is a write — the first thing we do with someone's credential must not change anything", () => {
    for (const t of ["gmail", "google-drive", "google-calendar", "google-docs", "notion", "slack", "dropbox", "github", "canva", "servis-ai"]) {
      expect(verifyProbeFor(t)!.action).not.toMatch(/create|send|delete|update|insert|append|write|post/i)
    }
  })

  test("an unknown toolkit has no probe, so connect falls back to the diff rather than guessing", () => {
    expect(verifyProbeFor("some-new-thing")).toBeNull()
    expect(verifyProbeFor("")).toBeNull()
  })
})

describe("isProbeSuccess", () => {
  test("only an explicit success:true counts", () => {
    expect(isProbeSuccess({ success: true })).toBe(true)
    expect(isProbeSuccess({ success: false })).toBe(false)
  })

  test('"no error" is NOT success — that conflation is how a 401 became a green check', () => {
    expect(isProbeSuccess({})).toBe(false)
    expect(isProbeSuccess(null)).toBe(false)
    expect(isProbeSuccess("ok")).toBe(false)
    expect(isProbeSuccess({ data: [1, 2, 3] })).toBe(false)
  })
})

describe("isProbeInconclusive", () => {
  test('"not allowed to ask" is never "your integration is broken" (#182581)', () => {
    expect(isProbeInconclusive(401, {})).toBe(true)
    expect(isProbeInconclusive(403, {})).toBe(true)
    expect(isProbeInconclusive(200, { error: "Authentication required" })).toBe(true)
  })

  test("a real answered failure is conclusive — it tells us something about the credential", () => {
    expect(isProbeInconclusive(200, { success: false, error: "invalid_grant" })).toBe(false)
    expect(isProbeInconclusive(500, { error: "upstream exploded" })).toBe(false)
  })
})
