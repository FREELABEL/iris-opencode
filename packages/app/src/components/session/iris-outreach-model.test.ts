import { describe, expect, test } from "bun:test"
import type { Conversation } from "./iris-inbox-model"
import { AUDIENCE_COURSES, AUDIENCE_CREATORS, BATCHES, CAMPAIGNS, COMMS, STRATEGIES } from "./iris-outreach.fixtures"
import {
  audienceGroups,
  audienceWarning,
  batchInReview,
  campaignViews,
  daysWord,
  filterMine,
  peopleWord,
  delayWord,
  leadView,
  onCount,
  segmentQuery,
  strategyOrder,
  todayCount,
  todayQueue,
  type AudienceAnswer,
  type CampaignRow,
  type Strategy,
} from "./iris-outreach-model"
import type { ReviewBatch } from "./iris-reachr-review-model"

const rows = CAMPAIGNS.data.campaigns as unknown as CampaignRow[]
const courses = AUDIENCE_COURSES.data as unknown as AudienceAnswer
const creators = AUDIENCE_CREATORS.data as unknown as AudienceAnswer
const convs = COMMS.conversations as unknown as Conversation[]

describe("campaign rows (recorded 2026-11-14)", () => {
  const views = campaignViews(rows)
  test("every campaign, the ones that are on first, then by label", () => {
    expect(views).toHaveLength(rows.length)
    expect(onCount(rows)).toBe(2)
    expect(views.slice(0, 2).map((v) => [v.label, v.on])).toEqual([
      ["AI Course Outreach", true],
      ["Creator Outreach", true],
    ])
    expect(views.slice(2).every((v) => !v.on)).toBe(true)
  })
  test("board, sender, script and cap read as measured — the cap says it is the default", () => {
    const c = views.find((v) => v.label === "AI Course Outreach")!
    expect(c).toMatchObject({ board: "#38", sender: "@heyiris.io", script: "Roadmap Commenters | V1", eligible: "6,050", cap: "40/day (default)" })
  })
  test("a campaign with no Instagram account sends on LinkedIn at 25/day", () => {
    const g = views.find((v) => v.label === "Good Deals Outreach")!
    expect(g.sender).toBe("LinkedIn")
    expect(g.cap).toBe("25/day (default)")
  })
  test("fits is '—' until the board is scanned; then days left follow the fitting leads, not the board", () => {
    const before = views.find((v) => v.label === "AI Course Outreach")!
    expect(before.fits).toBe("—")
    expect(before.days).toBe("151 days")
    const after = campaignViews(rows.map((r) => (r.id === 1 ? { ...r, fits: courses.report!.matching_eligible } : r))).find((v) => v.id === 1)!
    expect(after.fits).toBe("226")
    expect(after.days).toBe("5.7 days")
    expect(after.short).toBe(true)
  })
  test("an empty pool says empty, an unread one says —", () => {
    expect(views.find((v) => v.label === "Mayo Outreach")!.days).toBe("empty")
    expect(daysWord(null, null)).toBe("—")
  })
})

describe("audience grouping (recorded preflight)", () => {
  test("courses: the script's post first-class, the no-source-post leads counted, biggest first", () => {
    const g = audienceGroups(courses)
    expect(g[0]).toMatchObject({ label: "No source post", count: 5807, share: 96, target: false })
    expect(g[0]!.url).toBeUndefined()
    const roadmap = g.find((x) => x.key === "De9Uw8Ilhne")!
    expect(roadmap).toMatchObject({ count: 226, share: 4, target: true, url: "https://www.instagram.com/p/De9Uw8Ilhne/" })
    expect(roadmap.words.startsWith('"roadmap" 211')).toBe(true)
    // Every lead scanned is in exactly one group, or in a post beyond the top five.
    expect(g.reduce((n, x) => n + x.count, 0)).toBeLessThanOrEqual(courses.report!.scanned)
  })
  test("the mismatch is said in the report's own words", () => {
    expect(audienceWarning(courses.report)).toBe(`Mismatch: ${courses.report!.audience_reason}.`)
  })
  test("creators: the script names no audience, so no post is marked as its target and it says unchecked", () => {
    const g = audienceGroups(creators)
    expect(g.some((x) => x.target)).toBe(false)
    expect(g[0]).toMatchObject({ key: "DYIeJvBmY3n", count: 1919 })
    expect(audienceWarning(creators.report)).toStartWith("Unchecked:")
  })
  test("no report, no groups", () => {
    expect(audienceGroups(undefined)).toEqual([])
    expect(audienceWarning(null)).toBeUndefined()
  })
})

describe("leads in a segment", () => {
  test("the query filters by the stored post URL exactly, or the whole board", () => {
    expect(segmentQuery(38, "https://www.instagram.com/p/De9Uw8Ilhne/", 2)).toEqual({
      bloq_id: "38",
      custom_field_key: "source_post_url",
      custom_field_value: "https://www.instagram.com/p/De9Uw8Ilhne/",
      sort: "updated_at",
      order: "desc",
      per_page: "25",
      page: "2",
    })
    expect(segmentQuery(38, undefined, 1)).not.toHaveProperty("custom_field_key")
  })
  test("a lead row: comment, status, steps done of steps, replied (fl-api sends 0/1)", () => {
    const l = leadView({ id: 7, name: "x", status: "Prospected", has_replied: 0, outreach_completed_count: 0, outreach_steps_count: 5, custom_fields: { comment: " Roadmap " } })
    expect(l).toEqual({ id: 7, name: "x", comment: "Roadmap", status: "Prospected", step: "0/5", replied: false })
    expect(leadView({ id: 8, has_replied: 1 }).replied).toBe(true)
  })
})

describe("scripts (recorded strategies)", () => {
  const list = STRATEGIES.data.strategies as unknown as Strategy[]
  test("each strategy knows the campaigns that run it", () => {
    const roadmap = list.find((s) => s.id === 58)!
    expect(roadmap.campaigns!.map((c) => c.label)).toEqual(["AI Course Outreach"])
    expect(roadmap.usage_count).toBe(174)
    expect(roadmap.replies).toBe(1)
    expect(roadmap.steps[0]!.type).toBe("instagram")
  })
  test("run by a campaign first, then by use", () => {
    const ordered = strategyOrder([...list, { id: 1, bloq_id: 1, name: "Unused", description: null, category: null, usage_count: 999, replies: null, last_reply_at: null, steps: [], campaigns: [] }])
    expect(ordered.at(-1)!.name).toBe("Unused")
    expect(ordered[0]!.name).toBe("Mayo Outreach | V2") // 216 uses
  })
  test("delays read as people say them", () => {
    expect([0, 48, 96, 168, 30].map(delayWord)).toEqual(["day 0", "+48h", "+4 days", "+7 days", "+30h"])
  })
})

describe("the Today queue: replies first, then review", () => {
  // No batch was in review when this was recorded (BATCHES.data is []), so the review rows below are
  // the smallest batch shape the queue reads — counts per status, as fl-api groups them.
  const batch = (id: number, counts: Record<string, number>, starts_at: string | null = null) =>
    ({ id, name: `Batch ${id}`, status: "draft", stopped_reason: null, starts_at, pace_min_seconds: 180, pace_max_seconds: 300, counts }) as ReviewBatch

  test("recorded: only conversations that need a reply, newest inbound first", () => {
    const q = todayQueue(convs, BATCHES.data as unknown as ReviewBatch[])
    const need = convs.filter((c) => c.needsReply)
    expect(q).toHaveLength(need.length)
    expect(q.every((i) => i.kind === "reply")).toBe(true)
    const at = q.map((i) => i.at)
    expect([...at].sort().reverse()).toEqual(at)
    expect(todayCount(convs, [])).toBe(COMMS.counts.needsReply)
  })
  test("replies before review; a batch counts only its messages in review; empty batches drop out", () => {
    const q = todayQueue(convs.slice(0, 6), [batch(2, { pending_approval: 3, approved: 4 }, "2026-11-15T01:00:00Z"), batch(3, { sent: 9 }), batch(1, { draft: 1, pending_approval: 1 }, "2026-11-14T01:00:00Z")])
    const kinds = q.map((i) => i.kind)
    expect(kinds.lastIndexOf("reply")).toBeLessThan(kinds.indexOf("review"))
    expect(q.filter((i) => i.kind === "review").map((i) => i.key)).toEqual(["review:1", "review:2"])
    expect(batchInReview(batch(2, { pending_approval: 3, approved: 4 }))).toBe(3)
  })
  test("the count is replies plus messages in review; unknown when neither was read", () => {
    const replies = convs.filter((c) => c.needsReply).length
    expect(todayCount(convs, [batch(1, { pending_approval: 5 })])).toBe(replies + 5)
    expect(todayCount(undefined, undefined)).toBeUndefined()
  })
})

describe("people on a campaign (#193486, not live yet)", () => {
  test("no members field (today's fl-api) or an empty list reads 'No one assigned'", () => {
    expect(rows.every((r) => r.members === null)).toBe(true)
    expect(campaignViews(rows).every((v) => v.people === "No one assigned")).toBe(true)
    expect(peopleWord([])).toBe("No one assigned")
  })
  test("owners first, agents marked", () => {
    expect(
      peopleWord([
        { type: "user", id: 2, name: "Emily", role: "rep" },
        { type: "agent", id: 9, name: "Reachr", role: "rep" },
        { type: "user", id: 1, name: "Dani", role: "owner" },
      ]),
    ).toBe("Dani (owner), Emily, Reachr · agent")
  })
  test("Mine filters only when /campaigns/mine answered; null (404, not deployed) leaves every row", () => {
    expect(filterMine(rows, null, true)).toHaveLength(rows.length)
    expect(filterMine(rows, [1, 2], true).map((r) => r.id)).toEqual(rows.filter((r) => r.id === 1 || r.id === 2).map((r) => r.id))
    expect(filterMine(rows, [1], false)).toHaveLength(rows.length)
  })
})
