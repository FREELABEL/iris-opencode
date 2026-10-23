import { describe, expect, it } from "bun:test"
import { checkFields, fieldsForCreate, hintFor, normalizeDraft, parseModelJson } from "../src/cli/cmd/atlas-schema-draft"

/**
 * #187903 — a prompt drafts a schema, never creates one. These pin the guarantees that hold
 * WHATEVER the model answers: no field without a visibility, unsure means private, PHI-looking
 * names are raised and never lowered, and the draft pipes into `create --dry-run` cleanly.
 */
describe("normalizeDraft", () => {
  it("defaults a missing or unrecognised visibility to private — never public", () => {
    const d = normalizeDraft({ fields: [
      { key: "notes", type: "text" },
      { key: "colour", type: "text", visibility: "internal" },
      { key: "title", type: "text", visibility: "public" },
    ] }, "x")
    expect(d.fields.map((f) => f.visibility)).toEqual(["private", "private", "public"])
    expect(d.fields.every((f) => !!f.visibility)).toBe(true)
  })

  it("raises a PHI-looking field the model called public, and never lowers one", () => {
    const d = normalizeDraft({ fields: [
      { key: "date_of_birth", label: "Date of Birth", type: "date", visibility: "public" },
      { key: "insurance_member_id", type: "text", visibility: "private" },
      { key: "email", type: "email", visibility: "public" },
      { key: "favourite_colour", type: "text", visibility: "phi" },
    ] }, "patient intake with insurance")
    const vis = Object.fromEntries(d.fields.map((f) => [f.key, f.visibility]))
    expect(vis.date_of_birth).toBe("phi")
    expect(vis.insurance_member_id).toBe("phi")
    expect(vis.email).toBe("private")
    expect(vis.favourite_colour).toBe("phi") // the model's caution stands
    expect(d.review.find((r) => r.key === "date_of_birth")?.why).toContain("raised to phi")
  })

  it("clamps types, snake_cases and de-duplicates keys, and drops enum without options", () => {
    const d = normalizeDraft([
      { key: "Insurance Provider", type: "dropdown" },
      { key: "insurance_provider", type: "text" },
      { key: "status", type: "enum", options: [] },
      { key: "plan", type: "enum", options: ["HMO", "PPO"] },
      { nonsense: true },
    ], "s")
    expect(d.fields.map((f) => f.key)).toEqual(["insurance_provider", "insurance_provider_2", "status", "plan"])
    expect(d.fields[0]!.type).toBe("text")
    expect(d.fields[2]!.type).toBe("text")
    expect(d.fields[3]!.options).toEqual(["HMO", "PPO"])
  })

  it("is marked as an uncreated draft", () => {
    const d = normalizeDraft({ name: "Intake", fields: [{ key: "a", type: "text" }] }, "s")
    expect(d.draft).toBe(true)
    expect(d.created).toBe(false)
    expect(d.name).toBe("Intake")
  })
})

describe("draft → create --dry-run", () => {
  it("unwraps a draft to {fields} and passes the local checks", () => {
    const d = normalizeDraft({ fields: [{ key: "patient_name", type: "text" }, { key: "dob", type: "date" }] }, "s")
    const f = fieldsForCreate(JSON.parse(JSON.stringify(d)))
    expect(Object.keys(f)).toEqual(["fields"])
    expect(checkFields(f)).toEqual([])
  })

  it("refuses a field with no visibility, as fl-api would", () => {
    const problems = checkFields(fieldsForCreate([{ key: "a", type: "text" }]))
    expect(problems.join(" ")).toContain("visibility")
  })

  it("keeps the old create behaviour for non-draft input", () => {
    expect(fieldsForCreate({ fields: [], extra: 1 })).toEqual({ fields: [], extra: 1 })
  })
})

describe("hintFor / parseModelJson", () => {
  it("matches labels and keys alike", () => {
    expect(hintFor("x", "Social Security")?.visibility).toBe("phi")
    expect(hintFor("last_name")?.visibility).toBe("private")
    expect(hintFor("title")).toBeNull()
  })

  it("tolerates fences and think blocks", () => {
    expect(parseModelJson('<think>{"no":1}</think>```json\n{"fields":[]}\n```')).toEqual({ fields: [] })
    expect(parseModelJson("nope")).toBeNull()
  })
})
