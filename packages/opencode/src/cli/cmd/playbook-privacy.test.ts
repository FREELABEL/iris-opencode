import { describe, expect, test } from "bun:test"
import { privacyVerdict } from "./platform-playbook"

/**
 * #182344 G-11 / #182346 — `--scope private` was an asserted privacy claim with
 * nothing behind it.
 *
 * The failure mode is asymmetric in the worst direction. A broken PUBLISH shows the
 * author an error. A broken PRIVACY shows the author exactly what success looks
 * like: the command succeeds, no URL is printed, and the content is on the internet.
 *
 * These pin the verdict rule, in particular the one that is easy to get wrong under
 * pressure: an unreachable list means UNMEASURED, and unmeasured must never render
 * as private.
 */
describe("privacyVerdict", () => {
  test("withheld and unlisted is the only thing that counts as private", () => {
    const v = privacyVerdict({ directStatus: 404, listed: false })
    expect(v).toEqual({ private: true, readable: false, measured: true })
  })

  test("a readable body is not private, however unlisted it is", () => {
    const v = privacyVerdict({ directStatus: 200, listed: false })
    expect(v.private).toBe(false)
    expect(v.readable).toBe(true)
  })

  test("being listed is not private, however unreadable the body is", () => {
    // Leaking that a playbook EXISTS is a disclosure on its own — names carry
    // client and project information.
    const v = privacyVerdict({ directStatus: 404, listed: true })
    expect(v.private).toBe(false)
  })

  test("readable AND listed is the fully-open case", () => {
    const v = privacyVerdict({ directStatus: 200, listed: true })
    expect(v.private).toBe(false)
    expect(v.readable).toBe(true)
  })

  test("UNMEASURED IS NOT PRIVATE — the false green this epic exists to remove", () => {
    const v = privacyVerdict({ directStatus: 404, listed: null })
    expect(v.measured).toBe(false)
    expect(v.private).toBe(false) // must NOT report private just because we could not look
  })

  test("a network failure on the direct probe is not a pass either", () => {
    const v = privacyVerdict({ directStatus: -1, listed: null })
    expect(v.private).toBe(false)
  })

  test("403 counts as withheld, same as 404", () => {
    expect(privacyVerdict({ directStatus: 403, listed: false }).private).toBe(true)
  })
})
