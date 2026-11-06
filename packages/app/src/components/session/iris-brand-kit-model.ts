/**
 * Genesis › Brand kits — the editor's rules (#192667), kept out of the component so they are tested.
 *
 *   colour     parse any colour a kit holds, its WCAG contrast against the kit's own background and
 *              surface, and a pass/fail label a person can read without knowing what AA means
 *   logo       how much of a mark survives on a light and on a dark tile — "invisible" when almost
 *              none of it does (the IRIS white mark on white, #184115)
 *   draft      the kit as the editor holds it; every field is plain text so an input can own it
 *   diff       what a save would change, in words, before anything is sent
 *   save       the whole new value of each changed section (fl-api replaces sections whole), built
 *              on the section AS READ so keys the editor does not show survive
 *   export     the kit as CSS custom properties and as a design-tokens JSON `iris brands dt push` takes
 */

export type LogoVariant = "primary" | "on_dark" | "on_light" | "icon" | "social"
export const LOGO_VARIANTS: { id: LogoVariant; label: string; hint: string; tile?: "light" | "dark" }[] = [
  { id: "primary", label: "Primary", hint: "The main mark, when nothing better fits" },
  { id: "on_light", label: "On light", hint: "Drawn on white and light pages", tile: "light" },
  { id: "on_dark", label: "On dark", hint: "Drawn on black and dark pages", tile: "dark" },
  { id: "icon", label: "Icon", hint: "The small square mark — tabs, avatars, lists" },
  { id: "social", label: "Social", hint: "The share card other sites show for a link" },
]

export type BrandColor = { name: string; value: string; key: string; extra: Record<string, unknown> }
export type BrandKit = {
  brand: { id: number; name: string; slug: string; status: string; description?: string }
  colors: BrandColor[]
  fonts: { role: string; family: string }[]
  fontSection?: "typography" | "fonts" | "font"
  typeScale: { role: string; value: string }[]
  logoUrl?: string
  logos?: Partial<Record<LogoVariant, string>>
  motion?: { ease?: string; durationMs?: number; character?: string; stiffness?: number; damping?: number }
  voice?: string
  tone?: string
  personas: { name: string; isDefault: boolean; tone?: string }[]
  sections: Record<string, string>
}

import { logoFor, type ResolvedLogo } from "./iris-brand-logo"

// ── colour ───────────────────────────────────────────────────────────────────

export type Rgba = { r: number; g: number; b: number; a: number }

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n))

/** Any colour a kit holds: #rgb, #rgba, #rrggbb, #rrggbbaa, rgb()/rgba(), hsl()/hsla(). Else undefined. */
export function parseColor(input: string | undefined): Rgba | undefined {
  if (!input) return undefined
  const s = input.trim().toLowerCase()
  const hex = /^#([0-9a-f]{3,8})$/.exec(s)
  if (hex) {
    const h = hex[1]
    if (h.length === 3 || h.length === 4) {
      const [r, g, b, a = "f"] = h.split("")
      return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16), a: parseInt(a + a, 16) / 255 }
    }
    if (h.length === 6 || h.length === 8)
      return {
        r: parseInt(h.slice(0, 2), 16),
        g: parseInt(h.slice(2, 4), 16),
        b: parseInt(h.slice(4, 6), 16),
        a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
      }
    return undefined
  }
  const fn = /^(rgba?|hsla?)\(\s*([^)]*)\)$/.exec(s)
  if (!fn) return undefined
  const parts = fn[2].split(/[\s,/]+/).filter(Boolean)
  if (parts.length < 3) return undefined
  const alpha = (p?: string) => (p == null ? 1 : p.endsWith("%") ? parseFloat(p) / 100 : parseFloat(p))
  if (fn[1].startsWith("rgb")) {
    const ch = (p: string) => (p.endsWith("%") ? (parseFloat(p) / 100) * 255 : parseFloat(p))
    const [r, g, b] = parts.slice(0, 3).map(ch)
    const a = alpha(parts[3])
    if ([r, g, b, a].some((n) => !Number.isFinite(n))) return undefined
    return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) }
  }
  const hue = parseFloat(parts[0])
  const sat = parseFloat(parts[1]) / 100
  const lig = parseFloat(parts[2]) / 100
  const a = alpha(parts[3])
  if ([hue, sat, lig, a].some((n) => !Number.isFinite(n))) return undefined
  const k = (n: number) => (n + hue / 30) % 12
  const f = (n: number) => lig - sat * Math.min(lig, 1 - lig) * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1))
  return { r: Math.round(f(0) * 255), g: Math.round(f(8) * 255), b: Math.round(f(4) * 255), a: clamp(a, 0, 1) }
}

/** A colour with alpha, laid over an opaque ground — what the eye actually sees. */
export function over(fg: Rgba, bg: Rgba): Rgba {
  return { r: fg.r * fg.a + bg.r * (1 - fg.a), g: fg.g * fg.a + bg.g * (1 - fg.a), b: fg.b * fg.a + bg.b * (1 - fg.a), a: 1 }
}

/** WCAG 2 relative luminance, 0 (black) … 1 (white). */
export function luminance(c: Rgba): number {
  const lin = (v: number) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  }
  return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b)
}

/** WCAG 2 contrast ratio, 1 … 21. A translucent foreground is laid over the ground first. */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const ground = bg.a < 1 ? over(bg, { r: 255, g: 255, b: 255, a: 1 }) : bg
  const a = luminance(fg.a < 1 ? over(fg, ground) : fg)
  const b = luminance(ground)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

export type Grade = { ratio: number; label: string; pass: boolean; tone: "good" | "warn" | "bad"; detail: string }

/** The label a person reads: body text needs 4.5:1, large text and marks 3:1 (WCAG 2 AA). */
export function grade(ratio: number): Grade {
  const r = Math.round(ratio * 100) / 100
  if (ratio >= 7) return { ratio: r, label: "Pass", pass: true, tone: "good", detail: "Readable at any size (AAA)" }
  if (ratio >= 4.5) return { ratio: r, label: "Pass", pass: true, tone: "good", detail: "Readable as body text (AA)" }
  if (ratio >= 3) return { ratio: r, label: "Large only", pass: false, tone: "warn", detail: "Only for large text, icons and borders — too faint for body text" }
  return { ratio: r, label: "Fail", pass: false, tone: "bad", detail: "Too faint to read on this ground" }
}

export const ratioText = (r: number) => `${(Math.floor(r * 10) / 10).toFixed(1)}:1`

const BG_NAMES = ["background", "bg", "ground", "page", "base"]
const SURFACE_NAMES = ["surface", "background-card", "card", "panel", "raise", "background-elevated", "surface-1"]

/**
 * The grounds a colour is checked against: the kit's own background and surface. A kit with
 * neither is checked on white and black, and the label says so.
 */
export function groundsOf(colors: { name: string; value: string }[]): { id: "background" | "surface"; name: string; value: string; rgba: Rgba }[] {
  const find = (names: string[]) => {
    for (const n of names) {
      const c = colors.find((x) => x.name.toLowerCase() === n)
      const rgba = c && parseColor(c.value)
      if (c && rgba) return { name: c.name, value: c.value, rgba }
    }
  }
  const bg = find(BG_NAMES)
  const sf = find(SURFACE_NAMES)
  if (!bg && !sf)
    return [
      { id: "background", name: "white", value: "#ffffff", rgba: { r: 255, g: 255, b: 255, a: 1 } },
      { id: "surface", name: "black", value: "#000000", rgba: { r: 0, g: 0, b: 0, a: 1 } },
    ]
  return [
    ...(bg ? [{ id: "background" as const, ...bg }] : []),
    ...(sf ? [{ id: "surface" as const, ...sf }] : []),
  ]
}

/** One colour against each ground — skipped against itself (background on background is not a check). */
export function contrastChecks(color: { name: string; value: string }, grounds: ReturnType<typeof groundsOf>) {
  const fg = parseColor(color.value)
  if (!fg) return []
  return grounds
    .filter((g) => g.name !== color.name)
    .map((g) => ({ ground: g, grade: grade(contrastRatio(fg, g.rgba)) }))
}

/** Black or white, whichever reads better on this colour — for labels drawn ON a swatch. */
export function inkFor(value: string): "#000000" | "#ffffff" {
  const c = parseColor(value)
  if (!c) return "#000000"
  const w = contrastRatio({ r: 255, g: 255, b: 255, a: 1 }, c)
  const k = contrastRatio({ r: 0, g: 0, b: 0, a: 1 }, c)
  return k >= w ? "#000000" : "#ffffff"
}

/** For the native colour input, which takes only #rrggbb. */
export function toHex6(value: string): string {
  const c = parseColor(value)
  if (!c) return "#000000"
  const h = (n: number) => Math.round(n).toString(16).padStart(2, "0")
  return `#${h(c.r)}${h(c.g)}${h(c.b)}`
}

// ── logos ────────────────────────────────────────────────────────────────────

export const TILES = {
  light: { id: "light" as const, label: "Light", value: "#ffffff", rgba: { r: 255, g: 255, b: 255, a: 1 } },
  dark: { id: "dark" as const, label: "Dark", value: "#0a0a0a", rgba: { r: 10, g: 10, b: 10, a: 1 } },
}

export type LogoSeen = { verdict: "visible" | "faint" | "invisible"; visible: number; opaque: boolean; tone: "good" | "warn" | "bad"; label: string }

/**
 * How much of a mark survives on a tile, from its pixels (RGBA, as a canvas returns them).
 * A pixel "survives" when, laid over the tile, it differs from the tile by at least 1.6:1 — the
 * point where a white mark on a near-white page stops being findable. An image that paints its own
 * background (no transparency to speak of) is always visible: it brings its own tile.
 */
export function logoVisibility(pixels: ArrayLike<number>, tile: Rgba): LogoSeen {
  let inked = 0
  let seen = 0
  let solid = 0
  const n = Math.floor(pixels.length / 4)
  for (let i = 0; i < n; i++) {
    const a = pixels[i * 4 + 3] / 255
    if (a >= 0.98) solid++
    if (a < 0.1) continue
    inked++
    const px = over({ r: pixels[i * 4], g: pixels[i * 4 + 1], b: pixels[i * 4 + 2], a }, tile)
    if (contrastRatio(px, tile) >= 1.6) seen++
  }
  if (n > 0 && solid / n > 0.97) return { verdict: "visible", visible: 1, opaque: true, tone: "good", label: "Visible — brings its own background" }
  if (inked === 0) return { verdict: "invisible", visible: 0, opaque: false, tone: "bad", label: "Invisible — the image is empty" }
  // Two ways to be findable: most of the mark stands out, or a fair share of the whole image does —
  // an icon whose dark plate vanishes on dark still shows its white glyph (the IRIS cube).
  const visible = seen / inked
  const area = n > 0 ? seen / n : 0
  if (visible >= 0.5 || area >= 0.12) return { verdict: "visible", visible, opaque: false, tone: "good", label: "Visible" }
  if (visible >= 0.15 || area >= 0.04) return { verdict: "faint", visible, opaque: false, tone: "warn", label: "Faint here" }
  return { verdict: "invisible", visible, opaque: false, tone: "bad", label: "Invisible here" }
}

/**
 * The logo a ground gets, from the DRAFT — through the #192664 resolver (iris-brand-logo.ts, a
 * synced copy), so the previews and warnings here pick exactly what every surface will pick.
 * `ground` is any colour; `tile`, when set, is painted behind the mark.
 */
export function draftLogoFor(draft: Draft, ground: string): ResolvedLogo | null {
  const logo = Object.fromEntries(LOGO_VARIANTS.map((v) => [v.id, draft.logos[v.id].trim()]).filter(([, u]) => u))
  const bg = draft.colors.find((c) => BG_NAMES.includes(c.name.toLowerCase()) && parseColor(c.value))
  const tokens = { brand: { logo }, ...(bg ? { colors: { background: { DEFAULT: toHex6(bg.value) } } } : {}) }
  return logoFor(tokens, /^(light|dark)$/.test(ground) ? ground : toHex6(ground))
}

// ── the draft ────────────────────────────────────────────────────────────────

export type Draft = {
  colors: BrandColor[]
  fonts: { role: string; family: string }[]
  typeScale: { role: string; value: string }[]
  logos: Record<LogoVariant, string>
  voice: string
  tone: string
  ease: string
  durationMs: string
  character: string
  stiffness: string
  damping: string
}

export function draftFromKit(kit: BrandKit): Draft {
  const logos = { primary: "", on_dark: "", on_light: "", icon: "", social: "" } as Record<LogoVariant, string>
  const read = kit.logos ?? (kit.logoUrl ? { primary: kit.logoUrl } : {})
  for (const v of LOGO_VARIANTS) logos[v.id] = read[v.id] ?? ""
  const m = kit.motion ?? {}
  const n = (x: number | undefined) => (x == null ? "" : String(x))
  return {
    colors: kit.colors.map((c) => ({ ...c, extra: { ...c.extra } })),
    fonts: kit.fonts.map((f) => ({ ...f })),
    typeScale: kit.typeScale.map((t) => ({ ...t })),
    logos,
    voice: kit.voice ?? "",
    tone: kit.tone ?? "",
    ease: m.ease ?? "",
    durationMs: n(m.durationMs),
    character: m.character ?? "",
    stiffness: n(m.stiffness),
    damping: n(m.damping),
  }
}

export type DiffLine = {
  /** The token section this line writes. */
  section: string
  /** Which editor tab owns it. */
  part: "colours" | "type" | "logos" | "voice" | "motion"
  label: string
  before?: string
  after?: string
  /** For a colour, so the confirm can draw both. */
  swatch?: boolean
}

const blank = (s: string | undefined) => (s ?? "").trim()

/** What a save would change, field by field, in the order the editor shows them. */
export function diffKit(kit: BrandKit, draft: Draft): DiffLine[] {
  const out: DiffLine[] = []
  const was = draftFromKit(kit)
  const fontSection = kit.fontSection ?? "typography"
  const add = (l: DiffLine) => {
    if (blank(l.before) !== blank(l.after)) out.push({ ...l, before: blank(l.before) || undefined, after: blank(l.after) || undefined })
  }
  for (const c of draft.colors) add({ section: "colors", part: "colours", label: c.name, before: was.colors.find((x) => x.name === c.name)?.value, after: c.value, swatch: true })
  for (const f of draft.fonts) add({ section: fontSection, part: "type", label: f.role, before: was.fonts.find((x) => x.role === f.role)?.family, after: f.family })
  for (const t of draft.typeScale) add({ section: "typography", part: "type", label: t.role, before: was.typeScale.find((x) => x.role === t.role)?.value, after: t.value })
  for (const v of LOGO_VARIANTS) add({ section: "brand", part: "logos", label: `logo · ${v.label.toLowerCase()}`, before: was.logos[v.id], after: draft.logos[v.id] })
  add({ section: "brand", part: "voice", label: "voice", before: was.voice, after: draft.voice })
  add({ section: "brand", part: "voice", label: "tone", before: was.tone, after: draft.tone })
  add({ section: "motion", part: "motion", label: "ease", before: was.ease, after: draft.ease })
  add({ section: "motion", part: "motion", label: "duration (ms)", before: was.durationMs, after: draft.durationMs })
  add({ section: "motion", part: "motion", label: "character", before: was.character, after: draft.character })
  add({ section: "motion", part: "motion", label: "spring stiffness", before: was.stiffness, after: draft.stiffness })
  add({ section: "motion", part: "motion", label: "spring damping", before: was.damping, after: draft.damping })
  return out
}

/** A problem with the draft that would make the save refuse — named, so it can be fixed first. */
export function draftProblems(draft: Draft): string[] {
  const out: string[] = []
  for (const c of draft.colors) if (!parseColor(c.value)) out.push(`${c.name}: "${c.value}" is not a colour (use #rrggbb, rgb() or hsl())`)
  for (const f of draft.fonts) if (!blank(f.family)) out.push(`${f.role}: a font stack cannot be empty`)
  for (const f of draft.fonts) if (/[;{}<>]/.test(f.family)) out.push(`${f.role}: a font stack cannot hold ; { } < or >`)
  for (const t of draft.typeScale) if (!blank(t.value)) out.push(`${t.role}: a size cannot be empty`)
  for (const v of LOGO_VARIANTS) {
    const u = blank(draft.logos[v.id])
    if (u && !/^https?:\/\/\S+$/i.test(u)) out.push(`logo ${v.label.toLowerCase()}: not an http(s) URL`)
  }
  const ms = blank(draft.durationMs)
  if (ms && !(Number(ms) >= 0 && Number(ms) <= 10000)) out.push("duration: a number of milliseconds, 0 to 10000")
  const e = blank(draft.ease)
  if (e && !isEase(e)) out.push(`ease: "${e}" is not an easing a browser accepts`)
  const st = blank(draft.stiffness)
  const dm = blank(draft.damping)
  if ((st || dm) && !(Number(st) > 0 && Number(dm) > 0)) out.push("spring: needs both stiffness and damping, each above 0")
  return out
}

export function isEase(s: string): boolean {
  return (
    /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(s) ||
    /^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/.test(s) ||
    /^steps\(\s*\d+\s*(,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.test(s)
  )
}

const parse = (s: string | undefined): any => {
  try {
    const v = JSON.parse(s ?? "null")
    return v && typeof v === "object" && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

/**
 * Every section's new whole value, built on the section AS READ, so keys the editor does not show
 * (colour shades, brand.urls, spacing inside typography…) are carried through untouched.
 */
export function sectionsFor(kit: BrandKit, draft: Draft): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  // colours
  const colors = parse(kit.sections.colors)
  for (const c of draft.colors) {
    const prev = colors[c.name]
    colors[c.name] = prev && typeof prev === "object" ? { ...prev, [c.key || "DEFAULT"]: c.value.trim() } : { ...c.extra, [c.key || "DEFAULT"]: c.value.trim() }
  }
  out.colors = colors
  // type: stacks go back to the section they came from; the scale always lives in typography
  const fontSection = kit.fontSection ?? "typography"
  const typography = parse(kit.sections.typography)
  for (const t of draft.typeScale) typography[t.role] = { ...(typeof typography[t.role] === "object" ? typography[t.role] : {}), family: t.value.trim() }
  if (fontSection === "typography") {
    for (const f of draft.fonts) typography[f.role] = { ...(typeof typography[f.role] === "object" ? typography[f.role] : {}), family: f.family.trim() }
  } else {
    const loose = parse(kit.sections[fontSection])
    for (const f of draft.fonts) {
      const prev = loose[f.role]
      if (prev && typeof prev === "object") {
        const key = ["DEFAULT", "default", "family"].find((k) => typeof prev[k] === "string") ?? "DEFAULT"
        loose[f.role] = { ...prev, [key]: f.family.trim() }
      } else loose[f.role] = f.family.trim()
    }
    out[fontSection] = loose
  }
  out.typography = typography
  // motion
  const motion = parse(kit.sections.motion)
  const setOr = (k: string, v: unknown) => (v === undefined ? delete motion[k] : (motion[k] = v))
  setOr("ease", blank(draft.ease) || undefined)
  setOr("duration_ms", blank(draft.durationMs) ? Number(draft.durationMs) : undefined)
  setOr("character", blank(draft.character) || undefined)
  setOr("spring", blank(draft.stiffness) && blank(draft.damping) ? { ...(motion.spring ?? {}), stiffness: Number(draft.stiffness), damping: Number(draft.damping) } : undefined)
  out.motion = motion
  // brand: logo variants in the #192664 shape, voice and tone
  const brand = parse(kit.sections.brand)
  const logo: Record<string, unknown> = brand.logo && typeof brand.logo === "object" ? { ...brand.logo } : typeof brand.logo === "string" ? { primary: brand.logo } : {}
  for (const v of LOGO_VARIANTS) {
    const u = blank(draft.logos[v.id])
    if (u) logo[v.id] = u
    else delete logo[v.id]
  }
  if (Object.keys(logo).length) brand.logo = logo
  else delete brand.logo
  for (const k of ["voice", "tone"] as const) {
    const t = blank(draft[k])
    if (t) brand[k] = draft[k].trim()
    else delete brand[k]
  }
  out.brand = brand
  return out
}

/** The save request: only the sections a diff line touches, each with the section as read. */
export function buildSave(kit: BrandKit, draft: Draft): { changes: Record<string, unknown>; expected: Record<string, string> } {
  const touched = [...new Set(diffKit(kit, draft).map((l) => l.section))]
  const all = sectionsFor(kit, draft)
  const changes: Record<string, unknown> = {}
  const expected: Record<string, string> = {}
  for (const s of touched) {
    changes[s] = all[s]
    expected[s] = kit.sections[s] ?? "null"
  }
  return { changes, expected }
}

/** The confirm, in plain words: what changes, and that every page using the kit changes with it. */
export function saveConfirm(kit: BrandKit, draft: Draft): { title: string; body: string[]; warn: string[] } {
  const lines = diffKit(kit, draft)
  const n = lines.length
  const name = kit.brand.name
  const body = [
    `This changes every page that uses ${name}. Genesis pages, campaign pages and renders that read the ${name} kit pick up the change the next time they load.`,
  ]
  const warn: string[] = []
  const grounds = groundsOf(draft.colors)
  for (const l of lines) {
    if (l.part !== "colours" || !l.after) continue
    for (const c of contrastChecks({ name: l.label, value: l.after }, grounds))
      if (!c.grade.pass) warn.push(`${l.label} on ${c.ground.name} is ${ratioText(c.grade.ratio)} — ${c.grade.label === "Fail" ? "too faint to read" : "large text only"}.`)
  }
  for (const v of LOGO_VARIANTS) if (lines.some((l) => l.label === `logo · ${v.label.toLowerCase()}` && !l.after)) warn.push(`The ${v.label.toLowerCase()} logo is removed.`)
  return { title: `Save ${n} ${n === 1 ? "change" : "changes"} to ${name}?`, body, warn }
}

// ── export ───────────────────────────────────────────────────────────────────

const cssName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
const cssSafe = (v: string) => v.replace(/[;{}<>\\]/g, "")

/** The kit as CSS custom properties. Values that are not a colour/stack/size are left out, never escaped in. */
export function exportCss(kit: BrandKit, draft: Draft): string {
  const lines = [`/* ${cssSafe(kit.brand.name)} — IRIS brand kit (${cssSafe(kit.brand.slug)}) */`, ":root {"]
  for (const c of draft.colors) if (parseColor(c.value)) lines.push(`  --color-${cssName(c.name)}: ${cssSafe(c.value.trim())};`)
  for (const f of draft.fonts) if (blank(f.family)) lines.push(`  --font-${cssName(f.role)}: ${cssSafe(f.family.trim())};`)
  for (const t of draft.typeScale) if (blank(t.value)) lines.push(`  --${cssName(t.role)}: ${cssSafe(t.value.trim())};`)
  if (blank(draft.ease) && isEase(draft.ease.trim())) lines.push(`  --ease: ${draft.ease.trim()};`)
  if (blank(draft.durationMs) && Number.isFinite(Number(draft.durationMs))) lines.push(`  --duration: ${Number(draft.durationMs)}ms;`)
  for (const v of LOGO_VARIANTS) {
    const u = blank(draft.logos[v.id])
    if (/^https?:\/\/\S+$/i.test(u)) lines.push(`  --logo-${cssName(v.id)}: url("${u.replace(/["\\\n]/g, "")}");`)
  }
  lines.push("}")
  return lines.join("\n")
}

/** The kit as design tokens — the sections this editor owns, the shape `iris brands dt push` sends. */
export function exportJson(kit: BrandKit, draft: Draft): string {
  const all = sectionsFor(kit, draft)
  const keep = ["colors", "typography", kit.fontSection && kit.fontSection !== "typography" ? kit.fontSection : "", "motion", "brand"].filter(Boolean)
  const out: Record<string, unknown> = {}
  for (const k of keep) if (all[k] && Object.keys(all[k] as object).length) out[k] = all[k]
  return JSON.stringify(out, null, 2) + "\n"
}

export const exportName = (kit: BrandKit, ext: "css" | "json") => `${cssName(kit.brand.slug || kit.brand.name) || "brand"}-tokens.${ext}`

// ── previews ────────────────────────────────────────────────────────────────

const pick = (colors: { name: string; value: string }[], names: string[]) => {
  for (const n of names) {
    const c = colors.find((x) => x.name.toLowerCase() === n && parseColor(x.value))
    if (c) return c.value.trim()
  }
}

/**
 * The kit's roles for the previews, by the names kits use, with a readable fallback for each.
 * These are the ONLY place the kit's colours touch the pane outside its swatches.
 */
export function previewRoles(draft: Draft) {
  const c = draft.colors
  const bg = pick(c, BG_NAMES) ?? "#ffffff"
  const surface = pick(c, SURFACE_NAMES) ?? bg
  const text = pick(c, ["text-primary", "text", "ink", "foreground", "fg"]) ?? inkFor(bg)
  const muted = pick(c, ["text-secondary", "text-muted", "muted", "body"]) ?? text
  const primary = pick(c, ["primary", "brand", "accent"]) ?? text
  const accent = pick(c, ["accent", "secondary", "primary"]) ?? primary
  const onPrimary = pick(c, ["text-on-primary", "on-primary"]) ?? inkFor(primary)
  const border = pick(c, ["border", "line", "border-light"]) ?? muted
  const body = draft.fonts.find((f) => !/mono|code/i.test(f.role))?.family ?? draft.fonts[0]?.family ?? "inherit"
  const mono = draft.fonts.find((f) => /mono|code/i.test(f.role))?.family ?? "ui-monospace, monospace"
  const display = draft.fonts.find((f) => /display|heading|head|title/i.test(f.role))?.family ?? body
  return { bg, surface, text, muted, primary, accent, onPrimary, border, body, mono, display }
}

/** The type scale's sizes, smallest first, for the specimen. Weights and line heights are not sizes. */
export function scaleSizes(scale: { role: string; value: string }[]): { role: string; value: string; px: number }[] {
  const px = (v: string) => {
    const m = /^([\d.]+)(px|rem|em)?$/.exec(v.trim())
    if (!m) return NaN
    return m[2] === "rem" || m[2] === "em" ? parseFloat(m[1]) * 16 : parseFloat(m[1])
  }
  return scale
    .filter((t) => /size|^text-|^h[1-6]$|display|body|caption/i.test(t.role) && !/weight|line|leading|tracking|letter/i.test(t.role))
    .map((t) => ({ ...t, px: px(t.value) }))
    .filter((t) => Number.isFinite(t.px) && t.px > 0 && t.px <= 160)
    .sort((a, b) => a.px - b.px)
}

/** The same three starting points `iris brands dt motion --character` offers (brand-contract.ts). */
export const MOTION_PRESETS = {
  snappy: { ease: "cubic-bezier(.2,.9,.3,1)", durationMs: 180, stiffness: 420, damping: 30 },
  smooth: { ease: "cubic-bezier(.45,0,.15,1)", durationMs: 320, stiffness: 170, damping: 26 },
  heavy: { ease: "cubic-bezier(.7,0,.2,1)", durationMs: 600, stiffness: 90, damping: 20 },
} as const

/** The control points of a cubic-bezier(), for drawing the curve. Keywords map to their CSS curves. */
export function bezierOf(ease: string): [number, number, number, number] | undefined {
  const named: Record<string, [number, number, number, number]> = {
    linear: [0, 0, 1, 1],
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
  }
  const s = ease.trim()
  if (named[s]) return named[s]
  const m = /^cubic-bezier\(([^)]*)\)$/.exec(s)
  if (!m) return undefined
  const n = m[1].split(",").map((x) => parseFloat(x))
  return n.length === 4 && n.every(Number.isFinite) ? (n as [number, number, number, number]) : undefined
}
