import { afterEach, describe, expect, test } from "bun:test"
import { outroText } from "./clack"

// #188294 / #188325: a command that failed still ended on "Done".
describe("outro says Failed when the run already failed", () => {
  afterEach(() => {
    process.exitCode = 0
  })

  test("exit 0 keeps Done", () => {
    process.exitCode = 0
    expect(outroText("Done")).toBe("Done")
  })

  test("a non-zero exit code turns Done into Failed, with the code", () => {
    process.exitCode = 1
    expect(outroText("Done")).toBe("Failed (exit 1)")
    process.exitCode = 4
    expect(outroText("Done")).toBe("Failed (exit 4)")
  })

  test("any other outro text is left exactly as written", () => {
    process.exitCode = 1
    expect(outroText("Published — https://example.test")).toBe("Published — https://example.test")
    expect(outroText(undefined)).toBeUndefined()
  })
})
