import { describe, expect, test } from "bun:test"
import {
  buildSave,
  contrastChecks,
  contrastRatio,
  diffKit,
  draftFromKit,
  draftProblems,
  exportCss,
  exportJson,
  grade,
  groundsOf,
  inkFor,
  logoVisibility,
  parseColor,
  draftLogoFor,
  previewRoles,
  ratioText,
  saveConfirm,
  scaleSizes,
  sectionsFor,
  TILES,
  toHex6,
  type BrandKit,
} from "./iris-brand-kit-model"

// The IRIS kit (#8) as the engine read it on 2026-11-05 (trimmed): marks under brand.logo, stacks and
// sizes both in typography, motion with a spring, colour shades the editor does not show.
const SECTIONS = {
  colors: JSON.stringify({
    accent: { DEFAULT: "#f59e0b" },
    background: { DEFAULT: "#000000" },
    surface: { DEFAULT: "#171717" },
    "text-primary": { DEFAULT: "#ffffff" },
    "text-muted": { DEFAULT: "#737373" },
    primary: { DEFAULT: "#34d399", dark: "#059669" },
    shades: { 50: "#f0fdf4", 900: "#14532d" },
  }),
  typography: JSON.stringify({
    "font-family": { family: "Inter, sans-serif" },
    "font-family-mono": { family: "JetBrains Mono, monospace" },
    "font-size-base": { family: "1rem" },
    "font-size-2xl": { family: "1.5rem" },
    "font-weight-bold": { family: "700" },
  }),
  fonts: "null",
  font: "null",
  motion: JSON.stringify({ ease: "cubic-bezier(.45,0,.15,1)", spring: { damping: 26, stiffness: 170 }, character: "smooth", duration_ms: 320 }),
  brand: JSON.stringify({
    name: "IRIS",
    logo: { primary: "https://freelabel.net/images/iris-logo-white-transparent.png", icon: "https://freelabel.net/favicon.svg" },
    voice: "Confident, technical but approachable.",
    tone: "Professional yet bold.",
    urls: { website: "https://heyiris.io" },
  }),
}
const KIT: BrandKit = {
  brand: { id: 8, name: "IRIS", slug: "iris", status: "active" },
  colors: [
    { name: "accent", value: "#f59e0b", key: "DEFAULT", extra: {} },
    { name: "background", value: "#000000", key: "DEFAULT", extra: {} },
    { name: "surface", value: "#171717", key: "DEFAULT", extra: {} },
    { name: "text-primary", value: "#ffffff", key: "DEFAULT", extra: {} },
    { name: "text-muted", value: "#737373", key: "DEFAULT", extra: {} },
    { name: "primary", value: "#34d399", key: "DEFAULT", extra: { dark: "#059669" } },
  ],
  fonts: [
    { role: "font-family", family: "Inter, sans-serif" },
    { role: "font-family-mono", family: "JetBrains Mono, monospace" },
  ],
  fontSection: "typography",
  typeScale: [
    { role: "font-size-base", value: "1rem" },
    { role: "font-size-2xl", value: "1.5rem" },
    { role: "font-weight-bold", value: "700" },
  ],
  logoUrl: "https://freelabel.net/images/iris-logo-white-transparent.png",
  logos: { primary: "https://freelabel.net/images/iris-logo-white-transparent.png", icon: "https://freelabel.net/favicon.svg" },
  motion: { ease: "cubic-bezier(.45,0,.15,1)", durationMs: 320, character: "smooth", stiffness: 170, damping: 26 },
  voice: "Confident, technical but approachable.",
  tone: "Professional yet bold.",
  personas: [],
  sections: SECTIONS,
}
const black = { r: 0, g: 0, b: 0, a: 1 }
const white = { r: 255, g: 255, b: 255, a: 1 }

describe("colour", () => {
  test("every colour form a kit holds parses to the same thing", () => {
    expect(parseColor("#f59e0b")).toEqual({ r: 245, g: 158, b: 11, a: 1 })
    expect(parseColor("#fff")).toEqual(white)
    expect(parseColor("#00000080")!.a).toBeCloseTo(0.5, 2)
    expect(parseColor("rgb(245, 158, 11)")).toEqual({ r: 245, g: 158, b: 11, a: 1 })
    expect(parseColor("rgba(0 0 0 / 50%)")).toEqual({ r: 0, g: 0, b: 0, a: 0.5 })
    expect(parseColor("hsl(0, 100%, 50%)")).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(parseColor("hsl(120 100% 25%)")).toEqual({ r: 0, g: 128, b: 0, a: 1 })
    for (const bad of ["", "orange", "var(--x)", "#12", "#12345", "rgb(1,2)"]) expect(parseColor(bad)).toBeUndefined()
  })

  test("contrast is WCAG 2's: black on white is 21:1, a colour on itself 1:1", () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21, 5)
    expect(contrastRatio(white, white)).toBeCloseTo(1, 5)
    // The reference pair: #767676 on white is the lightest grey that passes AA (4.54:1).
    expect(contrastRatio(parseColor("#767676")!, white)).toBeCloseTo(4.54, 2)
    // Symmetric.
    expect(contrastRatio(white, parseColor("#767676")!)).toBeCloseTo(4.54, 2)
  })

  test("a translucent colour is judged as it looks, laid over its ground", () => {
    const halfBlack = { r: 0, g: 0, b: 0, a: 0.5 }
    const mid = contrastRatio(halfBlack, white)
    expect(mid).toBeGreaterThan(1)
    expect(mid).toBeLessThan(contrastRatio(black, white))
    expect(contrastRatio({ r: 0, g: 0, b: 0, a: 0 }, white)).toBeCloseTo(1, 5)
  })

  test("the label says pass or fail in words, at WCAG's lines", () => {
    expect(grade(21)).toMatchObject({ label: "Pass", pass: true, tone: "good" })
    expect(grade(4.5)).toMatchObject({ label: "Pass", pass: true })
    expect(grade(4.49)).toMatchObject({ label: "Large only", pass: false, tone: "warn" })
    expect(grade(3)).toMatchObject({ label: "Large only" })
    expect(grade(2.99)).toMatchObject({ label: "Fail", pass: false, tone: "bad" })
    expect(ratioText(4.4999)).toBe("4.4:1") // never rounds a fail up to a pass
    expect(ratioText(21)).toBe("21.0:1")
  })

  test("each colour is checked against the kit's own background and surface, never against itself", () => {
    const grounds = groundsOf(KIT.colors)
    expect(grounds.map((g) => [g.id, g.name])).toEqual([["background", "background"], ["surface", "surface"]])
    const accent = contrastChecks({ name: "accent", value: "#f59e0b" }, grounds)
    expect(accent.map((c) => c.ground.name)).toEqual(["background", "surface"])
    expect(accent[0].grade.pass).toBe(true) // amber on black: 9.8:1
    expect(contrastChecks({ name: "background", value: "#000000" }, grounds).map((c) => c.ground.name)).toEqual(["surface"])
    const muted = contrastChecks({ name: "text-muted", value: "#737373" }, grounds)
    // A real finding in the IRIS kit: its muted grey is 4.4:1 on black and 3.8:1 on its surface.
    expect(muted.map((c) => [ratioText(c.grade.ratio), c.grade.label])).toEqual([["4.4:1", "Large only"], ["3.7:1", "Large only"]])
    expect(contrastChecks({ name: "text-primary", value: "#ffffff" }, grounds).map((c) => c.grade.label)).toEqual(["Pass", "Pass"])
  })

  test("a kit with no background is checked on white and black, and says so by name", () => {
    expect(groundsOf([{ name: "primary", value: "#336699" }]).map((g) => g.name)).toEqual(["white", "black"])
  })

  test("labels on a swatch pick the readable ink; the picker gets #rrggbb", () => {
    expect(inkFor("#f59e0b")).toBe("#000000")
    expect(inkFor("#171717")).toBe("#ffffff")
    expect(toHex6("rgb(245,158,11)")).toBe("#f59e0b")
    expect(toHex6("#abc")).toBe("#aabbcc")
  })
})

/** A square image: `ink` pixels of one colour on transparency, or a fully opaque one. */
function image(color: [number, number, number], ink: number, total = 100, opaqueBg?: [number, number, number]) {
  const px = new Uint8ClampedArray(total * 4)
  for (let i = 0; i < total; i++) {
    const [r, g, b] = i < ink ? color : opaqueBg ?? [0, 0, 0]
    px.set([r, g, b, i < ink || opaqueBg ? 255 : 0], i * 4)
  }
  return px
}

describe("logo on light and dark (#184115)", () => {
  test("a white mark is invisible on a light tile and visible on a dark one", () => {
    const whiteMark = image([255, 255, 255], 30)
    expect(logoVisibility(whiteMark, TILES.light.rgba)).toMatchObject({ verdict: "invisible", tone: "bad" })
    expect(logoVisibility(whiteMark, TILES.dark.rgba)).toMatchObject({ verdict: "visible", tone: "good" })
  })

  test("a near-black mark is invisible on dark; a mid colour reads on both", () => {
    const ink = image([20, 20, 20], 30)
    expect(logoVisibility(ink, TILES.dark.rgba).verdict).toBe("invisible")
    expect(logoVisibility(ink, TILES.light.rgba).verdict).toBe("visible")
    const green = image([52, 211, 153], 30)
    expect(logoVisibility(green, TILES.dark.rgba).verdict).toBe("visible")
    expect(logoVisibility(green, TILES.light.rgba).verdict).toBe("visible") // 1.9:1 — findable
  })

  test("a mark that is mostly lost is faint, not visible", () => {
    // 30 inked pixels: 10 dark (survive on white), 20 white (vanish).
    const px = image([255, 255, 255], 30)
    for (let i = 0; i < 10; i++) px.set([0, 0, 0, 255], i * 4)
    expect(logoVisibility(px, TILES.light.rgba)).toMatchObject({ verdict: "faint", tone: "warn" })
  })

  test("an icon whose dark plate vanishes on dark still shows its glyph", () => {
    // 60 pixels of near-black plate, 20 of white glyph on it, 20 transparent corners.
    const px = image([12, 12, 12], 80)
    for (let i = 0; i < 20; i++) px.set([255, 255, 255, 255], i * 4)
    expect(logoVisibility(px, TILES.dark.rgba).verdict).toBe("visible")
    expect(logoVisibility(px, TILES.light.rgba).verdict).toBe("visible")
  })

  test("an image with its own background always shows; an empty one never does", () => {
    const jpg = image([255, 255, 255], 10, 100, [255, 255, 255])
    expect(logoVisibility(jpg, TILES.light.rgba)).toMatchObject({ verdict: "visible", opaque: true })
    expect(logoVisibility(new Uint8ClampedArray(400), TILES.light.rgba).verdict).toBe("invisible")
  })

  test("previews pick through the #192664 resolver: on_light / on_dark, else primary on a tile that keeps it visible", () => {
    const d = draftFromKit(KIT)
    d.logos.on_light = "https://freelabel.net/images/iris-logo-dark-transparent.png"
    d.logos.on_dark = KIT.logos!.primary!
    expect(draftLogoFor(d, "#ffffff")).toMatchObject({ variant: "on_light", tile: null })
    expect(draftLogoFor(d, "#171717")).toMatchObject({ variant: "on_dark", tile: null })
    // Before fl-iris-api #327: only the white primary. On white it goes on the kit's black ground.
    const before = draftFromKit(KIT)
    expect(draftLogoFor(before, "#ffffff")).toMatchObject({ variant: "primary", tile: "#000000", ground: "light" })
    expect(draftLogoFor(before, "#000000")).toMatchObject({ variant: "primary", tile: null })
    expect(draftLogoFor({ ...before, logos: { primary: "", on_dark: "", on_light: "", icon: "", social: "" } }, "#fff")).toBeNull()
  })
})

describe("the diff a save shows", () => {
  test("nothing edited → nothing to save", () => {
    const d = draftFromKit(KIT)
    expect(diffKit(KIT, d)).toEqual([])
    expect(buildSave(KIT, d)).toEqual({ changes: {}, expected: {} })
  })

  test("each change is a line with before and after, in the editor's order", () => {
    const d = draftFromKit(KIT)
    d.colors.find((c) => c.name === "accent")!.value = "#ff3366"
    d.logos.on_light = "https://freelabel.net/images/iris-logo-dark.png"
    d.voice = "Plain."
    d.durationMs = "240"
    expect(diffKit(KIT, d)).toEqual([
      { section: "colors", part: "colours", label: "accent", before: "#f59e0b", after: "#ff3366", swatch: true },
      { section: "brand", part: "logos", label: "logo · on light", before: undefined, after: "https://freelabel.net/images/iris-logo-dark.png" },
      { section: "brand", part: "voice", label: "voice", before: "Confident, technical but approachable.", after: "Plain." },
      { section: "motion", part: "motion", label: "duration (ms)", before: "320", after: "240" },
    ])
  })

  test("whitespace alone is not a change", () => {
    const d = draftFromKit(KIT)
    d.colors[0].value = "  #f59e0b "
    d.tone = "Professional yet bold.  "
    expect(diffKit(KIT, d)).toEqual([])
  })

  test("the confirm says, in plain words, that every page using the kit changes — and warns about a colour that now fails", () => {
    const d = draftFromKit(KIT)
    d.colors.find((c) => c.name === "accent")!.value = "#1a1a1a"
    const c = saveConfirm(KIT, d)
    expect(c.title).toBe("Save 1 change to IRIS?")
    expect(c.body[0]).toStartWith("This changes every page that uses IRIS.")
    expect(c.warn.some((w) => w.startsWith("accent on background is 1.") && w.includes("too faint"))).toBe(true)
    d.logos.icon = ""
    expect(saveConfirm(KIT, d).warn).toContain("The icon logo is removed.")
    expect(saveConfirm(KIT, d).title).toBe("Save 2 changes to IRIS?")
  })

  test("a broken value is named before the save is offered", () => {
    const d = draftFromKit(KIT)
    d.colors[0].value = "orange"
    d.logos.social = "ftp://x"
    d.ease = "bouncy"
    d.stiffness = "170"
    d.damping = ""
    expect(draftProblems(d)).toEqual([
      'accent: "orange" is not a colour (use #rrggbb, rgb() or hsl())',
      "logo social: not an http(s) URL",
      'ease: "bouncy" is not an easing a browser accepts',
      "spring: needs both stiffness and damping, each above 0",
    ])
    expect(draftProblems(draftFromKit(KIT))).toEqual([])
  })
})

describe("what a save sends", () => {
  test("only the touched sections, each pinned to the section as read", () => {
    const d = draftFromKit(KIT)
    d.colors.find((c) => c.name === "accent")!.value = "#ff3366"
    const s = buildSave(KIT, d)
    expect(Object.keys(s.changes)).toEqual(["colors"])
    expect(s.expected).toEqual({ colors: SECTIONS.colors })
  })

  test("keys the editor does not show survive: colour shades, a colour's dark variant, brand.urls, weights", () => {
    const d = draftFromKit(KIT)
    d.colors.find((c) => c.name === "primary")!.value = "#10b981"
    d.fonts[0].family = "Geist, sans-serif"
    d.logos.on_dark = "https://freelabel.net/images/iris-logo-white-transparent.png"
    const all = sectionsFor(KIT, d) as any
    expect(all.colors.shades).toEqual({ 50: "#f0fdf4", 900: "#14532d" })
    expect(all.colors.primary).toEqual({ DEFAULT: "#10b981", dark: "#059669" })
    expect(all.typography["font-family"]).toEqual({ family: "Geist, sans-serif" })
    expect(all.typography["font-weight-bold"]).toEqual({ family: "700" })
    expect(all.brand.urls).toEqual({ website: "https://heyiris.io" })
    expect(all.brand.name).toBe("IRIS")
    expect(all.brand.logo).toEqual({
      primary: "https://freelabel.net/images/iris-logo-white-transparent.png",
      icon: "https://freelabel.net/favicon.svg",
      on_dark: "https://freelabel.net/images/iris-logo-white-transparent.png",
    })
    expect(Object.keys(buildSave(KIT, d).changes).sort()).toEqual(["brand", "colors", "typography"])
  })

  test("a cleared logo variant is removed, not saved as an empty string", () => {
    const d = draftFromKit(KIT)
    d.logos.icon = ""
    expect((sectionsFor(KIT, d) as any).brand.logo).toEqual({ primary: KIT.logos!.primary })
  })

  test("stacks read from `fonts` go back to `fonts`, under the key they used", () => {
    const kit: BrandKit = {
      ...KIT,
      fonts: [{ role: "sans", family: "Inter" }],
      fontSection: "fonts",
      typeScale: [],
      sections: { ...SECTIONS, typography: "null", fonts: JSON.stringify({ sans: { DEFAULT: "Inter" }, mono: "JetBrains Mono" }) },
    }
    const d = draftFromKit(kit)
    d.fonts[0].family = "Geist"
    const s = buildSave(kit, d)
    expect(Object.keys(s.changes)).toEqual(["fonts"])
    expect(s.changes.fonts).toEqual({ sans: { DEFAULT: "Geist" }, mono: "JetBrains Mono" })
  })

  test("motion: a number goes out as a number, the spring as a pair, a cleared field is dropped", () => {
    const d = draftFromKit(KIT)
    d.durationMs = "240"
    d.character = ""
    const m = (sectionsFor(KIT, d) as any).motion
    expect(m).toEqual({ ease: "cubic-bezier(.45,0,.15,1)", spring: { damping: 26, stiffness: 170 }, duration_ms: 240 })
  })
})

describe("export", () => {
  test("CSS: colours, stacks, sizes, motion and logos as custom properties — of the draft, edits included", () => {
    const d = draftFromKit(KIT)
    d.colors.find((c) => c.name === "accent")!.value = "#ff3366"
    const css = exportCss(KIT, d)
    expect(css).toContain("--color-accent: #ff3366;")
    expect(css).toContain("--font-font-family: Inter, sans-serif;")
    expect(css).toContain("--font-size-2xl: 1.5rem;")
    expect(css).toContain("--ease: cubic-bezier(.45,0,.15,1);")
    expect(css).toContain("--duration: 320ms;")
    expect(css).toContain('--logo-primary: url("https://freelabel.net/images/iris-logo-white-transparent.png");')
  })

  test("CSS: a hostile value cannot close the rule", () => {
    const d = draftFromKit({ ...KIT, brand: { ...KIT.brand, name: "x</style>" } })
    d.fonts[0].family = "Georgia; } body { display:none"
    d.colors[0].value = "red; } *{x:y"
    d.logos.primary = 'https://x.test/a.png") ; } *{'
    const css = exportCss(KIT, d)
    expect(css.match(/[{}]/g)).toEqual(["{", "}"])
    expect(css).not.toMatch(/[<>]/)
  })

  test("JSON: the sections this editor owns, whole — what `iris brands dt push` takes", () => {
    const d = draftFromKit(KIT)
    d.voice = "Plain."
    const j = JSON.parse(exportJson(KIT, d))
    expect(Object.keys(j)).toEqual(["colors", "typography", "motion", "brand"])
    expect(j.brand.voice).toBe("Plain.")
    expect(j.colors.shades).toEqual({ 50: "#f0fdf4", 900: "#14532d" })
  })
})

describe("previews", () => {
  test("roles come from the kit's own names", () => {
    const r = previewRoles(draftFromKit(KIT))
    expect(r).toMatchObject({ bg: "#000000", surface: "#171717", text: "#ffffff", muted: "#737373", primary: "#34d399", accent: "#f59e0b" })
    expect(r.body).toBe("Inter, sans-serif")
    expect(r.mono).toBe("JetBrains Mono, monospace")
  })

  test("a kit with almost nothing still draws readably", () => {
    const r = previewRoles({ ...draftFromKit(KIT), colors: [{ name: "brand", value: "#1d4ed8", key: "DEFAULT", extra: {} }], fonts: [] })
    expect(r.bg).toBe("#ffffff")
    expect(r.text).toBe("#000000")
    expect(r.primary).toBe("#1d4ed8")
    expect(r.onPrimary).toBe("#ffffff")
  })

  test("the scale specimen is sizes only, smallest first", () => {
    expect(scaleSizes(KIT.typeScale)).toEqual([
      { role: "font-size-base", value: "1rem", px: 16 },
      { role: "font-size-2xl", value: "1.5rem", px: 24 },
    ])
  })
})
