import { describe, expect, test } from "bun:test"
import {
  findExisting,
  provenanceNote,
  leadPayload,
  judgeCreated,
  mapInstagramResult,
  mapLinkedInResult,
  planReplyLog,
  replyKey,
  shouldRetrySpec,
  inferMode,
  normalizeTarget,
  liSlug,
  auditRepliedLead,
  collectPages,
} from "./reachr-core"

/**
 * ReachR, as scenarios. Every fixture below copies the SHAPE of something measured on 2026-09-18
 * (a LinkedIn search card, an Instagram scrape result, the three legacy reply-note formats in
 * lead_comms). The people are invented; the shapes are not.
 */

// ── helpers ──────────────────────────────────────────────────────────────────
const liRaw = (profiles: any[], extra: any = {}) => ({
  mode: "search",
  target: "https://www.linkedin.com/search/results/people/?keywords=founder%20agency",
  query: "founder agency",
  location: "Dallas",
  scraped: profiles.length,
  profiles,
  errors: [],
  ...extra,
})
const liProfile = (name: string, slug: string, headline = "", summary = "", location = "Dallas, Texas, United States") => ({
  username: name,
  platform: "linkedin",
  displayName: name,
  profileUrl: `https://www.linkedin.com/in/${slug}/`,
  sourceContext: "search: …",
  rawMetadata: { headline, location, ...(summary ? { summary } : {}) },
})
const igRaw = (profiles: any[], extra: any = {}) => ({
  mode: "followers",
  target: "https://www.instagram.com/someagency/",
  ig_account: "ouraccount",
  scraped: profiles.length,
  existing_skipped: 0,
  profiles,
  errors: [],
  ...extra,
})

// ══ ACQUIRE: what a scrape turns into ═════════════════════════════════════════

describe("LinkedIn: a search card becomes a lead", () => {
  test("'Title at Company' splits into title and company", () => {
    const d = mapLinkedInResult(liRaw([liProfile("Dana Reyes", "dana-reyes-1a2b", "CEO at Northwind Creative")]))
    const l = d.leads[0]
    expect(l.title?.v).toBe("CEO")
    expect(l.company).toBe("Northwind Creative")
    expect(l.company_how).toBe("linkedin-headline")
    expect(l.handle).toBe("dana-reyes-1a2b")
    expect(l.socials?.linkedin).toBe("https://www.linkedin.com/in/dana-reyes-1a2b/")
  })

  test("a run-on headline splits on its first clause only", () => {
    const d = mapLinkedInResult(liRaw([liProfile("Sam Ortiz", "samortiz", "Owner @ Bright Print Co |  Custom Screen Printing, Embroidery & Promo Experts.")]))
    expect(d.leads[0].title?.v).toBe("Owner")
    expect(d.leads[0].company).toBe("Bright Print Co")
  })

  test("no company in the headline → taken from LinkedIn's own summary line", () => {
    const d = mapLinkedInResult(
      liRaw([liProfile("Kai Moreno", "kai-moreno", "Founder & CEO", "Founder & CEO at Moreno Studio in Dallas since 2019, building brands for …")]),
    )
    expect(d.leads[0].company).toBe("Moreno Studio")
    expect(d.leads[0].company_how).toBe("linkedin-summary")
  })

  test("'Founder of X' in the summary also names the company", () => {
    const d = mapLinkedInResult(liRaw([liProfile("Lee Park", "leepark", "Designer. Podcaster.", "Founder of the Signal Fire Agency in Dallas since December 2023, with …")]))
    expect(d.leads[0].company).toBe("the Signal Fire Agency")
  })

  test("no headline and no summary → a name and a profile, never an invented company", () => {
    const d = mapLinkedInResult(liRaw([liProfile("Ari Cole", "ari-cole")]))
    expect(d.leads[0].title).toBeNull()
    expect(d.leads[0].company).toBeUndefined()
  })

  test("a very long headline is cut to a readable title", () => {
    const long = "Helping founders ".repeat(20)
    const d = mapLinkedInResult(liRaw([liProfile("Jo Vance", "jo-vance", long)]))
    expect(d.leads[0].title!.v.length).toBeLessThanOrEqual(120)
  })

  test("a card without a /in/ URL is dropped, not written as a nameless lead", () => {
    const bad = { ...liProfile("Ghost", "x"), profileUrl: "https://www.linkedin.com/company/acme/" }
    const d = mapLinkedInResult(liRaw([bad, liProfile("Real Person", "real-person")]))
    expect(d.leads.map((l: any) => l.name.v)).toEqual(["Real Person"])
  })

  test("slugs are lowercased and percent-decoded, so the same person always has one key", () => {
    expect(liSlug("https://www.linkedin.com/in/Jos%C3%A9-Diaz-9/?miniProfile=1")).toBe("josé-diaz-9")
    expect(liSlug("not a profile")).toBe("")
  })
})

describe("Instagram: a scrape result becomes leads", () => {
  test("the handle is cleaned (no @, no trailing slash) and the profile URL is built from it", () => {
    const d = mapInstagramResult(igRaw([{ username: "@studio.nine/", displayName: "Studio Nine", rawMetadata: { followers: 1200 } }]))
    const l = d.leads[0]
    expect(l.handle).toBe("studio.nine")
    expect(l.socials?.instagram).toBe("https://www.instagram.com/studio.nine/")
    expect(l.name.v).toBe("Studio Nine")
  })

  test("an email in the bio is picked up as the email, marked as from the bio", () => {
    const d = mapInstagramResult(igRaw([{ username: "maya.makes", rawMetadata: { bio: "prints & murals · bookings maya@example.com" } }]))
    expect(d.leads[0].email).toEqual({ v: "maya@example.com", how: "ig-bio" })
  })

  test("no display name → the lead is named by its @handle", () => {
    const d = mapInstagramResult(igRaw([{ username: "quietbrand" }]))
    expect(d.leads[0].name.v).toBe("@quietbrand")
  })
})

describe("could not look ≠ found nothing (three states, never two)", () => {
  test("LinkedIn: nothing scraped AND errors → could not measure", () => {
    const d = mapLinkedInResult(liRaw([], { scraped: 0, errors: ["login wall"] }))
    expect(d.measured).toBe(false)
    expect(d.error).toContain("login wall")
  })

  test("Instagram: nothing scraped AND errors → could not measure", () => {
    const d = mapInstagramResult(igRaw([], { scraped: 0, errors: ["session expired"] }))
    expect(d.measured).toBe(false)
  })

  test("looked, no errors, nobody there → measured, and not ok", () => {
    const d = mapLinkedInResult(liRaw([], { scraped: 0 }))
    expect(d.measured).toBe(true)
    expect(d.ok).toBe(false)
  })
})

describe("Instagram target → mode", () => {
  test.each([
    ["https://www.instagram.com/p/Cx123/", "comments"],
    ["https://www.instagram.com/reel/Cx123/", "comments"],
    ["@someagency", "followers"],
    ["@a,@b", "profiles"],
    ["inbox", "inbox"],
  ])("%s → %s", (target, mode) => expect(inferMode(target)).toBe(mode as any))

  test("a bare handle becomes a profile URL; a profile list stays a list of @handles", () => {
    expect(normalizeTarget("someagency", "followers")).toBe("https://www.instagram.com/someagency/")
    expect(normalizeTarget("https://instagram.com/a/, @b", "profiles")).toBe("@a,@b")
  })
})

// ══ DEDUPE: is this person already on the board? ══════════════════════════════

describe("already on the board?", () => {
  const li = (slug: string, name = "Dana Reyes", company?: string) =>
    mapLinkedInResult(liRaw([liProfile(name, slug, company ? `CEO at ${company}` : "")])).leads[0]
  const ig = (handle: string, displayName?: string) =>
    mapInstagramResult(igRaw([{ username: handle, displayName }])).leads[0]

  test("LinkedIn: the same profile URL, however it was stored", () => {
    const board = [{ id: 1, name: "D. Reyes", contact_info: { linkedin: "https://linkedin.com/in/Dana-Reyes-1a2b?trk=x" } }]
    expect(findExisting(li("dana-reyes-1a2b"), board)?.id).toBe(1)
  })

  test("Instagram: the handle in contact_info or as the '@handle' nickname", () => {
    expect(findExisting(ig("studio.nine"), [{ id: 2, name: "x", contact_info: { instagram: "@Studio.Nine" } }])?.id).toBe(2)
    expect(findExisting(ig("studio.nine"), [{ id: 3, name: "x", nickname: "@studio.nine" }])?.id).toBe(3)
  })

  test("email matches regardless of case", () => {
    const l = mapInstagramResult(igRaw([{ username: "maya.makes", rawMetadata: { bio: "Maya@Example.com" } }])).leads[0]
    expect(findExisting(l, [{ id: 4, name: "Someone", email: "maya@example.com" }])?.id).toBe(4)
  })

  test("same name, no other identity on either side → treated as the same person", () => {
    expect(findExisting(li("dana-reyes-1a2b"), [{ id: 5, name: "dana reyes" }])?.id).toBe(5)
  })

  test("same name but DIFFERENT LinkedIn profiles → two people, not a duplicate", () => {
    // Two "Dana Reyes" in Dallas is ordinary. When both records carry a profile and they differ,
    // the profiles are the evidence; the name is not.
    const board = [{ id: 6, name: "Dana Reyes", contact_info: { linkedin: "https://www.linkedin.com/in/dana-reyes-other/" } }]
    expect(findExisting(li("dana-reyes-1a2b"), board)).toBeNull()
  })

  test("same display name but DIFFERENT Instagram handles → two accounts, not a duplicate", () => {
    const board = [{ id: 7, name: "Studio Nine", contact_info: { instagram: "studionine_official" } }]
    expect(findExisting(ig("studio.nine", "Studio Nine"), board)).toBeNull()
  })

  test("a board nickname like 'Danny' is a nickname, not a conflicting Instagram handle", () => {
    expect(findExisting(ig("studio.nine", "Studio Nine"), [{ id: 9, name: "Studio Nine", nickname: "Danny" }])?.id).toBe(9)
  })

  test("same name at different companies → two people", () => {
    expect(findExisting(li("dana-reyes-1a2b", "Dana Reyes", "Northwind"), [{ id: 8, name: "Dana Reyes", company: "Globex" }])).toBeNull()
  })
})

// ══ WRITE: what reaches the API ═══════════════════════════════════════════════

describe("what a written lead looks like", () => {
  test("LinkedIn lead: profile URL in contact_info.linkedin (the runner's shape), no IG fields", () => {
    const l = mapLinkedInResult(liRaw([liProfile("Dana Reyes", "dana-reyes-1a2b", "CEO at Northwind")])).leads[0]
    const p = leadPayload(l, 38)
    expect(p).toMatchObject({ name: "Dana Reyes", bloqId: 38, source: "leadgen:linkedin:search", company: "Northwind" })
    expect(p.contact_info).toEqual({ linkedin: "https://www.linkedin.com/in/dana-reyes-1a2b/" })
    expect(p.nickname).toBeUndefined()
  })

  test("Instagram lead: nickname '@handle' and contact_info.instagram (the SOM runner's shape)", () => {
    const l = mapInstagramResult(igRaw([{ username: "studio.nine" }])).leads[0]
    const p = leadPayload(l, 38)
    expect(p.nickname).toBe("@studio.nine")
    expect(p.contact_info).toEqual({ instagram: "studio.nine", instagram_url: "https://www.instagram.com/studio.nine/" })
  })

  test("the API upserted onto someone else (#137529) → not ours, no note attached", () => {
    const started = Date.parse("2026-09-18T20:00:00Z")
    expect(judgeCreated({ name: "Someone Else", created_at: "2026-01-01T00:00:00Z" }, "Dana Reyes", started).ours).toBe(false)
    expect(judgeCreated({ name: "Dana Reyes", created_at: "2026-01-01T00:00:00Z" }, "Dana Reyes", started).ours).toBe(false)
    expect(judgeCreated({ name: "dana reyes", created_at: "2026-09-18T20:00:03Z" }, "Dana Reyes", started).ours).toBe(true)
  })
})

describe("the provenance note tells the truth about where a lead came from", () => {
  test("LinkedIn: headline is self-described; summary and location are kept; no duplicate source line", () => {
    const l = mapLinkedInResult(
      liRaw([liProfile("Kai Moreno", "kai-moreno", "Founder & CEO", "Founder & CEO at Moreno Studio in Dallas since 2019.")]),
    ).leads[0]
    const n = provenanceNote(l, "2026-09-18")
    expect(n).toStartWith("PUBLIC — not confirmed.")
    expect(n).toContain("self-described")
    expect(n).toContain("summary: Founder & CEO at Moreno Studio")
    expect(n).toContain("location: Dallas")
    expect(n).not.toContain("instagram handle")
    expect(n.split("\n").filter((x) => x.includes("search/results")).length).toBe(1)
  })

  test("Instagram: says it may be a brand; follower count only when it was actually read", () => {
    const zero = mapInstagramResult(igRaw([{ username: "a", rawMetadata: { followers: 0 } }])).leads[0]
    const some = mapInstagramResult(igRaw([{ username: "b", rawMetadata: { followers: 950 } }])).leads[0]
    expect(provenanceNote(zero, "d")).toContain("may be a brand")
    expect(provenanceNote(zero, "d")).not.toContain("followers:")
    expect(provenanceNote(some, "d")).toContain("followers: 950")
  })
})

// ══ INBOUND: replies into the comms spine ═════════════════════════════════════

describe("is this reply already on the lead's thread?", () => {
  // The three shapes that really exist in lead_comms, from three producers.
  const DM_REPLY =
    '[DM Reply] @studio.nine replied via Instagram DM:\n---\nthem: Tell me more\nthem: Is there a price list?\n---\nScanned: 2026-05-16'
  const IG_PREVIEW = '[inbox reply] IG reply from @studio.nine: "Sounds good — what does onboarding look like for a team of 4 people who mostly work on mobile and'
  const LI_PREVIEW = '[inbox reply] LinkedIn reply detected from Dana Reyes: "Happy to chat next week"'

  test("a reply logged earlier by reachr itself", () => {
    const p = planReplyLog([{ body: "Tell me more", timestamp: null }], [{ body: "Tell me more" }])
    expect(p.toLog).toEqual([])
    expect(p.already).toBe(1)
  })

  test("case and whitespace do not make a new reply", () => {
    expect(replyKey("  Tell   me MORE ")).toBe(replyKey("tell me more"))
  })

  test("inside a combined [DM Reply] note — each line is its own reply", () => {
    const p = planReplyLog(
      [{ body: "Is there a price list?", timestamp: null }, { body: "New question", timestamp: null }],
      [{ body: DM_REPLY }],
    )
    expect(p.toLog.map((r) => r.body)).toEqual(["New question"])
  })

  test("a truncated [inbox reply] preview counts as the full reply it was cut from", () => {
    const full =
      "Sounds good — what does onboarding look like for a team of 4 people who mostly work on mobile and travel a lot between sites?"
    expect(planReplyLog([{ body: full, timestamp: null }], [{ body: IG_PREVIEW }]).toLog).toEqual([])
  })

  test("the LinkedIn '[inbox reply] … reply detected from Name' shape", () => {
    expect(planReplyLog([{ body: "Happy to chat next week", timestamp: null }], [{ body: LI_PREVIEW }]).toLog).toEqual([])
  })

  test("a placeholder row that carries no text does not hide a real reply", () => {
    const placeholder = "[inbox reply] IG reply detected from @studio.nine in ouraccount inbox"
    expect(planReplyLog([{ body: "Tell me more", timestamp: null }], [{ body: placeholder }]).toLog.length).toBe(1)
  })

  test("a short preview is not a wildcard — 'ok' does not swallow every reply starting with ok", () => {
    const p = planReplyLog([{ body: "ok but what about pricing for teams?", timestamp: null }], [{ body: '[inbox reply] IG reply from @x: "ok"' }])
    expect(p.toLog.length).toBe(1)
  })

  test("the same reply twice in one scan is logged once", () => {
    const p = planReplyLog([{ body: "Yes!", timestamp: null }, { body: "yes!", timestamp: null }], [])
    expect(p.toLog.length).toBe(1)
  })

  test("empty bodies are skipped", () => {
    expect(planReplyLog([{ body: "   ", timestamp: null }], []).toLog).toEqual([])
  })

  test("sent_at only when Instagram showed a real time; otherwise the server stamps it", () => {
    const p = planReplyLog([{ body: "a", timestamp: "2026-09-17T14:30:00.000Z" }, { body: "b", timestamp: "Yesterday" }], [])
    expect(p.toLog[0].sent_at).toBe("2026-09-17T14:30:00.000Z")
    expect(p.toLog[1].sent_at).toBeUndefined()
  })
})

// ══ RUNNER: when a failed browser run is retried ══════════════════════════════

describe("retry a spec run?", () => {
  const CLOSED = "Error: page.goto: Target page, context or browser has been closed"
  test("the first-navigation crash: no result, browser closed, died fast → retry", () => {
    expect(shouldRetrySpec({ resultFileExists: false, text: CLOSED, elapsedMs: 9_000 })).toBe(true)
  })
  test("the scan already wrote its result → never (a retry could repeat a write-back)", () => {
    expect(shouldRetrySpec({ resultFileExists: true, text: CLOSED, elapsedMs: 9_000 })).toBe(false)
  })
  test("died after a long run → a real failure, reported", () => {
    expect(shouldRetrySpec({ resultFileExists: false, text: CLOSED, elapsedMs: 300_000 })).toBe(false)
  })
  test("any other error (login wall, timeout) → reported, not retried away", () => {
    expect(shouldRetrySpec({ resultFileExists: false, text: "Timeout 30000ms exceeded", elapsedMs: 9_000 })).toBe(false)
  })
})

// ══ AUDIT: is a "DM Replied" tag backed by a real reply? ═════════════════════
// Shapes from the 24 tagged leads on boards 38 and 80, 2026-09-18 (#186186). A scan before the fix
// wrote our own pitch into the note as the "reply", under sender "me".

describe("audit a 'DM Replied' lead", () => {
  const note = (lines: string[]) =>
    `[DM Reply] @studio.nine replied via Instagram DM:\n---\n${lines.join("\n")}\n---\nScanned: 2026-04-26`

  test("a note holding only our own lines ('me:') → no real reply: the tag is false", () => {
    const v = auditRepliedLead({ notes: [note(["me: Noticed you're heavily involved in AI. Interested in teaming up?"])], comms: [] })
    expect(v.verdict).toBe("false_reply")
    expect(v.ourLines).toBe(1)
  })

  test("a note with a line from them → a real reply, the tag stands", () => {
    const v = auditRepliedLead({ notes: [note(["me: Noticed you're into AI", "them: Tell me more"])], comms: [] })
    expect(v.verdict).toBe("replied")
    expect(v.evidence).toContain("Tell me more")
  })

  test("a reachr-inbox comms row is evidence — it was read with the fixed sender logic", () => {
    const v = auditRepliedLead({ notes: [note(["me: pitch"])], comms: [{ body: "Sounds good", source: "reachr-inbox" }] })
    expect(v.verdict).toBe("replied")
  })

  test("a comms row that is only a backfilled copy of a 'me:' note is NOT evidence", () => {
    const n = note(["me: Noticed you're heavily involved in AI."])
    const v = auditRepliedLead({ notes: [n], comms: [{ body: n, source: null }] })
    expect(v.verdict).toBe("false_reply")
  })

  test("a line from them that repeats our own opening line is still ours", () => {
    // The old scan's second bug labelled OUR un-avatared bubbles by the lead's handle sometimes.
    const v = auditRepliedLead({
      notes: [note(["studio.nine: Noticed you're heavily involved in AI. Interested in teaming up?"])],
      comms: [],
      ourOpeners: ["noticed you're heavily involved in ai"],
    })
    expect(v.verdict).toBe("false_reply")
  })

  test("no note and no comms → cannot tell (tagged by some other path) — never called false", () => {
    expect(auditRepliedLead({ notes: [], comms: [] }).verdict).toBe("unknown")
  })

  test("an older [inbox reply] preview from them counts as a reply", () => {
    const v = auditRepliedLead({ notes: ['[inbox reply] IG reply from @studio.nine: "yes interested"'], comms: [] })
    expect(v.verdict).toBe("replied")
  })
})

// ══ READING A BOARD: every lead, or an error — never a silent subset ═════════

describe("reading every page of a board", () => {
  const board = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }))
  const pager = (rows: any[]) => async (page: number, size: number) => rows.slice((page - 1) * size, page * size)

  test("a 6,005-lead board is read to the end (the old 20-page cap stopped at 4,000)", async () => {
    const got = await collectPages(pager(board(6005)), { pageSize: 200, maxPages: 100 })
    expect(got.length).toBe(6005)
  })

  test("an exact multiple of the page size ends on the empty page", async () => {
    expect((await collectPages(pager(board(400)), { pageSize: 200, maxPages: 100 })).length).toBe(400)
  })

  test("hitting the safety cap with pages still full is an error, not a partial answer", async () => {
    await expect(collectPages(pager(board(1000)), { pageSize: 200, maxPages: 3 })).rejects.toThrow(/more than 600/)
  })
})
