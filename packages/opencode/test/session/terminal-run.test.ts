import { afterEach, describe, expect, test } from "bun:test"
import { TerminalRun } from "../../src/session/terminal-run"

afterEach(() => TerminalRun.reset())

describe("TerminalRun (#190530)", () => {
  test("reads output from an offset and reports the next one", () => {
    const run = TerminalRun.create("ses_a", "echo hi")
    TerminalRun.append(run, "hello ")
    const first = TerminalRun.read(run, 0)
    expect(first).toMatchObject({ output: "hello ", next: 6, status: "running", truncated: false, exitCode: null })
    TerminalRun.append(run, "world")
    expect(TerminalRun.read(run, first.next).output).toBe("world")
    expect(TerminalRun.read(run, 11).output).toBe("")
  })

  test("caps retained output and says when a reader missed bytes", () => {
    const run = TerminalRun.create("ses_a", "yes")
    TerminalRun.append(run, "a".repeat(TerminalRun.OUTPUT_LIMIT))
    TerminalRun.append(run, "bbb")
    expect(run.output.length).toBe(TerminalRun.OUTPUT_LIMIT)
    const read = TerminalRun.read(run, 0)
    expect(read.truncated).toBe(true)
    expect(read.next).toBe(TerminalRun.OUTPUT_LIMIT + 3)
    expect(read.output.endsWith("bbb")).toBe(true)
    expect(TerminalRun.read(run, TerminalRun.OUTPUT_LIMIT).truncated).toBe(false)
  })

  test("the first final state wins", () => {
    const run = TerminalRun.create("ses_a", "false")
    TerminalRun.finish(run, { status: "exited", exitCode: 1 })
    TerminalRun.finish(run, { status: "cancelled" })
    expect(TerminalRun.read(run)).toMatchObject({ status: "exited", exitCode: 1 })
    expect(run.ended).not.toBeNull()
  })

  test("a run is only visible to its own session", () => {
    const run = TerminalRun.create("ses_a", "ls")
    expect(TerminalRun.get("ses_a", run.id)).toBe(run)
    expect(TerminalRun.get("ses_b", run.id)).toBeUndefined()
  })

  test("finished runs are forgotten after the TTL; running ones are kept", () => {
    const done = TerminalRun.create("ses_a", "true", 0)
    TerminalRun.finish(done, { status: "exited", exitCode: 0 }, 0)
    const live = TerminalRun.create("ses_a", "sleep 9", 0)
    TerminalRun.sweep(TerminalRun.TTL_MS + 1)
    expect(TerminalRun.get("ses_a", done.id)).toBeUndefined()
    expect(TerminalRun.get("ses_a", live.id)).toBe(live)
    expect(TerminalRun.running("ses_a")).toBe(1)
  })
})
