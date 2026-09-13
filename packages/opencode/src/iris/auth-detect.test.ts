import { describe, expect, test } from "bun:test"
import { describeAuth } from "./platform"

describe("describeAuth", () => {
  test("signed in AND the provider can see it -> ready", () => {
    expect(describeAuth({ storedToken: "k", source: "auth store", envKey: "k" }).verdict).toBe("ready")
  })

  test("nothing anywhere -> signed-out, which is the one that should prompt a login", () => {
    expect(describeAuth({ storedToken: null, source: "none", envKey: undefined }).verdict).toBe("signed-out")
  })

  test("THE REAL CASE: signed in, provider blind -> not a login problem", () => {
    // A valid key in auth.json, IRIS_API_KEY unset. Chat 401s. Asking "are you signed in?"
    // answers YES and explains nothing, and prompting a re-login fixes nothing. This verdict
    // is the whole reason the state is three-valued instead of a boolean.
    const a = describeAuth({ storedToken: "k", source: "auth store (iris auth login)", envKey: undefined })
    expect(a.signedIn).toBe(true)
    expect(a.providerCanSee).toBe(false)
    expect(a.verdict).toBe("unreachable-credential")
  })

  test("an empty-string env key is not a credential", () => {
    // The trap: `IRIS_API_KEY=` exports an empty string, which is present-but-useless. Treating
    // presence as truth would report "ready" and hand the user the same raw 401 back.
    expect(describeAuth({ storedToken: "k", source: "auth store", envKey: "" }).verdict).toBe("unreachable-credential")
  })
})
