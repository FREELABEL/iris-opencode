import { describe, expect, test } from "bun:test"
import {
  atBottom,
  basis,
  engineName,
  mergeRead,
  offsets,
  percent,
  pickRun,
  transcript,
  type RunRead,
  type RunSummary,
} from "./iris-hive-sims-model"

// #194084 — Hive › Simulations, the pure half.

const step = (id: RunRead["steps"][number]["id"], over: Partial<RunRead["steps"][number]> = {}) => ({
  id,
  title: id,
  status: "waiting" as const,
  started: null,
  ended: null,
  exitCode: null,
  reason: null,
  output: "",
  next: 0,
  truncated: false,
  ...over,
})

const read = (over: Partial<RunRead> = {}): RunRead => ({
  id: "sim_1",
  engine: "/repo/research/monetization-engine.py",
  knobs: { worlds: 4000, cohort: 1000, days: 30, refresh: true },
  status: "running",
  started: 1000,
  ended: null,
  reason: null,
  steps: [step("engine"), step("pull"), step("tie-out"), step("simulate"), step("flip")],
  feed: { tables: [], flips: [], ignored: 0 },
  header: [],
  ...over,
})

describe("hive sims model", () => {
  test("reads append each step's output and the next read asks from each step's offset", () => {
    const a = mergeRead(undefined, read({ steps: [step("engine", { output: "engine: /x\n", next: 11 }), step("pull"), step("tie-out"), step("simulate"), step("flip")] }))
    expect(offsets(a)).toBe("11,0,0,0,0")
    const b = mergeRead(
      a,
      read({ steps: [step("engine", { output: "sha256: abc\n", next: 23 }), step("pull", { output: "pulled\n", next: 7 }), step("tie-out"), step("simulate"), step("flip")] }),
    )
    expect(b.outputs.engine).toBe("engine: /x\nsha256: abc\n")
    expect(b.outputs.pull).toBe("pulled\n")
    expect(offsets(b)).toBe("23,7,0,0,0")
    // A different run never inherits another's output.
    expect(mergeRead(b, read({ id: "sim_2" })).outputs.engine).toBe("")
    expect(transcript(b)).toBe("── engine ──\nengine: /x\nsha256: abc\n\n── pull ──\npulled")
  })

  test("MEASURED vs DRAWN: the feed first, then the header text, else said to be missing", () => {
    expect(basis(read({ feed: { inputs: { measured: ["a"], drawn: ["b"] }, tables: [], flips: [], ignored: 0 }, header: ["MEASURED: x"] }))).toEqual({
      kind: "feed",
      measured: ["a"],
      drawn: ["b"],
    })
    expect(basis(read({ header: ["MEASURED: x | DRAWN: y"] }))).toEqual({ kind: "header", lines: ["MEASURED: x | DRAWN: y"] })
    expect(basis(read())).toEqual({ kind: "missing", waiting: true })
    expect(basis(read({ status: "passed" }))).toEqual({ kind: "missing", waiting: false })
  })

  test("which run shows: picked, unless a newer one started since; else the running one; else the newest", () => {
    const r = (id: string, started: number, status: RunSummary["status"] = "passed"): RunSummary => ({
      id,
      engine: "e.py",
      status,
      started,
      ended: null,
      reason: null,
      steps: [],
    })
    expect(pickRun([], undefined)).toBeUndefined()
    expect(pickRun([r("a", 1), r("b", 2)], undefined)).toBe("b")
    expect(pickRun([r("a", 1, "running"), r("b", 2)], undefined)).toBe("a")
    expect(pickRun([r("a", 1), r("b", 2)], { id: "a", at: 5 })).toBe("a")
    // An agent starts a new run after the pick: it takes over.
    expect(pickRun([r("a", 1), r("b", 2), r("c", 9, "running")], { id: "a", at: 5 })).toBe("c")
    expect(pickRun([r("b", 2)], { id: "gone", at: 5 })).toBe("b")
  })

  test("percent, names and follow", () => {
    expect(percent({ done: 1, total: 3 })).toBe(33)
    expect(percent({ done: 5, total: 0 })).toBeUndefined()
    expect(percent(undefined)).toBeUndefined()
    expect(engineName("/a/b/monetization-engine.py")).toBe("monetization-engine.py")
    expect(atBottom({ scrollTop: 480, scrollHeight: 800, clientHeight: 300 })).toBe(true)
    expect(atBottom({ scrollTop: 100, scrollHeight: 800, clientHeight: 300 })).toBe(false)
  })
})
