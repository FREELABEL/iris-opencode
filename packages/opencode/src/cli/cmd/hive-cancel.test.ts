import { describe, expect, test } from "bun:test"
import { cancelTaskWith } from "./platform-hive"

/**
 * #190292 — cancelling a task running on another machine failed with "No query results for model
 * NodeTask": the CLI posted a result with THIS machine's node key, and that endpoint only finds
 * tasks assigned to the calling node. Cancel goes through the owner's endpoint now.
 */
describe("cancelTaskWith", () => {
  test("cancels through the owner endpoint, never the node-agent result route", async () => {
    const calls: Array<{ path: string; method?: string }> = []
    const r = await cancelTaskWith(async (path, init) => {
      calls.push({ path, method: init.method })
      return new Response(JSON.stringify({ message: "Task cancelled" }), { status: 200 })
    }, "01a15cb7-0000-7000-8000-000000000001")
    expect(r.ok).toBe(true)
    expect(calls).toEqual([{ path: "/api/v6/nodes/tasks/01a15cb7-0000-7000-8000-000000000001/cancel", method: "POST" }])
  })

  test("a finished task says why it cannot be cancelled", async () => {
    const r = await cancelTaskWith(
      async () => new Response(JSON.stringify({ error: "Task already completed", message: "Task is in 'completed' state and cannot be cancelled" }), { status: 422 }),
      "x",
    )
    expect(r).toEqual({ ok: false, message: "Task is in 'completed' state and cannot be cancelled" })
  })

  test("an unknown id is named, not a model-lookup error", async () => {
    const r = await cancelTaskWith(async () => new Response("{}", { status: 404 }), "nope")
    expect(r.message).toBe("No task nope on your account")
  })
})
