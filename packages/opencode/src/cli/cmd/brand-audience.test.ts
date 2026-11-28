import { describe, expect, test } from "bun:test"
import {
  AUDIENCE_ENUMS,
  AUDIENCE_SCHEMA,
  SEGMENT_GROUPS,
  audienceSummary,
  audienceTemplateYaml,
  cleanAudienceInput,
  emptyAudience,
  emptySegment,
  isB2b,
  normalizeAudience,
  pruneAudience,
  segmentSummary,
  uniqueSegmentId,
  validateAudience,
  type Audience,
} from "./brand-audience"

// audience.v1 (#194610). A made-up brand, one B2B and one B2C segment — never a real brand's data.
const NORTHWIND: Audience = {
  schema: "audience.v1",
  segments: [
    {
      id: "studio-owner",
      name: "Small studio owner",
      summary: "Runs a 2-10 person design studio and wins work on referrals.",
      priority: "primary",
      market: "b2b",
      share: 60,
      demographics: { age_band: ["35-44", "25-34"], locations: ["United States", "Canada"], settlement: ["urban"], languages: ["en"] },
      firmographics: { role: "Founder", seniority: "owner", industry: ["Design", "Marketing"], company_size: "2-10", revenue_band: "250k-1M", tech_maturity: "medium" },
      psychographics: { values: ["independence"], motivations: ["look professional"], frustrations: ["chasing invoices"], fears: ["a slow quarter"], self_image: "I'm the one who makes things happen" },
      day_in_life: { routine: { morning: "Inbox and the day's deadlines", work: "Client calls, design reviews", evening: "Proposals" }, tools_they_use: ["Figma", "Notion"], media: ["Design Matters"], where_they_hang_out: ["LinkedIn"], best_time_to_reach: "weekday mornings, 7-9am local" },
      jobs: [{ when: "a new lead emails", want_to: "send a proposal the same day", so_they_can: "win the work before a rival does", today_they_use: "a Google Doc template" }],
      buying: { what_they_buy: ["Figma", "QuickBooks"], budget: "$50-150 a month", price_sensitivity: "medium", buying_triggers: ["a lost deal"], objections: ["another tool to learn"], decision: "self", influencers: ["their accountant"], where_they_buy: ["online"], cycle: "weeks" },
      interests: { hobbies: ["cycling"], topics: ["pricing"], communities: ["AIGA"], follows: ["Chris Do"] },
      messaging: { resonates: ["time back"], words_to_use: ["simple"], words_to_avoid: ["enterprise"], proof_they_need: ["a demo"], best_cta: "Start free", best_channels: ["LinkedIn", "email"] },
      evidence: { confidence: "observed", sources: ["Interviews, 2026-11 (5 people)"], last_reviewed: "2026-11-28" },
      personas: [{ name: "Maya", age: 38, role: "Founder, 6-person studio", quote: "I lose a day a week to admin.", typical_tuesday: "Calls until noon, design after.", goals: ["two new clients a month"], frustrations: ["late payments"], what_would_make_them_switch: "proposals in minutes" }],
    },
    {
      id: "home-maker",
      name: "Weekend maker",
      summary: "Buys our prints and kits for their own home projects.",
      priority: "secondary",
      market: "b2c",
      demographics: { age_band: ["25-34"], gender_skew: "mostly_women", income_band: "75-150k", education: "bachelors", household: "couple" },
      evidence: { confidence: "assumed" },
    },
  ],
  use_cases: [{ name: "Same-day proposals", for_segments: ["studio-owner"], problem: "Proposals take days", how_we_solve_it: "A template that fills itself", outcome_metric: "proposal turnaround", example: "Maya sends one before lunch" }],
  not_for: [{ who: "Large agencies", why: "They need procurement and SSO we don't offer" }],
  positioning: { statement: "The studio kit for small teams.", category: "Studio operations", alternatives: ["Google Docs", "HoneyBook"] },
}

describe("audience.v1 — validate", () => {
  test("the empty template is valid", () => {
    expect(validateAudience(emptyAudience())).toEqual({ ok: true, errors: [], warnings: [] })
  })

  test("a full example is valid with no warnings", () => {
    expect(validateAudience(NORTHWIND)).toEqual({ ok: true, errors: [], warnings: [] })
  })

  test("enum values are checked, with the path to the bad one", () => {
    const bad = structuredClone(NORTHWIND) as any
    bad.segments[0].demographics.age_band = ["35-44", "40-50"]
    bad.segments[0].priority = "top"
    bad.segments[1].buying = { cycle: "years" }
    const r = validateAudience(bad)
    expect(r.ok).toBe(false)
    expect(r.errors.map((e) => [e.path, e.code])).toEqual([
      ["segments[0].priority", "enum"],
      ["segments[0].demographics.age_band[1]", "enum"],
      ["segments[1].buying.cycle", "enum"],
    ])
    expect(r.errors[0]!.message).toContain("primary, secondary, emerging")
  })

  test("lists must be lists of text", () => {
    const bad = structuredClone(NORTHWIND) as any
    bad.segments[0].psychographics.values = "independence"
    bad.segments[0].interests.hobbies = ["cycling", 3]
    const r = validateAudience(bad)
    expect(r.errors.map((e) => e.path)).toEqual(["segments[0].psychographics.values", "segments[0].interests.hobbies[1]"])
    expect(r.errors.every((e) => e.code === "type")).toBe(true)
  })

  test("confidence is required on every segment", () => {
    const bad = structuredClone(NORTHWIND) as any
    delete bad.segments[1].evidence
    bad.segments[0].evidence = { sources: [] }
    const r = validateAudience(bad)
    expect(r.errors.map((e) => [e.path, e.code])).toEqual([
      ["segments[0].evidence.confidence", "required"],
      ["segments[1].evidence.confidence", "required"],
    ])
  })

  test("a segment needs a name; a persona needs a name", () => {
    const bad = structuredClone(NORTHWIND) as any
    bad.segments[0].name = "  "
    bad.segments[0].personas[0].name = ""
    expect(validateAudience(bad).errors.map((e) => e.path)).toEqual(["segments[0].name", "segments[0].personas[0].name"])
  })

  test("unknown keys are warnings, not errors — and are kept", () => {
    const x = structuredClone(NORTHWIND) as any
    x.segments[0].demographics.pets = ["dog"]
    x.notes = "from the workshop"
    const r = validateAudience(x)
    expect(r.ok).toBe(true)
    expect(r.warnings.map((w) => [w.path, w.code])).toEqual([
      ["notes", "unknown"],
      ["segments[0].demographics.pets", "unknown"],
    ])
    expect((normalizeAudience(x) as any).notes).toBe("from the workshop")
    expect((pruneAudience(normalizeAudience(x)) as any).segments[0].demographics.pets).toEqual(["dog"])
  })

  test("numbers, dates and the schema tag", () => {
    const bad = structuredClone(NORTHWIND) as any
    bad.schema = "audience.v2"
    bad.segments[0].share = 140
    bad.segments[0].evidence.last_reviewed = "28/11/2026"
    bad.segments[0].personas[0].age = "38"
    expect(validateAudience(bad).errors.map((e) => [e.path, e.code])).toEqual([
      ["schema", "schema"],
      ["segments[0].share", "range"],
      ["segments[0].evidence.last_reviewed", "date"],
      ["segments[0].personas[0].age", "type"],
    ])
  })

  test("a use case pointing at no segment, an odd language code and a duplicate id", () => {
    const x = structuredClone(NORTHWIND) as any
    x.use_cases[0].for_segments = ["studio-owner", "nobody"]
    x.segments[0].demographics.languages = ["English"]
    expect(validateAudience(x).warnings.map((w) => [w.path, w.code])).toEqual([
      ["segments[0].demographics.languages[0]", "language"],
      ["use_cases[0].for_segments[1]", "reference"],
    ])
    x.segments[1].id = "studio-owner"
    expect(validateAudience(x).errors.map((e) => e.path)).toEqual(["segments[1].id"])
  })

  test("cleaning drops empty rows but adds nothing — a missing confidence still fails", () => {
    expect(cleanAudienceInput({ schema: "audience.v1", segments: [] })).toEqual({ schema: "audience.v1", segments: [] })
    const r = validateAudience(cleanAudienceInput({ schema: "audience.v1", segments: [{ name: "A", evidence: { sources: [""] } }] }))
    expect(r.errors.map((e) => e.path)).toEqual(["segments[0].evidence.confidence"])
  })

  test("not an object, or no segments", () => {
    for (const bad of [null, "x", [], 3]) expect(validateAudience(bad).ok).toBe(false)
    expect(validateAudience({ schema: AUDIENCE_SCHEMA }).errors[0]!.path).toBe("segments")
  })
})

describe("audience.v1 — read, store, summarise", () => {
  test("normalize gives the editor every group; prune gives back only what was said", () => {
    const n = normalizeAudience({ schema: "audience.v1", segments: [{ name: "A", evidence: { confidence: "validated" } }] })
    for (const g of SEGMENT_GROUPS) if (g.shape !== "flat") expect(n.segments[0]![g.key as "demographics"]).toBeDefined()
    expect(pruneAudience(n)).toEqual({ schema: "audience.v1", segments: [{ name: "A", evidence: { confidence: "validated" } }] })
    expect(pruneAudience(normalizeAudience(NORTHWIND))).toEqual(NORTHWIND)
    expect(normalizeAudience(undefined)).toEqual(emptyAudience())
  })

  test("prune trims text and drops empty strings and lists", () => {
    const n = normalizeAudience(emptyAudience())
    n.segments.push({ ...emptySegment(" B "), summary: "  ", demographics: { locations: ["", " Austin "] } } as any)
    expect(pruneAudience(n).segments[0]).toEqual({ id: "b", name: "B", demographics: { locations: ["Austin"] }, evidence: { confidence: "assumed" } })
  })

  test("one line per segment", () => {
    expect(audienceSummary(NORTHWIND)).toEqual([
      "Small studio owner (observed): primary · b2b · 25-44 · 2-10 people · United States, Canada · 60% — Runs a 2-10 person design studio and wins work on referrals.",
      "Weekend maker (assumed): secondary · b2c · 25-34 · income 75-150k — Buys our prints and kits for their own home projects.",
    ])
    expect(segmentSummary({ name: "x", evidence: { confidence: "assumed" } })).toBe("")
    expect(audienceSummary(null)).toEqual([])
  })

  test("firmographics are for b2b and b2b2c", () => {
    expect([isB2b("b2b"), isB2b("b2b2c"), isB2b("b2c"), isB2b(undefined)]).toEqual([true, true, false, true])
  })

  test("segment ids are unique", () => {
    expect(uniqueSegmentId("Studio leads", ["studio-leads", "studio-leads-2"])).toBe("studio-leads-3")
    expect(uniqueSegmentId("", [])).toBe("segment")
  })

  test("the template is YAML naming every field, and validates once a segment has a name", () => {
    const yaml = audienceTemplateYaml()
    for (const g of SEGMENT_GROUPS) for (const fld of g.fields) expect(yaml).toContain(`${fld.key}:`)
    for (const v of AUDIENCE_ENUMS.confidence) expect(yaml).toContain(v)
    const doc = (globalThis as any).Bun.YAML.parse(yaml)
    expect(doc.schema).toBe("audience.v1")
    // As printed, the raw template names the required fields it leaves empty…
    expect(validateAudience(doc).errors.map((e) => e.path)).toEqual(["segments[0].name", "segments[0].personas[0].name", "use_cases[0].name", "not_for[0].who"])
    // …and cleaned (empty rows dropped, as `set` and `validate` do) only the segment's name is missing.
    expect(validateAudience(cleanAudienceInput(doc)).errors.map((e) => e.path)).toEqual(["segments[0].name"])
    doc.segments[0].name = "Anyone"
    const cleaned = cleanAudienceInput(doc) as any
    expect(cleaned).toEqual({ schema: "audience.v1", segments: [{ name: "Anyone", evidence: { confidence: "assumed" } }] })
    const r = validateAudience(cleaned)
    expect(r.errors).toEqual([])
    expect(r.warnings).toEqual([])
  })
})
