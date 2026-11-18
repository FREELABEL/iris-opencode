import { describe, expect, test } from "bun:test"
import { signInSummary, signInTone } from "./iris-artifact-publish"

// Who can sign in (#193846): the words are fl-api's rule at the door, and an empty list is never
// a quiet blank — it says out loud that anyone with the code gets in.
describe("sign-in summary", () => {
  test("an empty list says anyone with the code gets in, in amber", () => {
    expect(signInSummary([], "known", "Pathways")).toContain("anyone who can receive the code")
    expect(signInSummary([], "none", "Pathways")).toStartWith("Members of Pathways")
    expect(signInTone([], "known")).toBe("warn")
  })
  test("a list names what it admits, in green", () => {
    expect(signInSummary(["a@b.com", "@c.com"], "known", "")).toBe(
      "Board members, plus these 2. Anyone else is told they aren't authorized.",
    )
    expect(signInTone(["@c.com"], "known")).toBe("good")
  })
  test("an unreadable list is not shown as empty", () => {
    expect(signInSummary([], "unknown", "X")).toContain("Couldn't read")
    expect(signInTone([], "loading")).toBe("idle")
  })
})
