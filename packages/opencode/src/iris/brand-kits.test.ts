import { describe, expect, test } from "bun:test"
import { isDrawableColor, isFontStack, kitOf, kitToCss, normalizeTokens, sectionProblem } from "./brand-kits"

// Genesis › Brand kits (#188816). Shapes taken from the real `iris` brand kit (2026-10-09):
// flat legacy colours ("primary": "#34d399") and type sizes filed under typography.

const IRIS_FLAT = {
  colors: { primary: "#34d399", accent: "#f59e0b", background: "#000000", weird: "var(--x)" },
  typography: {
    "font-family": "Inter, -apple-system, 'Segoe UI', sans-serif",
    "font-family-mono": "JetBrains Mono, 'Fira Code', monospace",
    "font-size-lg": "1.125rem",
    "font-weight-bold": "700",
  },
  logo: "https://cdn.heyiris.io/logo.png",
  motion: { ease: "cubic-bezier(.45,0,.15,1)", duration_ms: 800 },
}

describe("reading a kit", () => {
  test("flat legacy tokens read the same as nested ones (fl-api DesignTokenNormalizer)", () => {
    const n = normalizeTokens(IRIS_FLAT)
    expect(n.colors.primary).toEqual({ DEFAULT: "#34d399" })
    expect(n.typography["font-family"]).toEqual({ family: IRIS_FLAT.typography["font-family"] })
    expect(n.logos.primary.url).toBe(IRIS_FLAT.logo)
    expect(normalizeTokens({ colors: { primary: { DEFAULT: "#34d399", dark: "#0f8a5f" } } }).colors.primary.dark).toBe("#0f8a5f")
  })

  test("garbage in → an empty kit, never a throw", () => {
    for (const bad of [null, undefined, "x", 3, []]) expect(normalizeTokens(bad)).toEqual({})
  })

  test("font stacks are specimens; sizes and weights filed under typography are a type scale", () => {
    const kit = kitOf({ id: 7, name: "IRIS", slug: "iris", personas: [] }, IRIS_FLAT)
    expect(kit.fonts.map((f) => f.role)).toEqual(["font-family", "font-family-mono"])
    expect(kit.typeScale).toEqual([
      { role: "font-size-lg", value: "1.125rem" },
      { role: "font-weight-bold", value: "700" },
    ])
    expect(isFontStack("1.125rem")).toBe(false)
    expect(isFontStack("700")).toBe(false)
    expect(isFontStack("Georgia, serif")).toBe(true)
  })

  test("a colour's other keys are kept, so editing DEFAULT cannot drop a dark variant", () => {
    const kit = kitOf({ id: 1, name: "b" }, { colors: { primary: { DEFAULT: "#111111", dark: "#eeeeee" } } })
    expect(kit.colors[0]).toEqual({ name: "primary", value: "#111111", key: "DEFAULT", extra: { dark: "#eeeeee" } })
  })

  test("both spellings in the wild read the same, and remember which they used", () => {
    // `iris brands dt import --css` writes lowercase `default`; fl-api's normaliser writes DEFAULT.
    const kit = kitOf({ id: 1, name: "b" }, { colors: { ink: { default: "#111111" }, primary: { DEFAULT: "#ff5500" } } })
    expect(kit.colors.map((c) => [c.name, c.value, c.key])).toEqual([
      ["ink", "#111111", "default"],
      ["primary", "#ff5500", "DEFAULT"],
    ])
    expect(sectionProblem("colors", { ink: { default: "#222222" } })).toBeNull()
  })

  test("motion, logo and the default persona come through", () => {
    const kit = kitOf(
      { id: 1, name: "b", personas: [{ name: "Narrator", is_default: 1, tone: "dry" }, { name: "Hype" }] },
      IRIS_FLAT,
    )
    expect(kit.motion).toEqual({ ease: "cubic-bezier(.45,0,.15,1)", durationMs: 800, character: undefined })
    expect(kit.logoUrl).toBe(IRIS_FLAT.logo)
    expect(kit.personas).toEqual([
      { name: "Narrator", isDefault: true, tone: "dry" },
      { name: "Hype", isDefault: false, tone: undefined },
    ])
  })

  test("sections are serialised as read, for the pinned save", () => {
    const kit = kitOf({ id: 1, name: "b" }, IRIS_FLAT)
    expect(JSON.parse(kit.sections.colors).primary).toEqual({ DEFAULT: "#34d399" })
    expect(kit.sections.motion).toBe(JSON.stringify(IRIS_FLAT.motion))
  })
})

describe("saving a section", () => {
  test("only colours, typography and motion are writable here", () => {
    expect(sectionProblem("logos", {})).toContain("not editable")
    expect(sectionProblem("colors", [])).toContain("must be an object")
  })

  test("a colour that is not a colour is refused, naming it", () => {
    expect(sectionProblem("colors", { primary: { DEFAULT: "#34d399" } })).toBeNull()
    expect(sectionProblem("colors", { primary: { DEFAULT: "green-ish" } })).toContain('"primary"')
    expect(sectionProblem("colors", { primary: "rgb(1,2,3)" })).toBeNull()
  })

  test("an empty type role is refused", () => {
    expect(sectionProblem("typography", { body: { family: "  " } })).toContain('"body"')
    expect(sectionProblem("typography", { body: { family: "Georgia, serif" } })).toBeNull()
  })
})

describe("the kit as CSS (what Use hands the agent)", () => {
  test("drawable colours, font stacks and motion become custom properties", () => {
    const css = kitToCss(kitOf({ id: 1, name: "IRIS" }, IRIS_FLAT))
    expect(css).toContain("--color-primary: #34d399;")
    expect(css).toContain("--font-font-family-mono: JetBrains Mono, 'Fira Code', monospace;")
    expect(css).toContain("--ease: cubic-bezier(.45,0,.15,1);")
    expect(css).toContain("--duration: 800ms;")
    expect(css).not.toContain("var(--x)") // not a drawable colour → not emitted
    expect(isDrawableColor("var(--x)")).toBe(false)
  })

  test("a hostile token cannot close the declaration or the rule", () => {
    const kit = kitOf(
      { id: 1, name: "x</style><script>" },
      { typography: { "body; } * { display:none": "Georgia; } body { display:none" } },
    )
    const css = kitToCss(kit)
    expect(css).not.toMatch(/[<>]/)
    expect(css.match(/[{}]/g)).toEqual(["{", "}"]) // exactly the one :root rule
  })
})
