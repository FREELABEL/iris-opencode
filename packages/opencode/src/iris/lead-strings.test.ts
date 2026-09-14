import { describe, expect, test } from "bun:test"
import { str } from "./platform"

describe("str — the coercion that keeps one odd field from voiding a whole surface", () => {
  test("the exact payload that took Leads down: an object whose values are all null", () => {
    // Expected string | undefined, got {"source":null} at ["leads"][0]["keywords"]
    expect(str({ source: null })).toBeUndefined()
  })

  test("an object that DOES carry information keeps it rather than printing [object Object]", () => {
    expect(str({ source: "linkedin", campaign: "q3" })).toBe("linkedin, q3")
  })

  test("strings and arrays behave as they did before", () => {
    expect(str("hiring")).toBe("hiring")
    expect(str(["hiring", "remote"])).toBe("hiring, remote")
  })

  test("empty is undefined, not an empty string — the schema field is optional", () => {
    expect(str("")).toBeUndefined()
    expect(str([])).toBeUndefined()
    expect(str({})).toBeUndefined()
    expect(str(null)).toBeUndefined()
    expect(str(undefined)).toBeUndefined()
  })

  test("numbers and booleans survive as text", () => {
    expect(str(42)).toBe("42")
    expect(str(0)).toBe("0")
    expect(str(false)).toBe("false")
  })

  test("nested nonsense still yields a string or nothing — never a throw", () => {
    expect(str([{ a: null }, { b: "x" }])).toBe("x")
    expect(str({ a: { b: { c: "deep" } } })).toBe("deep")
    expect(() => str(Symbol("s"))).not.toThrow()
  })
})
