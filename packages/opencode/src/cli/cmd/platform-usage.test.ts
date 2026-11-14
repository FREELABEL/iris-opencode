import { describe, test, expect } from "bun:test"
import { parseUsageLine } from "./platform-usage"

// =============================================================================
// `iris usage --local` reads Claude Code and Codex transcripts off disk. Those are
// OTHER TOOLS' private formats — they owe us no compatibility and change shape without
// notice, on a user's machine, where we cannot see it happen.
//
// The failure mode that matters is not a crash. It is a parser that silently stops
// matching and reports zero, because "you ran nothing" and "I can no longer read your
// transcripts" print the same thing — the exact ambiguity the trace spine exists to end.
//
// So these assert the DISTINCTION: a line we understand produces numbers, a line we do
// not produces null, and neither one ever throws.
// =============================================================================

const usageLine = (extra: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: "assistant",
    timestamp: "2026-08-10T12:00:00.000Z",
    message: {
      model: "claude-opus-5",
      usage: {
        input_tokens: 10,
        output_tokens: 200,
        cache_read_input_tokens: 5000,
        cache_creation_input_tokens: 300,
        ...usage,
      },
      ...extra,
    },
  })

describe("parseUsageLine", () => {
  test("reads the real Claude Code assistant shape", () => {
    const r = parseUsageLine(usageLine())
    expect(r).not.toBeNull()
    expect(r!.model).toBe("claude-opus-5")
    expect(r!.input).toBe(10)
    expect(r!.output).toBe(200)
    expect(r!.cacheRead).toBe(5000)
    expect(r!.cacheWrite).toBe(300)
    expect(r!.day).toBe("2026-08-10")
  })

  test("skips lines that carry no usage block", () => {
    // Most lines in a transcript are user turns, file snapshots, mode changes.
    expect(parseUsageLine(JSON.stringify({ type: "user", message: { role: "user" } }))).toBeNull()
    expect(parseUsageLine(JSON.stringify({ type: "file-history-snapshot" }))).toBeNull()
  })

  test("a truncated final line costs that line, not the file", () => {
    // Sessions are appended to while we read them, so the last line is routinely half-written.
    expect(parseUsageLine('{"type":"assistant","message":{"usa')).toBeNull()
    expect(parseUsageLine("")).toBeNull()
    expect(parseUsageLine("   ")).toBeNull()
  })

  test("missing token fields count as zero rather than NaN", () => {
    // A NaN propagates into the totals and renders the whole report as NaN — one absent
    // field would take out every number on screen.
    const r = parseUsageLine(usageLine({}, { output_tokens: undefined, cache_read_input_tokens: "not-a-number" }))
    expect(r).not.toBeNull()
    expect(r!.output).toBe(0)
    expect(r!.cacheRead).toBe(0)
    expect(Number.isFinite(r!.input)).toBe(true)
  })

  test("an unnamed model is labelled, not dropped", () => {
    // Dropping it would undercount real spend. "unknown" is visible in the table and
    // prompts someone to look; a missing row does not.
    const r = parseUsageLine(usageLine({ model: undefined }))
    expect(r!.model).toBe("unknown")
  })

  test("respects the window cutoff", () => {
    const cutoff = Date.parse("2026-08-09T00:00:00.000Z")
    expect(parseUsageLine(usageLine(), cutoff)).not.toBeNull()

    const old = JSON.stringify({
      timestamp: "2026-01-01T00:00:00.000Z",
      message: { model: "m", usage: { input_tokens: 1 } },
    })
    expect(parseUsageLine(old, cutoff)).toBeNull()
  })

  test("an undated line is kept and dated now, not silently discarded", () => {
    // Undercounting is the failure this command exists to end, so an unparseable
    // timestamp must not remove real token spend from the report.
    const noTs = JSON.stringify({ message: { model: "m", usage: { output_tokens: 7 } } })
    const now = Date.parse("2026-08-11T09:00:00.000Z")
    const r = parseUsageLine(noTs, Date.parse("2026-08-01T00:00:00.000Z"), now)
    expect(r).not.toBeNull()
    expect(r!.day).toBe("2026-08-11")
    expect(r!.output).toBe(7)
  })

  test("never throws on hostile or malformed input", () => {
    const inputs = [
      "null",
      "[]",
      '"a string"',
      "123",
      JSON.stringify({ message: null }),
      JSON.stringify({ message: { usage: "not-an-object" } }),
      JSON.stringify({ message: { usage: [] } }),
      JSON.stringify({ message: { model: { nested: true }, usage: { input_tokens: {} } } }),
    ]
    for (const i of inputs) {
      expect(() => parseUsageLine(i)).not.toThrow()
    }
  })

  test("a usage block that is an array is rejected, not counted as a zero-token message", () => {
    // typeof [] === "object", so a bare object check lets this through and inflates the
    // message tally with rows carrying no usage at all.
    expect(parseUsageLine(JSON.stringify({ message: { model: "m", usage: [] } }))).toBeNull()
    expect(parseUsageLine(JSON.stringify({ message: { model: "m", usage: [1, 2] } }))).toBeNull()
  })
})
