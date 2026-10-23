import { describe, test, expect } from "bun:test"
import { parseApprovalArgs } from "../src/cli/cmd/platform-schedules"

/**
 * `iris schedule approvals approve <id> --args '{…}'` (#187911). The CLI only refuses what is
 * not an edit at all; whether the edit is ALLOWED (schema, targets, destination) is the server's
 * call, re-checked there on every approve.
 */
describe("parseApprovalArgs", () => {
  test("a JSON object is the edit", () => {
    expect(parseApprovalArgs('{"discount_pct": 10}')).toEqual({ ok: true, args: { discount_pct: 10 } })
  })

  test("invalid JSON fails before anything is sent", () => {
    const r = parseApprovalArgs("{discount_pct: 10}")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("not valid JSON")
  })

  test.each(["[1,2]", "null", "10", '"text"'])("%s is not an object", (raw) => {
    const r = parseApprovalArgs(raw)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("JSON object")
  })

  test("an empty object is refused — approve without --args instead", () => {
    const r = parseApprovalArgs("{}")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("empty")
  })
})
