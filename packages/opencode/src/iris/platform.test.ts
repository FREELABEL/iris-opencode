import { describe, expect, test } from "bun:test"
import { FL_API, IRIS_API } from "./platform"

/**
 * These do not call the network. The live check is `probe.ts`, run by hand against a signed-in
 * machine — a unit test that needs an account is a test that fails in CI for the wrong reason.
 *
 * What IS worth locking down is the thing that silently breaks: the two backends are different
 * services and a call to the wrong one 404s rather than erroring, so a base URL swapped by a
 * careless edit looks like missing data.
 */
describe("platform base urls", () => {
  test("fl-api and iris-api are different hosts", () => {
    expect(FL_API).not.toBe(IRIS_API)
  })

  test("neither base ends in a slash — paths are joined raw", () => {
    expect(FL_API.endsWith("/")).toBe(false)
    expect(IRIS_API.endsWith("/")).toBe(false)
  })
})
