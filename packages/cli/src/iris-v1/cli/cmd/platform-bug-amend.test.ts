import { describe, expect, test } from "bun:test"
import { bugAmendHeaders } from "./platform-bug"

// A bug on a registered intake board (QA / client) can only be amended by that board's owner or
// members, so update/resolve must carry the caller's token. They used to send none, and every such
// bug answered "not found" (#664, BUG-36).
describe("bugAmendHeaders", () => {
  test("carries the caller's token as a bearer", () => {
    expect(bugAmendHeaders("tok_abc").Authorization).toBe("Bearer tok_abc")
  })

  test("an anonymous caller sends no Authorization at all — never an empty bearer", () => {
    const headers = bugAmendHeaders("")
    expect("Authorization" in headers).toBe(false)
    expect(headers["Content-Type"]).toBe("application/json")
  })
})
