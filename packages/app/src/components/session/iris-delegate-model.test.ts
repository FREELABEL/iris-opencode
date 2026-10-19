import { describe, expect, test } from "bun:test"
import {
  agentTone,
  alreadyAssigned,
  cardFromDrag,
  dragPayload,
  handoffPrompt,
  isImportedPerson,
  openWork,
  sessionTargets,
  sortAgents,
  type DelegateAgent,
} from "./iris-delegate-model"

const agent = (id: number, name: string, extra: Partial<DelegateAgent> = {}): DelegateAgent => ({
  id,
  name,
  status: "active",
  heartbeat: false,
  ...extra,
})

describe("Delegate › drag payload", () => {
  test("reads the board's own payload and nothing else", () => {
    expect(cardFromDrag(dragPayload(189933))).toBe(189933)
    expect(cardFromDrag("atlas-item:42")).toBe(42)
    expect(cardFromDrag("https://example.com")).toBeNull()
    expect(cardFromDrag("atlas-item:")).toBeNull()
    expect(cardFromDrag("atlas-item:abc")).toBeNull()
    expect(cardFromDrag("atlas-item:-3")).toBeNull()
    expect(cardFromDrag(undefined)).toBeNull()
  })
})

describe("Delegate › agents", () => {
  test("open work skips done tasks and the boards an agent merely watches", () => {
    expect(
      openWork([
        { source: "bloq_item_task", done: false },
        { source: "bloq_item_task", done: true },
        { source: "lead_task", done: false },
        { source: "scheduled_job", done: false },
        { source: "heartbeat_bloq", done: false },
      ]),
    ).toBe(3)
    expect(openWork([])).toBe(0)
  })

  test("a second drop of the same card on the same agent is not a second task", () => {
    // card #189951's tasks after two drops on IRIS (agent 750), 2026-10-19
    const tasks = [
      { agentId: 750, done: false },
      { agentId: 701, done: true },
    ]
    expect(alreadyAssigned(tasks, 750)).toBe(true)
    expect(alreadyAssigned(tasks, 701)).toBe(false) // done work does not block new work
    expect(alreadyAssigned([], 750)).toBe(false)
  })

  test("a queue that could not be read is unknown, never free", () => {
    expect(agentTone(agent(1, "a"), null)).toBe("unknown")
    expect(agentTone(agent(1, "a"), 0)).toBe("free")
    expect(agentTone(agent(1, "a"), 2)).toBe("busy")
  })

  test("paused or inactive agents are off whatever their queue says", () => {
    expect(agentTone(agent(1, "a", { status: "paused" }), 0)).toBe("off")
    expect(agentTone(agent(1, "a", { active: false }), 0)).toBe("off")
    expect(agentTone(agent(1, "a", { status: "Stopped" }), null)).toBe("off")
  })

  test("free first, then least loaded, unknown and off last, ties by name", () => {
    const open: Record<number, number | null> = { 1: 3, 2: 0, 3: null, 4: 1, 5: 0, 6: 0 }
    const sorted = sortAgents(
      [
        agent(1, "Coder"),
        agent(2, "Writer"),
        agent(3, "Ghost"),
        agent(4, "Researcher"),
        agent(5, "Ops"),
        agent(6, "Paused", { status: "paused" }),
      ],
      (id) => open[id] ?? null,
    )
    expect(sorted.map((a) => a.name)).toEqual(["Ops", "Writer", "Researcher", "Coder", "Ghost", "Paused"])
  })
})

describe("Delegate › people are not agents", () => {
  // The four rows bloq 503's /iris/agents returned on 2026-10-19.
  test("imported team members are filtered, real agents kept", () => {
    const rows = [
      { id: 787, description: "Human team member imported from project sharing." },
      { id: 786, description: "Human team member imported from project sharing. User: r@example.com | Email" },
      { id: 750, description: "" },
      { id: 709, description: undefined },
    ]
    expect(rows.filter((a) => !isImportedPerson(a)).map((a) => a.id)).toEqual([750, 709])
  })
})

describe("Delegate › sessions", () => {
  test("top-level, not archived, most recent first, capped", () => {
    const rows = [
      { id: "a", time: { updated: 10 } },
      { id: "b", time: { updated: 30 } },
      { id: "child", parentID: "b", time: { updated: 99 } },
      { id: "old", time: { created: 5 } },
      { id: "gone", time: { updated: 50, archived: 60 } },
      { id: "c", time: { updated: 20 } },
    ]
    expect(sessionTargets(rows).map((s) => s.id)).toEqual(["b", "c", "a", "old"])
    expect(sessionTargets(rows, 2).map((s) => s.id)).toEqual(["b", "c"])
  })
})

describe("Delegate › hand-off prompt", () => {
  test("names the card by id and the command that reads it", () => {
    const p = handoffPrompt({ id: 189933, title: "Delegate board", listName: "Todo", boardName: "IRIS Features" })
    expect(p).toContain('Atlas card #189933 — "Delegate board" (board "IRIS Features", list "Todo")')
    expect(p).toContain("`iris boards get 189933`")
    expect(p).toContain("`iris boards update 189933 --status done`")
  })
  test("no empty parentheses when the board and list are unknown", () => {
    expect(handoffPrompt({ id: 7, title: "x" })).toStartWith('Atlas card #7 — "x" was handed')
  })
})
