import { describe, expect, test } from "bun:test"
import { pollDelayMs, waitForTask } from "./platform-hive-nodes"

/**
 * #190406 — every `hive run` paid a 1500ms poll tick, so the cheapest command cost ~3s
 * end to end while the node reported 0-1000ms of execution. The tick was paid per command,
 * not per long job, and that is most of why Hive feels slow next to ssh.
 */
describe("hive run poll backoff", () => {
  test("starts fast and settles at the old rate", () => {
    expect([1, 2, 3, 4, 5, 6, 20].map(pollDelayMs)).toEqual([100, 200, 400, 800, 1500, 1500, 1500])
  })

  test("never exceeds the pre-existing tick", () => {
    for (let attempt = 1; attempt <= 50; attempt++) expect(pollDelayMs(attempt)).toBeLessThanOrEqual(1500)
  })

  test("a task that is already done is seen after one short wait, not 1500ms", async () => {
    const waits: number[] = []
    const result = await waitForTask("t1", {
      deadlineMs: 60_000,
      sleep: async (ms) => {
        waits.push(ms)
      },
      fetchTask: async () => ({ id: "t1", status: "succeeded" }),
    })
    expect(result).toMatchObject({ status: "succeeded" })
    expect(waits).toEqual([100])
  })

  test("an explicit intervalMs still wins, so existing callers are unaffected", async () => {
    const waits: number[] = []
    let t = 0
    await waitForTask("t1", {
      deadlineMs: 30,
      intervalMs: 0,
      sleep: async (ms) => {
        waits.push(ms)
      },
      fetchTask: async () => ({ id: "t1", status: "running" }),
      now: () => (t += 10),
    })
    expect(waits.length).toBeGreaterThan(0)
    expect(new Set(waits)).toEqual(new Set([0]))
  })
})
