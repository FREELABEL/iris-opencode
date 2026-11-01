import { describe, expect, test } from "bun:test"
import { canApprove, canEdit, canHold, canRelease, cleanForBulk, failureLine, matchesFilter, nextId, paceLine, tally, type ReviewMessage } from "./iris-reachr-review-model"

const msg = (id: number, status: string): ReviewMessage => ({
  id, status, lead_id: 1, lead_name: null, to_email: null, to_name: null, group: null, subject: null, body: null,
  warning: null, hold_reason: null, send_error: null, check_result: null, scheduled_for: null, sent_at: null,
})

describe("reachr review model", () => {
  test("a message stuck mid-send counts as a problem, because it may have gone out", () => {
    const counts = tally([msg(1, "pre_check"), msg(2, "failed"), msg(3, "pending_approval"), msg(4, "scheduled")])
    expect(counts).toEqual({ all: 4, review: 1, approved: 1, held: 0, sent: 0, problem: 2 })
    expect(matchesFilter(msg(1, "pre_check"), "problem")).toBe(true)
  })

  test("what has gone or is going can't be edited, held or approved", () => {
    for (const status of ["pre_check", "sent", "declined"]) {
      const m = msg(1, status)
      expect([canEdit(m), canApprove(m), canHold(m), canRelease(m)]).toEqual([false, false, false, false])
    }
  })

  test("only a message in review can be approved, and only a held one released", () => {
    expect(canApprove(msg(1, "approved"))).toBe(false)
    expect(canApprove(msg(1, "held"))).toBe(false)
    expect(canRelease(msg(1, "held"))).toBe(true)
  })

  test("a failed pre-check says not sent; a failed send says it may have gone", () => {
    const checked = { ...msg(1, "failed"), send_error: "x", check_result: { ok: false, failed: ["x"], at: "" } }
    const sending = { ...msg(2, "failed"), send_error: "y", check_result: { ok: true, failed: [], at: "" } }
    expect(failureLine(checked)).toStartWith("Not sent")
    expect(failureLine(sending)).toStartWith("This may have gone out")
  })

  test("bulk approval leaves flagged messages for a person", () => {
    const flagged = { ...msg(1, "pending_approval"), warning: "Lead email needs fixing" }
    expect(cleanForBulk([flagged, msg(2, "pending_approval"), msg(3, "held")]).map((m) => m.id)).toEqual([2])
  })

  test("pace reads as a person says it", () => {
    expect(paceLine(180, 300)).toBe("3–5 min apart")
    expect(paceLine(60, 60)).toBe("1 min apart")
  })

  test("moving past either end stays put, and a vanished selection lands on the first", () => {
    const list = [msg(1, "pending_approval"), msg(2, "pending_approval")]
    expect(nextId(list, 2, 1)).toBe(2)
    expect(nextId(list, 1, -1)).toBe(1)
    expect(nextId(list, 99, 1)).toBe(1)
    expect(nextId([], 1, 1)).toBeUndefined()
  })
})
