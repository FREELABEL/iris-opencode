import { describe, expect, test } from "bun:test"
import {
  buildRecipientList,
  checkMode,
  effectiveStatus,
  flattenToArgs,
  parseRecipientFile,
  sendLabel,
  statusTotals,
  statusVerdict,
  testSubject,
  type StatusMessage,
} from "./email-send"

describe("recipient list — nothing disappears without a reason", () => {
  test("a list that silently shrinks: every input is a recipient or a skip with a reason", () => {
    const inputs = ["a@x.com", "A@X.com ", "not-an-email", "", "b@y.org", "Jo Smith <c@z.io>"]
    const r = buildRecipientList(inputs)
    expect(r.recipients).toEqual(["a@x.com", "b@y.org", "c@z.io"])
    expect(r.skipped.map((s) => s.reason)).toEqual(["duplicate", "invalid", "blank"])
    expect(r.recipients.length + r.skipped.length).toBe(inputs.length)
  })

  test("the same person twice in different case is mailed once, not twice", () => {
    expect(buildRecipientList(["Alex@FreeLabel.net", "alex@freelabel.net"]).recipients).toEqual(["alex@freelabel.net"])
  })

  test("an address the server would refuse is refused here first (no TLD, spaces)", () => {
    const r = buildRecipientList(["a@b", "a b@c.com", "a@b.c"])
    expect(r.recipients).toEqual([])
    expect(r.skipped.every((s) => s.reason === "invalid")).toBe(true)
  })

  test("--to a,b --to c is three recipients, not one malformed address", () => {
    expect(flattenToArgs(["a@x.com,b@x.com", "c@x.com"])).toEqual(["a@x.com", "b@x.com", "c@x.com"])
    expect(flattenToArgs("a@x.com")).toEqual(["a@x.com"])
    expect(flattenToArgs(undefined)).toEqual([])
  })
})

describe("recipient files", () => {
  test("a member export whose first column is a name reads the email column, not the names", () => {
    const csv = 'Name,Email,Chapter\n"Smith, Jo",jo@x.com,FW\nAl,al@y.com,FW\n'
    const p = parseRecipientFile(csv, "members.csv")
    expect(p.error).toBeUndefined()
    expect(p.entries.map((e) => e.value)).toEqual(["jo@x.com", "al@y.com"])
    expect(p.entries[0].line).toBe(2)
  })

  test("a CSV with no email column is an error, never 'use the first column'", () => {
    const p = parseRecipientFile("name,phone\nJo,555\n", "x.csv")
    expect(p.error).toContain('No "email" column')
    expect(p.entries).toEqual([])
  })

  test("header variants: 'E-mail', 'email_address', 'Email Address'", () => {
    for (const h of ["E-mail", "email_address", "Email Address"]) {
      expect(parseRecipientFile(`${h}\na@x.com\n`, "x.csv").entries.map((e) => e.value)).toEqual(["a@x.com"])
    }
  })

  test("a plain list keeps line numbers and ignores blanks and # comments", () => {
    const p = parseRecipientFile("# board\na@x.com\n\nbad\n", "list.txt")
    expect(p.entries).toEqual([
      { value: "a@x.com", line: 2 },
      { value: "bad", line: 4 },
    ])
  })

  test("an empty CSV row's blank email is reported as blank, not dropped", () => {
    const p = parseRecipientFile("email\na@x.com\n,\n", "x.csv")
    const r = buildRecipientList(p.entries)
    expect(r.skipped).toEqual([{ input: "", reason: "blank", line: 3 }])
  })
})

describe("test vs live — the wrong file must not reach the wrong 400 people", () => {
  test("live without --confirm-count refuses and names the number to confirm", () => {
    const r = checkMode({ live: true, unique: 412 })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("--confirm-count 412")
  })

  test("live with a count that does not match the unique valid recipients refuses", () => {
    const r = checkMode({ live: true, confirmCount: 400, unique: 412 })
    expect(r.ok).toBe(false)
  })

  test("live with the matching count is allowed", () => {
    expect(checkMode({ live: true, confirmCount: 3, unique: 3 })).toEqual({ ok: true, mode: "live" })
  })

  test("neither --test nor --live is refused rather than defaulting to a real send", () => {
    expect(checkMode({ unique: 1 }).ok).toBe(false)
    expect(checkMode({ test: true, live: true, unique: 1 }).ok).toBe(false)
  })

  test("a test send to a whole list is refused (test is at most 10)", () => {
    expect(checkMode({ test: true, unique: 11 }).ok).toBe(false)
    expect(checkMode({ test: true, unique: 10 })).toEqual({ ok: true, mode: "test" })
  })

  test("zero valid recipients refuses in either mode", () => {
    expect(checkMode({ test: true, unique: 0 }).ok).toBe(false)
    expect(checkMode({ live: true, confirmCount: 0, unique: 0 }).ok).toBe(false)
  })

  test("a test subject is labelled once, never '[TEST] [TEST]'", () => {
    expect(testSubject("October issue")).toBe("[TEST] October issue")
    expect(testSubject("[TEST] October issue")).toBe("[TEST] October issue")
  })
})

describe("status — accepted is not delivered", () => {
  const m = (o: Partial<StatusMessage>): StatusMessage => ({ email: "a@x.com", status: "sent", ...o })

  test("a sent row the provider was never asked about reads 'accepted', not 'sent' or 'delivered'", () => {
    expect(effectiveStatus(m({}))).toBe("accepted")
    expect(effectiveStatus(m({ delivery_status: "delivered" }))).toBe("delivered")
    expect(effectiveStatus(m({ status: "failed", delivery_status: null }))).toBe("failed")
  })

  test("totals count by the effective status", () => {
    expect(statusTotals([m({}), m({ delivery_status: "delivered" }), m({ delivery_status: "delivered" }), m({ status: "failed" })])).toEqual({
      accepted: 1,
      delivered: 2,
      failed: 1,
    })
  })

  test("a bounce exits non-zero even when everything else was delivered", () => {
    const v = statusVerdict([m({ delivery_status: "delivered" }), m({ delivery_status: "bounced" })], { refreshed: true })
    expect(v.exitCode).toBe(1)
    expect(v.reasons).toContain("1 bounced")
  })

  test("after --refresh, all still 'accepted' is not success — the provider confirmed nothing", () => {
    expect(statusVerdict([m({}), m({})], { refreshed: true }).exitCode).toBe(1)
    // Without asking, stored acceptance is reported but not treated as a failure.
    expect(statusVerdict([m({}), m({})], { refreshed: false }).exitCode).toBe(0)
  })

  test("a server that ignores ?refresh=1 is reported as such, not presented as delivery", () => {
    const v = statusVerdict([m({})], { refreshed: true, refreshUnsupported: true })
    expect(v.exitCode).toBe(1)
    expect(v.reasons).toContain("delivery status not available from server yet")
  })

  test("a run where nothing was accepted exits non-zero", () => {
    expect(statusVerdict([m({ status: "failed" })], { refreshed: false }).exitCode).toBe(1)
    expect(statusVerdict([], { refreshed: false }).exitCode).toBe(1)
  })

  test("a queued live run says pending, not 'nothing accepted'", () => {
    const v = statusVerdict([m({ status: "pending" })], { refreshed: false })
    expect(v.exitCode).toBe(1)
    expect(v.reasons[0]).toContain("pending")
    expect(v.reasons.join()).not.toContain("nothing was accepted")
  })

  test("delivered and opened is a clean exit", () => {
    expect(statusVerdict([m({ delivery_status: "delivered" }), m({ delivery_status: "opened" })], { refreshed: true }).exitCode).toBe(0)
  })
})

describe("status — labels and 'unknown'", () => {
  const m = (o: Partial<StatusMessage>): StatusMessage => ({ email: "a@x.com", status: "sent", ...o })
  test("the send column never says a bare 'sent' that reads as delivered", () => {
    expect(sendLabel(m({}))).toBe("sent (accepted)")
    expect(sendLabel(m({ status: "failed" }))).toBe("failed")
  })
  test("after --refresh, a provider answering 'unknown' for everything is not a confirmation", () => {
    expect(statusVerdict([m({ delivery_status: "unknown" }), m({ delivery_status: null })], { refreshed: true }).exitCode).toBe(1)
  })
  test("a complaint or block fails the run like a bounce does", () => {
    expect(statusVerdict([m({ delivery_status: "complained" })], { refreshed: true }).exitCode).toBe(1)
    expect(statusVerdict([m({ delivery_status: "blocked" })], { refreshed: true }).exitCode).toBe(1)
  })
})
