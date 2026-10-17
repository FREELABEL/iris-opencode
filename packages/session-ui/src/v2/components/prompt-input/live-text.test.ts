import { describe, expect, test } from "bun:test"
import { appendFinal, composeLive, speechKey } from "./live-text"

/** What the chat box shows after a run of engine events. */
function play(events: Array<["partial" | "final", string]>) {
  let finals: string[] = []
  let partial = ""
  for (const [kind, text] of events) {
    if (kind === "final") {
      finals = appendFinal(finals, text)
      partial = ""
    } else partial = text
  }
  return composeLive(finals, partial)
}

describe("live words — one spoken sentence is shown once (#189546)", () => {
  test("the reported case: the same final arriving twice", () => {
    expect(
      play([
        ["partial", "I need to"],
        ["partial", "I need to build a shopping list"],
        ["final", "I need to build a shopping list."],
        ["final", "I need to build a shopping list."],
      ]),
    ).toBe("I need to build a shopping list.")
  })

  test("a resend that differs only in punctuation, case or spacing is still a repeat", () => {
    expect(play([["final", "I need to build a shopping list."], ["final", " i need to build a shopping list"]])).toBe(
      "I need to build a shopping list.",
    )
  })

  test("a final that restates the whole take so far replaces it", () => {
    expect(
      play([
        ["final", "I need to build a shopping list."],
        ["final", "I need to build a shopping list. Eggs and milk."],
      ]),
    ).toBe("I need to build a shopping list. Eggs and milk.")
  })

  test("a partial that restates what is locked is not shown after a second copy of it", () => {
    expect(
      play([
        ["final", "I need to build a shopping list."],
        ["partial", "I need to build a shopping list. Eggs"],
      ]),
    ).toBe("I need to build a shopping list. Eggs")
  })

  test("a partial that is a lagging copy of the last final adds nothing", () => {
    expect(play([["final", "I need to build a shopping list."], ["partial", "a shopping list"]])).toBe(
      "I need to build a shopping list.",
    )
  })

  test("separate utterances still accumulate in order", () => {
    expect(
      play([
        ["final", "First, eggs."],
        ["partial", "then"],
        ["final", "Then milk."],
        ["partial", "and bread"],
      ]),
    ).toBe("First, eggs. Then milk. and bread")
  })

  test("saying the same sentence again on purpose, after something else, is kept", () => {
    expect(play([["final", "Buy eggs."], ["final", "Buy milk."], ["final", "Buy eggs."]])).toBe("Buy eggs. Buy milk. Buy eggs.")
  })
})

test("speechKey ignores case, punctuation and spacing", () => {
  expect(speechKey("  I need, to build — a LIST. ")).toBe("i need to build a list")
})
