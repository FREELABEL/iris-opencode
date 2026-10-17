import { describe, expect, test } from "bun:test"
import { describeDiskLive } from "./platform-hive-nodes"

describe("describeDiskLive (#188700)", () => {
  test("a healthy disk says nothing", () => {
    expect(describeDiskLive({ free_gb: 120, total_gb: 245, low: false })).toBeNull()
    expect(describeDiskLive(null)).toBeNull()
  })
  test("a low disk is named with its numbers", () => {
    expect(describeDiskLive({ free_gb: 2.3, total_gb: 245, low: true })).toBe("⚠ disk: 2.3 GB free of 245 GB")
  })
  test("a failed state write is shown even when free space looks fine", () => {
    expect(describeDiskLive({ free_gb: 40, total_gb: 245, low: false, last_write_error: { code: "EROFS", file: "config.json" } }))
      .toBe("⚠ disk: 40 GB free of 245 GB · last write failed: EROFS (config.json)")
  })
})
