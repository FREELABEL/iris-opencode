import { describe, expect, test } from "bun:test"
import { chatTextScale, chatTextSize, stepChatTextSize } from "./chat-text-size"

describe("chat text size (#193464)", () => {
  test("snaps stored values to a real step", () => {
    expect(chatTextSize(14)).toBe(14)
    expect(chatTextSize(17)).toBe(16)
    expect(chatTextSize(40)).toBe(20)
    expect(chatTextSize(undefined)).toBe(14)
    expect(chatTextSize("big")).toBe(14)
    expect(chatTextSize(Number.NaN)).toBe(14)
  })

  test("steps one size at a time and stops at the ends", () => {
    expect(stepChatTextSize(14, 1)).toBe(16)
    expect(stepChatTextSize(14, -1)).toBe(13)
    expect(stepChatTextSize(20, 1)).toBe(20)
    expect(stepChatTextSize(13, -1)).toBe(13)
  })

  test("the default leaves the chat exactly as it was", () => {
    expect(chatTextScale(14)).toBe(1)
    expect(chatTextScale(20)).toBeCloseTo(20 / 14)
  })
})
