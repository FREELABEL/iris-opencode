import { describe, expect, test } from "bun:test"
import { hexToRgb } from "./color"
import { DEFAULT_THEMES } from "./default-themes"
import { resolveThemeVariant, themeToCss } from "./resolve"
import { resolveThemeVariantV2, themeV2ToCss } from "./v2/resolve"
import type { HexColor } from "./types"
import blossom from "./themes/blossom.json"

// Blossom is the pink theme a client asked for (#186544, epic #189448). Pink is the colour
// most likely to be picked by eye and fail by measurement: the first light-mode accent drawn
// for it was 2.9:1 against its own background. So this theme ships with its contrast pinned.
const TEXT_MIN = 4.5

// WCAG 2.x relative luminance. Deliberately NOT ./color's contrastRatio: that weights green
// at 0.587 (Rec.601 luma) instead of 0.7152, so its weights sum to 0.87 and it under-reads
// any colour with green in it — #c8336f on #fff4f7 is 4.70:1 by WCAG and 4.23 there.
function wcag(fg: HexColor, bg: HexColor) {
  const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
  const lum = (h: HexColor) => {
    const { r, g, b } = hexToRgb(h)
    return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b)
  }
  const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
  return (a + 0.05) / (b + 0.05)
}

describe("Blossom", () => {
  test("is registered under its id, so the picker lists it", () => {
    expect(Object.keys(DEFAULT_THEMES)).toContain("blossom")
    expect(DEFAULT_THEMES.blossom?.name).toBe("Blossom")
  })

  for (const mode of ["light", "dark"] as const) {
    const variant = blossom[mode]
    const bg = variant.palette.neutral as HexColor

    test(`${mode}: resolves to CSS through the same path the app uses`, () => {
      const css = themeToCss(resolveThemeVariant(variant as any, mode === "dark"))
      const v2 = themeV2ToCss(resolveThemeVariantV2(variant as any, mode === "dark"))
      expect(css.length).toBeGreaterThan(500)
      expect(v2.length).toBeGreaterThan(100)
      expect(css).not.toContain("NaN")
      expect(css).not.toContain("undefined")
    })

    test(`${mode}: every text colour reads at ${TEXT_MIN}:1 on its background`, () => {
      const colours: Record<string, string> = { ...variant.palette, ...variant.overrides }
      const failing = Object.entries(colours)
        .filter(([k]) => k !== "neutral" && k !== "markdown-horizontal-rule")
        .map(([k, v]) => [k, v, wcag(v as HexColor, bg)] as const)
        .filter(([, , r]) => r < TEXT_MIN)
      expect(failing).toEqual([])
    })
  }
})
