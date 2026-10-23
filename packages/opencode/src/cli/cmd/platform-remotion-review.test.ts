import { describe, expect, test } from "bun:test"
import { formatTimecode, parseTimecode, sortNotes, formatRevisionNotes, type ReviewNote } from "./platform-remotion-review"

// #187928: notes carry `t` (seconds); agents read them in playback order.
const n = (id: number, t: number | null, body: string, resolved = false): ReviewNote => ({ id, t, body, resolved })

describe("timecodes", () => {
  test("format", () => {
    expect(formatTimecode(42)).toBe("0:42")
    expect(formatTimecode(42.9)).toBe("0:42")
    expect(formatTimecode(3725)).toBe("1:02:05")
  })
  test("parse", () => {
    expect(parseTimecode("42")).toBe(42)
    expect(parseTimecode("0:42")).toBe(42)
    expect(parseTimecode("1:02:05")).toBe(3725)
    expect(parseTimecode("42.5")).toBe(42.5)
    expect(parseTimecode(undefined)).toBeNull()
    expect(parseTimecode("-3")).toBeNull()
    expect(parseTimecode("abc")).toBeNull()
    expect(parseTimecode("1:2:3:4")).toBeNull()
  })
})

describe("revision notes", () => {
  test("timed notes sort in playback order, untimed last", () => {
    expect(sortNotes([n(1, null, "a"), n(2, 50, "b"), n(3, 12, "c")]).map((x) => x.id)).toEqual([3, 2, 1])
  })
  test("revision text lists only open notes, each with its second", () => {
    const out = formatRevisionNotes([n(1, 42, "logo too small"), n(2, 5, "done already", true), n(3, null, "warmer grade")])
    expect(out).toContain("[0:42 = 42s] logo too small")
    expect(out).toContain("[whole video] warmer grade")
    expect(out).not.toContain("done already")
    expect(out.indexOf("logo")).toBeLessThan(out.indexOf("warmer"))
    expect(formatRevisionNotes([n(1, 1, "x", true)])).toBe("No open revision notes.")
  })
})
