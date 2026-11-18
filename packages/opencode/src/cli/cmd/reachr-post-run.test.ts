import { describe, expect, test } from "bun:test"
import { mapInstagramResult, type Lead } from "./reachr-core"
import { specCommand } from "./reachr-playwright"
import {
  approvalError,
  busyReason,
  cameFromPost,
  contactReason,
  keywordLedgerHandles,
  ledgerBlocks,
  liveCampaignOnBoard,
  messageWarnings,
  perPost,
  planRun,
  postShortcode,
  SOURCE_LINE,
  tally,
  templateWording,
  type LedgerEntry,
  type SavedPlan,
} from "./reachr-post-run"

/** The shape leadgen-scraper.spec.ts writes to RESULT_FILE in a dry run. The people are invented. */
const POST = "https://www.instagram.com/p/ABC123/"
const raw = {
  mode: "comments",
  target: POST,
  ig_account: "acct",
  scraped: 6,
  existing_skipped: 900,
  errors: [],
  profiles: [
    { username: "ana_builds", rawMetadata: { commentText: "ROADMAP please" } },
    { username: "Ben.Makes/", displayName: "Ben", rawMetadata: { commentText: "love this" } },
    { username: "ana_builds", rawMetadata: { commentText: "again" } },
    { username: "acct", rawMetadata: { commentText: "our own" } },
    { username: "sister_acct", rawMetadata: { commentText: "ours too" } },
    { username: "no_text", rawMetadata: {} },
  ],
}
const leads: Lead[] = mapInstagramResult(raw).leads
const plan = (over: any = {}) =>
  planRun({
    leads,
    postUrl: POST,
    template: "{source} I build IRIS.",
    account: "acct",
    ownHandles: ["sister_acct"],
    blocked: new Map(),
    limit: 5,
    remainingToday: 40,
    ...over,
  })

describe("the true-source rule", () => {
  test("a commenter on this post is told so, word for word", () => {
    expect(cameFromPost(leads[0]!, POST)).toBe(true)
    const r = templateWording({ template: "{source} Hi {handle}", lead: leads[0]!, postUrl: POST })
    expect(r).toEqual({ message: `${SOURCE_LINE} Hi ana_builds` })
  })
  test("a different post, a different source, or no comment on record refuses the claim", () => {
    const other = "https://www.instagram.com/p/OTHER/"
    const follower = { ...leads[0]!, source: "leadgen:instagram:followers" }
    const silent = leads.find((l) => l.handle === "no_text")!
    for (const [lead, url] of [[leads[0]!, other], [follower, POST], [silent, POST]] as const) {
      expect("refused" in templateWording({ template: "{source} Hi", lead, postUrl: url })).toBe(true)
      expect("refused" in templateWording({ template: "Saw your comment! Hi", lead, postUrl: url })).toBe(true)
    }
  })
  test("a message with no claim needs no comment on record", () => {
    const silent = leads.find((l) => l.handle === "no_text")!
    expect(templateWording({ template: "Hi", lead: silent, postUrl: POST })).toEqual({ message: "Hi" })
  })
  test("an unknown placeholder is refused rather than sent as text", () => {
    expect("refused" in templateWording({ template: "Hi {firstname}", lead: leads[0]!, postUrl: POST })).toBe(true)
  })
  test("a link draws a warning", () => {
    expect(messageWarnings("get it at heyiris.io").length).toBe(1)
    expect(messageWarnings("no link here. thanks").length).toBe(0)
  })
  test("the wording seam can be swapped without touching the plan", () => {
    const r = plan({ wording: () => ({ message: "custom" }) })
    expect(r.targets.every((t) => t.message === "custom")).toBe(true)
  })
})

describe("who gets a message", () => {
  test("dedupes, skips our accounts, refuses the unbacked claim, and says why", () => {
    const r = plan()
    expect(r.targets.map((t) => t.handle)).toEqual(["ana_builds", "ben.makes"])
    expect(r.targets[0]!.why).toContain("ROADMAP please")
    expect(r.skipped.map((s) => s.handle).sort()).toEqual(["acct", "no_text", "sister_acct"])
  })
  test("someone already contacted is skipped with the reason", () => {
    const r = plan({ blocked: new Map([["ana_builds", "already sent by a post run"]]) })
    expect(r.targets.map((t) => t.handle)).toEqual(["ben.makes"])
    expect(r.skipped).toContainEqual({ handle: "ana_builds", reason: "already sent by a post run" })
  })
  test("never lists more than the limit or today's remaining cap", () => {
    expect(plan({ limit: 1 }).targets.length).toBe(1)
    expect(plan({ limit: 1 }).overLimit).toBe(1)
    expect(plan({ remainingToday: 1 }).targets.length).toBe(1)
    expect(plan({ remainingToday: 0 }).targets.length).toBe(0)
  })
  test("a lead's own record decides contact", () => {
    expect(contactReason([], [])).toBeNull()
    expect(contactReason([{ id: 1 }], [])).toContain("already contacted")
    expect(contactReason([], [{ content: '[SOM DM] Sent via @x: "hi"' }])).toContain("already contacted")
    expect(contactReason([], [{ message: "[SOM UNDELIVERABLE] cannot DM" }])).toContain("undeliverable")
    expect(contactReason([], [{ content: "[SOM FAIL] typed" }])).toContain("failed")
    expect(contactReason([], [{ content: "PUBLIC — not confirmed" }])).toBeNull()
  })
  test("keyword-dm's ledger counts real sends, not dry runs", () => {
    const m = keywordLedgerHandles({ posts: { A: { entries: [{ handle: "@One", status: "sent" }, { handle: "two", status: "dry", dry: true }, { handle: "three", status: "failed" }] } } })
    expect([...m.keys()]).toEqual(["one"])
  })
})

describe("approval", () => {
  const saved: SavedPlan = {
    run_id: "r",
    created_at: "2026-11-01T12:00:00Z",
    post_url: POST,
    account: "acct",
    board_id: 9,
    targets: plan().targets,
  }
  const ask = (over: any = {}) =>
    approvalError(saved, { postUrl: POST, account: "acct", boardId: 9, confirmCount: 2, remainingToday: 40, now: Date.parse("2026-11-01T13:00:00Z"), ...over })
  test("the count from the preview, on the same post, account and board, is approval", () => expect(ask()).toBeNull())
  test("a reel URL for the same post is the same post", () => expect(ask({ postUrl: "https://www.instagram.com/reel/ABC123/?igsh=x" })).toBeNull())
  test("--send alone, or a wrong count, is not", () => {
    expect(ask({ confirmCount: undefined })).toContain("--confirm-count 2")
    expect(ask({ confirmCount: 3 })).toContain("does not match")
    expect(ask({ confirmCount: "abc" })).toContain("does not match")
  })
  test("no preview, a different target, or a stale preview is not", () => {
    expect(approvalError(null, { postUrl: POST, account: "acct", boardId: 9, confirmCount: 2, remainingToday: 40, now: 0 })).toContain("No preview")
    expect(ask({ boardId: 10 })).toContain("different")
    expect(ask({ account: "other" })).toContain("different")
    expect(ask({ postUrl: "https://www.instagram.com/p/ZZZ/" })).toContain("different")
    expect(ask({ now: Date.parse("2026-11-02T13:00:00Z") })).toContain("24 hours")
  })
  test("a list over today's remaining cap is refused whole", () => expect(ask({ remainingToday: 1 })).toContain("Only 1"))
})

describe("results stay honest", () => {
  const e = (handle: string, outcome: LedgerEntry["outcome"], recorded = true, shortcode = "ABC123"): LedgerEntry => ({ run_id: "r", shortcode, handle, lead_id: 1, outcome, recorded })
  test("undeliverable is its own count, and is not sent", () => {
    const t = tally([e("a", "sent"), e("b", "undeliverable"), e("c", "unconfirmed"), e("d", "failed"), e("f", "sent", false)], 6)
    expect(t).toEqual({ approved: 6, sent: 2, undeliverable: 1, unconfirmed: 1, failed: 1, not_attempted: 1, sent_not_recorded: 1 })
  })
  test("everything but a plain failure blocks a second DM", () => {
    expect([...ledgerBlocks([e("a", "sent"), e("b", "undeliverable"), e("c", "unconfirmed"), e("d", "failed")]).keys()]).toEqual(["a", "b", "c"])
  })
  test("per post, the latest attempt per person counts", () => {
    const r = perPost([e("a", "failed"), e("a", "sent"), e("b", "sent", true, "OTHER")])
    expect(r.map((p) => [p.shortcode, p.latest.map((x) => x.outcome)])).toEqual([["ABC123", ["sent"]], ["OTHER", ["sent"]]])
  })
})

describe("one browser at a time", () => {
  const now = 1_000_000_000
  const opts = { now, alive: () => true }
  test("a live lock blocks; a dead or old one does not", () => {
    expect(busyReason({ pid: 5, started: now - 1000 }, "", opts)).toContain("pid 5")
    expect(busyReason({ pid: 5, started: now - 1000 }, "", { now, alive: () => false })).toBeNull()
    expect(busyReason({ pid: 5, started: now - 31 * 60_000 }, "", opts)).toBeNull()
    expect(busyReason(null, "", opts)).toBeNull()
  })
  test("a SOM browser job blocks; other work on the machine does not", () => {
    expect(busyReason(null, "123 node /x/playwright test batch-with-login.spec.ts --headed", opts)).toContain("123")
    expect(busyReason(null, "124 node som-all.js only=courses", opts)).toContain("124")
    expect(busyReason(null, "125 node /x/playwright test desktop-smoke.spec.ts\n126 bun run dev", opts)).toBeNull()
    expect(busyReason(null, "127 /bin/bash -c grep -E batch-with-login|som-all.js", opts)).toBeNull()
    expect(busyReason(null, "128 xvfb-run -a npx playwright test leadgen-scraper.spec.ts", opts)).toContain("128")
  })
  test("a board with a live campaign is named", () => {
    const cache = { campaigns: { courses: { boardId: "38", active: true }, old: { boardId: "9", active: false } } }
    expect(liveCampaignOnBoard(cache, 38)).toBe("courses")
    expect(liveCampaignOnBoard(cache, 9)).toBeNull()
    expect(liveCampaignOnBoard(null, 38)).toBeNull()
  })
})

test("the post's shortcode ignores account prefix, reel form and tracking", () => {
  for (const u of [POST, "https://instagram.com/reel/ABC123/?igsh=x", "https://www.instagram.com/someone/p/ABC123"]) expect(postShortcode(u)).toBe("ABC123")
  expect(postShortcode("https://www.instagram.com/someone/")).toBeNull()
})

test("a headed browser on a Linux machine with no display goes through xvfb; a send never retries", () => {
  const base = { platform: "linux", hasDisplay: false, hasXvfb: true }
  expect(specCommand("a.spec.ts", 5, base)[0]).toBe("xvfb-run")
  expect(specCommand("a.spec.ts", 5, { ...base, hasDisplay: true })[0]).toBe("npx")
  expect(specCommand("a.spec.ts", 5, { ...base, platform: "darwin" })[0]).toBe("npx")
  expect(specCommand("a.spec.ts", 5, { ...base, noRetry: true })).toContain("--retries=0")
})
