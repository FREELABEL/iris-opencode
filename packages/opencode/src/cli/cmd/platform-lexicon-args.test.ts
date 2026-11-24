import { describe, expect, test } from "bun:test"
import { lexiconArgs, runFailed } from "./platform-lexicon"

// #193830 — legal-engagement-letter's own schema (frontmatter args), as published.
const engagement = {
  lead: { type: "number", required: true },
  mode: { type: "string", default: "draft", enum: ["draft", "review"] },
  letter: { type: "string" }, fee: { type: "string" }, bloq: { type: "number" }, list: { type: "number" },
  record: { type: "string", default: "no", enum: ["no", "yes"] },
  signed: { type: "string", default: "no", enum: ["no", "yes"] },
} as any

describe("lexiconArgs — a door gets the playbook's defaults, like iris playbook run", () => {
  // Exactly what EngagementCmd passes: no `signed` at all.
  const door = { lead: 30648, mode: "draft", letter: undefined, fee: "contingency 33.3%", bloq: undefined, list: undefined, record: "yes", yes: false }
  const a = lexiconArgs(engagement, door)
  test("an arg the door never passes arrives at its default (signed=no) — the draft condition holds", () => {
    expect(a.signed).toBe("no")
    expect(`${a.mode}-${a.signed}`).toBe("draft-no")
  })
  test("what the door did pass is kept", () => {
    expect(a.record).toBe("yes"); expect(a.fee).toBe("contingency 33.3%"); expect(Number(a.lead)).toBe(30648)
  })
  test("an absent (undefined) flag never overwrites a default", () => {
    expect(lexiconArgs(engagement, { lead: 1, mode: undefined }).mode).toBe("draft")
  })
  test("non-schema keys the door uses (yes) survive", () => {
    expect(a.yes).toBe(false)
  })
})

describe("runFailed — the door's exit code", () => {
  test("completed with every step ok → 0", () => {
    expect(runFailed({ status: "completed", steps: { a: { status: "success" }, b: { status: "skipped" } } })).toBe(false)
  })
  test("completed but a step failed (on-error: continue) → 1", () => {
    expect(runFailed({ status: "completed", steps: { open: { status: "failed" } } })).toBe(true)
  })
  test("a run that did not complete → 1", () => {
    expect(runFailed({ status: "failed", steps: {} })).toBe(true)
  })
})
