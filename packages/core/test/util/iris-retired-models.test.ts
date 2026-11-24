import { describe, expect, test } from "bun:test"
import { IRIS_RETIRED_MODELS, forwardRetired, parseRetired } from "../../src/util/iris-retired-models"

describe("iris retired models (#194085)", () => {
  const offered = (...ids: string[]) => (id: string) => ids.includes(id)

  test("forwards the four models OpenCode Go dropped", () => {
    const all = offered("kimi-k2.7-code", "minimax-m3", "mimo-v2.6-flash", "deepseek-v4.1-flash")
    expect(forwardRetired("kimi-k2.6", all)).toBe("kimi-k2.7-code")
    expect(forwardRetired("iris/minimax-m2.7", all)).toBe("minimax-m3")
    expect(forwardRetired("mimo-v2.5-go", all)).toBe("mimo-v2.6-flash")
    expect(forwardRetired("deepseek-v4-flash-go", all)).toBe("deepseek-v4.1-flash")
  })

  test("only forwards to a model that is offered", () => {
    expect(forwardRetired("kimi-k2.6", offered())).toBeUndefined()
    expect(forwardRetired("kimi-k2.7-code", offered("kimi-k2.7-code"))).toBeUndefined()
  })

  test("follows a chain and survives a loop", () => {
    expect(forwardRetired("a", offered("c"), { a: "b", b: "c" })).toBe("c")
    expect(forwardRetired("a", offered(), { a: "b", b: "a" })).toBeUndefined()
  })

  test("reads the manifest's retired map and ignores junk", () => {
    expect(parseRetired({ "iris/x": "iris/y", bad: 3 })).toEqual({ x: "y" })
    expect(parseRetired(["x"])).toEqual({})
    expect(parseRetired(undefined)).toEqual({})
  })

  test("no forward points at itself", () => {
    for (const [from, to] of Object.entries(IRIS_RETIRED_MODELS)) expect(to).not.toBe(from)
  })
})
