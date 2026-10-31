import { describe, expect, test } from "bun:test"
import { heldSeats } from "./licence"

describe("licence show", () => {
  test("a released seat is history, not a held seat", () => {
    expect(heldSeats([{ released_at: null }, { released_at: "2026-10-01" }, {}])).toBe(2)
    expect(heldSeats(undefined)).toBe(0)
  })
})
