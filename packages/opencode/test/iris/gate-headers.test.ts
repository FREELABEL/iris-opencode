import { describe, expect, test } from "bun:test"
import { gateFromHeaders } from "../../src/session/llm/ai-sdk"
import { stepGate } from "../../src/session/processor"

// #189589 — the model proxy's x-gate-* headers become the step-finish part's `gate`.
describe("gateFromHeaders", () => {
  test("no x-gate-scanned means Gate did not screen the call", () => {
    expect(gateFromHeaders(undefined)).toBeUndefined()
    expect(gateFromHeaders({ "content-type": "text/event-stream" })).toBeUndefined()
  })

  test("reads every header, defaulting what the proxy left out", () => {
    expect(gateFromHeaders({ "x-gate-scanned": "3", "x-gate-held": "1", "x-gate-flagged": "0", "x-gate-mode": "enforce" })).toEqual({
      scanned: 3,
      held: 1,
      flagged: 0,
      errors: 0,
      mode: "enforce",
    })
  })

  test("garbage never becomes a negative or NaN count", () => {
    expect(gateFromHeaders({ "x-gate-scanned": "x", "x-gate-held": "-4" })).toMatchObject({ scanned: 0, held: 0 })
  })
})

describe("stepGate", () => {
  test("lifts metadata.iris.gate onto the part, and adds nothing otherwise", () => {
    expect(stepGate({ iris: { gate: { scanned: 2, held: 0, flagged: 1, errors: 0, mode: "shadow" } } })).toEqual({
      gate: { scanned: 2, held: 0, flagged: 1, errors: 0, mode: "shadow" },
    })
    expect(stepGate({ openai: {} })).toEqual({})
    expect(stepGate(undefined)).toEqual({})
  })
})
