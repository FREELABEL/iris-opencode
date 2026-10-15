import { describe, expect, test } from "bun:test"
import { recordHeadline } from "../src/cli/cmd/platform-atlas-datasets"

// #187830 — `records list` headlined a Lexicon demand letter with its `gaps` array,
// comma-joined, because MySQL returns JSON keys sorted by length and the CLI took
// whichever came first. The headline is a field, chosen on purpose.
describe("record headline", () => {
  const lexDemandSchema = {
    fields: {
      fields: [
        { key: "matter_ref", type: "text", label: "Matter" },
        { key: "status", type: "select", label: "Status" },
        { key: "recipient", type: "text", label: "Recipient" },
        { key: "amount", type: "number", label: "Amount" },
        { key: "readiness", type: "select", label: "Readiness" },
        { key: "gaps", type: "list", label: "Gaps" },
      ],
    },
  }

  // Key order exactly as fl-api returned it (shortest first) — that order is the bug.
  const lexDemandRecord = {
    id: 24313,
    external_id: "LEX-TEST9001-DEM",
    data: {
      gaps: [
        "Final orthopedic evaluation and prognosis",
        "Wage loss letter from employer",
        "Health insurer lien amount",
      ],
      amount: 185000,
      status: "attorney_review",
      readiness: "ready_with_gaps",
      recipient: "Brazos Mutual — adjuster",
      drafted_at: "2026-10-03T05:51:03Z",
      matter_ref: "LEX-TEST9001",
    },
  }

  test("lex-demand: the first SCHEMA field, not the shortest key", () => {
    const h = recordHeadline(lexDemandRecord, lexDemandSchema)
    expect(h.value).toBe("LEX-TEST9001")
    expect(h.key).toBe("matter_ref")
  })

  test("display_field is honoured when it holds a scalar", () => {
    const schema = { fields: { ...lexDemandSchema.fields, display_field: "recipient" } }
    expect(recordHeadline(lexDemandRecord, schema)).toEqual({ key: "recipient", value: "Brazos Mutual — adjuster" })
  })

  test("display_field pointing at an array falls through", () => {
    const schema = { fields: { ...lexDemandSchema.fields, display_field: "gaps" } }
    expect(recordHeadline(lexDemandRecord, schema).value).toBe("LEX-TEST9001")
  })

  test("display_field pointing at an empty value falls through", () => {
    const schema = { fields: { ...lexDemandSchema.fields, display_field: "missing" } }
    expect(recordHeadline(lexDemandRecord, schema).value).toBe("LEX-TEST9001")
  })

  test("title, then name, then label beat the schema order", () => {
    const base = { id: 1, data: { tags: ["a"], matter_ref: "M-1", name: "Nombre", title: "The Title", label: "Lbl" } }
    expect(recordHeadline(base, lexDemandSchema)).toEqual({ key: "title", value: "The Title" })
    const noTitle = { id: 1, data: { tags: ["a"], matter_ref: "M-1", label: "Lbl", name: "Nombre" } }
    expect(recordHeadline(noTitle, lexDemandSchema)).toEqual({ key: "name", value: "Nombre" })
    const blankTitle = { id: 1, data: { title: "", label: "Lbl", matter_ref: "M-1" } }
    expect(recordHeadline(blankTitle, lexDemandSchema)).toEqual({ key: "label", value: "Lbl" })
  })

  test("no schema at all: the first scalar data key", () => {
    const r = { id: 9, data: { gaps: ["x", "y"], meta: { a: 1 }, empty: "", amount: 42, status: "open" } }
    expect(recordHeadline(r, undefined)).toEqual({ key: "amount", value: "42" })
  })

  test("booleans count as scalars", () => {
    const r = { id: 9, data: { tags: ["x"], done: false } }
    expect(recordHeadline(r, null)).toEqual({ key: "done", value: "false" })
  })

  test("nothing scalar: external_id, then #id — never an array or object", () => {
    const withExt = { id: 5, external_id: "EXT-5", data: { gaps: ["a", "b"], meta: { x: 1 } } }
    expect(recordHeadline(withExt, lexDemandSchema)).toEqual({ key: null, value: "EXT-5" })
    const bare = { id: 5, data: { gaps: ["a", "b"], meta: { x: 1 } } }
    expect(recordHeadline(bare, lexDemandSchema)).toEqual({ key: null, value: "#5" })
    expect(recordHeadline({ id: 6 }, undefined)).toEqual({ key: null, value: "#6" })
  })
})
