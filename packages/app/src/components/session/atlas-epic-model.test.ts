import { describe, expect, test } from "bun:test"
import { buttonsFor, hue, initials, itemKey, progress, promptFor, readEpic, sourceMark } from "./atlas-epic-model"

const INPUT = {
  title: "Reply to people waiting on me",
  summary: "2 ready",
  lists: [
    {
      title: "Draft replies",
      source: "Gmail",
      status: "ready",
      items: [
        { title: "Maria Lopez", subtitle: "Rescheduling Thursday's cleaning", body: "Hi Maria", kind: "draft", ref: { type: "gmail_message", id: "1a11" } },
        { title: "" },
      ],
    },
    { title: "", items: [] },
    { title: "Overdue", status: "done", items: [{ title: "Acme", kind: "alert" }] },
  ],
}

describe("readEpic", () => {
  test("while running it draws from the input, skips untitled rows, and says Working", () => {
    const e = readEpic(INPUT, {}, "running")
    expect(e.working).toBe(true)
    expect(e.saved).toBeUndefined()
    expect(e.lists.map((l) => l.title)).toEqual(["Draft replies", "Overdue"])
    expect(e.lists[0].items).toHaveLength(1)
    expect(e.lists[0].source).toBe("gmail")
  })

  test("once completed it reads the metadata — ids, saved, reason", () => {
    const meta = { ...INPUT, saved: true, bloqId: 42, listIds: [5], lists: [{ ...INPUT.lists[0], items: [{ title: "Maria Lopez", id: 9 }] }] }
    const e = readEpic(INPUT, meta, "completed")
    expect(e).toMatchObject({ working: false, saved: true, bloqId: 42, listIds: [5] })
    expect(e.lists[0].items[0].id).toBe(9)
  })

  test("a partial streaming input does not throw", () => {
    expect(readEpic({ title: "x", lists: [{ title: "a" }] }, undefined, "pending").lists[0].items).toEqual([])
    expect(readEpic(undefined, undefined, "pending").title).toBe("Atlas Epic")
  })
})

describe("progress", () => {
  test("a done list counts as done; a tick overrides the data", () => {
    const e = readEpic(INPUT, {}, "running")
    expect(progress(e, () => undefined)).toEqual({ done: 1, total: 2 })
    const k = itemKey(0, 0, e.lists[0].items[0])
    expect(progress(e, (key) => (key === k ? true : undefined))).toEqual({ done: 2, total: 2 })
  })
})

describe("buttons and prompts", () => {
  const e = readEpic(INPUT, {}, "running")
  const maria = e.lists[0].items[0]

  test("drafts get Review & send + Edit; alerts get Walk me through it + Dismiss", () => {
    expect(buttonsFor(maria)).toEqual(["send", "edit"])
    expect(buttonsFor(e.lists[1].items[0])).toEqual(["walk", "dismiss"])
    expect(buttonsFor({ title: "x", kind: "note" })).toEqual([])
    expect(buttonsFor({ title: "x", actions: ["edit"] })).toEqual(["edit"])
  })

  test("the send prompt names the person, the subject and the message it refers to", () => {
    expect(promptFor("send", maria, e.lists[0])).toBe(
      `Send the drafted reply to Maria Lopez ("Rescheduling Thursday's cleaning") [gmail_message 1a11] in gmail.`,
    )
  })
})

describe("avatar + icon", () => {
  test("initials and hue are stable", () => {
    expect(initials("Maria Lopez")).toBe("ML")
    expect(initials("acme")).toBe("AC")
    expect(initials("")).toBe("?")
    expect(hue("Maria Lopez")).toBe(hue("Maria Lopez"))
    expect(hue("Maria Lopez")).toBeLessThan(360)
    expect(sourceMark("calendar")).toBe("31")
    expect(sourceMark("quickbooks")).toBe("Qu")
    expect(sourceMark(undefined)).toBe("•")
  })
})
