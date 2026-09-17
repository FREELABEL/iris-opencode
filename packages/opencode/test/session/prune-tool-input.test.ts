import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"

/**
 * #185821 — an oversized tool ARGUMENT was being re-sent on every subsequent turn.
 * Only the copy sent to the model shrinks; the stored part keeps everything.
 */

const big = "x".repeat(50_000)

describe("MessageV2.pruneToolInput", () => {
  test("leaves a small input completely alone", () => {
    const input = { file: "a.ts", limit: 20, deep: { ok: true, list: ["a", "b"] } }
    expect(MessageV2.pruneToolInput(input)).toEqual(input)
  })

  test("shrinks a long string and says how much was left out", () => {
    const out = MessageV2.pruneToolInput({ body: big }) as any
    expect(out.body.length).toBeLessThan(big.length)
    expect(out.body).toContain("characters omitted from context")
    expect(out.body).toContain(String(50_000 - MessageV2.TOOL_INPUT_MAX_CHARS))
  })

  test("keeps the beginning, so the argument is still recognisable", () => {
    const value = "SELECT * FROM leads WHERE " + big
    const out = MessageV2.pruneToolInput({ query: value }) as any
    expect(out.query.startsWith("SELECT * FROM leads WHERE")).toBe(true)
  })

  test("preserves structure — keys, numbers, booleans, arrays, null", () => {
    // A model re-reading its own call needs to see WHICH arguments it passed.
    const input = { path: "/tmp/x", count: 3, flag: false, missing: null, items: [1, 2], body: big }
    const out = MessageV2.pruneToolInput(input) as any
    expect(Object.keys(out).sort()).toEqual(["body", "count", "flag", "items", "missing", "path"])
    expect(out.count).toBe(3)
    expect(out.flag).toBe(false)
    expect(out.missing).toBeNull()
    expect(out.items).toEqual([1, 2])
    expect(out.path).toBe("/tmp/x")
  })

  test("reaches long strings nested in arrays and objects", () => {
    const out = MessageV2.pruneToolInput({ edits: [{ replace: big }] }) as any
    expect(out.edits[0].replace.length).toBeLessThan(big.length)
  })

  test("does NOT mutate the input it was given — the stored part must stay whole", () => {
    // The safety property: this is a context measure, not a data one.
    const stored = { body: big }
    const out = MessageV2.pruneToolInput(stored) as any
    expect(stored.body.length).toBe(50_000)
    expect(out).not.toBe(stored)
  })

  test("a string exactly at the limit is untouched (boundary)", () => {
    const exact = "y".repeat(MessageV2.TOOL_INPUT_MAX_CHARS)
    expect(MessageV2.pruneToolInput({ v: exact })).toEqual({ v: exact })
  })
})

describe("toModelMessage prunes what it sends", () => {
  const base = {
    id: "msg_1",
    sessionID: "ses_1",
    role: "assistant" as const,
    time: { created: 1, completed: 2 },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: "iris-ai",
    providerID: "iris",
    mode: "build",
    agent: "build",
    path: { cwd: "/tmp", root: "/tmp" },
  }

  function toolMessage(input: Record<string, unknown>) {
    return MessageV2.toModelMessage([
      {
        info: base as any,
        parts: [
          {
            id: "prt_1",
            messageID: "msg_1",
            sessionID: "ses_1",
            type: "tool",
            callID: "call_1",
            tool: "brands",
            state: {
              status: "completed",
              input,
              output: "ok",
              title: "brands",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          } as any,
        ],
      },
    ])
  }

  test("the request carries the pruned argument, not the 50KB one", () => {
    const messages = toolMessage({ tokens: big })
    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain(big)
    expect(serialized).toContain("characters omitted from context")
  })

  test("a normal tool call is passed through unchanged", () => {
    const messages = toolMessage({ slug: "pathways" })
    expect(JSON.stringify(messages)).toContain("pathways")
  })
})
