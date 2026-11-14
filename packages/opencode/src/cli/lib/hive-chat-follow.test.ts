import { describe, expect, test } from "bun:test"
import { anchorIndex, followStep, newFollowState, refusedAtCreate } from "./hive-chat-follow"

const sent = "what changed today?"
const mine = { role: "user", type: "text", text: `[via iris · iris-hive-001] ${sent}` }

describe("hive chat follow (#190671)", () => {
  test("anchors on the LAST user message containing what we sent, prefix and all", () => {
    const older = { role: "user", type: "text", text: sent }
    const reply = { role: "assistant", type: "text", text: "old answer" }
    expect(anchorIndex([older, reply, mine], sent)).toBe(2)
    expect(anchorIndex([older, reply], "something else")).toBe(-1)
  })

  test("prints nothing before our message lands, then only what each poll adds", () => {
    const s = newFollowState()
    expect(followStep(s, [{ role: "assistant", type: "text", text: "earlier" }], sent).out).toBe("")
    expect(s.anchored).toBe(false)

    expect(followStep(s, [mine, { role: "assistant", type: "text", text: "Two" }], sent).out).toBe("Two")
    expect(followStep(s, [mine, { role: "assistant", type: "text", text: "Two commits" }], sent).out).toBe(" commits")
    expect(s.answered).toBe(true)
  })

  test("a tool call prints once, and an unchanged poll reports no change", () => {
    const s = newFollowState()
    const tool = { role: "assistant", type: "tool_use", tool: "bash", command: "git log -1" }
    const msgs = [mine, tool, { role: "assistant", type: "text", text: "done" }]
    expect(followStep(s, msgs, sent).out).toBe("· bash git log -1\ndone")
    const again = followStep(s, msgs, sent)
    expect(again.out).toBe("")
    expect(again.changed).toBe(false)
  })

  test("no assistant text yet is not an answer — a tool-only turn keeps following", () => {
    const s = newFollowState()
    followStep(s, [mine, { role: "assistant", type: "tool_use", tool: "read", file_path: "a.ts" }], sent)
    expect(s.anchored).toBe(true)
    expect(s.answered).toBe(false)
  })
})

describe("refusedAtCreate (#190945 — a refused send is not 'sent')", () => {
  test("a task created already failed names the reason", () => {
    expect(refusedAtCreate({ task: { status: "failed", result: { metadata: { reason: "is busy (CPU at 168%)" } } } })).toBe("is busy (CPU at 168%)")
  })
  test("a dispatched or pending task is not a refusal", () => {
    expect(refusedAtCreate({ task: { status: "dispatched" } })).toBeNull()
    expect(refusedAtCreate({ task: { status: "pending" } })).toBeNull()
    expect(refusedAtCreate(null)).toBeNull()
  })
})
