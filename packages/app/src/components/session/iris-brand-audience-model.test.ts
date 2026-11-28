import { describe, expect, test } from "bun:test"
import { IRIS_BRAND_AUDIENCE_ENGLISH } from "@/i18n/iris-brand-audience"
import { AUDIENCE_ENUMS, NOT_FOR_FIELDS, POSITIONING_FIELDS, SEGMENT_GROUPS, USE_CASE_FIELDS, normalizeAudience, type AudienceIssue } from "./iris-brand-audience-schema"
import { audienceChanged, audienceDiff, audienceToSave, groupOfPath, issuesUnder } from "./iris-brand-audience-model"

// The Audience tab (#194611). A made-up brand; nothing here is a real customer.
const READ = {
  schema: "audience.v1",
  segments: [
    { id: "studio-owner", name: "Small studio owner", market: "b2b", demographics: { age_band: ["35-44"] }, evidence: { confidence: "observed" } },
    { name: "Weekend maker", market: "b2c", evidence: { confidence: "assumed" } },
  ],
}
const words = {
  segment: (n: string) => `Audience · ${n}`,
  brand: (p: string) => p,
  group: (k: string) => k,
  added: "added",
  removed: "removed",
  changed: (p: string) => `${p} changed`,
  unnamed: "Unnamed",
}
const en = IRIS_BRAND_AUDIENCE_ENGLISH as Record<string, string>

describe("Audience tab — copy", () => {
  test("every audience.v1 field, group and allowed value has English words", () => {
    const missing: string[] = []
    const need = (k: string) => en[k] || missing.push(k)
    for (const g of SEGMENT_GROUPS) {
      need(`iris.aud.g.${g.key}`)
      need(`iris.aud.g.${g.key}.lede`)
      for (const f of g.fields) if (f.key !== "id") need(`iris.aud.f.${f.key}`)
    }
    for (const f of [...USE_CASE_FIELDS, ...NOT_FOR_FIELDS, ...POSITIONING_FIELDS]) need(`iris.aud.f.${f.key}`)
    for (const [name, values] of Object.entries(AUDIENCE_ENUMS)) for (const v of values) need(`iris.aud.v.${name}.${v}`)
    for (const code of ["required", "type", "enum", "range", "date", "url", "reference", "schema"]) need(`iris.aud.err.${code}`)
    expect(missing).toEqual([])
  })
})

describe("Audience tab — draft and save", () => {
  test("reading and not touching it is not a change; one edit is", () => {
    const draft = normalizeAudience(READ)
    expect(audienceChanged(READ, draft)).toBe(false)
    expect(audienceChanged(undefined, normalizeAudience(undefined))).toBe(false)
    draft.segments[1]!.summary = "Buys prints"
    expect(audienceChanged(READ, draft)).toBe(true)
  })

  test("a save fills in missing ids, unique, and drops the empty fields the editor binds to", () => {
    const draft = normalizeAudience(READ)
    draft.segments.push({ ...normalizeAudience({ segments: [{ name: "Small studio owner" }] }).segments[0]! })
    const saved = audienceToSave(draft)
    expect(saved.segments.map((s) => s.id)).toEqual(["studio-owner", "weekend-maker", "small-studio-owner"])
    expect(saved.segments[1]).toEqual({ id: "weekend-maker", name: "Weekend maker", market: "b2c", evidence: { confidence: "assumed" } })
  })

  test("the confirm says what changed in words: added, a group changed, removed", () => {
    const draft = normalizeAudience(READ)
    draft.segments[0]!.demographics!.age_band = ["35-44", "45-54"]
    draft.segments[0]!.priority = "primary"
    draft.segments.splice(1, 1)
    draft.segments.push(normalizeAudience({ segments: [{ name: "Agency" }] }).segments[0]!)
    draft.positioning = { statement: "The studio kit." }
    expect(audienceDiff(READ, draft, words).map((l) => [l.label, l.note])).toEqual([
      ["Audience · Small studio owner", "identity, demographics changed"],
      ["Audience · Agency", "added"],
      ["Audience · Weekend maker", "removed"],
      ["positioning", "positioning changed"],
    ])
    expect(audienceDiff(READ, normalizeAudience(READ), words)).toEqual([])
  })

  test("an issue's path finds its segment, its group and its field", () => {
    expect(groupOfPath("segments[1].demographics.age_band[0]")).toEqual({ segment: 1, group: "demographics" })
    expect(groupOfPath("segments[0].name")).toEqual({ segment: 0, group: "identity" })
    expect(groupOfPath("use_cases[0].name")).toBeUndefined()
    const issues: AudienceIssue[] = [{ path: "segments[0].demographics.age_band[1]", code: "enum", message: "" }, { path: "segments[10].name", code: "required", message: "" }]
    expect(issuesUnder(issues, "segments[0].demographics.age_band").length).toBe(1)
    expect(issuesUnder(issues, "segments[1]").length).toBe(0)
  })
})
