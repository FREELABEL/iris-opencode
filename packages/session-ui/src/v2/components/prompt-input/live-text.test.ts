import { describe, expect, test } from "bun:test"
import { appendFinal, atBottom, composeLive, growFollowing, speechKey } from "./live-text"

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

describe("live words stay in view as the take grows (#189977)", () => {
  /** A chat box 180px tall holding `content` px, scrolled to `top`; the browser clamps scrollTop. */
  function box(content: number, top: number) {
    const el = {
      content,
      clientHeight: 180,
      get scrollHeight() {
        return this.content
      },
      _top: top,
      get scrollTop() {
        return this._top
      },
      set scrollTop(v: number) {
        this._top = Math.max(0, Math.min(v, this.content - 180))
      },
    }
    return el
  }

  test("at the bottom: the take grows by a line and the view follows it", () => {
    const el = box(400, 220) // 400 - 220 - 180 = 0 from the bottom
    growFollowing(el, () => (el.content += 60))
    expect(el.scrollTop).toBe(280)
    expect(atBottom(el, 0)).toBe(true)
  })

  test("scrolled up on purpose: the take grows without yanking the view down", () => {
    const el = box(400, 0) // rereading the top of a long draft
    growFollowing(el, () => (el.content += 60))
    expect(el.scrollTop).toBe(0)
  })

  test("within a few pixels of the bottom still counts as the bottom", () => {
    expect(atBottom({ scrollTop: 200, scrollHeight: 400, clientHeight: 180 })).toBe(true)
    expect(atBottom({ scrollTop: 100, scrollHeight: 400, clientHeight: 180 })).toBe(false)
  })
})
