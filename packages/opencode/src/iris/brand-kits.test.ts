import { describe, expect, test } from "bun:test"
import { isDrawableColor, isEase, isFontStack, kitOf, kitToCss, logosOf, normalizeTokens, probeTarget, sectionProblem } from "./brand-kits"

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

// ── #192667: the editor ────────────────────────────────────────────────────────

// The IRIS kit (#8) as fl-api held it on 2026-11-05: marks under brand.logo, voice/tone beside them,
// stacks and sizes both filed under typography, motion with a spring.
const IRIS_NOW = {
  brand: {
    name: "IRIS",
    logo: {
      icon: "https://freelabel.net/favicon.svg",
      social: "https://freelabel.net/images/iris-logo-social-share-preview.png",
      primary: "https://freelabel.net/images/iris-logo-white-transparent.png",
    },
    tone: "Professional yet bold.",
    voice: "Confident, technical but approachable.",
    urls: { website: "https://heyiris.io" },
  },
  colors: { accent: { DEFAULT: "#f59e0b" }, background: { DEFAULT: "#000000" }, surface: { DEFAULT: "#171717" } },
  typography: { "font-family": { family: "Inter, sans-serif" }, "font-size-lg": { family: "1.125rem" } },
  motion: { ease: "cubic-bezier(.45,0,.15,1)", spring: { damping: 26, stiffness: 170 }, character: "smooth", duration_ms: 320 },
}

describe("the editor reads every part it edits (#192667)", () => {
  test("logo variants come from brand.logo, voice and tone from brand, the spring from motion", () => {
    const kit = kitOf({ id: 8, name: "IRIS", slug: "iris" }, IRIS_NOW)
    expect(kit.logos).toEqual({
      icon: IRIS_NOW.brand.logo.icon,
      social: IRIS_NOW.brand.logo.social,
      primary: IRIS_NOW.brand.logo.primary,
    })
    expect(kit.logoUrl).toBe(IRIS_NOW.brand.logo.primary)
    expect(kit.voice).toBe(IRIS_NOW.brand.voice)
    expect(kit.tone).toBe(IRIS_NOW.brand.tone)
    expect(kit.motion).toEqual({ ease: "cubic-bezier(.45,0,.15,1)", durationMs: 320, character: "smooth", stiffness: 170, damping: 26 })
    expect(kit.fontSection).toBe("typography")
    expect(JSON.parse(kit.sections.brand).urls).toEqual({ website: "https://heyiris.io" })
  })

  test("on_light / on_dark (fl-iris-api #327) are read, and brand.logo wins over the older logos.*", () => {
    const logos = logosOf({
      logos: { primary: { url: "https://x.test/old.png" }, icon: { url: "https://x.test/old-icon.png" } },
      brand: { logo: { primary: "https://x.test/new.png", on_light: "https://x.test/dark-ink.png", on_dark: "https://x.test/white.png" } },
    })
    expect(logos).toEqual({
      primary: "https://x.test/new.png",
      icon: "https://x.test/old-icon.png",
      on_light: "https://x.test/dark-ink.png",
      on_dark: "https://x.test/white.png",
    })
    expect(logosOf({ brand: { logo: { primary: "javascript:alert(1)" } } })).toEqual({})
  })

  test("stacks filed under fonts are read from there, and the kit says so — a save writes them back there", () => {
    const kit = kitOf({ id: 1, name: "Atlas" }, { fonts: { sans: { DEFAULT: "Inter, sans-serif" } } })
    expect(kit.fonts).toEqual([{ role: "sans", family: "Inter, sans-serif" }])
    expect(kit.fontSection).toBe("fonts")
    expect(kit.sections.fonts).toBe(JSON.stringify({ sans: { DEFAULT: "Inter, sans-serif" } }))
  })
})

describe("what a save may send (#192667)", () => {
  test("brand, fonts and motion are writable; logos and personas are not", () => {
    expect(sectionProblem("brand", { logo: { on_light: "https://x.test/a.png" }, voice: "plain" })).toBeNull()
    expect(sectionProblem("fonts", { sans: { DEFAULT: "Inter" } })).toBeNull()
    expect(sectionProblem("personas", {})).toContain("not editable")
  })

  test("a logo that is not an http(s) URL is refused, naming the variant", () => {
    expect(sectionProblem("brand", { logo: { on_dark: "javascript:alert(1)" } })).toContain('"on_dark"')
    expect(sectionProblem("brand", { logo: "https://x.test/a.png" })).toContain("object")
    expect(sectionProblem("brand", { voice: 3 })).toContain("voice")
  })

  test("motion must be something a browser can play", () => {
    expect(sectionProblem("motion", { ease: "cubic-bezier(.45,0,.15,1)", duration_ms: 320 })).toBeNull()
    expect(sectionProblem("motion", { ease: "ease-in-out" })).toBeNull()
    expect(sectionProblem("motion", { ease: "cubic-bezier(1,2,3); } body {" })).toContain("ease")
    expect(sectionProblem("motion", { duration_ms: 20000 })).toContain("duration")
    expect(sectionProblem("motion", { spring: { stiffness: 170 } })).toContain("spring")
    expect(isEase("steps(4, end)")).toBe(true)
  })

  test("a font stack cannot close a rule", () => {
    expect(sectionProblem("typography", { body: { family: "Georgia; } body { display:none" } })).toContain('"body"')
  })
})

describe("the logo probe never reaches this machine (#192667)", () => {
  test("public http(s) only", () => {
    expect(probeTarget("https://freelabel.net/favicon.svg")?.hostname).toBe("freelabel.net")
    for (const bad of ["file:///etc/passwd", "http://localhost:4096/", "http://127.0.0.1/x.png", "http://10.0.0.4/x.png", "http://192.168.1.2/a", "http://172.20.0.1/a", "http://[::1]/a", "http://printer.local/a", "not a url"])
      expect(probeTarget(bad)).toBeUndefined()
  })
})
