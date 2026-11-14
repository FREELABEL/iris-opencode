import { describe, expect, test } from "bun:test"
import { chatFont, chatFontFamily, chatSpacing, chatSpacingScale } from "./chat-reading"

describe("chat font and spacing (#193477)", () => {
  test("unknown or missing values fall back to the defaults", () => {
    expect(chatFont(undefined)).toBe("sans")
    expect(chatFont("comic")).toBe("sans")
    expect(chatFont("serif")).toBe("serif")
    expect(chatSpacing(3)).toBe("default")
    expect(chatSpacing("roomy")).toBe("roomy")
  })

  test("the defaults leave the chat exactly as it was", () => {
    expect(chatFontFamily(undefined)).toBe("var(--font-family-sans)")
    expect(chatSpacingScale(undefined)).toEqual({ leading: 1, gap: 1 })
  })

  test("mono follows the code font; serif is the system serif", () => {
    expect(chatFontFamily("mono")).toBe("var(--font-family-mono)")
    expect(chatFontFamily("serif")).toContain("ui-serif")
  })
})
