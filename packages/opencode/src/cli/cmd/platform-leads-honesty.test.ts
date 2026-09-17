import { describe, test, expect } from "bun:test"

import {
  mergeRefreshIntoChecks,
  channelShortName,
  groupChannelBlindness,
  sentimentSufficiency,
  latestTouch,
  collectTouchCandidates,
  hydrationDecision,
  normalizeTaskStatus,
  normalizeTask,
  taskTitleKey,
  findDuplicateTaskGroups,
  resolveNextBestAction,
  normalizeTouchDate,
  buildTouchPayload,
  nextFollowUpState,
  type ChannelHealthLike,
} from "./platform-leads-honesty"

// =============================================================================
// #184926 — a score must not be emitted when the measurement did not happen
// =============================================================================
//
// Observed on lead #15743 in a single pulse run: Integration Health reported four
// of six channels DOWN, and pulse printed "Engagement: 20/100", "Last outreach
// 2695h ago" and a HIGH payment follow-up with no qualifier. The number could not
// distinguish "this lead has gone quiet" from "we lost the ability to look".

/** The exact channel set from the bug report, in the order pulse probes them. */
const VANGUARD_RUN: ChannelHealthLike[] = [
  { name: "Gmail", ok: false, status: "not_connected", error: "No active 'gmail' connection found" },
  { name: "Google Calendar", ok: false, status: "no_permission", error: "No permission to read the Calendar store" },
  { name: "iMessage", ok: false, status: "no_permission", error: "No permission to read Messages" },
  { name: "WhatsApp", ok: true, status: "verified" },
  { name: "Apple Mail", ok: false, status: "no_permission", error: "No permission to read Mail" },
  { name: "IRIS Bridge", ok: true, status: "verified" },
]

describe("#184926 groupChannelBlindness", () => {
  test("maps probe names to the short tokens the message uses", () => {
    expect(channelShortName("Gmail")).toBe("gmail")
    expect(channelShortName("Google Calendar")).toBe("calendar")
    expect(channelShortName("iMessage")).toBe("imessage")
    expect(channelShortName("WhatsApp")).toBe("whatsapp")
    expect(channelShortName("Apple Mail")).toBe("applemail")
    expect(channelShortName("IRIS Bridge")).toBe("bridge")
  })

  test("unknown channel names fall back to a slug rather than vanishing", () => {
    expect(channelShortName("Microsoft Teams")).toBe("microsoftteams")
  })

  test("the vanguard run is reported as 4/6 blind, naming exactly the blind ones", () => {
    const b = groupChannelBlindness(VANGUARD_RUN)
    expect(b.total).toBe(6)
    expect(b.blind).toBe(4)
    expect(b.live).toBe(2)
    expect(b.blindNames).toEqual(["gmail", "calendar", "imessage", "applemail"])
    expect(b.summary).toBe("4/6 channels blind (gmail, calendar, imessage, applemail)")
  })

  test("4 of 6 blind is UNAVAILABLE — blind at least matches live", () => {
    expect(groupChannelBlindness(VANGUARD_RUN).unavailable).toBe(true)
  })

  test("3 of 6 blind is NOT unavailable — it is a partial read, still qualified", () => {
    const partial = groupChannelBlindness([
      { name: "Gmail", ok: false, status: "expired" },
      { name: "Google Calendar", ok: true, status: "verified" },
      { name: "iMessage", ok: false, status: "no_permission" },
      { name: "WhatsApp", ok: true, status: "verified" },
      { name: "Apple Mail", ok: false, status: "no_permission" },
      { name: "IRIS Bridge", ok: true, status: "verified" },
    ])
    expect(partial.blind).toBe(3)
    expect(partial.unavailable).toBe(false)
    expect(partial.partial).toBe(true)
  })

  test("one blind channel is partial, not unavailable", () => {
    const one = groupChannelBlindness([
      { name: "Gmail", ok: false, status: "expired" },
      { name: "iMessage", ok: true, status: "verified" },
      { name: "IRIS Bridge", ok: true, status: "verified" },
    ])
    expect(one.partial).toBe(true)
    expect(one.unavailable).toBe(false)
  })

  test("all channels live is neither blind nor partial", () => {
    const clean = groupChannelBlindness([
      { name: "Gmail", ok: true, status: "verified" },
      { name: "iMessage", ok: true, status: "verified" },
      { name: "IRIS Bridge", ok: true, status: "verified" },
    ])
    expect(clean.blind).toBe(0)
    expect(clean.partial).toBe(false)
    expect(clean.unavailable).toBe(false)
    expect(clean.summary).toBe("0/3 channels blind")
  })

  test("a failed probe batch (no results) is blind, not clean", () => {
    const none = groupChannelBlindness([])
    expect(none.unavailable).toBe(true)
    expect(none.total).toBe(0)
    expect(none.summary).toBe("channel health could not be measured")
  })

  test("singular phrasing for one blind channel", () => {
    const one = groupChannelBlindness([
      { name: "Gmail", ok: false, status: "expired" },
      { name: "IRIS Bridge", ok: true, status: "verified" },
    ])
    expect(one.summary).toBe("1/2 channels blind (gmail)")
  })
})

// =============================================================================
// #184940 — never characterise a relationship from a sample of one
// =============================================================================

const NOW = new Date("2026-09-13T12:00:00Z")
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86400_000).toISOString()

describe("#184940 sentimentSufficiency", () => {
  test("the exact bug case: one outbound email, 112 days old, 3 of 6 channels unreadable", () => {
    const s = sentimentSufficiency([{ date: daysAgo(112), isOutbound: true, channel: "Gmail" }], {
      blindCount: 3,
      totalChannels: 6,
      now: NOW,
    })
    expect(s.sufficient).toBe(false)
    expect(s.reason).toBe("sample_too_small")
    expect(s.sampled).toBe(1)
    expect(s.inbound).toBe(0)
    expect(s.detail).toBe("1 message sampled (outbound, 112 days old); 3 of 6 channels unreadable")
  })

  test("a larger sample with no inbound is still refused", () => {
    const s = sentimentSufficiency(
      [
        { date: daysAgo(10), isOutbound: true },
        { date: daysAgo(9), isOutbound: true },
        { date: daysAgo(8), isOutbound: true },
      ],
      { now: NOW },
    )
    expect(s.sufficient).toBe(false)
    expect(s.reason).toBe("no_inbound")
    expect(s.inbound).toBe(0)
  })

  test("a single inbound message is refused — sample of one either way", () => {
    const s = sentimentSufficiency([{ date: daysAgo(2), isOutbound: false }], { now: NOW })
    expect(s.sufficient).toBe(false)
    expect(s.reason).toBe("sample_too_small")
  })

  test("three messages including an inbound is sufficient", () => {
    const s = sentimentSufficiency(
      [
        { date: daysAgo(5), isOutbound: true },
        { date: daysAgo(3), isOutbound: false },
        { date: daysAgo(1), isOutbound: true },
      ],
      { now: NOW },
    )
    expect(s.sufficient).toBe(true)
    expect(s.reason).toBe("ok")
    expect(s.inbound).toBe(1)
    expect(s.outbound).toBe(2)
  })

  test("no messages at all reports zero, not a neutral verdict", () => {
    const s = sentimentSufficiency([], { blindCount: 4, totalChannels: 6, now: NOW })
    expect(s.sufficient).toBe(false)
    expect(s.reason).toBe("no_messages")
    expect(s.detail).toBe("no messages sampled; 4 of 6 channels unreadable")
  })

  test("channel clause is omitted when every channel was readable", () => {
    const s = sentimentSufficiency([{ date: daysAgo(112), isOutbound: true }], { now: NOW })
    expect(s.detail).toBe("1 message sampled (outbound, 112 days old)")
  })

  test("mixed direction is named as mixed, and age counts from the newest message", () => {
    const s = sentimentSufficiency(
      [
        { date: daysAgo(200), isOutbound: true },
        { date: daysAgo(4), isOutbound: false },
      ],
      { now: NOW },
    )
    expect(s.detail).toBe("2 messages sampled (mixed, 4 days old)")
  })

  test("a message with no usable date does not crash the age calculation", () => {
    const s = sentimentSufficiency([{ date: "", isOutbound: true }, { date: daysAgo(3), isOutbound: false }], { now: NOW })
    expect(s.sufficient).toBe(false)
    expect(s.newestAgeDays).toBe(3)
  })
})

// =============================================================================
// #184927 — hydration must read every channel, not just outbound sequence sends
// =============================================================================

describe("#184927 latestTouch", () => {
  test("a logged phone call counts as contact", () => {
    const t = latestTouch([
      { at: daysAgo(30), source: "outreach_send" },
      { at: daysAgo(0), source: "call_log" },
    ])
    expect(t.at?.toISOString()).toBe(new Date(daysAgo(0)).toISOString())
    expect(t.source).toBe("call_log")
  })

  test("a note counts as contact", () => {
    const t = latestTouch([
      { at: daysAgo(60), source: "outreach_send" },
      { at: daysAgo(1), source: "note" },
    ])
    expect(t.source).toBe("note")
  })

  test("an inbound message counts as contact", () => {
    const t = latestTouch([
      { at: daysAgo(10), source: "outreach_send" },
      { at: daysAgo(2), source: "inbound" },
    ])
    expect(t.source).toBe("inbound")
  })

  test("meeting intel counts as contact", () => {
    const t = latestTouch([{ at: daysAgo(0.5), source: "meeting_intel" }])
    expect(t.source).toBe("meeting_intel")
  })

  test("null, undefined and unparseable dates are ignored", () => {
    const t = latestTouch([
      { at: null, source: "note" },
      { at: undefined, source: "call_log" },
      { at: "not-a-date", source: "note" },
      { at: daysAgo(4), source: "inbound" },
    ])
    expect(t.source).toBe("inbound")
  })

  test("no candidates at all yields null, not a fabricated timestamp", () => {
    expect(latestTouch([])).toEqual({ at: null, source: null })
  })

  test("ties prefer the earlier-listed candidate so call order is stable", () => {
    const t = latestTouch([
      { at: daysAgo(3), source: "outreach_send" },
      { at: daysAgo(3), source: "note" },
    ])
    expect(t.source).toBe("outreach_send")
  })
})

describe("#184927 collectTouchCandidates", () => {
  test("the bug scenario: a phone call logged today is a touch even with no outreach send", () => {
    const candidates = collectTouchCandidates({
      lastOutboundAt: null,
      activities: [{ created_at: daysAgo(0), type: "call_log", content: "Called Richard re funding" }],
      notes: [],
      outreachSteps: [],
    })
    const t = latestTouch(candidates)
    expect(t.source).toBe("call_log")
    expect(t.at?.toISOString()).toBe(new Date(daysAgo(0)).toISOString())
  })

  test("meeting intel is classified separately from a note", () => {
    const candidates = collectTouchCandidates({
      activities: [{ created_at: daysAgo(1), activity_type: "meeting_intel" }],
    })
    expect(latestTouch(candidates).source).toBe("meeting_intel")
  })

  test("a CRM note is a touch", () => {
    const candidates = collectTouchCandidates({
      notes: [{ created_at: daysAgo(3), content: "Discussed budget" }],
    })
    expect(latestTouch(candidates).source).toBe("note")
  })

  test("only completed outreach steps count as a touch", () => {
    const candidates = collectTouchCandidates({
      outreachSteps: [
        { id: 1, due_date: daysAgo(1) },
        { id: 2, completed_at: daysAgo(60) },
      ],
    })
    expect(candidates).toHaveLength(1)
    expect(latestTouch(candidates).source).toBe("outreach_send")
  })

  test("inbound channel messages are touches", () => {
    const candidates = collectTouchCandidates({
      channelMessages: [{ date: daysAgo(2), isOutbound: false }, { date: daysAgo(90), isOutbound: false }],
    })
    expect(candidates).toHaveLength(2)
    expect(latestTouch(candidates).source).toBe("inbound")
  })

  test("an outbound message we sent is a touch — 'never' must not be claimed over it", () => {
    const candidates = collectTouchCandidates({
      channelMessages: [{ date: daysAgo(5), isOutbound: true }],
    })
    expect(latestTouch(candidates).source).toBe("outreach_send")
  })

  test("the newest of all sources wins, and it is the call from today", () => {
    const candidates = collectTouchCandidates({
      lastOutboundAt: daysAgo(112),
      lastInboundAt: daysAgo(400),
      notes: [{ created_at: daysAgo(3) }],
      activities: [{ created_at: daysAgo(0), type: "call_log" }],
      outreachSteps: [{ completed_at: daysAgo(50) }],
      channelMessages: [{ date: daysAgo(20), isOutbound: false }],
    })
    const t = latestTouch(candidates)
    expect(t.source).toBe("call_log")
    expect(t.at?.toISOString()).toBe(new Date(daysAgo(0)).toISOString())
  })

  test("an empty payload yields no candidates rather than a fake touch", () => {
    expect(collectTouchCandidates({})).toEqual([])
  })

  test("records without timestamps are skipped, not dated to now", () => {
    const candidates = collectTouchCandidates({
      notes: [{ content: "undated" }, { created_at: daysAgo(5) }],
      activities: [{ type: "call_log" }],
    })
    expect(candidates).toHaveLength(1)
  })
})

describe("#184927 hydrationDecision", () => {
  test("contact 2 hours ago suppresses the follow-up even past the window", () => {
    const d = hydrationDecision({
      lastTouchAt: new Date(NOW.getTime() - 2 * 3600_000),
      now: NOW,
      windowHours: 24,
      blind: false,
    })
    expect(d.eligible).toBe(false)
    expect(d.reason).toBe("inside_window")
    expect(d.hoursSinceLabel).toBe("2h ago")
  })

  test("no contact at all is eligible", () => {
    const d = hydrationDecision({ lastTouchAt: null, now: NOW, windowHours: 24, blind: false })
    expect(d.eligible).toBe(true)
    expect(d.reason).toBe("eligible")
    expect(d.hoursSinceLabel).toBe("never")
  })

  test("blind channels refuse the send even when the window has elapsed", () => {
    const d = hydrationDecision({
      lastTouchAt: new Date(NOW.getTime() - 2695 * 3600_000),
      now: NOW,
      windowHours: 24,
      blind: true,
      blindSummary: "4/6 channels blind (gmail, calendar, imessage, applemail)",
    })
    expect(d.eligible).toBe(false)
    expect(d.suppressedByBlindness).toBe(true)
    expect(d.reason).toBe("channels_blind")
  })

  test("an explicit force overrides blindness but says so", () => {
    const d = hydrationDecision({
      lastTouchAt: new Date(NOW.getTime() - 2695 * 3600_000),
      now: NOW,
      windowHours: 24,
      blind: true,
      force: true,
    })
    expect(d.eligible).toBe(true)
    expect(d.suppressedByBlindness).toBe(true)
    expect(d.reason).toBe("forced_despite_blindness")
  })

  test("blindness is checked before recency — a recent call is still refused", () => {
    const d = hydrationDecision({
      lastTouchAt: new Date(NOW.getTime() - 3600_000),
      now: NOW,
      windowHours: 24,
      blind: true,
    })
    expect(d.eligible).toBe(false)
    expect(d.reason).not.toBe("inside_window")
  })
})

// =============================================================================
// #184936 — a null `status` is worse than no key: it fails open
// =============================================================================

describe("#184936 normalizeTaskStatus", () => {
  test("is_completed true is completed regardless of dates", () => {
    expect(normalizeTaskStatus({ is_completed: true, completed_at: "2026-05-08T00:00:00Z", due_date: "2026-01-01" }, NOW)).toBe(
      "completed",
    )
  })

  test("incomplete with a past due date is overdue — the value the row lacked", () => {
    expect(normalizeTaskStatus({ is_completed: false, due_date: "2026-04-01T00:00:00Z" }, NOW)).toBe("overdue")
  })

  test("incomplete with a future due date is pending", () => {
    expect(normalizeTaskStatus({ is_completed: false, due_date: "2026-12-01T00:00:00Z" }, NOW)).toBe("pending")
  })

  test("incomplete with no due date is pending, not overdue", () => {
    expect(normalizeTaskStatus({ is_completed: false, due_date: null }, NOW)).toBe("pending")
  })

  test("a completed_at with is_completed absent still reads completed", () => {
    expect(normalizeTaskStatus({ completed_at: "2026-05-08T00:00:00Z" }, NOW)).toBe("completed")
  })

  test("an unparseable due date does not masquerade as overdue", () => {
    expect(normalizeTaskStatus({ is_completed: false, due_date: "soon" }, NOW)).toBe("pending")
  })

  test("normalizeTask preserves the raw fields for back-compat", () => {
    const t = normalizeTask({ id: 391, is_completed: true, completed_at: "2026-05-08T00:00:00Z", title: "Done thing" }, NOW)
    expect(t.id).toBe(391)
    expect(t.is_completed).toBe(true)
    expect(t.status).toBe("completed")
  })
})

// =============================================================================
// #184941 — duplicates inflate every derived metric
// =============================================================================

describe("#184941 taskTitleKey", () => {
  test("byte-identical titles collapse", () => {
    expect(taskTitleKey("Map vanguardhcs.com domain to Genesis")).toBe(
      taskTitleKey("Map vanguardhcs.com domain to Genesis"),
    )
  })

  test("a trailing ellipsis is not a different task", () => {
    expect(taskTitleKey("Map vanguardhcs.com domain to Genesis…")).toBe(
      taskTitleKey("Map vanguardhcs.com domain to Genesis"),
    )
  })

  test("case and punctuation are not differences", () => {
    expect(taskTitleKey("Map vanguardhcs.com domain to Genesis!")).toBe(
      taskTitleKey("map vanguardhcs com domain to genesis"),
    )
  })

  test("genuinely different tasks keep different keys", () => {
    expect(taskTitleKey("Map domain")).not.toBe(taskTitleKey("Map DNS"))
  })
})

describe("#184941 findDuplicateTaskGroups", () => {
  test("finds the #682/#685 pair that was byte-identical", () => {
    const groups = findDuplicateTaskGroups([
      { id: 682, title: "Map vanguardhcs.com domain to Genesis" },
      { id: 685, title: "Map vanguardhcs.com domain to Genesis" },
      { id: 999, title: "Send invoice" },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].ids).toEqual([682, 685])
  })

  test("the #673/#682/#685 triple collapses into one group of three", () => {
    const groups = findDuplicateTaskGroups([
      { id: 673, title: "Map vanguardhcs.com domain to Genesis…" },
      { id: 682, title: "Map vanguardhcs.com domain to Genesis" },
      { id: 685, title: "Map vanguardhcs.com domain to genesis" },
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0].ids).toEqual([673, 682, 685])
  })

  test("no duplicates yields no groups", () => {
    expect(findDuplicateTaskGroups([{ id: 1, title: "A" }, { id: 2, title: "B" }])).toEqual([])
  })

  test("completed tasks are excluded — a resolved duplicate is not a live problem", () => {
    const groups = findDuplicateTaskGroups([
      { id: 1, title: "Same thing", is_completed: true },
      { id: 2, title: "Same thing", is_completed: false },
    ])
    expect(groups).toEqual([])
  })

  test("untitled rows are not all treated as duplicates of each other", () => {
    const groups = findDuplicateTaskGroups([
      { id: 1, title: "" },
      { id: 2, title: "" },
    ])
    expect(groups).toEqual([])
  })
})

// =============================================================================
// #184926 (continued) — recommendation must refuse to act on a blind read
// =============================================================================

describe("#184926 resolveNextBestAction", () => {
  const blind = groupChannelBlindness(VANGUARD_RUN)

  test("a blind read recommends the permission fix, not outreach", () => {
    const r = resolveNextBestAction({
      blindness: blind,
      hasPaymentGate: true,
      paymentReceived: false,
      lastOutboundAt: new Date(NOW.getTime() - 2695 * 3600_000),
      status: "Active",
      now: NOW,
    })
    expect(r.priority).toBe("high")
    expect(r.action).toContain("channels blind")
    expect(r.action).not.toContain("payment follow-up")
    expect(r.action).not.toContain("Re-engage")
  })

  test("the blindness recommendation names the real remedy", () => {
    const r = resolveNextBestAction({ blindness: blind, status: "Active", now: NOW })
    expect(r.hint).toContain("Full Disk Access")
  })

  test("with channels readable, the payment gate rule fires as before", () => {
    const clear = groupChannelBlindness([
      { name: "Gmail", ok: true, status: "verified" },
      { name: "iMessage", ok: true, status: "verified" },
    ])
    const r = resolveNextBestAction({
      blindness: clear,
      hasPaymentGate: true,
      paymentReceived: false,
      lastOutboundAt: new Date(NOW.getTime() - 72 * 3600_000),
      status: "Active",
      now: NOW,
    })
    expect(r.action).toContain("payment follow-up")
    expect(r.priority).toBe("high")
  })

  test("\"last outreach never\" is not claimed when the read was blind", () => {
    const r = resolveNextBestAction({
      blindness: blind,
      hasPaymentGate: true,
      paymentReceived: false,
      lastOutboundAt: null,
      status: "Active",
      now: NOW,
    })
    expect(r.action).not.toContain("never")
  })

  test("a recent phone call suppresses the stale-outreach action on a clear read", () => {
    const clear = groupChannelBlindness([{ name: "Gmail", ok: true, status: "verified" }])
    const r = resolveNextBestAction({
      blindness: clear,
      hasPaymentGate: true,
      paymentReceived: false,
      lastOutboundAt: new Date(NOW.getTime() - 2 * 3600_000),
      status: "Active",
      now: NOW,
    })
    expect(r.action).toContain("Wait for payment")
    expect(r.priority).toBe("low")
  })
})

// =============================================================================
// #184939 — nowhere to put a date, so a pulse recommendation can never be closed
// =============================================================================
describe("normalizeTouchDate", () => {
  test("resolves 'today' against the given clock, not the machine's", () => {
    // A `now` far from the machine's real date on purpose: if the implementation ignores
    // the argument and calls new Date(), this returns today's real date instead and fails.
    const now = new Date("2019-03-04T22:30:00Z")
    expect(normalizeTouchDate("today", now)).toBe("2019-03-04")
  })

  test("accepts an explicit ISO date unchanged", () => {
    expect(normalizeTouchDate("2026-08-01")).toBe("2026-08-01")
  })

  test("accepts a full ISO timestamp by taking its date", () => {
    expect(normalizeTouchDate("2026-08-01T14:22:00Z")).toBe("2026-08-01")
  })

  test("refuses free prose — a date field that silently accepts 'sometime' is not a date field", () => {
    expect(normalizeTouchDate("spoke to him the other day")).toBeNull()
    expect(normalizeTouchDate("13/09/2026")).toBeNull()
    expect(normalizeTouchDate("")).toBeNull()
  })

  test("refuses an impossible calendar date rather than rolling it over", () => {
    expect(normalizeTouchDate("2026-02-31")).toBeNull()
    expect(normalizeTouchDate("2026-13-01")).toBeNull()
  })

  test("accepts yesterday/tomorrow relative tokens", () => {
    const now = new Date("2026-09-13T12:00:00Z")
    expect(normalizeTouchDate("yesterday", now)).toBe("2026-09-12")
    expect(normalizeTouchDate("tomorrow", now)).toBe("2026-09-14")
  })
})

describe("buildTouchPayload", () => {
  const ci = { email: "r@vanguardhcs.com", chat_ids: ["chat1"] }

  test("merges into contact_info without dropping the keys beside it", () => {
    const p = buildTouchPayload({ existing: ci, lastContacted: "2026-09-13" })
    expect(p.contact_info).toEqual({
      email: "r@vanguardhcs.com",
      chat_ids: ["chat1"],
      last_contacted: "2026-09-13",
    })
  })

  test("carries both dates when both are given", () => {
    const p = buildTouchPayload({ existing: ci, lastContacted: "2026-09-13", nextFollowUp: "2026-09-17" })
    expect(p.contact_info).toMatchObject({ last_contacted: "2026-09-13", next_follow_up: "2026-09-17" })
  })

  test("an empty choice emits nothing — never a null that would overwrite a real date", () => {
    const p = buildTouchPayload({ existing: ci })
    expect(p.contact_info).toBeUndefined()
    expect(p).toEqual({})
  })

  test("a lead with no contact_info yet still gets a payload", () => {
    const p = buildTouchPayload({ existing: null, lastContacted: "2026-09-13" })
    expect(p.contact_info).toEqual({ last_contacted: "2026-09-13" })
  })

  test("tolerates a non-object contact_info (JSON drift) without throwing", () => {
    const p = buildTouchPayload({ existing: "garbage" as any, lastContacted: "2026-09-13" })
    expect(p.contact_info).toEqual({ last_contacted: "2026-09-13" })
  })
})

describe("nextFollowUpState", () => {
  const NOW = new Date("2026-09-13T12:00:00Z")

  test("no date on the record means nothing is scheduled", () => {
    const s = nextFollowUpState({}, NOW)
    expect(s.scheduled).toBe(false)
    expect(s.label).toBe("")
  })

  test("a future date is scheduled and named with how far out it is", () => {
    const s = nextFollowUpState({ next_follow_up: "2026-09-17" }, NOW)
    expect(s.scheduled).toBe(true)
    expect(s.label).toContain("in 4 day")
    expect(s.overdue).toBe(false)
  })

  test("a due-today follow-up is scheduled and says so", () => {
    const s = nextFollowUpState({ next_follow_up: "2026-09-13" }, NOW)
    expect(s.scheduled).toBe(true)
    expect(s.overdue).toBe(false)
    expect(s.label.toLowerCase()).toContain("today")
  })

  test("a past date is overdue, and overdue is NOT the same as scheduled", () => {
    const s = nextFollowUpState({ next_follow_up: "2026-09-10" }, NOW)
    expect(s.scheduled).toBe(false)
    expect(s.overdue).toBe(true)
    expect(s.label).toContain("overdue")
  })

  test("reads a full timestamp too, for records written by other tools", () => {
    const s = nextFollowUpState({ next_follow_up: "2026-09-17T00:00:00Z" }, NOW)
    expect(s.scheduled).toBe(true)
  })

  test("unparseable prose is not a schedule — fail open to 'unknown', never to 'scheduled'", () => {
    const s = nextFollowUpState({ next_follow_up: "next Wednesday ish" }, NOW)
    expect(s.scheduled).toBe(false)
    expect(s.overdue).toBe(false)
  })
})

describe("mergeRefreshIntoChecks — what THIS RUN saw (#184926)", () => {
  const health = [
    { name: "Apple Mail", ok: false },
    { name: "iMessage", ok: false },
    { name: "Gmail", ok: false },
    { name: "WhatsApp", ok: true },
  ]

  test("a channel the refresh read is no longer blind, even though the daemon probe failed", () => {
    // Measured 2026-09-17: the daemon has no Full Disk Access, so its Apple Mail probe fails —
    // but pulse read that mailbox over AppleEvents in the same run.
    const merged = mergeRefreshIntoChecks(health, [{ name: "Apple Mail", ok: true }, { name: "iMessage", ok: true }])
    const blind = merged.filter((c) => !c.ok).map((c) => c.name)

    expect(blind).toEqual(["Gmail"])
  })

  test("a channel the refresh could NOT read stays blind", () => {
    const merged = mergeRefreshIntoChecks(health, [{ name: "Apple Mail", ok: false, detail: "Mail.app is not answering" }])

    expect(merged.find((c) => c.name === "Apple Mail")?.ok).toBe(false)
  })

  test("a refresh failure on a channel nothing probed is added as blind", () => {
    const merged = mergeRefreshIntoChecks([{ name: "Gmail", ok: true }], [{ name: "WhatsApp (store)", ok: false }])

    expect(merged.map((c) => c.name)).toContain("WhatsApp (store)")
    expect(merged.find((c) => c.name === "WhatsApp (store)")?.ok).toBe(false)
  })

  test("a healthy channel is never turned blind by the refresh saying it is fine", () => {
    const merged = mergeRefreshIntoChecks([{ name: "WhatsApp", ok: true }], [{ name: "WhatsApp", ok: true }])

    expect(merged).toEqual([{ name: "WhatsApp", ok: true }])
  })
})
