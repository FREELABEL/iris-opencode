import { describe, expect, test } from "bun:test"
import fs from "fs"
import path from "path"
import { waitingLines } from "../../src/cli/cmd/platform-hive-sessions"

// #188536 / epic #188549 — a session blocked on a person shows the question it is blocked on.
// The `waiting` shape is what iris-daemon's lib/session-waiting.js reports from the transcript.
const W = {
  kind: "question",
  asked_at: "2026-10-08T10:02:00Z",
  questions: [
    {
      question: "Which layout for the pricing section?",
      header: "Layout",
      options: [{ label: "Three tiers (Recommended)" }, { label: "One plan" }, { label: "A table" }],
    },
  ],
}

describe("waitingLines", () => {
  test("prints the question, then the options numbered the way the agent reads them", () => {
    expect(waitingLines(W)).toEqual([
      "? Which layout for the pricing section?",
      "  1. Three tiers (Recommended)",
      "  2. One plan",
      "  3. A table",
    ])
  })

  test("nothing, or anything malformed, prints nothing — never half a question", () => {
    for (const bad of [null, undefined, {}, { kind: "question" }, { kind: "other", questions: W.questions }, { kind: "question", questions: [{}] }] as any[]) {
      expect(waitingLines(bad)).toEqual([])
    }
  })

  test("an option with no label is skipped, the rest keep their numbers", () => {
    const w = { kind: "question", questions: [{ question: "Pick", options: [{ label: "A" }, {}, null, { label: "  " }, { label: "D" }] }] } as any
    expect(waitingLines(w)).toEqual(["? Pick", "  1. A", "  5. D"])
  })

  test("a long question is clipped to one line", () => {
    const [line] = waitingLines({ kind: "question", questions: [{ question: "x ".repeat(300), options: [] }] })
    expect(line.length).toBeLessThanOrEqual(112)
    expect(line.includes("\n")).toBe(false)
  })
})

test("needs_you sorts above active and is accepted by --status", () => {
  const SRC = fs.readFileSync(path.join(__dirname, "../../src/cli/cmd/platform-hive-sessions.ts"), "utf8")
  expect(SRC).toMatch(/needs_you: -1, active: 0/)
  expect(SRC).toMatch(/describe: "needs_you \| active/)
  expect(SRC).toMatch(/if \(r\.status === "needs_you"\) for \(const line of waitingLines\(r\.waiting\)\)/)
})
