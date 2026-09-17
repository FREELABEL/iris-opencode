import { describe, expect, test } from "bun:test"
import { channelOutcome, describeHttpFailure, failedRunWarning, nothingToRead, readOk, unavailable } from "./comms-channel-read"

// The body the bridge actually returned on 2026-09-17 for Kristen Montero (#28363).
const FDA_503 = '{"error":"No permission to read Mail — the iris daemon has no Full Disk Access (the DAEMON\'s own grant, not your terminal\'s)"}'

describe("#185776 — a channel that could not be read is never reported as empty", () => {
  test("the measured case: a 503 reads as COULD NOT READ, keeps the bridge's reason, and fails the run", () => {
    const read = unavailable(`kmontero@pathwaysinjuryconsultants.com: ${describeHttpFailure("bridge /api/mail/search", 503, FDA_503)}`)
    const out = channelOutcome("apple_mail", read)

    expect(out.kind).toBe("unavailable")
    expect(out.failed).toBe(true)
    expect(out.line).toContain("COULD NOT READ")
    expect(out.line).toContain("Full Disk Access")
    expect(out.line).not.toContain("no messages found")
  })

  test("a real, successful zero is still reported as no messages — and does not fail the run", () => {
    const out = channelOutcome("apple_mail", readOk([]))

    expect(out.kind).toBe("empty")
    expect(out.failed).toBe(false)
    expect(out.line).toBe("apple_mail: no messages found")
  })

  test("no handle to read with is its own state: neither a failure nor a zero", () => {
    const out = channelOutcome("imessage", nothingToRead("lead has no phone, email or instagram handle"))

    expect(out.kind).toBe("nothing")
    expect(out.failed).toBe(false)
    expect(out.line).not.toContain("no messages found")
  })

  test("some items plus a failed address is partial, and still fails the run", () => {
    const out = channelOutcome("apple_mail", { items: [{ id: 1 }, { id: 2 }], unavailable: ["alt@x.com: bridge returned HTTP 503"] })

    expect(out.kind).toBe("partial")
    expect(out.failed).toBe(true)
    expect(out.line).toContain("read 2 message(s)")
  })

  test("a source that answered with zero, beside one that failed, is partial — not COULD NOT READ", () => {
    // Measured: --channel gmail when Apple Mail 503s and the Gmail threads fallback answers with 0.
    const out = channelOutcome("gmail", { items: [], answered: true, unavailable: ["Apple Mail could not be read, so only the Gmail threads fallback was used (0 found) — 503"] })

    expect(out.kind).toBe("partial")
    expect(out.failed).toBe(true)
    expect(out.line).not.toContain("COULD NOT READ")
    expect(out.line).toContain("read 0 message(s)")
  })

  test("items with no failures proceed to ingest", () => {
    const out = channelOutcome("gmail", readOk([{ id: 1 }]))

    expect(out.kind).toBe("items")
    expect(out.failed).toBe(false)
  })
})

describe("describeHttpFailure keeps what the server said", () => {
  test("uses the JSON error sentence", () => {
    expect(describeHttpFailure("bridge", 503, FDA_503)).toBe(
      "bridge returned HTTP 503: No permission to read Mail — the iris daemon has no Full Disk Access (the DAEMON's own grant, not your terminal's)",
    )
  })

  test("falls back to plain text, and to a key hint on a bare 401", () => {
    expect(describeHttpFailure("bridge", 502, "upstream timeout")).toBe("bridge returned HTTP 502: upstream timeout")
    expect(describeHttpFailure("bridge", 401, "")).toContain("X-Bridge-Key")
    expect(describeHttpFailure("bridge", 500, "")).toBe("bridge returned HTTP 500")
  })
})

describe("the closing warning", () => {
  test("says the totals are not a zero, and is absent when nothing failed", () => {
    expect(failedRunWarning(["apple_mail"])).toContain("do NOT mean there was no contact")
    expect(failedRunWarning([])).toBeNull()
  })
})
