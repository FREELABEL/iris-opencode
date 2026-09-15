import { describe, expect, test } from "bun:test"
import { diffDraft, draftFrom, statusOptions, type CardDoc } from "./iris-card-editor"

const doc: CardDoc = {
  measured: true,
  id: 179202,
  title: "Diary",
  content: "# hi",
  contentKind: "markdown",
  status: "active",
  priority: "high",
  listId: 1776,
  listName: "Daily Diary",
  labels: [],
  isPublic: false,
  tasks: [],
  tasksMeasured: true,
}

describe("card editor — what a save sends", () => {
  test("an untouched form sends nothing", () => {
    expect(diffDraft(doc, draftFrom(doc))).toEqual({})
  })

  test("only the changed fields, typed for the wire", () => {
    const d = { ...draftFrom(doc), status: "done", listId: "1822", dueDate: "2026-09-20" }
    expect(diffDraft(doc, d)).toEqual({ status: "done", listId: 1822, dueDate: "2026-09-20" })
  })

  test("clearing a nullable sends null, not an empty string", () => {
    // fl-api's has('priority') is true for null and assigns it; an empty string would be
    // stored as "" and read back as a priority nobody can see.
    const d = { ...draftFrom(doc), priority: "" }
    expect(diffDraft(doc, d)).toEqual({ priority: null })
  })

  test("a blank title is not a rename", () => {
    const d = { ...draftFrom(doc), title: "   " }
    expect(diffDraft(doc, d)).toEqual({})
  })
})

describe("card editor — the status picker", () => {
  const schema = [
    { id: "todo", label: "To Do" },
    { id: "done", label: "Done" },
    { id: "blocked", label: "Blocked" },
  ]

  test("keeps the item's current status even when the vocabulary omits it", () => {
    // `active` is a legal stored status the default schema does not name. Dropping it would
    // render the current value blank and the first save would silently change it.
    const opts = statusOptions(schema, "active")
    expect(opts[0]).toEqual({ id: "active", label: "active", writable: true })
    expect(opts.map((o) => o.id)).toEqual(["active", "todo", "done", "blocked"])
  })

  test("marks a schema status the column will refuse, rather than hiding it", () => {
    const blocked = statusOptions(schema, "todo").find((o) => o.id === "blocked")
    expect(blocked?.writable).toBe(false)
  })

  test("does not duplicate a current status the schema already names", () => {
    expect(statusOptions(schema, "todo").filter((o) => o.id === "todo")).toHaveLength(1)
  })
})

import { allowListSummary, fileSize, parseAllowEntries } from "./iris-card-editor"

describe("card editor — sharing allow-list", () => {
  test("parses emails and @domains, lower-cased, de-duplicated against what is there", () => {
    expect(parseAllowEntries("Alex@Freelabel.net, @heyiris.io\nbob@x.co bob@x.co", ["alex@freelabel.net"])).toEqual([
      "@heyiris.io",
      "bob@x.co",
    ])
  })

  test("drops what is neither an email nor a domain", () => {
    expect(parseAllowEntries("hello world, not-an-email")).toEqual([])
  })

  test("says out loud that an EMPTY list on a public item admits anyone", () => {
    // never-empty-a-gate-allowlist: this is the sentence that has to be on screen.
    expect(allowListSummary(true, [])).toMatch(/ANYONE with the link/)
    expect(allowListSummary(true, ["a@b.co"])).toMatch(/Only 1 allowed entry/)
    expect(allowListSummary(false, [])).toMatch(/Private/)
  })
})

describe("card editor — attachment sizes", () => {
  test("bytes, KB, MB", () => {
    expect(fileSize(900)).toBe("900 B")
    expect(fileSize(4 * 1024)).toBe("4.0 KB")
    expect(fileSize(42 * 1024 * 1024)).toBe("42.0 MB")
    expect(fileSize(undefined)).toBe("")
  })
})
