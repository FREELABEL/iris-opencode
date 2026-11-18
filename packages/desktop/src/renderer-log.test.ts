import { describe, expect, test } from "bun:test"
import { clip, createLimiter, describeError, describeLoad, describeRejection } from "./renderer-log"

// #191508 — renderer errors and document loads go to engine.log, which survives a reload.

describe("renderer log lines", () => {
  test("a line is one line and bounded", () => {
    expect(clip("a\n   b\nc")).toBe("a ⏎ b ⏎ c")
    expect(clip("x".repeat(20), 5)).toBe("xxxxx…")
  })

  test("an uncaught error names where it happened and what was thrown", () => {
    const line = describeError({
      message: "Uncaught TypeError: e() is undefined",
      filename: "tauri://localhost/assets/index.js",
      lineno: 12,
      colno: 34,
      error: new TypeError("e() is undefined"),
    })
    expect(line).toContain("tauri://localhost/assets/index.js:12:34")
    expect(line).toContain("TypeError: e() is undefined")
  })

  test("a rejection with a non-Error reason is still readable", () => {
    expect(describeRejection("boom")).toBe("boom")
    expect(describeRejection({ status: 401 })).toBe('{"status":401}')
    expect(describeRejection(undefined)).toBe("undefined")
  })

  test("a document load says whether it was a reload", () => {
    expect(describeLoad({ navigationType: "reload", url: "tauri://localhost/", startedAt: 41.6 })).toBe(
      "document loaded (reload) tauri://localhost/ t+42ms",
    )
  })

  test("a render loop cannot flood the log, and the gap is reported once it clears", () => {
    let t = 0
    const allow = createLimiter(2, () => t)
    expect(allow().ok).toBe(true)
    expect(allow().ok).toBe(true)
    expect(allow()).toEqual({ ok: false, dropped: 1 })
    expect(allow()).toEqual({ ok: false, dropped: 2 })
    t = 61_000
    expect(allow()).toEqual({ ok: true, dropped: 2 })
  })
})
