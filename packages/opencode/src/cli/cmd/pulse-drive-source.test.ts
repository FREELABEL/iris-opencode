import { describe, expect, test } from "bun:test"
import { sweepDrive, toObservations, type SweepOptions } from "./pulse-check-sweep"

// #190969 — Google Drive on the topic route. A connected Drive can hold patient records whose NAMES
// identify the patient, so a name may be shown locally but must never be uploaded.
const DAY = 864e5
const now = Date.now()
const file = (id: string, name: string, at: number, mimeType = "application/pdf") => ({ id, name, mimeType, modifiedTime: new Date(at).toISOString() })
const opts = (o: Partial<SweepOptions> = {}): SweepOptions =>
  ({ keyword: "creator os", repo: "/tmp", windowDays: 7, limit: 10, sources: ["drive"], ...o }) as SweepOptions

describe("topic route — Google Drive stop", () => {
  test("counts files changed this window and the one before", async () => {
    const sw = await sweepDrive(opts(), async () => ({ success: true, data: { files: [file("a", "Creator OS plan", now - DAY), file("b", "Creator OS v0", now - 9 * DAY), file("c", "old", now - 40 * DAY)] } }))
    expect(sw.searched).toBe(true)
    expect(sw.hits).toBe(1)
    expect(sw.hitsPrior).toBe(1)
  })

  test("several connected accounts are each searched, and a file they share counts once", async () => {
    const calls: any[] = []
    const sw = await sweepDrive(opts(), async (_p, sel) => {
      calls.push(sel)
      if (!sel.integrationId) return { success: false, code: "account_ambiguous", accounts: [{ integration_id: 1 }, { integration_id: 2 }] }
      return { success: true, data: { files: [file("shared", "Creator OS", now - DAY), file(`own${sel.integrationId}`, "Creator OS notes", now - DAY)] } }
    })
    expect(calls.map((c) => c.integrationId)).toEqual([undefined, 1, 2])
    expect(sw.hits).toBe(3)
  })

  test("not connected is a SHUT stop with the reason, never 0 found", async () => {
    const sw = await sweepDrive(opts(), async () => ({ success: false, error: "No google-drive integration connected" }))
    expect(sw.searched).toBe(false)
    expect(sw.unavailableReason).toContain("google-drive")
  })

  test("a file NAME never reaches the upload — not as a locator, not with --include-context", async () => {
    const sw = await sweepDrive(opts(), async () => ({ success: true, data: { files: [file("p", "Doe, Jane - Knee Surgery 09-19-25.pdf", now - DAY)] } }))
    expect(sw.items[0].text).toContain("Doe, Jane") // shown in your own brief
    for (const includeContext of [false, true]) {
      const [obs] = toObservations("creator os", [sw], { includeContext, windowDays: 7 })
      expect(JSON.stringify(obs)).not.toContain("Doe")
      expect(obs.payload.locators[0].where).toBe("Drive · pdf")
      expect(obs.metrics.drive_hits).toBe(1)
    }
  })
})
