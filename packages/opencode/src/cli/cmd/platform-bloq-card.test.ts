import { describe, expect, test } from "bun:test"
import { flattenTasks, formatAssignees, formatTaskTree } from "./platform-bloq-card"

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")

describe("card checklist (#189800)", () => {
  const rows = [
    {
      id: 1,
      title: "Draft the copy",
      is_completed: false,
      status: "todo",
      due_date: "2026-10-20T00:00:00.000000Z",
      children: [
        { id: 2, title: "Headline", is_completed: true, parent_id: 1 },
        { id: 3, title: "Body", status: "done", parent_id: 1, agent: { name: "Elon" }, agent_id: 9 },
      ],
    },
    { id: 4, title: "Review", is_completed: false },
  ]

  test("nested children flatten top to bottom with a depth", () => {
    const t = flattenTasks(rows)
    expect(t.map((x) => [x.id, x.depth])).toEqual([
      [1, 0],
      [2, 1],
      [3, 1],
      [4, 0],
    ])
    expect(t[0].dueDate).toBe("2026-10-20")
    expect(t[2]).toMatchObject({ done: true, agentName: "Elon", agentId: 9, parentId: 1 })
  })

  test("the tree reads like a checklist, progress first", () => {
    const out = strip(formatTaskTree(flattenTasks(rows)))
    expect(out.split("\n")).toEqual([
      "2/4 done",
      "[ ] Draft the copy  #1  due 2026-10-20",
      "  [x] Headline  #2",
      "  [x] Body  #3  agent: Elon",
      "[ ] Review  #4",
    ])
  })

  test("empty and malformed input say so instead of throwing", () => {
    expect(formatTaskTree(flattenTasks(null))).toBe("No checklist on this card yet.")
    expect(flattenTasks({ not: "an array" })).toEqual([])
  })
})

describe("card assignees (#189800)", () => {
  test("people and agents, with the assignee id to unassign by", () => {
    const out = strip(
      formatAssignees([
        { id: 7, type: "user", user_id: 42, name: "Ana Pérez" },
        { id: 8, type: "agent", agent_id: 9, name: "Elon" },
      ]),
    )
    expect(out).toContain("person  Ana Pérez  assignee #7 · user 42")
    expect(out).toContain("agent  Elon  assignee #8 · agent 9")
    expect(formatAssignees([])).toBe("Nobody is assigned to this card.")
  })
})
