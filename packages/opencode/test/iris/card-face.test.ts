import { describe, expect, test } from "bun:test"
import { cardFace } from "../../src/iris/platform"

describe("cardFace (#189806)", () => {
  test("columns every item has: due date, priority, card type", () => {
    expect(cardFace({ due_date: "2026-10-20", priority: "high", card_type: "bug" })).toEqual({
      dueDate: "2026-10-20",
      priority: "high",
      cardType: "bug",
    })
  })

  test("fl-api's card summary: labels, task progress, attachments, assignees", () => {
    const f = cardFace({
      summary: {
        labels: ["bug", "urgent"],
        tasks: { open: 2, done: 1, total: 3 },
        attachments: 2,
        assignees: [
          { id: 7, type: "user", user_id: 42, name: "Ana" },
          { id: 8, type: "agent", agent_id: 9, name: "Elon" },
          { id: 9, type: "nonsense" },
        ],
      },
    })
    expect(f.labels).toEqual(["bug", "urgent"])
    expect(f.tasks).toEqual({ open: 2, done: 1, total: 3 })
    expect(f.attachments).toBe(2)
    expect(f.assignees).toEqual([
      { id: 7, type: "user", userId: 42, name: "Ana" },
      { id: 8, type: "agent", agentId: 9, name: "Elon" },
    ])
  })

  test("an fl-api without the summary: counts are ABSENT, not zero; labels come from the body", () => {
    const f = cardFace({ content: JSON.stringify({ text: "x", labels: ["a", "b", "a"] }) })
    expect(f.labels).toEqual(["a", "b"])
    expect("tasks" in f).toBe(false)
    expect("attachments" in f).toBe(false)
    expect("assignees" in f).toBe(false)
  })

  test("a prose body has no labels and does not throw", () => {
    expect(cardFace({ content: "just words" })).toEqual({})
  })
})
