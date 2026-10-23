import { describe, expect, test } from "bun:test"
import { appendTranscript, diffDraft, draftFrom, groupTrail, statusOptions, timeAgo, type CardDoc, type TrailRow } from "./iris-card-editor"

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

describe("appendTranscript — a meeting lands at the END of the body, never over it (#190041)", () => {
  test("a new line after what is there", () => {
    expect(appendTranscript("Agenda\n- budget", "We agreed on the budget.")).toBe("Agenda\n- budget\n\nWe agreed on the budget.")
  })
  test("an empty body becomes the transcript", () => {
    expect(appendTranscript("", "  hello  ")).toBe("hello")
  })
  test("trailing whitespace is not stacked into blank lines", () => {
    expect(appendTranscript("notes\n\n\n", "more")).toBe("notes\n\nmore")
  })
  test("an empty transcript leaves the body exactly as it was", () => {
    expect(appendTranscript("keep  \n", "   ")).toBe("keep  \n")
  })
})

describe("card editor — the chat thread (Elon layout)", () => {
  // fl-api sends the trail newest first.
  const rows: TrailRow[] = [
    { id: 9, type: "comment", text: "Moved it.", actor: "FREELABEL", actorId: 193, at: "2026-10-22T10:09:00Z" },
    { id: 8, type: "item_updated", text: "Item updated: x", actor: "FREELABEL", actorId: 193, at: "2026-10-22T10:08:00Z" },
    { id: 7, type: "item_updated", text: "Item updated: x", actor: "FREELABEL", actorId: 193, at: "2026-10-22T10:07:00Z" },
    { id: 6, type: "item_updated", text: "Item updated: x", actor: "FREELABEL", actorId: 193, at: "2026-10-22T10:06:00Z" },
    { id: 5, type: "comment", text: "Looks good", actor: "Sam", actorId: 7, at: "2026-10-22T10:05:00Z" },
    { id: 4, type: "item_assigned", text: "Assigned Crate Keeper", actor: "Sam", actorId: 7, at: "2026-10-22T10:04:00Z" },
  ]

  test("reads oldest first, and folds a run of edits by one person into one line", () => {
    const t = groupTrail(rows, { id: 193 })
    expect(t.map((e) => e.kind)).toEqual(["change", "comment", "change", "comment"])
    const edits = t[2]
    expect(edits.kind === "change" && edits.rows.length).toBe(3)
    expect(edits.kind === "change" && edits.summary).toBe("edited the card 3×")
    expect(edits.kind === "change" && edits.at).toBe("2026-10-22T10:08:00Z")
  })

  test("a single change keeps its own words; mixed changes are counted", () => {
    const one = groupTrail([rows[5]])
    expect(one[0].kind === "change" && one[0].summary).toBe("Assigned Crate Keeper")
    const mixed = groupTrail([rows[1], { ...rows[5], actor: "FREELABEL", actorId: 193 }])
    expect(mixed[0].kind === "change" && mixed[0].summary).toBe("made 2 changes")
  })

  test("your own comments are yours by id, not by a display name that differs", () => {
    const t = groupTrail(rows, { id: 193, name: "admin", email: "admin@freelabel.net" })
    const comments = t.filter((e) => e.kind === "comment")
    expect(comments.map((c) => c.kind === "comment" && c.mine)).toEqual([false, true])
  })

  test("without an id, the name or email still finds them", () => {
    const noIds = rows.map(({ actorId, ...r }) => r)
    const t = groupTrail(noIds, { name: "freelabel" })
    expect(t.filter((e) => e.kind === "comment").map((c) => c.kind === "comment" && c.mine)).toEqual([false, true])
  })

  test("relative times", () => {
    const now = Date.parse("2026-10-22T12:00:00Z")
    expect(timeAgo("2026-10-22T11:59:40Z", now)).toBe("just now")
    expect(timeAgo("2026-10-22T11:55:00Z", now)).toBe("5m ago")
    expect(timeAgo("2026-10-22T10:00:00Z", now)).toBe("2h ago")
    expect(timeAgo("2026-10-19T12:00:00Z", now)).toBe("3d ago")
    expect(timeAgo(undefined, now)).toBe("")
    expect(timeAgo("not a date", now)).toBe("not a date")
  })
})
