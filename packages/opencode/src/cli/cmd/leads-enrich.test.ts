import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { ENRICH_DESCRIBE, enrichMany, enrichOne, enrichRequestBody, formatOutcome, summarizeEnrich, type EnrichFetch } from "./leads-enrich"

/**
 * #191700 — `iris leads enrich` must preview by default, confirm only on --apply, and use the
 * same web-research contract for --bloq as for --id. The API is faked; nothing here calls it.
 */

// The fl-api answer for lead #30324 "Hank's" (a coffee shop) after #191700: the research found
// Hank's Gourmet Beverages, a soda company, and the guard calls it ambiguous.
const hanksPreview = {
  success: true,
  requires_confirmation: true,
  persisted: false,
  data: {
    lead_id: 30324,
    entity_match: {
      status: "ambiguous",
      reasons: [
        `name-only match: lead is "Hank's / Hank's Coffee" but the result is "Hank's Gourmet Beverages" (business type differs: coffee vs gourmet beverages)`,
        "lead has no city, state, address or ZIP on record to verify the result against",
      ],
      evidence: [],
      result_business: "Hank's Gourmet Beverages",
    },
    proposed_changes: [
      { field: "email", value: "info@hanksbeverages.com", current: null, action: "set", passes_guard: false, guard_reason: "entity guard: ambiguous", provenance: { source_url: "https://hanksbeverages.com/contact", provider: "web_research", researched_at: "2026-10-29T02:32:21Z" } },
      { field: "website", value: "https://hanksbeverages.com", current: null, action: "set", passes_guard: false, guard_reason: "entity guard: ambiguous", provenance: { source_url: "https://hanksbeverages.com", provider: "web_research", researched_at: "2026-10-29T02:32:21Z" } },
    ],
    applied: false,
    applied_fields: [],
    apply_refused_reason: null,
  },
}

const brewApplied = {
  success: true,
  requires_confirmation: false,
  persisted: true,
  data: {
    lead_id: 2,
    entity_match: { status: "matched", reasons: [], evidence: ['name: "Brew and Brew"', "city Austin, TX"], result_business: "Brew and Brew" },
    proposed_changes: [
      { field: "email", value: "hello@brewandbrew.com", current: null, action: "set", passes_guard: true, provenance: { source_url: "https://www.brewandbrew.com/contact", provider: "web_research", researched_at: "t" } },
    ],
    applied: true,
    applied_fields: ["email"],
  },
}

type Call = { path: string; body: Record<string, unknown> }
function fakeApi(answers: Record<number, any>): { post: EnrichFetch; calls: Call[] } {
  const calls: Call[] = []
  const post: EnrichFetch = async (path, body) => {
    calls.push({ path, body })
    const id = Number(path.match(/leads\/(\d+)\//)?.[1])
    const a = answers[id]
    if (a === undefined) return { ok: false, status: 400, json: async () => ({}), text: async () => "Could not fetch Instagram profile" }
    return { ok: true, status: 200, json: async () => a, text: async () => JSON.stringify(a) }
  }
  return { post, calls }
}

describe("preview is the default", () => {
  test("without --apply the body carries no confirmation", () => {
    expect(enrichRequestBody(false)).toEqual({})
    expect(enrichRequestBody(true)).toEqual({ apply: true })
  })

  test("Hank's comes back ambiguous with the reason, and the output says nothing was saved", async () => {
    const { post, calls } = fakeApi({ 30324: hanksPreview })
    const o = await enrichOne(30324, false, post)
    expect(calls).toEqual([{ path: "/api/v1/leads/30324/enrich", body: {} }])
    expect(o.status).toBe("ambiguous")
    expect(o.persisted).toBe(false)
    const text = formatOutcome(o, false).join("\n")
    expect(text).toContain("guard AMBIGUOUS")
    expect(text).toContain("business type differs")
    expect(text).toContain("info@hanksbeverages.com")
    expect(text).toContain("[held]")
    expect(text).toContain("https://hanksbeverages.com/contact")
    expect(text).toContain("preview only — nothing saved")
    expect(text).not.toContain("would apply")
  })
})

describe("--apply", () => {
  test("sends confirmation and reports per-field application", async () => {
    const { post, calls } = fakeApi({ 2: brewApplied })
    const o = await enrichOne(2, true, post)
    expect(calls[0].body).toEqual({ apply: true })
    expect(o.applied).toBe(true)
    expect(o.integrity_violation).toBeNull()
    expect(formatOutcome(o, true).join("\n")).toContain("✓ applied 1 field(s)")
  })

  test("an API that saves without the guard passing is flagged, never reported as fine", () => {
    // What production did on 2026-10-29: it saved while the result was the wrong business.
    const bad = { ...hanksPreview, persisted: true, data: { ...hanksPreview.data, applied: true, applied_fields: ["email"] } }
    expect(summarizeEnrich(30324, bad, true).integrity_violation).toContain("ambiguous")
    expect(summarizeEnrich(30324, bad, false).integrity_violation).toContain("--apply was not given")
  })

  test("an API with no guard verdict (pre-#191700) is called unverified", () => {
    const old = { success: true, requires_confirmation: true, data: { found_contacts: {}, note: { id: 380020 } } }
    const o = summarizeEnrich(30324, old, false)
    expect(o.status).toBe("unknown")
    expect(o.integrity_violation).toContain("no entity guard verdict")
  })
})

describe("--bloq uses the same contract as --id", () => {
  test("every lead goes to /enrich with the same body; no Instagram-only endpoint", async () => {
    const { post, calls } = fakeApi({ 30324: hanksPreview, 2: brewApplied })
    const { tally } = await enrichMany([30324, 2], false, post)
    expect(calls.map((c) => c.path)).toEqual(["/api/v1/leads/30324/enrich", "/api/v1/leads/2/enrich"])
    expect(calls.every((c) => JSON.stringify(c.body) === "{}")).toBe(true)
    expect(calls.some((c) => c.path.includes("quick-enrich-ig"))).toBe(false)
    expect(tally).toMatchObject({ total: 2, ambiguous: 1, matched: 1, failed: 0 })
  })

  test("--apply in bulk sends confirmation for each lead", async () => {
    const { post, calls } = fakeApi({ 30324: hanksPreview, 2: brewApplied })
    const { tally } = await enrichMany([30324, 2], true, post)
    expect(calls.every((c) => c.body.apply === true)).toBe(true)
    expect(tally.applied).toBe(1)
  })

  test("one failing lead does not stop the rest", async () => {
    const { post } = fakeApi({ 2: brewApplied })
    const { tally, outcomes } = await enrichMany([999, 2], false, post)
    expect(tally.failed).toBe(1)
    expect(outcomes[1].status).toBe("matched")
  })

  test("the command no longer dispatches the Hive leadgen task", () => {
    const src = readFileSync(join(import.meta.dir, "platform-leads.ts"), "utf8")
    const start = src.indexOf("const LeadsEnrichCommand = cmd({")
    const end = src.indexOf("\n})\n", start)
    const body = src.slice(start, end)
    expect(start).toBeGreaterThan(-1)
    expect(body).not.toContain("/api/v6/nodes/tasks")
    expect(body).not.toContain("quick-enrich-ig")
    expect(body).toContain("enrichMany(")
    expect(body).toContain('"apply"')
  })
})

describe("help text matches the behaviour", () => {
  test("says preview-only by default and what --apply does", () => {
    expect(ENRICH_DESCRIBE).toContain("Preview-only by default")
    expect(ENRICH_DESCRIBE).toContain("--apply saves only results the guard matched")
    expect(ENRICH_DESCRIBE).toContain("Instagram only as an extra source")
  })
})
