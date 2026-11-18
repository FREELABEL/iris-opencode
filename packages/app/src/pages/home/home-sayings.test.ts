import { describe, expect, test } from "bun:test"
import { SAYINGS, sayingFor } from "./home-sayings"

const day = (n: number, hour = 12) => new Date(2026, 10, 4 + n, hour)

describe("sayingFor", () => {
  test("there are 100, none repeated", () => {
    expect(SAYINGS.length).toBe(100)
    expect(new Set(SAYINGS).size).toBe(100)
  })

  test("holds for the whole local day", () => {
    expect(sayingFor(193, day(0, 0))).toBe(sayingFor(193, day(0, 23)))
  })

  test("changes the next day and cycles through all 100 before repeating", () => {
    const seen = Array.from({ length: 100 }, (_, n) => sayingFor(193, day(n)))
    expect(new Set(seen).size).toBe(100)
    expect(sayingFor(193, day(100))).toBe(seen[0])
  })

  test("different users usually get different lines on the same day", () => {
    const lines = new Set(Array.from({ length: 50 }, (_, user) => sayingFor(user + 1, day(0))))
    expect(lines.size).toBeGreaterThan(30)
  })
})
