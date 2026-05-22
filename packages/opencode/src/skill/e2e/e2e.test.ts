import { describe, test, expect } from "bun:test"
import { runE2ESuite } from "./runner"

describe("e2e: local tier", () => {
  test("all local playbooks pass", async () => {
    const result = await runE2ESuite({ tier: "local" })
    expect(result.failed).toBe(0)
    expect(result.passed).toBeGreaterThan(0)
  }, 30_000)
})
