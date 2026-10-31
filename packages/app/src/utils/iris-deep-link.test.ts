import { describe, expect, test } from "bun:test"
import { parseIrisLink } from "./iris-deep-link"

describe("parseIrisLink (#190233)", () => {
  test("the post-payment link names the plan", () => {
    expect(parseIrisLink("iris://upgraded?plan=iris-personal-monthly")).toEqual({
      kind: "upgraded",
      plan: "iris-personal-monthly",
    })
  })

  test("all three spellings of the same link are accepted", () => {
    for (const raw of ["iris://upgraded/?plan=iris-solo-monthly", "iris:upgraded?plan=iris-solo-monthly", "iris:///upgraded?plan=iris-solo-monthly"]) {
      expect(parseIrisLink(raw)).toEqual({ kind: "upgraded", plan: "iris-solo-monthly" })
    }
  })

  test("a link with no plan, or a plan that is not a slug, still opens the app but names nothing", () => {
    expect(parseIrisLink("iris://upgraded")).toEqual({ kind: "upgraded", plan: null })
    expect(parseIrisLink("iris://upgraded?plan=<script>alert(1)</script>")).toEqual({ kind: "upgraded", plan: null })
    expect(parseIrisLink("iris://upgraded?plan=" + "a".repeat(80))).toEqual({ kind: "upgraded", plan: null })
  })

  test("anything else is ignored, not guessed at", () => {
    expect(parseIrisLink("iris://open?url=https://evil.example")).toBeNull()
    expect(parseIrisLink("iris://")).toBeNull()
    expect(parseIrisLink("https://heyiris.io/p/upgraded")).toBeNull()
    expect(parseIrisLink("javascript:alert(1)")).toBeNull()
    expect(parseIrisLink("not a url")).toBeNull()
  })
})
