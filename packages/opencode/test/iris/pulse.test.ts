import { describe, expect, test } from "bun:test"
import { contactRoute, topicStop, topicSummary, type ContactInputs } from "../../src/iris/pulse"
import type { SourceSweep } from "../../src/iris/pulse/sweep"

const from = (id: string) => `iris pulse check "x" --sources ${id}`

describe("pulse topic (#189286)", () => {
  test("a source that could not look is SHUT with its reason — its count is null, never 0", () => {
    const s = topicStop({ source: "imessage", searched: false, unavailableReason: "iMessage is only readable on macOS", hits: 0, items: [] }, from)
    expect(s.shut).toBe(true)
    expect(s.count).toBeNull()
    expect(s.provenance).toBe("not-measured")
    expect(s.text).toContain("macOS")
    expect(s.fix?.label).toBe("Run this route on the Mac")
  })

  test("a capped count is a floor, and is never compared with the window before", () => {
    const s = topicStop({ source: "git", searched: true, hits: 200, hitsPrior: 150, capped: true, items: [] }, from)
    expect([s.count, s.floor, s.delta, s.provenance]).toEqual([200, true, null, "partial"])
    expect(s.text).toStartWith("At least 200 commits")
  })

  test("an uncapped count carries its change against the window before", () => {
    const s = topicStop({ source: "bloq", searched: true, hits: 53, hitsPrior: 56, items: [] }, from)
    expect([s.count, s.delta, s.provenance]).toEqual([53, -3, "measured"])
    expect(s.text).toContain("3 fewer")
  })

  test("summary: prior only when every read stop could reconstruct it; shut stops are counted, not summed", () => {
    const sweeps: SourceSweep[] = [
      { source: "git", searched: true, hits: 10, hitsPrior: 4, items: [], lastHitEpoch: 1_700_000_000 },
      { source: "files", searched: true, hits: 0, hitsPrior: 0, items: [] },
      { source: "imessage", searched: false, unavailableReason: "mac only", hits: 0, items: [] },
    ]
    expect(topicSummary(sweeps)).toEqual({ hits: 10, floor: false, withHits: 1, reachable: 2, total: 3, shut: 1, prior: 4, lastTouched: 1_700_000_000_000 })
    sweeps.push({ source: "opencode", searched: true, hits: 3, items: [] })
    expect(topicSummary(sweeps).prior).toBeNull()
  })
})

const NOW = Date.parse("2026-10-13T12:00:00Z")
const ok = (body: unknown) => ({ ok: true as const, body })
const base: ContactInputs = {
  lead: { id: 7, name: "Injury law client", status: "In Negotiation", email: "c@example.com" },
  activities: ok({ data: [{ activity_type: "meeting_note", created_at: "2026-08-17T10:00:00Z", content: "met" }] }),
  deal: ok({ data: { has_payment_gate: true, contract_signed: false, payment_received: false, amount: 125, billing_type: "monthly", reminders_sent: 0, reminders_total: 3, created_at: "2026-05-25 14:16:32" } }),
  tasks: ok({ data: { tasks: [{ title: "Give them a login", is_completed: false, due_date: "2026-05-23" }, { title: "Done thing", is_completed: true }] } }),
  checks: ok({ total: 5, passing: 5, failing: 0, last_run: "2026-05-11T00:00:00Z" }),
  readiness: ok({ data: { score: 60, band: "at_risk", previous_score: 58, coverage: { ratio: 92 }, history: [{ score: 60, created_at: "b" }, { score: 58, created_at: "a" }] } }),
  gmail: ok({ threads: [] }),
}

describe("pulse contact (#189286)", () => {
  test("the unpaid gate and the overdue task are owed, with how long", () => {
    const r = contactRoute(base, { days: 30, now: NOW })
    expect(r.owed[0]).toEqual({ what: "Signed contract + first payment", amount: "$125/mo", since: "141 d" })
    expect(r.owed[1].what).toBe("Overdue: Give them a login")
    const deal = r.stops.find((s) => s.id === "deal")!
    expect(deal.text).toBe("Payment gate waiting on both: contract unsigned, $125/mo unpaid. 0 of 3 reminders sent.")
  })

  test("a check that has not run in a week is 'not kept', not measured", () => {
    const checks = contactRoute(base, { days: 30, now: NOW }).stops.find((s) => s.id === "checks")!
    expect([checks.count, checks.provenance]).toEqual([5, "not-kept"])
  })

  test("channels the app cannot read are SHUT — the calendar is never 'no meetings'", () => {
    const r = contactRoute(base, { days: 30, now: NOW })
    const meetings = r.stops.find((s) => s.id === "meetings")!
    expect([meetings.shut, meetings.count]).toEqual([true, null])
    expect(meetings.text).toContain("not “no meetings”")
    expect(r.channels).toEqual({ read: 1, total: 5 })
  })

  test("a failed read is a shut stop with the reason, and the route still renders", () => {
    const r = contactRoute({ ...base, deal: { ok: false, why: "HTTP 500" } }, { days: 30, now: NOW })
    const deal = r.stops.find((s) => s.id === "deal")!
    expect([deal.shut, deal.count, deal.reason]).toEqual([true, null, "could not read the deal (HTTP 500)"])
    expect(r.owed.some((o) => o.what.includes("contract"))).toBe(false)
  })

  test("score history runs oldest to newest and coverage is a fraction", () => {
    const r = contactRoute(base, { days: 30, now: NOW })
    expect(r.score.history.map((h) => h.score)).toEqual([58, 60])
    expect(r.score.coverage).toBe(0.92)
  })
})
