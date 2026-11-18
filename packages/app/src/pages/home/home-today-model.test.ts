import { describe, expect, test } from "bun:test"
import { todayOf } from "./home-today-model"

const node = (online: boolean, active = 0, models: string[] = []) => ({ online, activeTasks: active, maxConcurrent: 3, modelsServing: models })

describe("#192222 Home › today", () => {
  test("real numbers from the fleet, agents and inbox", () => {
    const t = todayOf(
      { measured: true, nodes: [node(true, 1, ["hive/qwen3:14b", "hive/llama3.2:3b"]), node(true), node(false)] },
      { measured: true, agents: [{ id: 1, name: "a" }, { id: 2, name: "b" }] },
      { measured: true, unread: 4 },
    )
    expect(t.map((x) => [x.label, x.value, x.detail])).toEqual([
      ["Machines", "2 of 3 online", "5 free slots · 2 models serving"],
      ["Agents", "2", "you own, across your boards"],
      ["Hive inbox", "4 unread", "work and messages sent to you"],
    ])
  })
  test("an offline machine adds no free slots and no models", () => {
    const t = todayOf({ measured: true, nodes: [node(false, 0, ["hive/x"])] }, { measured: true, agents: [] }, { measured: true, unread: 0 })
    expect(t[0].detail).toBe("0 free slots · no models serving")
  })
  test("not measured is a dash with the reason, never zero", () => {
    const t = todayOf(
      { measured: false, reason: "not signed in", nodes: [] },
      { measured: false, agents: [] },
      { measured: true, unread: null },
    )
    expect(t.map((x) => x.value)).toEqual(["—", "—", "—"])
    expect(t[0].detail).toBe("Not measured — not signed in")
    expect(t.every((x) => !x.measured)).toBe(true)
  })
  test("no machines yet says how to add one", () => {
    expect(todayOf({ measured: true, nodes: [] }, { measured: true, agents: [] }, { measured: true, unread: 0 })[0]).toMatchObject({
      value: "None yet",
      detail: "Connect one: iris how-to view hive-dispatch",
    })
  })
  test("a full page of agents without a total reads 200+, and a total wins", () => {
    const many = Array.from({ length: 200 }, (_, i) => ({ id: i, name: `a${i}` }))
    const hive = { measured: true, nodes: [] }
    const inbox = { measured: true, unread: 0 }
    expect(todayOf(hive, { measured: true, agents: many }, inbox)[1].value).toBe("200+")
    expect(todayOf(hive, { measured: true, agents: many, total: 236 }, inbox)[1].value).toBe("236")
  })
})
