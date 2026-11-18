import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { failJson, normalizeBloqName } from "./platform-bloqs"

/**
 * #190624 — `iris atlas <command> --json` printed {"success":false,...} and exited 0.
 * A script that chained on `&&` treated a 422/404/500 as success. Human output already
 * exited non-zero for the same operation. `failJson` is the one place that prints a
 * machine-readable failure, and it must also set the exit code.
 */

describe("failJson", () => {
  afterEach(() => {
    process.exitCode = 0
  })

  test("prints the payload as one JSON line", () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      failJson({ success: false, error: "HTTP 422" })
      expect(log).toHaveBeenCalledTimes(1)
      const line = String((log.mock.calls[0] as unknown[])[0])
      expect(JSON.parse(line)).toEqual({ success: false, error: "HTTP 422" })
    } finally {
      log.mockRestore()
    }
  })

  test("exits 1 when no explicit code was set", () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      process.exitCode = 0
      failJson({ success: false, error: "not found" })
      expect(process.exitCode).toBe(1)
    } finally {
      log.mockRestore()
    }
  })

  test("preserves an explicit exit code (e.g. 2 for a missing flag)", () => {
    const log = spyOn(console, "log").mockImplementation(() => {})
    try {
      process.exitCode = 2
      failJson({ success: false, error: "Missing required --name" })
      expect(process.exitCode).toBe(2)
    } finally {
      log.mockRestore()
    }
  })
})

describe("normalizeBloqName", () => {
  test("trims a real name", () => {
    expect(normalizeBloqName("  Project Atlas  ")).toBe("Project Atlas")
  })

  test("refuses a blank name instead of letting the API invent 'My First Bloq' (#190633)", () => {
    expect(normalizeBloqName("   ")).toBeNull()
    expect(normalizeBloqName("")).toBeNull()
    expect(normalizeBloqName(undefined)).toBeNull()
  })
})
