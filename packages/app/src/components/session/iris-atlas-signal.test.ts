import { describe, expect, test } from "bun:test"
import { countBoard, matchesFocus, openQuestions, readSignal, splitPrefix, tidyPlan } from "./iris-atlas-signal"

// Shapes taken from real cards on #402 / #503 / #297 (#192839), titles lightly genericised.
const card = (id: number, title: string, extra: Record<string, unknown> = {}) => ({ id, title, ...extra })

describe("splitPrefix", () => {
  test("moves the bracket prefix out of the title", () => {
    expect(splitPrefix("[ACCT-1 ✅ DONE] Reconcile the March deposits")).toEqual(["ACCT-1 ✅ DONE", "Reconcile the March deposits"])
    expect(splitPrefix("[SOC2 · P0] [CC6.1] Rotate keys")).toEqual(["SOC2 · P0 · CC6.1", "Rotate keys"])
  })
  test("a title that is only a bracket keeps it", () => {
    expect(splitPrefix("[WIP]")).toEqual([undefined, "[WIP]"])
  })
})

describe("readSignal — structured field first, then title, then list name", () => {
  test("the default status reads as nothing: no colour on a normal card", () => {
    const s = readSignal(card(1, "Call the clinic back", { status: "active" }), "Todo")
    expect(s.state).toBeNull()
    expect(s.loud).toBeNull()
  })

  test("done from the title, and the tag keeps only what is not state or priority", () => {
    const s = readSignal(card(2, "[ACCT-1 ✅ DONE] Reconcile the March deposits", { status: "active" }))
    expect(s.state).toBe("done")
    expect(s.stateFrom).toBe("title")
    expect(s.tag).toBe("ACCT-1")
    expect(s.title).toBe("Reconcile the March deposits")
  })

  test("a list called Completed means done when nothing else says otherwise", () => {
    expect(readSignal(card(3, "Send the welcome pack"), "Completed").state).toBe("done")
    expect(readSignal(card(3, "Send the welcome pack"), "In Progress").state).toBe("in_progress")
  })

  test("the field beats the title and the list", () => {
    const s = readSignal(card(4, "[DONE] Old title", { status: "in_progress" }), "Completed")
    expect(s.state).toBe("in_progress")
    expect(s.stateFrom).toBe("field")
  })

  test("priority from the title is loud only for P0/P1/urgent/high", () => {
    expect(readSignal(card(5, "[SOC2 · P0 · CC6.1] Rotate the keys")).loud).toBe("urgent")
    expect(readSignal(card(6, "[HIGH] Model proxy rewrote required")).loud).toBe("high")
    const p2 = readSignal(card(7, "[P2] Tidy the footer"))
    expect(p2.loud).toBeNull()
    expect(p2.priority).toBe("P2")
  })

  test("a structured priority wins", () => {
    expect(readSignal(card(8, "[P0] something", { priority: "low" })).loud).toBeNull()
  })

  test("epics are a card type wherever they sit", () => {
    expect(readSignal(card(9, "EPIC — Linked billing")).epic).toBe(true)
    expect(readSignal(card(10, "[EPIC] Desktop Outreach tab")).epic).toBe(true)
    expect(readSignal(card(11, "Epic music night", { type: "epic" })).epic).toBe(true)
    expect(readSignal(card(12, "Epicentre venue outreach")).epic).toBe(false)
  })

  test("a ring only from recorded child links; otherwise children as words, never 0%", () => {
    const linked = readSignal(card(13, "EPIC — X", { tasks: { open: 3, done: 5, total: 8 } }))
    expect(linked.progress).toEqual({ done: 5, total: 8 })
    expect(linked.children).toBeUndefined()

    const written = readSignal(card(14, "EPIC — Y (8 child tickets)"))
    expect(written.progress).toBeUndefined()
    expect(written.children).toBe(8)

    const none = readSignal(card(15, "EPIC — Z", { tasks: { open: 0, done: 0, total: 0 } }))
    expect(none.progress).toBeUndefined()
    expect(none.children).toBeUndefined()
  })

  test("Next: comes from the body", () => {
    expect(readSignal(card(16, "EPIC — A", { preview: "Goal…\n**Next:** answer Q1–Q3, then T0" })).next).toBe("answer Q1–Q3, then T0")
  })
})

describe("open questions", () => {
  const body = `## Questions

| # | Question | Owner | Priority | Blocks | Source | Status |
|---|---|---|---|---|---|---|
| Q1 | First apps? | Alex | critical | T2 | raised by IRIS | open |
| Q2 | Markup? | Alex | high | T5 | raised by IRIS | answered |
| Q3 | Cost grade? | Alex | critical | T5 | raised by IRIS | open |

## Blocked by
| What | Waiting on |
| 1 | x | open |`

  test("counts open rows in the Questions table only", () => {
    expect(openQuestions(body)).toBe(2)
    expect(openQuestions("no sections")).toBe(0)
  })

  test("unknown without a body — the strip must not claim zero", () => {
    expect(readSignal(card(1, "EPIC — x", { preview: body })).openQuestions).toBeUndefined()
    expect(readSignal(card(1, "EPIC — x", { content: body })).openQuestions).toBe(2)
  })
})

describe("countBoard and focus", () => {
  const lists = [
    { name: "Todo", items: [card(1, "A"), card(2, "[BLOCKED] B"), card(3, "EPIC — C")] },
    { name: "In Progress", items: [card(4, "D")] },
    { name: "Completed", items: [card(5, "E"), card(6, "F")] },
  ]

  test("counts what the board says", () => {
    const c = countBoard(lists)
    expect(c).toMatchObject({ open: 4, in_progress: 1, blocked: 1, epics: 1, questionsKnown: false })
  })

  test("a focus dims everything that does not match", () => {
    const b = readSignal(card(2, "[BLOCKED] B"))
    const a = readSignal(card(1, "A"))
    expect(matchesFocus(b, "blocked")).toBe(true)
    expect(matchesFocus(a, "blocked")).toBe(false)
    expect(matchesFocus(a, null)).toBe(true)
  })
})

describe("tidyPlan", () => {
  test("proposes real status and priority from titles and list names, never over a set field", () => {
    const plan = tidyPlan([
      { name: "Completed", items: [card(1, "Send pack", { status: "active" }), card(2, "Shipped thing", { status: "in_progress" })] },
      { name: "Todo", items: [card(3, "[ACCT-2 ✅ DONE] Close books"), card(4, "[P1] Fix login"), card(5, "[P1] Set by hand", { priority: "low" }), card(-1, "[DONE] pending card")] },
    ])
    const byId = Object.fromEntries(plan.map((c) => [c.itemId, c]))
    expect(byId[1]).toMatchObject({ status: "done" })
    expect(byId[2]).toBeUndefined() // in_progress was set by a person
    expect(byId[3]).toMatchObject({ status: "done" })
    expect(byId[4]).toMatchObject({ priority: "high" })
    expect(byId[4].status).toBeUndefined()
    expect(byId[5]).toBeUndefined()
    expect(byId[-1]).toBeUndefined()
  })

  test("blocked is never proposed — it is not a writable status", () => {
    expect(tidyPlan([{ name: "Todo", items: [card(1, "[BLOCKED] waiting on FA")] }])).toEqual([])
  })
})
