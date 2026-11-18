/** Seat flag parsing (#192422) and who reviews a red objective (#192426). */
import { describe, expect, test } from "bun:test"
import { parseRights, parseCaps, parseObjective, reviewerFor, SeatArgError } from "./seat-args"

describe("--set rights", () => {
  test("self, a seat id, and an empty value that removes — merged onto what the seat already has", () => {
    expect(parseRights(["egress=self", "payment=12"], { shared_write: { decide: "self", input: [] } })).toEqual({ shared_write: "self", egress: "self", payment: 12 })
    expect(parseRights(["egress="], { egress: { decide: "self" } })).toEqual({})
  })
  test("read is not a decision, and a name is not a seat id", () => {
    expect(() => parseRights(["read=self"])).toThrow(SeatArgError)
    expect(() => parseRights(["payment=Controller"])).toThrow("seat id")
    expect(() => parseRights(["payment"])).toThrow("effect=")
  })
})

describe("--cap limits", () => {
  test("sets, merges and removes a window; unknown effects are refused", () => {
    expect(parseCaps(["egress.per_hour=5"])).toEqual({ rate_caps: { egress: { per_hour: 5 } } })
    expect(parseCaps(["egress.per_day=50"], { rate_caps: { egress: { per_hour: 5 } }, expires_at: "x" })).toEqual({ rate_caps: { egress: { per_hour: 5, per_day: 50 } }, expires_at: "x" })
    expect(parseCaps(["egress.per_hour="], { rate_caps: { egress: { per_hour: 5 } } })).toBeNull()
    expect(() => parseCaps(["read.per_hour=5"])).toThrow("counted")
  })
})

describe("--add objective", () => {
  test("only the first two bars split — the command keeps its own pipes", () => {
    expect(parseObjective("dso|DSO under 40|iris invoices list --json | jq -e '.dso < 40'")).toEqual({ id: "dso", title: "DSO under 40", exit_check: "iris invoices list --json | jq -e '.dso < 40'" })
  })
  test("no command, no objective", () => {
    expect(() => parseObjective("dso|DSO under 40|")).toThrow("no command can score")
    expect(() => parseObjective("dso|only two")).toThrow(SeatArgError)
  })
})

describe("the reviewer is the human up the seat's line", () => {
  const roles = [
    { id: 1, title: "CFO", reports_to_role_id: null, holder: { type: "human", id: 501 } },
    { id: 2, title: "Controller", reports_to_role_id: 1, holder: null },
    { id: 3, title: "AP Clerk", reports_to_role_id: 2, holder: { type: "agent", id: 8701 } },
  ]
  test("a vacant parent escalates", () => {
    expect(reviewerFor(3, roles)).toEqual({ role_id: 1, title: "CFO", user_id: 501 })
  })
  test("the top seat has nobody above it", () => {
    expect(reviewerFor(1, roles)).toBeNull()
  })
})
