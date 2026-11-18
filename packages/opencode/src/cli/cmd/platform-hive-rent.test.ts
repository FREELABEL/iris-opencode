import { describe, expect, test } from "bun:test"
import { releasedBefore } from "./platform-hive-rent"

// #193809: releasing an already-released lease must not read as "it was billing until now".
describe("releasedBefore", () => {
  const asked = Date.parse("2026-11-18T02:30:00Z")
  test("a lease released an hour before the call is already-released", () => {
    expect(releasedBefore({ released_at: "2026-11-18T01:28:12+00:00" }, asked)).toBe(true)
  })
  test("a lease released by this call (server time ≈ now) is not", () => {
    expect(releasedBefore({ released_at: "2026-11-18T02:30:01+00:00" }, asked)).toBe(false)
  })
  test("clock skew of a few seconds does not flip it", () => {
    expect(releasedBefore({ released_at: "2026-11-18T02:29:57+00:00" }, asked)).toBe(false)
  })
  test("no released_at (older server, or still releasing) is not", () => {
    expect(releasedBefore({ released_at: null }, asked)).toBe(false)
  })
})
