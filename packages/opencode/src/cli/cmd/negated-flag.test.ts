import { describe, expect, test } from "bun:test"
import { applyNegation } from "./negated-flag"

// #193782: `--no-x` must reach the handler as `x = false`, under both spellings yargs hands it.
describe("applyNegation", () => {
  test("--no-x sets x and its camelCase twin to false", () => {
    const a: Record<string, unknown> = { "no-require-otp": true, "require-otp": undefined }
    applyNegation(a, "require-otp")
    expect(a["require-otp"]).toBe(false)
    expect(a.requireOtp).toBe(false)
  })
  test("absent --no-x leaves the flag exactly as given, default included", () => {
    const a: Record<string, unknown> = { "no-launch": false, launch: true }
    applyNegation(a, "launch")
    expect(a.launch).toBe(true)
  })
  test("--no-x overrides a default-true flag", () => {
    const a: Record<string, unknown> = { "no-playbooks": true, playbooks: true }
    applyNegation(a, "playbooks")
    expect(a.playbooks).toBe(false)
  })
})
