import { describe, expect, test } from "bun:test"
import { credentialAge } from "./auth"

/**
 * `auth list` printed only the provider name and `oauth`, which reads as a working connection.
 *
 * Measured on a real machine 2026-09-22: the Anthropic row had an access token that expired 230
 * days earlier and was visually identical to a live one — and GitHub Copilot's had been dead for
 * 133 days without anyone noticing either. A listing that answers "is it present" while the
 * reader is asking "does it work" is the same defect as an advertised-but-dead model, or a node
 * that heartbeats while its transport carries nothing.
 */
const DAY = 86_400_000

describe("credentialAge", () => {
  test("says nothing for an api key — there is no expiry to report", () => {
    expect(credentialAge({ type: "api" })).toBe("")
  })

  test("says nothing for an oauth record with no expiry recorded", () => {
    expect(credentialAge({ type: "oauth" })).toBe("")
  })

  test("names how long ago an expired token died", () => {
    const out = credentialAge({ type: "oauth", expires: Date.now() - 230 * DAY })
    expect(out).toContain("access expired 230 days ago")
  })

  /**
   * The fix must not replace one misleading signal with another. In OAuth an expired ACCESS token
   * is ordinary — the refresh token usually renews it on next use — so this must never say "dead".
   */
  test("does NOT call an expired access token dead, and names the remedy conditionally", () => {
    const out = credentialAge({ type: "oauth", expires: Date.now() - 10 * DAY })
    expect(out.toLowerCase()).not.toContain("dead")
    expect(out.toLowerCase()).not.toContain("invalid")
    expect(out).toContain("normally refreshes on next use")
    expect(out).toContain("re-login if calls fail")
  })

  test("reports a healthy token quietly, in dim", () => {
    const out = credentialAge({ type: "oauth", expires: Date.now() + 90 * DAY })
    expect(out).toContain("expires in 90 days")
    expect(out).toContain("\x1b[90m") // dim, not a warning
    expect(out).not.toContain("\x1b[93m")
  })

  test("warns when a valid token is about to lapse", () => {
    const out = credentialAge({ type: "oauth", expires: Date.now() + 3 * DAY })
    expect(out).toContain("expires in 3 days")
    expect(out).toContain("\x1b[93m") // warning — this one is worth acting on
  })

  test("says day, not days, for exactly one", () => {
    expect(credentialAge({ type: "oauth", expires: Date.now() + 1 * DAY })).toContain("expires in 1 day")
    expect(credentialAge({ type: "oauth", expires: Date.now() - 1 * DAY })).toContain("expired 1 day ago")
  })

  test("never prints any part of the token itself", () => {
    const secret = "sk-ant-oat01-SUPERSECRETVALUE"
    const out = credentialAge({ type: "oauth", expires: Date.now() - DAY, access: secret } as any)
    expect(out).not.toContain("sk-ant")
    expect(out).not.toContain("SUPERSECRET")
  })
})
