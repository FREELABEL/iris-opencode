import { describe, expect, test } from "bun:test"
import { MAIL_THREAD_READER_JXA, withoutLedgerDuplicates } from "./comms-mail-applescript"

describe("withoutLedgerDuplicates — two writers, two keys, one row", () => {
  // Measured on #28363: `iris mail send` logged "Test note is on CAS102812" at send time; the same
  // message read back from Sent Mail carries its RFC Message-ID, a different key.
  const logged = [{ direction: "outbound", subject: "Test note is on CAS102812", sent_at: "2026-09-17T07:44:05Z" }]

  test("drops the Sent Mail copy of a message already logged at send time", () => {
    const read = [{ direction: "outbound", subject: "Test note is on CAS102812", sent_at: "2026-09-17T07:44:31Z", external_message_id: "rfc822_<x@y>" }]
    expect(withoutLedgerDuplicates(read, logged)).toEqual({ keep: [], dropped: 1 })
  })

  test("keeps a genuinely different message: other subject, other direction, or far apart in time", () => {
    const read = [
      { direction: "outbound", subject: "Different subject", sent_at: "2026-09-17T07:44:31Z" },
      { direction: "inbound", subject: "Test note is on CAS102812", sent_at: "2026-09-17T07:44:31Z" },
      { direction: "outbound", subject: "Test note is on CAS102812", sent_at: "2026-09-17T09:00:00Z" },
    ]
    const r = withoutLedgerDuplicates(read, logged)
    expect(r.dropped).toBe(0)
    expect(r.keep).toHaveLength(3)
  })

  test("a row logged by hand with a date and no time still matches its message (comm 5207)", () => {
    const handLogged = [{ direction: "outbound", subject: "IRIS + Pathways Cheat Sheet", sent_at: "2026-09-03T00:00:00.000000Z" }]
    const read = [{ direction: "outbound", subject: "IRIS + Pathways Cheat Sheet", sent_at: "2026-09-03T16:14:26.000Z" }]
    expect(withoutLedgerDuplicates(read, handLogged).dropped).toBe(1)
  })

  test("a precise row is NOT widened: same subject sixteen hours apart is two messages", () => {
    const precise = [{ direction: "outbound", subject: "IRIS + Pathways Cheat Sheet", sent_at: "2026-09-03T00:00:07Z" }]
    const read = [{ direction: "outbound", subject: "IRIS + Pathways Cheat Sheet", sent_at: "2026-09-03T16:14:26.000Z" }]
    expect(withoutLedgerDuplicates(read, precise).dropped).toBe(0)
  })

  test("an unparseable date never counts as a duplicate — it is written, not silently dropped", () => {
    const read = [{ direction: "outbound", subject: "Test note is on CAS102812", sent_at: "not a date" }]
    expect(withoutLedgerDuplicates(read, logged).dropped).toBe(0)
  })
})

describe("the embedded Mail reader", () => {
  test("survives embedding: the regex keeps its escape and the script parses", () => {
    expect(MAIL_THREAD_READER_JXA).toContain("/(^|\\/)sent( mail| messages)?$/i")
    expect(() => new Function(MAIL_THREAD_READER_JXA)).not.toThrow()
  })

  test("matches by exact address and reads one named account — never the unified inbox", () => {
    expect(MAIL_THREAD_READER_JXA).toContain("emailOf(snd[i]) === addr")
    expect(MAIL_THREAD_READER_JXA).toContain("Mail.accounts.byName(acctName)")
    expect(MAIL_THREAD_READER_JXA).not.toContain("Mail.inbox")
    expect(MAIL_THREAD_READER_JXA).not.toContain("_contains")
  })
})
