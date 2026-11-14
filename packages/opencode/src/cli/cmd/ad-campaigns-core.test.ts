import { describe, expect, test } from "bun:test"
import {
  campaignBody,
  centsToDollars,
  countsLine,
  creativeBody,
  creativeLine,
  dollarsToCents,
  parseId,
  reviewBody,
  slidesFrom,
  splitList,
} from "./ad-campaigns-core"

// #192625 — the pure half of `iris campaigns`: what is sent, and what a person reads.

describe("budget", () => {
  test("dollars the way people write them become cents", () => {
    expect(dollarsToCents("500")).toBe(50000)
    expect(dollarsToCents("$1,250.50")).toBe(125050)
    expect(dollarsToCents("19.9")).toBe(1990)
    expect(dollarsToCents(undefined)).toBeUndefined()
  })
  test("something that is not an amount is refused, never sent as zero", () => {
    expect(dollarsToCents("five hundred")).toBeNull()
    expect(dollarsToCents("-5")).toBeNull()
    expect(dollarsToCents("1.234")).toBeNull()
    expect(campaignBody(1, { name: "x", budget: "lots" }).error).toContain("not an amount")
  })
  test("cents read back as dollars", () => {
    expect(centsToDollars(50000)).toBe("$500")
    expect(centsToDollars(125050)).toBe("$1,250.50")
  })
})

describe("campaign body", () => {
  test("names the board, splits channels, leaves out what was not given", () => {
    const { body } = campaignBody(912, { name: "Spring", channels: "instagram, x", budget: "500" })
    expect(body).toEqual({ bloq_id: 912, name: "Spring", channels: ["instagram", "x"], budget_cents: 50000 })
  })
  test("an unknown state is refused here, in words", () => {
    expect(campaignBody(1, { name: "x", state: "live" }).error).toContain("draft, active, paused, ended")
  })
})

describe("creative body", () => {
  test("maps flags onto the shared field names and never sends approval fields", () => {
    const b = creativeBody(912, { headline: "H", text: "T", textX: "X", image: "https://a/1.png", submit: true })
    expect(b).toEqual({ bloq_id: 912, headline: "H", post_text: "T", post_text_x: "X", image_url: "https://a/1.png", submit: true })
    for (const k of ["approval_state", "approved_by", "approved_at", "campaign_ref"]) expect(b).not.toHaveProperty(k)
  })
  test("slides keep their order and say which are video", () => {
    expect(slidesFrom("https://a/1.png,https://a/2.mp4")).toEqual([
      { url: "https://a/1.png", type: "image", alt: "" },
      { url: "https://a/2.mp4", type: "video", alt: "" },
    ])
  })
})

describe("review", () => {
  test("approve needs no note", () => {
    expect(reviewBody(912, "approve").body).toEqual({ bloq_id: 912, decision: "approve" })
  })
  test("reject and request changes must say why", () => {
    expect(reviewBody(912, "reject").error).toContain("why")
    expect(reviewBody(912, "request_changes", "   ").error).toContain("what needs to change")
    expect(reviewBody(912, "reject", " Off-brand ").body).toEqual({ bloq_id: 912, decision: "reject", note: "Off-brand" })
  })
})

describe("what a person reads", () => {
  test("a decided creative says who decided and the note", () => {
    const line = creativeLine({ id: 7, headline: "Book now", approval_state: "rejected", approved_by: "a@b.co", approved_at: "2026-11-05T15:04:00Z", approval_note: "Off-brand" })
    expect(line).toContain("#7")
    expect(line).toContain("Rejected")
    expect(line).toContain("by a@b.co")
    expect(line).toContain('"Off-brand"')
  })
  test("a draft says nothing about a decider", () => {
    expect(creativeLine({ id: 1, headline: "H", approval_state: "draft", approved_by: "creator@b.co" })).not.toContain("by ")
  })
  test("counts show only the states that have something", () => {
    expect(countsLine({ draft: 0, in_review: 0, approved: 2, rejected: 1, changes_requested: 0 })).toBe("2 approved · 1 rejected")
    expect(countsLine({ draft: 0 })).toBe("no creatives yet")
  })
  test("ids may be typed with a hash; anything else is not an id", () => {
    expect(parseId("#12")).toBe(12)
    expect(parseId("12")).toBe(12)
    expect(parseId("abc")).toBeNull()
    expect(parseId("0")).toBeNull()
    expect(splitList(["a,b", "c"])).toEqual(["a", "b", "c"])
  })
})
