import { describe, test, expect } from "bun:test"
import { formatServerLedger, serverLedgerPath, type ServerLedgerSummary } from "../src/cli/cmd/som-send-ledger"

/**
 * `iris som ledger --server` (#193485): the server's send ledger, every machine's sends.
 * Pure formatter + query builder, so no network and no terminal mocks.
 */

const summary: ServerLedgerSummary = {
  bloq_id: 38,
  campaign: null,
  since: null,
  caps: { instagram: 40, linkedin: 25 },
  accounts: [
    { account: "heyiris.io", channel: "instagram", date: "2026-11-14", timezone: "America/Chicago", timezone_source: "owner", sent_today: 37, failed_today: 2, cap: 40, remaining: 3 },
    { account: "linkedin", channel: "linkedin", date: "2026-11-14", timezone: "UTC", timezone_source: "utc_default", sent_today: 4, failed_today: 0, cap: 25, remaining: 21 },
  ],
  campaigns: [
    {
      account: "heyiris.io", channel: "instagram", campaign: "Silent Iris", campaign_id: 53,
      sent_today: 37, failed_today: 2, sent: 120, failed: 9, skipped: 0, undeliverable: 4,
      leads_sent: 118, replies: 6, replies_untimed: 1, reply_rate: 0.0508,
      first_sent_at: "2026-11-01T15:00:00Z", last_event_at: "2026-11-14T18:00:00Z",
    },
  ],
  generated_at: "2026-11-14T19:00:00Z",
}

describe("iris som ledger --server", () => {
  test("query string carries only what was given", () => {
    expect(serverLedgerPath({})).toBe("/api/v1/som/send-events/summary")
    expect(serverLedgerPath({ bloq: 38, campaign: "Silent Iris", since: "2026-11-01" })).toBe(
      "/api/v1/som/send-events/summary?bloq=38&campaign=Silent+Iris&since=2026-11-01",
    )
  })

  test("the first line says it is the server's ledger", () => {
    const lines = formatServerLedger(summary)
    expect(lines[0]).toBe("Showing: SERVER ledger (board 38)")
  })

  test("per account: sent today, what is left under the cap, and the timezone the day is in", () => {
    const text = formatServerLedger(summary).join("\n")
    expect(text).toContain("@heyiris.io")
    expect(text).toContain("37 sent")
    expect(text).toContain("3 of 40 left")
    expect(text).toContain("[2026-11-14 America/Chicago]")
    expect(text).toContain("← near the cap")
    expect(text).toContain("21 of 25 left  [2026-11-14 UTC (no timezone set)]")
  })

  test("per campaign: totals and reply rate", () => {
    const text = formatServerLedger(summary).join("\n")
    expect(text).toContain("Silent Iris")
    expect(text).toContain("total 120 sent, 9 failed, 4 undeliverable")
    expect(text).toContain("replies 6/118 5.1% (1 without a reply time)")
  })

  test("an empty server ledger points back at the local one", () => {
    const lines = formatServerLedger({ ...summary, accounts: [], campaigns: [], bloq_id: null })
    expect(lines[0]).toBe("Showing: SERVER ledger (your reported sends)")
    expect(lines[1]).toContain("iris som ledger")
  })
})
