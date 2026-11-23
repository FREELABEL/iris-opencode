import { afterEach, describe, expect, test } from "bun:test"
import fs from "fs"
import { Effect } from "effect"
import { HiveSim } from "../../src/iris/hive-sim"
import { TerminalRun } from "../../src/session/terminal-run"

// #194084 — Hive simulations, live: the run's state machine and the optional event feed.

afterEach(() => {
  HiveSim.reset()
  TerminalRun.reset()
})

type Script = Partial<Record<HiveSim.StepId, { code?: number; out?: string; hang?: boolean; events?: string[] }>>

/** A fake executor: each step prints `out`, writes `events` to the feed file, and exits `code`. */
function fake(script: Script, seen: { step: string; env: Record<string, string> }[] = []): HiveSim.Exec {
  return (input) =>
    Effect.gen(function* () {
      seen.push({ step: input.step, env: input.env })
      const s = script[input.step] ?? {}
      if (s.out) input.onOutput(s.out)
      if (s.events && input.env.HIVE_SIM_EVENTS) {
        fs.appendFileSync(input.env.HIVE_SIM_EVENTS, s.events.join("\n") + "\n")
      }
      if (s.hang) return yield* Effect.never
      return s.code ?? 0
    })
}

const input = { sessionID: "ses_a", directory: "/tmp", engine: "engine.py" }

const until = async (run: HiveSim.Run, ms = 3000) => {
  await HiveSim.wait(run, ms, undefined, 5)
  return run
}

describe("HiveSim run", () => {
  test("runs the four shell steps in order, then the flip step passes on a flip section", async () => {
    const seen: { step: string; env: Record<string, string> }[] = []
    const run = HiveSim.start(input, fake({ simulate: { out: "MEASURED: spend\nDRAWN: activity\nranking…\nTHE FLIP\n  days/month" } }, seen))
    if (typeof run === "string") throw new Error(run)
    await until(run)
    expect(seen.map((s) => s.step)).toEqual(["engine", "pull", "tie-out", "simulate"])
    expect(run.status).toBe("passed")
    expect(run.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "passed", "passed"])
    expect(run.header).toEqual(["MEASURED: spend", "DRAWN: activity"])
    expect(run.ended).not.toBeNull()
    // Only the simulate step gets the feed; the knobs reach the playbook's scripts as variables.
    expect(seen.find((s) => s.step === "simulate")!.env.HIVE_SIM_EVENTS).toBeDefined()
    expect(seen.find((s) => s.step === "tie-out")!.env.HIVE_SIM_EVENTS).toBeUndefined()
    expect(seen[0].env).toMatchObject({ engine: "engine.py", worlds: "4000", cohort: "1000", days: "30", refresh: "yes" })
    expect(seen[0].env.TMPDIR).toBe(seen[3].env.TMPDIR)
  })

  test("a tie-out failure stops the run: nothing downstream runs, and the reason is the step's own words", async () => {
    const seen: { step: string; env: Record<string, string> }[] = []
    const run = HiveSim.start(
      input,
      fake({ "tie-out": { code: 1, out: "TIE-OUT FAILED — nothing downstream of this would be true:\nuser 193: median $4.1930 vs $0.3672\n" } }, seen),
    )
    if (typeof run === "string") throw new Error(run)
    await until(run)
    expect(seen.map((s) => s.step)).toEqual(["engine", "pull", "tie-out"])
    expect(run.status).toBe("failed")
    expect(run.steps.map((s) => s.status)).toEqual(["passed", "passed", "failed", "waiting", "waiting"])
    expect(HiveSim.step(run, "tie-out").reason).toContain("user 193: median $4.1930 vs $0.3672")
    expect(HiveSim.step(run, "tie-out").exitCode).toBe(1)
    expect(run.reason).toContain("Tie out the data")
    expect(HiveSim.report(run)).toContain("✗ tie-out — failed (exit 1)")
  })

  test("Stop: the running step fails as stopped, later steps stay waiting, the run is cancelled", async () => {
    const run = HiveSim.start(input, fake({ simulate: { out: "simulated 10 / 4000", hang: true } }))
    if (typeof run === "string") throw new Error(run)
    for (let i = 0; i < 100 && HiveSim.step(run, "simulate").status !== "running"; i++) await Bun.sleep(5)
    expect(HiveSim.cancel("ses_b", run.id)).toBe(false)
    expect(HiveSim.cancel("ses_a", run.id)).toBe(true)
    await until(run)
    expect(run.status).toBe("cancelled")
    expect(run.steps.map((s) => s.status)).toEqual(["passed", "passed", "passed", "failed", "waiting"])
    expect(HiveSim.step(run, "simulate").reason).toBe("stopped")
    expect(HiveSim.cancel("ses_a", run.id)).toBe(false)
  })

  test("the playbook's timeout stops a run that hangs", async () => {
    const run = HiveSim.start(input, fake({ pull: { hang: true } }), { timeoutMs: 60 })
    if (typeof run === "string") throw new Error(run)
    await until(run)
    expect(run.status).toBe("failed")
    expect(run.reason).toContain("timed out")
    expect(HiveSim.step(run, "pull").status).toBe("failed")
  })

  test("no flip anywhere fails the flip step — a ranking without one is not an answer", async () => {
    const run = HiveSim.start(input, fake({ simulate: { out: "ranking: a > b\n" } }))
    if (typeof run === "string") throw new Error(run)
    await until(run)
    expect(HiveSim.step(run, "simulate").status).toBe("passed")
    expect(HiveSim.step(run, "flip").status).toBe("failed")
    expect(run.status).toBe("failed")
  })

  test("feed events land on the run; a flip event passes the flip step", async () => {
    const run = HiveSim.start(
      input,
      fake({
        simulate: {
          out: "ranking\n",
          events: [
            JSON.stringify({ type: "inputs", measured: ["spend"], drawn: ["activity"] }),
            JSON.stringify({ type: "progress", done: 4000, total: 4000 }),
            "garbage",
            JSON.stringify({ type: "table", title: "T", columns: ["a"], rows: [[1]] }),
            JSON.stringify({ type: "flip", text: "activity flips it", input: "days", range: "2-12" }),
          ],
        },
      }),
    )
    if (typeof run === "string") throw new Error(run)
    await until(run)
    expect(run.status).toBe("passed")
    expect(run.feed.inputs).toEqual({ measured: ["spend"], drawn: ["activity"] })
    expect(run.feed.progress).toEqual({ done: 4000, total: 4000 })
    expect(run.feed.tables).toEqual([{ title: "T", columns: ["a"], rows: [["1"]] }])
    expect(run.feed.flips).toEqual([{ text: "activity flips it", input: "days", range: "2-12" }])
    expect(run.feed.ignored).toBe(1)
    expect(HiveSim.report(run)).toContain("FLIP: activity flips it")
  })

  test("bad knobs and a missing engine are refused before anything runs", () => {
    const exec = fake({})
    expect(HiveSim.start({ ...input, engine: "" }, exec)).toContain("engine")
    expect(HiveSim.start({ ...input, worlds: 0 }, exec)).toContain("worlds")
    expect(HiveSim.start({ ...input, days: 1.5 }, exec)).toContain("days")
    expect(HiveSim.list("ses_a")).toEqual([])
  })

  test("reads are per step from offsets; another session cannot see a run", async () => {
    const run = HiveSim.start(input, fake({ engine: { out: "engine: /x\nsha256: abc\n" }, simulate: { out: "flip" } }))
    if (typeof run === "string") throw new Error(run)
    await until(run)
    const first = HiveSim.read(run)
    expect(first.steps[0].output).toBe("engine: /x\nsha256: abc\n")
    const again = HiveSim.read(run, HiveSim.parseFrom(first.steps.map((s) => s.next).join(",")))
    expect(again.steps.every((s) => s.output === "")).toBe(true)
    expect(HiveSim.get("ses_b", run.id)).toBeUndefined()
    expect(HiveSim.list("ses_a").map((r) => r.id)).toEqual([run.id])
    expect(HiveSim.summary(run)).not.toHaveProperty("cancel")
  })
})

describe("HiveSim feed parsing", () => {
  test("only well-formed events of known types parse", () => {
    expect(HiveSim.parseEvent('{"type":"progress","done":3,"total":10}')).toEqual({ type: "progress", done: 3, total: 10 })
    expect(HiveSim.parseEvent('{"type":"progress","done":30,"total":10}')).toEqual({ type: "progress", done: 10, total: 10 })
    for (const bad of [
      "not json",
      "[]",
      "null",
      '{"type":"progress","done":"3","total":10}',
      '{"type":"progress","done":1,"total":0}',
      '{"type":"inputs","measured":["a"]}',
      '{"type":"table","title":"t","columns":["a"],"rows":[1,2]}',
      '{"type":"flip"}',
      '{"type":"mystery"}',
    ])
      expect(HiveSim.parseEvent(bad)).toBeUndefined()
  })

  test("a line split across two reads is joined, not counted as bad", () => {
    const a = HiveSim.readLines("", '{"type":"progress","do')
    expect(a.lines).toEqual([])
    const b = HiveSim.readLines(a.rest, 'ne":1,"total":2}\n{"type":"flip","text":"x"}\n')
    expect(b.lines.map((l) => HiveSim.parseEvent(l)?.type)).toEqual(["progress", "flip"])
    expect(b.rest).toBe("")
    expect(HiveSim.readLines("", '{"type":"flip","text":"y"}', true).lines).toHaveLength(1)
  })

  test("a table re-sent under the same title replaces the earlier one", () => {
    const feed: HiveSim.Feed = { tables: [], flips: [], ignored: 0 }
    HiveSim.apply(feed, JSON.stringify({ type: "table", title: "R", columns: ["c"], rows: [["…"]] }))
    HiveSim.apply(feed, JSON.stringify({ type: "table", title: "R", columns: ["c"], rows: [["$0.25"]] }))
    HiveSim.apply(feed, "}{")
    expect(feed.tables).toEqual([{ title: "R", columns: ["c"], rows: [["$0.25"]] }])
    expect(feed.ignored).toBe(1)
  })

  test("MEASURED/DRAWN header lines are read from an engine's text", () => {
    expect(HiveSim.headerLines("title\nMEASURED: a, b\nDRAWN: c\nbody mentions measured later")).toEqual(["MEASURED: a, b", "DRAWN: c"])
    expect(HiveSim.headerLines("MEASURED: x | DRAWN: y")).toEqual(["MEASURED: x | DRAWN: y"])
    expect(HiveSim.headerLines("nothing here")).toEqual([])
  })

  test("the agent's copy of a long output keeps the head and the tail", () => {
    const long = "H".repeat(HiveSim.RESULT_HEAD) + "x".repeat(50_000) + "T".repeat(HiveSim.RESULT_TAIL)
    const t = HiveSim.trim(long)
    expect(t.startsWith("H".repeat(HiveSim.RESULT_HEAD))).toBe(true)
    expect(t.endsWith("T".repeat(HiveSim.RESULT_TAIL))).toBe(true)
    expect(t).toContain("characters cut")
    expect(t.length).toBeLessThan(HiveSim.RESULT_HEAD + HiveSim.RESULT_TAIL + 100)
  })
})
