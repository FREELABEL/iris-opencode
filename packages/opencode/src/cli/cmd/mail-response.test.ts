import { describe, test, expect } from "bun:test"
import { mailRows } from "./mail-response"

// =============================================================================
// `iris mail search` returned "No emails from X in the last N days" for EVERY
// sender, against a mailbox with 274,414 messages (936 that week). The bridge
// answered HTTP 200 with {emails: [...]}; the CLI read `data.messages`, which the
// Envelope-Index rewrite had renamed. Undefined → [] → "no emails".
//
// The failure was invisible because a broken reader and an empty mailbox printed
// the same sentence. So these tests assert the DISTINCTION, not just the parse:
// an unknown shape must throw rather than quietly become zero rows.
// =============================================================================

describe("mailRows", () => {
  test("reads the post-rewrite `emails` key", () => {
    expect(mailRows({ emails: [{ sender: "a@b.c" }], count: 1 })).toHaveLength(1)
  })

  test("still reads the legacy `messages` key", () => {
    // Most fleet nodes run the pre-rewrite daemon. Dropping this would just move
    // the silence onto those machines instead of fixing it.
    expect(mailRows({ messages: [{ sender: "a@b.c" }, { sender: "d@e.f" }] })).toHaveLength(2)
  })

  test("prefers `emails` when a daemon sends both", () => {
    expect(mailRows({ emails: [1, 2], messages: [3] })).toEqual([1, 2])
  })

  test("a genuinely empty result is empty, not an error", () => {
    // The honest zero must survive — otherwise the fix trades one wrong answer
    // for another.
    expect(mailRows({ emails: [], count: 0 })).toEqual([])
    expect(mailRows({ messages: [] })).toEqual([])
  })

  test("THE REGRESSION: an unrecognised shape throws instead of reading as empty", () => {
    // This is the exact payload that caused the bug: the real response body, read
    // by a consumer looking for a key that is not in it. Before the fix this
    // produced [] and the CLI said "no emails".
    expect(() => mailRows({ results: [{ sender: "a@b.c" }] })).toThrow(/unrecognised mail response/)
    expect(() => mailRows({})).toThrow(/expected 'emails' or 'messages'/)
    expect(() => mailRows(null)).toThrow()
  })

  test("maps `date_sent` onto `date` so the Date line renders", () => {
    // Same rename one field down. It only made the Date line vanish rather than
    // zeroing the result, which is exactly why it went unreported.
    const [row] = mailRows({ emails: [{ sender: "a@b.c", date_sent: "2026-08-04T00:00:00Z" }] })
    expect(row.date).toBe("2026-08-04T00:00:00Z")
    expect(row.date_sent).toBe("2026-08-04T00:00:00Z") // original preserved
  })

  test("does not clobber a `date` the daemon already sent", () => {
    const [row] = mailRows({ messages: [{ date: "legacy", date_sent: "new" }] })
    expect(row.date).toBe("legacy")
  })

  test("the error names the version mismatch, so nobody debugs their inbox", () => {
    // The first diagnosis off this bug was "your inbound email is failing" — about
    // the user's own infrastructure. The message has to point at the real cause.
    expect(() => mailRows({ results: [] })).toThrow(/version mismatch, not an empty mailbox/)
    expect(() => mailRows({ results: [] })).toThrow(/keys: results/)
  })
})

// #189941 — `iris mail search` / `read` argument handling.
import { mailSearchParams, describeMailQuery, bodyMissingNote } from "./mail-response"

describe("mailSearchParams", () => {
  test("a sender query is trimmed and passed through unmangled (quotes, %, _, ;)", () => {
    for (const q of ["o'brien", '"quoted"', "100%", "a_b", "x;y LIMIT 5;"]) {
      const r = mailSearchParams({ query: `  ${q} `, days: 7, limit: 5 })
      expect("error" in r).toBe(false)
      expect((r as URLSearchParams).get("from")).toBe(q)
    }
  })

  test("subject-only search works with no sender (was: 'No emails from \"\"')", () => {
    const r = mailSearchParams({ query: "", subject: "Iris demo", days: 7, limit: 5 }) as URLSearchParams
    expect(r.get("subject")).toBe("Iris demo")
    expect(r.has("from")).toBe(false)
  })

  test("nothing to search for is an error, not a search for everything", () => {
    expect("error" in (mailSearchParams({ query: "   ", days: 7, limit: 5 }) as any)).toBe(true)
    expect("error" in (mailSearchParams({ days: 7, limit: 5 }) as any)).toBe(true)
    expect("error" in (mailSearchParams({ query: "", subject: "  ", days: 7, limit: 5 }) as any)).toBe(true)
  })

  test("--full asks for bodies; --thread asks for both directions", () => {
    const r = mailSearchParams({ query: "hpk@m42.com", days: 30, limit: 5, full: true, maxBody: 900, thread: true }) as URLSearchParams
    expect(r.get("include_body")).toBe("1")
    expect(r.get("max_body")).toBe("900")
    expect(r.get("participant")).toBe("hpk@m42.com")
    expect(r.has("from")).toBe(false)
  })

  test("describeMailQuery names what was actually searched", () => {
    expect(describeMailQuery({ query: "", subject: "demo", days: 7 })).toBe('No emails with subject "demo" in the last 7 days')
    expect(describeMailQuery({ query: "khalsa", days: 7 })).toBe('No emails from "khalsa" in the last 7 days')
    expect(describeMailQuery({ query: "a@b.c", thread: true, days: 7 })).toBe('No emails to or from "a@b.c" in the last 7 days')
  })

  test("--full against a bridge that returned no body says so instead of printing nothing", () => {
    expect(bodyMissingNote({ subject: "x" })).toContain("older than body support")
    expect(bodyMissingNote({ body: null, body_error: "message file not on disk" })).toContain("not on disk")
    expect(bodyMissingNote({ body: "hello" })).toBeNull()
  })
})
