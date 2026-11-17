import { describe, expect, test } from "bun:test"
import { boardIds, cardPosition, readCardMode, stepCard } from "./iris-card-panel"

// #193330 — a card opens in the side panel; the step buttons walk the board in its own order.
const board = [
  { id: 1, items: [{ id: 10 }, { id: 11 }] },
  { id: 2, items: [] },
  { id: 3, items: [{ id: -5 }, { id: 30 }] },
]

describe("Atlas cards in the side panel (#193330)", () => {
  test("the board's order is list by list, and offline cards are skipped", () => {
    expect(boardIds(board)).toEqual([10, 11, 30])
  })

  test("next from the last card in a list is the top of the next list with cards", () => {
    expect(stepCard(boardIds(board), 11, 1)).toBe(30)
    expect(stepCard(boardIds(board), 30, -1)).toBe(11)
  })

  test("there is nothing before the first card or after the last", () => {
    expect(stepCard(boardIds(board), 10, -1)).toBeUndefined()
    expect(stepCard(boardIds(board), 30, 1)).toBeUndefined()
  })

  test("a card that is not on the board as read has no position and no steps", () => {
    expect(cardPosition(boardIds(board), 99)).toBeUndefined()
    expect(stepCard(boardIds(board), 99, 1)).toBeUndefined()
    expect(cardPosition(boardIds(board), 11)).toEqual({ index: 1, total: 3 })
  })

  test("cards open in the panel unless the pop-up was chosen last", () => {
    expect(readCardMode(() => null)).toBe("panel")
    expect(readCardMode(() => "dialog")).toBe("dialog")
    expect(
      readCardMode(() => {
        throw new Error("storage blocked")
      }),
    ).toBe("panel")
  })
})
