import { describe, expect, test } from "bun:test"
import { audienceCheck, audienceOf, campaignReport, commentKeyword, eligiblePoolPath, postKey, summarizePool, supply, type PoolLead } from "./som-preflight"

const lead = (post: string | null, comment = ""): PoolLead => ({
  custom_fields: { source_post_url: post ? `https://www.instagram.com/p/${post}/` : undefined, comment },
})
const many = (n: number, post: string | null, comment = "") => Array.from({ length: n }, () => lead(post, comment))

// Production strategies, 2026-10-30 (descriptions verbatim).
const roadmap = {
  name: "Roadmap Commenters | V1",
  description: "2026-10-28: first DM for people who commented 'Roadmap' on instagram.com/p/De9Uw8Ilhne (AI roadmap giveaway). One step, no link.",
  steps: [{ order: 0, instructions: "Saw you grabbed the AI roadmap. What are you trying to build with it?" }],
}
const guest = {
  name: "Guest Feature | V1",
  description: "Entrepreneurs/brands/business owners as featured guests on the Freelabel live stream — remote via Discord. Sender @thediscoverpage_.",
  steps: [{ order: 0, instructions: "We're lining up guests for the live stream..." }],
}

describe("parsing", () => {
  test("post shortcodes from /p/, /reel/ and user-prefixed reel URLs", () => {
    expect(postKey("https://www.instagram.com/p/De9Uw8Ilhne/")).toBe("De9Uw8Ilhne")
    expect(postKey("https://www.instagram.com/shawnapeezy/reel/DSGM0OuE4Ax/")).toBe("DSGM0OuE4Ax")
    expect(postKey("https://example.com/p/x")).toBeNull()
    expect(postKey(undefined)).toBeNull()
  })
  test("comments reduce to a short keyword; long comments are not keywords", () => {
    expect(commentKeyword("Roadmap!!")).toBe("roadmap")
    expect(commentKeyword(" SITE ")).toBe("site")
    expect(commentKeyword("🔥🔥")).toBeNull()
    expect(commentKeyword("this is a long sentence about things")).toBeNull()
  })
  test("the audience a strategy names: its post and its quoted word", () => {
    const a = audienceOf(roadmap)
    expect(a.posts).toEqual(["De9Uw8Ilhne"])
    expect(a.keywords).toEqual(["roadmap"])
    expect(audienceOf(guest).posts).toEqual([])
    expect(audienceOf(guest).keywords).toEqual([])
  })
})

describe("#191274 — days of supply", () => {
  test("eligible / daily cap, warned below the threshold", () => {
    expect(supply(280, 40, 7)).toEqual({ days: 7, level: "ok" })
    expect(supply(270, 40, 7)).toEqual({ days: 6.8, level: "low" })
    expect(supply(0, 40, 7)).toEqual({ days: 0, level: "empty" })
  })
  test("an exhausted board (355 for @freelabelnet) is a warning before the run", () => {
    const r = campaignReport({ campaign: "freelabelnet", active: false, board: 355, strategyName: "x", strategy: roadmap, eligible: 0, leads: [], dailyCap: 40, minDays: 7 })
    expect(r.supply).toBe("empty")
    expect(r.warnings.join(" ")).toContain("no eligible leads")
  })
})

describe("#191276 — lead list vs the strategy's audience", () => {
  test("strategy names a post: share of leads from it decides (board 38: 704 of 5000)", () => {
    const leads = [...many(704, "De9Uw8Ilhne", "roadmap"), ...many(4296, null)]
    const a = audienceCheck(audienceOf(roadmap), leads)
    expect(a.level).toBe("mismatch")
    expect(a.matching).toBe(704)
  })
  test("all from the named post is a match", () => {
    expect(audienceCheck(audienceOf(roadmap), many(50, "De9Uw8Ilhne", "roadmap")).level).toBe("match")
  })
  test("strategy names nothing, list dominated by one giveaway post (board 529 'Site') → mismatch", () => {
    const leads = [...many(89, "DZ-awTZEnZH", "Site"), ...many(11, "DZ-awTZEnZH", "")]
    const a = audienceCheck(audienceOf(guest), leads)
    expect(a.level).toBe("mismatch")
    expect(a.reason).toContain('"site"')
    expect(a.reason).toContain("/p/DZ-awTZEnZH")
  })
  test("dominant source the strategy does mention is a match", () => {
    const s = { ...guest, steps: [{ order: 0, instructions: "Thanks for asking about the site." }] }
    expect(audienceCheck(audienceOf(s), many(10, "DZ-awTZEnZH", "site")).level).toBe("match")
  })
  test("a mixed list with no named audience is 'unstated', not a pass or a fail", () => {
    const leads = [...many(3, "A1"), ...many(3, "B2"), ...many(4, null)]
    expect(audienceCheck(audienceOf(guest), leads).level).toBe("unstated")
  })
  test("matching supply is counted, not extrapolated — a partial scan is a floor", () => {
    const leads = [...many(200, "De9Uw8Ilhne", "roadmap"), ...many(800, null)]
    const r = campaignReport({ campaign: "courses", active: true, board: 38, strategyName: roadmap.name, strategy: roadmap, eligible: 2000, leads, dailyCap: 40, minDays: 7 })
    expect(r.matching_eligible).toBe(200)
    expect(r.matching_complete).toBe(false)
    expect(r.matching_days_of_supply).toBe(5)
    expect(r.warnings.some((w) => w.startsWith("audience mismatch"))).toBe(true)
    expect(r.warnings.some((w) => w.includes("at least 200 leads match"))).toBe(true)
  })
  test("a strategy that does not exist on the board is reported", () => {
    const r = campaignReport({ campaign: "x", active: true, board: 1, strategyName: "Gone | V1", strategy: null, eligible: 10, leads: many(10, null), dailyCap: 1, minDays: 1 })
    expect(r.strategy_found).toBe(false)
    expect(r.warnings[0]).toContain('"Gone | V1" not found')
  })
})

test("summarizePool counts posts and comments", () => {
  const s = summarizePool([...many(3, "A1", "art"), ...many(1, null, "")])
  expect(s).toEqual({ scanned: 4, posts: [{ post: "A1", count: 3 }], comments: [{ comment: "art", count: 3 }], noPost: 1 })
})

test("the pool is the one a first-contact batch reads", () => {
  expect(eligiblePoolPath(38, { social: true, perPage: 500, page: 2 })).toBe(
    "/api/v1/leads?bloq_id=38&outreach_status=no_outreach&has_social=1&sort=updated_at&order=desc&per_page=500&page=2",
  )
  expect(eligiblePoolPath(302, { social: false, perPage: 10, page: 1 })).not.toContain("has_social")
})
