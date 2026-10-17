import { describe, expect, test } from "bun:test"
import { gateMarkText, gateSummary } from "./part-group"

// #189589 — Constellation Gate's verdict on a turn, from its steps' step-finish parts.
const step = (gate?: Record<string, unknown>) => ({ id: "s", type: "step-finish", messageID: "m", sessionID: "x", reason: "stop", cost: 0, tokens: {}, ...(gate ? { gate } : {}) }) as any
const text = { id: "t", type: "text", text: "hi", messageID: "m", sessionID: "x" } as any

describe("gateSummary", () => {
  test("a turn Gate never screened has no summary — not '0 clean'", () => {
    expect(gateSummary([text, step()])).toBeUndefined()
  })

  test("sums every step, and one enforcing step makes the turn enforce", () => {
    const g = gateSummary([
      step({ scanned: 3, held: 0, flagged: 0, errors: 0, mode: "shadow" }),
      text,
      step({ scanned: 2, held: 1, flagged: 0, errors: 0, mode: "enforce" }),
    ])
    expect(g).toEqual({ scanned: 5, held: 1, flagged: 0, errors: 0, mode: "enforce" })
  })
})

describe("gateMarkText", () => {
  test("clean is one quiet count", () => {
    expect(gateMarkText({ scanned: 6, held: 0, flagged: 0, errors: 0, mode: "shadow" })).toEqual({ text: "Gate · 6 clean", tone: "clean" })
  })

  test("a hold outranks a flag, and both outrank clean", () => {
    expect(gateMarkText({ scanned: 6, held: 1, flagged: 2, errors: 0, mode: "enforce" }).text).toBe("Gate held 1")
    expect(gateMarkText({ scanned: 6, held: 0, flagged: 2, errors: 0, mode: "shadow" }).tone).toBe("flagged")
  })

  test("scans that could not run are not counted as clean", () => {
    expect(gateMarkText({ scanned: 2, held: 0, flagged: 0, errors: 2, mode: "shadow" }).text).toBe("Gate unavailable")
    expect(gateMarkText({ scanned: 3, held: 0, flagged: 0, errors: 1, mode: "shadow" }).text).toBe("Gate · 2 clean")
  })
})
