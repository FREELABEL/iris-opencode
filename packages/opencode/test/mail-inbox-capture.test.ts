/**
 * `iris mail audit --inbox` — received mail from a lead reaches that lead's record (#194236).
 * Until this, inbound email was logged only when someone ran a pulse on that one lead: Apple Mail
 * inbound last logged 2026-10-14, Gmail 2026-11-09.
 */
import { describe, expect, test } from "bun:test"
import { sentReaderArgs, unloggedInbound, MAIL_SENT_READER_JXA, type SentItem } from "../src/cli/cmd/comms-mail-applescript"

const msg = (from: string, subject: string, at = "2026-11-24T15:00:00.000Z"): SentItem =>
  ({ external_message_id: "rfc822_" + subject, from, subject, sent_at: at, to: ["me@example.net"], cc: [], bcc: [] }) as SentItem

const leads: Record<string, number> = { "client@example.com": 101, "partner@example.org": 202 }
const leadOf = (a: string) => leads[a]

describe("unloggedInbound (#194236)", () => {
  test("mail from a lead that is on no record is a gap, owned by the sender's lead", () => {
    const gaps = unloggedInbound([msg("client@example.com", "Re: compliance")], leadOf, () => [])
    expect(gaps.map((g) => g.missing)).toEqual([[101]])
  })

  test("already on the record (same subject, same time, inbound) is not a gap", () => {
    const ledger = [{ direction: "inbound", subject: "Re: compliance", sent_at: "2026-11-24T15:00:00.000Z" }]
    expect(unloggedInbound([msg("client@example.com", "Re: compliance")], leadOf, () => ledger)).toEqual([])
  })

  test("an OUTBOUND row with the same subject does not hide a received message", () => {
    const ledger = [{ direction: "outbound", subject: "Re: compliance", sent_at: "2026-11-24T15:00:00.000Z" }]
    expect(unloggedInbound([msg("client@example.com", "Re: compliance")], leadOf, () => ledger).length).toBe(1)
  })

  test("newsletters and strangers (no lead) are never logged", () => {
    expect(unloggedInbound([msg("news@newsletter.example", "Weekly digest"), msg("", "no sender")], leadOf, () => [])).toEqual([])
  })
})

describe("inbox reader arguments (#194236)", () => {
  test("inbox mode is passed even with no id list", () => {
    expect(sentReaderArgs("me@example.net", 2, false, undefined, "inbox").slice(4)).toEqual(["2", "me@example.net", "", "", "inbox"])
  })
  test("sent mode is unchanged", () => {
    expect(sentReaderArgs("me@example.net", 2, false).slice(4)).toEqual(["2", "me@example.net", ""])
  })
  test("the reader reads the Inbox and records the sender in inbox mode", () => {
    expect(MAIL_SENT_READER_JXA).toContain('const inbox = argv[4] === "inbox"')
    expect(MAIL_SENT_READER_JXA).toContain('direction: inbox ? "inbound" : "outbound"')
  })
})
