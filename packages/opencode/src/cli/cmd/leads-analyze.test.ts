import { describe, expect, test } from "bun:test"
import { analyzeJson, dmLedger, dmTrend, inPeriod, messagesHeader, messagesInPeriod, sentHeadline, type SentMessage } from "./leads-analyze"

const week = { start_date: "2026-10-23", end_date: "2026-10-29" }
const msg = (date: string, lead_id = 1): SentMessage => ({ date, channel: "IG", lead_id, lead_name: `L${lead_id}`, text: "hi" })

describe("#191706 — messages are scoped to the report's period", () => {
  test("messages outside the server's window are dropped (the Feb–Sep list under -p week)", () => {
    const all = [msg("2026-02-11T10:00:00Z", 1), msg("2026-09-30T23:59:00Z", 2), msg("2026-10-24T09:00:00Z", 3)]
    expect(messagesInPeriod(all, week, 10).map((m) => m.lead_id)).toEqual([3])
  })
  test("both window ends are inclusive; undated messages are not in any period", () => {
    expect(inPeriod("2026-10-23T00:00:00Z", week)).toBe(true)
    expect(inPeriod("2026-10-29T23:59:59Z", week)).toBe(true)
    expect(inPeriod("2026-10-30T00:00:00Z", week)).toBe(false)
    expect(inPeriod("", week)).toBe(false)
  })
  test("newest first, capped at the limit", () => {
    const all = [msg("2026-10-24T09:00:00Z", 1), msg("2026-10-28T09:00:00Z", 2), msg("2026-10-26T09:00:00Z", 3)]
    expect(messagesInPeriod(all, week, 2).map((m) => m.lead_id)).toEqual([2, 3])
  })
  test("the header names the window, or says plainly that there is none", () => {
    expect(messagesHeader(week, 10)).toContain("2026-10-23 → 2026-10-29")
    expect(messagesHeader(undefined, 10)).toContain("all time")
  })
})

describe("#191701 — --json carries what the table shows", () => {
  const metrics = { period: week, summary: { total_completed: 0 }, by_type: { instagram_dm: { count: 0 } } }
  const quota = { quotas: { dms_per_week: 350 }, progress: { dms_this_week: 0, replies_this_week: 48 }, percent: { dms: 0 } }
  test("quota and messages are the real values, not {} and []", () => {
    const m = [msg("2026-10-24T09:00:00Z", 9)]
    const j = analyzeJson({ boardId: 80, periodName: "week", metrics, quota, messages: m })
    expect(j.quota).toEqual(quota)
    expect(j.messages).toEqual(m)
    expect(j.metrics).toEqual({ total_completed: 0 })
    expect(j.period).toEqual({ name: "week", ...week })
    expect(j.by_type).toEqual(metrics.by_type)
  })
  test("an unavailable quota is {} and messages not requested are []", () => {
    const j = analyzeJson({ boardId: 80, periodName: "week", metrics, quota: null, messages: null })
    expect(j.quota).toEqual({})
    expect(j.messages).toEqual([])
  })
})

describe("#191709 — DMs Sent and the messages listed come from one query", () => {
  const serverDms = {
    sent: 8,
    previous_period: 4,
    avg_per_day: 1.1,
    messages: [
      { id: 2, lead_id: 7, lead_name: "Ana", type: "instagram_dm", message: "hey", sent_at: "2026-10-28T15:00:00Z" },
      { id: 1, lead_id: 9, lead_name: null, type: "linkedin_dm", message: "hi", sent_at: "2026-10-28T14:00:00Z" },
    ],
  }
  const metrics = { period: week, summary: { total_completed: 0 }, dms: serverDms }

  test("the headline is the server's DM count, not the step count (0 vs 8 on 2026-10-28)", () => {
    const ledger = dmLedger(metrics, 10)
    expect(sentHeadline(metrics.summary, ledger)).toEqual({ label: "DMs Sent", value: 8 })
  })
  test("the list is the same query's rows, mapped and capped", () => {
    const ledger = dmLedger(metrics, 1)!
    expect(ledger.messages).toEqual([{ date: "2026-10-28T15:00:00Z", channel: "IG", lead_id: 7, lead_name: "Ana", text: "hey" }])
    expect(dmLedger(metrics, 10)!.messages[1]).toMatchObject({ channel: "LI", lead_name: "#9" })
  })
  test("a server without dms: no ledger, and the step count is not called DMs Sent", () => {
    const old = { period: week, summary: { total_completed: 3 } }
    expect(dmLedger(old, 10)).toBeNull()
    expect(sentHeadline(old.summary, null)).toEqual({ label: "Steps Completed", value: 3 })
  })
  test("--json carries the same dms_sent the table prints", () => {
    const ledger = dmLedger(metrics, 10)
    const j = analyzeJson({ boardId: 80, periodName: "week", metrics, quota: null, messages: ledger!.messages, ledger })
    expect(j.dms_sent).toBe(8)
    expect(j.messages.length).toBe(2)
    expect(analyzeJson({ boardId: 80, periodName: "week", metrics, quota: null, messages: null }).dms_sent).toBeNull()
  })
  test("trend is DMs vs DMs", () => {
    expect(dmTrend(dmLedger(metrics, 10))).toEqual({ trend: "up", percent: 100 })
    expect(dmTrend(null)).toBeNull()
  })
})
