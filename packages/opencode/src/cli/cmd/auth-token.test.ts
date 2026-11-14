import { describe, expect, test } from "bun:test"
import { authTokenOutput } from "./auth"

/**
 * `iris auth token` lets a playbook run as the machine's signed-in account instead of a token
 * pasted into a repo `.env` — the Discover feed broke when that pasted token was revoked (#191214).
 * The contract a script depends on: the bearer alone on stdout, and no token is a failure.
 */
describe("iris auth token", () => {
  test("prints only the bearer, trimmed, and succeeds", () => {
    expect(authTokenOutput("  abc.def.ghi\n")).toEqual({ code: 0, stdout: "abc.def.ghi" })
  })

  test("not signed in is a non-zero exit with the reason on stderr, never an empty stdout", () => {
    for (const t of [undefined, "", "   "]) {
      const out = authTokenOutput(t)
      expect(out.code).toBe(1)
      expect(out.stdout).toBeUndefined()
      expect(out.stderr).toContain("iris auth login")
    }
  })
})
