import { afterEach, describe, expect, test } from "bun:test"
import { GlobalBus, type GlobalEvent } from "@/bus/global"
import preview from "../../test/iris/fixtures/fl-api-segment-preview.json"
import unjudged from "../../test/iris/fixtures/fl-api-segment-preview-unjudged.json"
import refusal from "../../test/iris/fixtures/fl-api-segment-422.json"
import {
  addFilter,
  changeDraft,
  filtersFromApi,
  filtersToApi,
  findArgs,
  findPeople,
  parseFilterValue,
  previewSegment,
  readDraft,
  removeFilter,
  resetDrafts,
  saveDraft,
  SEGMENT_EVENT,
  SegmentIO,
  shapeMember,
  shapePreview,
  stepText,
  targetCampaign,
  unsaved,
} from "./segments"

// #193533 / #193534 / #193535 — Audiences: fl-api segments (D3 #193484) and the shared draft.

type Call = { path: string; method: string; body: any }
const real = { ...SegmentIO }
let calls: Call[] = []

/** fl-api as a table of answers by "METHOD path"; every request is recorded. */
function serve(answers: Record<string, unknown | ((c: Call) => unknown)>) {
  calls = []
  SegmentIO.fl = async (path, init) => {
    const c = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const a = answers[`${c.method} ${path}`]
    if (a === undefined) return new Response(JSON.stringify({ message: "nope" }), { status: 500 })
    return new Response(JSON.stringify(typeof a === "function" ? (a as (c: Call) => unknown)(c) : a), { status: 200 })
  }
}

afterEach(() => {
  Object.assign(SegmentIO, real)
  resetDrafts()
})

describe("filter values", () => {
  test("text from the agent becomes the type fl-api takes", () => {
    expect(parseFilterValue("source_post", "https://www.instagram.com/reel/De9Uw8Ilhne/")).toBe("De9Uw8Ilhne")
    expect(parseFilterValue("niche_in", "Coach, Course creator")).toEqual(["Coach", "Course creator"])
    expect(parseFilterValue("replied", "no")).toBe(false)
    expect(parseFilterValue("followers_min", "5k")).toBe(5000)
    expect(parseFilterValue("followers_min", "")).toBeUndefined()
    expect(parseFilterValue("has_email", "perhaps")).toBeUndefined()
  })
  test("the ordered list and fl-api's object round-trip, unknown keys dropped", () => {
    const list = filtersFromApi({ source_post: "De9Uw8Ilhne", bogus: 1, comment_contains: "roadmap" })
    expect(list).toEqual([
      { key: "source_post", value: "De9Uw8Ilhne" },
      { key: "comment_contains", value: "roadmap" },
    ])
    expect(Object.keys(filtersToApi(list))).toEqual(["source_post", "comment_contains"])
    expect(filtersFromApi([{ key: "replied", value: "yes" }])).toEqual([{ key: "replied", value: true }])
  })
})

describe("shapes (recorded from fl-api PR #308, served locally)", () => {
  test("a preview: the steps in fl-api's order, totals, the first page of members", () => {
    const p = shapePreview(preview)
    expect(p.total).toBe(788)
    expect(p.of).toBe(909)
    expect(p.breakdown.map((r) => [r.key, r.before, r.known, r.matched])).toEqual([
      ["source_post", 909, 909, 849],
      ["comment_contains", 849, 849, 788],
    ])
    expect(p.members).toMatchObject({ total: 788, page: 1, last_page: 394 })
    expect(p.members.data.map((m) => m.handle)).toEqual(["@example.1", "@example.2"])
    expect(p.members.data[0]).toMatchObject({ comment: "Roadmap", followers: null, niche: null, city: null })
  })
  test("each step reads as matched of before, known/unknown, or can't be judged yet — never a bare 0", () => {
    const steps = shapePreview(unjudged).breakdown
    expect(steps.map(stepText)).toEqual(["849 of 909", "788 of 849", "can't be judged yet · 788 unknown"])
    expect(stepText({ key: "niche_in", before: 6050, known: 4, unknown: 6046, matched: 3, of: 6050, always_known: false })).toBe("3 of 4 known · 6,046 unknown")
    expect(stepText({ key: "replied", before: 10, known: 10, unknown: 0, matched: 9, of: 10, always_known: true })).toBe("9 of 10")
  })
  test("a follower count of 0 is unknown, as fl-api means it", () => {
    expect(shapeMember({ id: 1, handle: "a", followers: 0 }).followers).toBeNull()
    expect(shapeMember({ id: 1, handle: "@a", followers: 1200 })).toMatchObject({ handle: "@a", followers: 1200 })
  })
})

describe("routes asked of fl-api", () => {
  test("preview posts the filters, in order, to the board's preview route", async () => {
    serve({ "POST /api/v1/bloqs/38/segments/preview": preview })
    const r = await previewSegment(38, [
      { key: "source_post", value: "De9Uw8Ilhne" },
      { key: "comment_contains", value: "roadmap" },
    ])
    expect(r.measured).toBe(true)
    expect(calls).toEqual([
      { path: "/api/v1/bloqs/38/segments/preview", method: "POST", body: { filters: { source_post: "De9Uw8Ilhne", comment_contains: "roadmap" }, per_page: 25 } },
    ])
    expect(Object.keys(calls[0].body.filters)).toEqual(["source_post", "comment_contains"])
  })

  test("an unknown key's 422 is passed on with the allowed keys (recorded)", async () => {
    SegmentIO.fl = async () => new Response(JSON.stringify(refusal), { status: 422 })
    const r = await previewSegment(38, [])
    expect(r.reason).toStartWith("Unknown filter key(s): bogus. Allowed: source_post,")
  })

  test("a missing segments API says which one, not a bare 404", async () => {
    SegmentIO.fl = async () => new Response("", { status: 404 })
    const r = await previewSegment(38, [])
    expect(r.measured).toBe(false)
    expect(r.reason).toContain("#193484")
  })

  test("save POSTs a new segment, then PATCHes the same one", async () => {
    serve({
      "POST /api/v1/bloqs/38/segments": (c: Call) => ({ data: { segment: { id: 77, bloq_id: 38, ...c.body } } }),
      "PATCH /api/v1/segments/77": (c: Call) => ({ data: { segment: { id: 77, bloq_id: 38, ...c.body } } }),
    })
    await addFilter(38, "source_post", "De9Uw8Ilhne")
    const first = await saveDraft(38, "Roadmap")
    expect(first.data).toMatchObject({ segment_id: 77, name: "Roadmap" })
    expect(unsaved(first.data)).toBe(false)
    await addFilter(38, "comment_contains", "roadmap")
    expect(unsaved((await readDraft(38)).data!)).toBe(true)
    await saveDraft(38)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/v1/bloqs/38/segments", "PATCH /api/v1/segments/77"])
    expect(calls[1].body).toEqual({ name: "Roadmap", filters: { source_post: "De9Uw8Ilhne", comment_contains: "roadmap" } })
  })

  test("save refuses a nameless or empty segment without asking fl-api", async () => {
    serve({})
    expect((await saveDraft(38, "x")).reason).toContain("at least one filter")
    await addFilter(38, "replied", "no")
    expect((await saveDraft(38, "  ")).reason).toContain("name")
    expect(calls).toEqual([])
  })

  test("targeting a campaign PUTs segment_id on it, and says when fl-api ignores the field", async () => {
    serve({ "PUT /api/v1/som/campaigns/53": { data: { campaign: { id: 53, segment_id: 77 } } } })
    expect((await targetCampaign(53, 77)).data).toEqual({ campaign: 53, segment_id: 77 })
    expect(calls[0]).toEqual({ path: "/api/v1/som/campaigns/53", method: "PUT", body: { segment_id: 77 } })
    serve({ "PUT /api/v1/som/campaigns/53": { data: { campaign: { id: 53, name: "Silent Iris" } } } })
    const r = await targetCampaign(53, 77)
    expect(r.measured).toBe(false)
    expect(r.reason).toContain("segment_id")
  })
})

describe("the shared draft", () => {
  test("every change bumps rev, moves the focus, and is announced on the event stream", async () => {
    const seen: GlobalEvent[] = []
    const on = (e: GlobalEvent) => e.payload?.type === SEGMENT_EVENT && seen.push(e)
    GlobalBus.on("event", on)
    try {
      expect((await readDraft()).data).toBeNull()
      const a = await addFilter(38, "source_post", "De9Uw8Ilhne", "agent")
      const b = await addFilter(38, "comment_contains", "roadmap", "agent")
      expect(b.data.rev).toBeGreaterThan(a.data.rev)
      expect((await readDraft()).data).toMatchObject({ bloq: 38, by: "agent" })
      expect(seen.map((e) => e.payload.properties)).toEqual([
        { bloq: 38, rev: a.data.rev, segment_id: null, by: "agent" },
        { bloq: 38, rev: b.data.rev, segment_id: null, by: "agent" },
      ])
    } finally {
      GlobalBus.off("event", on)
    }
  })

  test("adding a key already there replaces its value in place; removing drops it", async () => {
    await addFilter(38, "comment_contains", "roadmap")
    await addFilter(38, "source_post", "a")
    await addFilter(38, "source_post", "De9Uw8Ilhne")
    // In fl-api's order (SegmentFilters::KEYS), whatever order they were added in.
    expect((await readDraft(38)).data!.filters.map((f) => `${f.key}=${f.value}`)).toEqual(["source_post=De9Uw8Ilhne", "comment_contains=roadmap"])
    await removeFilter(38, "source_post")
    expect((await readDraft(38)).data!.filters.map((f) => f.key)).toEqual(["comment_contains"])
    expect((await removeFilter(38, "replied")).measured).toBe(false)
  })

  test("a CLI edit of the saved segment reaches a clean draft on the next read (U2c)", async () => {
    let server = { id: 77, bloq_id: 38, name: "Roadmap", filters: { source_post: "De9Uw8Ilhne" } }
    serve({ "GET /api/v1/segments/77": () => ({ data: { segment: server } }) })
    const opened = await changeDraft({ bloq: 38, load: 77 })
    expect(opened.data).toMatchObject({ segment_id: 77, name: "Roadmap" })
    // Nothing changed on the server: same rev.
    expect((await readDraft()).data!.rev).toBe(opened.data.rev)
    // `iris segment update 77 --comment-contains roadmap`, elsewhere:
    server = { ...server, filters: { source_post: "De9Uw8Ilhne", comment_contains: "roadmap" } as any }
    const after = (await readDraft()).data!
    expect(after.rev).toBeGreaterThan(opened.data.rev)
    expect(after.by).toBe("server")
    expect(after.filters.map((f) => f.key)).toEqual(["source_post", "comment_contains"])
    expect(unsaved(after)).toBe(false)
  })

  test("a draft with unsaved edits keeps them over the server's", async () => {
    const server = { id: 77, bloq_id: 38, name: "Roadmap", filters: { source_post: "De9Uw8Ilhne" } }
    serve({ "GET /api/v1/segments/77": () => ({ data: { segment: server } }) })
    await changeDraft({ bloq: 38, load: 77 })
    await addFilter(38, "replied", "no", "panel")
    server.filters = { source_post: "OTHER" } as any
    const d = (await readDraft()).data!
    expect(d.filters.map((f) => `${f.key}=${f.value}`)).toEqual(["source_post=De9Uw8Ilhne", "replied=false"])
  })
})

describe("find (adds leads, never sends)", () => {
  test("a post runs reachr scrape --instagram --write; pages run reachr scrape <urls> --write", () => {
    expect(findArgs({ bloq: 38, post_url: "https://www.instagram.com/p/De9Uw8Ilhne/" })).toEqual([
      "reachr", "scrape", "38", "--instagram", "https://www.instagram.com/p/De9Uw8Ilhne/", "--write", "--json",
    ])
    expect(findArgs({ bloq: 38, urls: ["https://example.com/team"], limit: 20 })).toEqual(["reachr", "scrape", "38", "https://example.com/team", "--write", "--json", "--limit", "20"])
    expect(findArgs({ bloq: 38, post_url: "https://example.com" })).toContain("not an Instagram post")
    expect(findArgs({ bloq: 38, urls: ["file:///etc/passwd"] })).toContain("only http(s)")
    expect(findArgs({ bloq: 38 })).toContain("post_url")
  })

  test("no argument list ever names a send command", () => {
    const all = [findArgs({ bloq: 1, post_url: "https://www.instagram.com/p/x/" }), findArgs({ bloq: 1, urls: ["https://a.b"] })].flat()
    expect(all.some((a) => /send|post-run|batch|dm/i.test(a))).toBe(false)
  })

  test("reads the CLI's JSON outcome", async () => {
    const ran: string[][] = []
    SegmentIO.cli = () => "/home/u/.iris/bin/iris"
    SegmentIO.exec = async (_f, args) => {
      ran.push(args)
      return { code: 0, stderr: "", stdout: JSON.stringify({ leads: [1, 2, 3], dry_run: false, outcome: { created: [{}, {}], existing: [{}], failed: [] } }) }
    }
    const r = await findPeople({ bloq: 38, post_url: "https://www.instagram.com/p/De9Uw8Ilhne/" })
    expect(r.data).toEqual({ added: 2, already: 1, failed: 0, found: 3, source: "commenters on https://www.instagram.com/p/De9Uw8Ilhne/" })
    expect(ran).toHaveLength(1)
  })

  test("a CLI error is the reason, and no CLI says so", async () => {
    SegmentIO.cli = () => "/x/iris"
    SegmentIO.exec = async () => ({ code: 1, stderr: "", stdout: JSON.stringify({ ok: false, error: "No Instagram session" }) })
    expect((await findPeople({ bloq: 38, post_url: "https://www.instagram.com/p/x/" })).reason).toBe("No Instagram session")
    SegmentIO.cli = () => null
    expect((await findPeople({ bloq: 38, post_url: "https://www.instagram.com/p/x/" })).reason).toContain("not installed")
  })
})
