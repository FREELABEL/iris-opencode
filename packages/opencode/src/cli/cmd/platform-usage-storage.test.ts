import { describe, test, expect } from "bun:test"
import { storagePath, formatSize, formatOwnStorage, formatAllStorage } from "./platform-usage-storage"

// =============================================================================
// `iris usage storage` (#193867). Two things matter:
//   1. The CLI never says who the caller is. The server derives the account from the token;
//      a user_id on the wire would be the exact spoofable input #187931 removed.
//   2. The numbers a client reads must be the numbers they are billed on — decimal units,
//      matching the server's GB-month figure, and never NaN on a partial payload.
// =============================================================================

describe("storagePath", () => {
  test("never sends a user id", () => {
    expect(storagePath(false)).toBe("/api/v1/usage/storage")
    expect(storagePath(true)).toBe("/api/v1/usage/storage?all=1")
    expect(storagePath(false)).not.toContain("user_id")
    expect(storagePath(true)).not.toContain("user_id")
  })
})

describe("formatSize", () => {
  test("uses decimal units, like the billing figure", () => {
    expect(formatSize(0)).toBe("0 B")
    expect(formatSize(999)).toBe("999 B")
    expect(formatSize(1500)).toBe("1.50 KB")
    expect(formatSize(2_500_000_000)).toBe("2.50 GB")
    expect(formatSize(123_000_000)).toBe("123 MB")
  })

  test("junk reads as zero, not NaN", () => {
    expect(formatSize(undefined)).toBe("0 B")
    expect(formatSize(null)).toBe("0 B")
    expect(formatSize(Number.NaN)).toBe("0 B")
  })
})

describe("formatOwnStorage", () => {
  const payload = {
    user_id: 42,
    current: { bytes: 3_000_000_000, files: 12 },
    by_workspace: [
      { bloq_id: 7, name: "Launch", bytes: 2_000_000_000, files: 10 },
      { bloq_id: null, name: null, bytes: 1_000_000_000, files: 2 },
    ],
    history: [
      { day: "2026-11-16", bytes: 1_000_000_000, files: 4 },
      { day: "2026-11-17", bytes: 3_000_000_000, files: 12 },
    ],
    month_to_date: { month: "2026-11", days_recorded: 2, gb_months: 0.133333 },
  }

  test("speaks to the client in plain words, by workspace", () => {
    const out = formatOwnStorage(payload).join("\n")
    expect(out).toContain("You are storing 3.00 GB across 12 files.")
    expect(out).toContain("Launch (#7)")
    expect(out).toContain("Not in a workspace")
    expect(out).toContain("2026-11-17")
    expect(out).toContain("0.133 GB-months")
    expect(out).not.toContain("NaN")
  })

  test("an empty account says so rather than printing a blank table", () => {
    const out = formatOwnStorage({ current: { bytes: 0, files: 0 }, by_workspace: [], history: [] }).join("\n")
    expect(out).toContain("You are storing 0 B across 0 files.")
    expect(out).toContain("No daily history yet")
  })

  test("never throws on a partial payload", () => {
    expect(() => formatOwnStorage({})).not.toThrow()
    expect(() => formatOwnStorage(null)).not.toThrow()
  })
})

describe("formatAllStorage", () => {
  test("lists every client, largest first as the server ranked them", () => {
    const out = formatAllStorage({
      total: { clients: 3, bytes: 5_000_000, files: 9 },
      clients: [
        { rank: 1, user_id: 5, name: "Big Co", bytes: 4_000_000, files: 7 },
        { rank: 2, user_id: 9, name: null, email: "small@example.com", bytes: 1_000_000, files: 2 },
      ],
    })
    expect(out[0]).toBe("3 clients storing 5.00 MB in 9 files.")
    expect(out.join("\n")).toContain("Big Co")
    expect(out.join("\n")).toContain("small@example.com")
    expect(out.join("\n")).toContain("… and 1 more")
    expect(out.findIndex((l) => l.includes("Big Co"))).toBeLessThan(out.findIndex((l) => l.includes("small@")))
  })
})
