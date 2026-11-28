import { describe, expect, test } from "bun:test"
import { absoluteTime, isTimestamp, relativeTime, shortDate, timeWithExact, toTime } from "./relative-time"

// Local-time fixtures, so "yesterday" means the calendar day before wherever the test runs.
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const NOW = at(2026, 11, 28, 15, 0)
const ago = (ms: number) => NOW - ms

describe("relativeTime", () => {
  test("under a minute is just now, either side", () => {
    expect(relativeTime(ago(0), NOW)).toBe("just now")
    expect(relativeTime(ago(59_000), NOW)).toBe("just now")
    expect(relativeTime(NOW + 30_000, NOW)).toBe("just now")
  })

  test("minutes and hours", () => {
    expect(relativeTime(ago(5 * 60_000), NOW)).toBe("5m ago")
    expect(relativeTime(ago(59 * 60_000), NOW)).toBe("59m ago")
    expect(relativeTime(ago(60 * 60_000), NOW)).toBe("1h ago")
    expect(relativeTime(ago(23 * 3_600_000), NOW)).toBe("23h ago")
  })

  test("yesterday is the calendar day before, then days, then a date", () => {
    expect(relativeTime(at(2026, 11, 27, 9), NOW)).toBe("yesterday")
    expect(relativeTime(at(2026, 11, 25, 9), NOW)).toBe("3d ago")
    expect(relativeTime(at(2026, 11, 22, 9), NOW, { locale: "en-US" })).toBe("6d ago")
    expect(relativeTime(at(2026, 11, 3, 9), NOW, { locale: "en-US" })).toBe("Nov 3")
    expect(relativeTime(at(2025, 11, 3, 9), NOW, { locale: "en-US" })).toBe("Nov 3, 2025")
  })

  test("the future reads forwards", () => {
    expect(relativeTime(NOW + 5 * 60_000, NOW)).toBe("in 5m")
    expect(relativeTime(NOW + 3 * 3_600_000, NOW)).toBe("in 3h")
    expect(relativeTime(at(2026, 11, 29, 18), NOW)).toBe("tomorrow")
    expect(relativeTime(at(2026, 12, 2, 18), NOW)).toBe("in 4d")
  })

  test("accepts ISO strings, ms and Dates; nothing readable is empty", () => {
    const iso = new Date(ago(5 * 60_000)).toISOString()
    expect(relativeTime(iso, NOW)).toBe("5m ago")
    expect(relativeTime(new Date(ago(5 * 60_000)), NOW)).toBe("5m ago")
    expect(relativeTime(undefined, NOW)).toBe("")
    expect(relativeTime(null, NOW)).toBe("")
    expect(relativeTime("", NOW)).toBe("")
    expect(relativeTime("not a date", NOW)).toBe("")
    expect(toTime("2026-11-03T10:00:00Z")).toBe(Date.parse("2026-11-03T10:00:00Z"))
  })
})

describe("words", () => {
  test("an app passes its own words; the rest stay English", () => {
    expect(relativeTime(ago(5 * 60_000), NOW, { words: { minutesAgo: (n) => `hace ${n} min` } })).toBe("hace 5 min")
    expect(relativeTime(ago(0), NOW, { words: { minutesAgo: (n) => `${n}` } })).toBe("just now")
  })
})

describe("absoluteTime and shortDate", () => {
  test("the exact time for a hover", () => {
    const s = absoluteTime(at(2026, 11, 3, 16, 5), { locale: "en-US" })
    expect(s).toContain("Nov 3, 2026")
    expect(s).toMatch(/4:05\s?PM/)
    expect(absoluteTime(undefined)).toBe("")
  })

  test("the year only when it is not this year", () => {
    expect(shortDate(at(2026, 11, 3), { now: NOW, locale: "en-US" })).toBe("Nov 3")
    expect(shortDate(at(2024, 1, 9), { now: NOW, locale: "en-US" })).toBe("Jan 9, 2024")
  })
})

describe("timestamps in text", () => {
  test("isTimestamp knows a platform timestamp, and nothing else", () => {
    expect(isTimestamp("2026-11-03T16:05:00Z")).toBe(true)
    expect(isTimestamp("2026-11-03T16:05:00.123+02:00")).toBe(true)
    expect(isTimestamp("2026-11-03")).toBe(true)
    expect(isTimestamp("2026-13-45")).toBe(false)
    expect(isTimestamp("12 pages")).toBe(false)
    expect(isTimestamp(1730000000000)).toBe(false)
  })

  test("timeWithExact keeps both", () => {
    const s = timeWithExact(ago(5 * 60_000), NOW, { locale: "en-US" })
    expect(s.startsWith("5m ago (")).toBe(true)
    expect(s.endsWith(")")).toBe(true)
    expect(timeWithExact(undefined, NOW)).toBe("")
  })
})
