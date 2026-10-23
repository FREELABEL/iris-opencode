import { describe, expect, test } from "bun:test"
import { waitForTask } from "./platform-hive-nodes"
import { resolveTaskIdArg } from "./platform-hive"

/**
 * #187990 — `iris hive run` reported "failed, Process exited with code 1, 1000ms, no output"
 * while its own task completed in 17s with the right output. Task ids are UUIDv7, so three
 * tasks dispatched seconds apart share their first 8 characters (01a109da-…), and the
 * failure on screen belonged to an older one.
 *
 * The fake server below holds exactly that: two older tasks with the same 8-character
 * prefix, the OLDEST of which failed fast, plus the one this run dispatched. It answers
 * exact ids exactly — and, like any prefix/"latest" lookup would, hands back the first
 * prefix match for anything shorter — so a poll by anything but the full id gets the
 * wrong record.
 */
const OLD_FAILED = "01a109da-14d0-7000-8000-000000000001"
const OLD_RUNNING = "01a109da-2fc0-7000-8000-000000000002"
const MINE = "01a109da-a3e0-7000-8000-000000000003"

function fakeServer() {
  const tasks: Record<string, any> = {
    [OLD_FAILED]: { id: OLD_FAILED, status: "failed", error: "Process exited with code 1", duration_ms: 1000, result: {} },
    [OLD_RUNNING]: { id: OLD_RUNNING, status: "running" },
    [MINE]: { id: MINE, status: "dispatched" },
  }
  const asked: string[] = []
  let polls = 0
  const fetchTask = async (id: string) => {
    asked.push(id)
    // MINE runs for a few polls, then completes with real output.
    if (++polls >= 3) tasks[MINE] = { id: MINE, status: "completed", duration_ms: 17000, result: { output: "ok\n", metadata: { exit_code: 0 } } }
    else if (polls >= 1) tasks[MINE] = { ...tasks[MINE], status: "running" }
    return tasks[id] ?? Object.values(tasks).find((t) => t.id.startsWith(id))
  }
  return { fetchTask, asked }
}

const fast = { deadlineMs: 60_000, intervalMs: 0, sleep: async () => {} }

describe("hive run polls its own task (#187990)", () => {
  test("reports the dispatched task's status and output, not an older task sharing its prefix", async () => {
    const { fetchTask, asked } = fakeServer()
    const seen: string[] = []
    const final = await waitForTask(MINE, { ...fast, fetchTask, initialStatus: "dispatched", onStatus: (t) => seen.push(t.status) })
    expect(final.id).toBe(MINE)
    expect(final.status).toBe("completed")
    expect(final.result.output).toBe("ok\n")
    expect(final.error).toBeUndefined()
    expect(seen).toEqual(["running", "completed"])
    // Every poll used the full id — never the 8-character display form.
    expect(asked.every((id) => id === MINE)).toBe(true)
  })

  test("a poll that returns a different task is an error, never someone else's result", async () => {
    const fetchTask = async () => ({ id: OLD_FAILED, status: "failed", error: "Process exited with code 1" })
    await expect(waitForTask(MINE, { ...fast, fetchTask })).rejects.toThrow(/returned a different task/)
  })

  test("times out (null) rather than inventing a result", async () => {
    let t = 0
    const r = await waitForTask(MINE, { deadlineMs: 10, intervalMs: 0, sleep: async () => {}, now: () => (t += 5), fetchTask: async () => ({ id: MINE, status: "running" }) })
    expect(r).toBeNull()
  })
})

describe("cancel / tasks get resolve a short id to exactly one task (#187990)", () => {
  const list = async () => [OLD_FAILED, OLD_RUNNING, MINE]

  test("a full id passes through untouched, without listing", async () => {
    let listed = false
    expect(await resolveTaskIdArg(MINE, 1, async () => ((listed = true), []))).toEqual({ id: MINE })
    expect(listed).toBe(false)
  })

  test("the 8-character prefix all three share is ambiguous, and says so", async () => {
    const r = await resolveTaskIdArg("01a109da", 1, list)
    expect(r).toEqual({ error: expect.stringContaining("matches 3 tasks") })
  })

  test("a longer prefix resolves to the one task", async () => {
    expect(await resolveTaskIdArg("01a109da-a3e", 1, list)).toEqual({ id: MINE })
  })

  test("an unknown prefix is a clear error, not an API 404", async () => {
    expect(await resolveTaskIdArg("01a109d7", 1, list)).toEqual({ error: expect.stringContaining("no task starting with 01a109d7") })
  })
})
