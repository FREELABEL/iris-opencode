// The brand contract — how one hand-written Genesis page becomes a template for any brand.
//
// rebrand used to swap composable-page fields only (theme.branding, nav, footer, contact). A
// bespoke HTML page — the house default lane — keeps its palette and type in its CSS, and nothing
// rewrote it, so our best pages could not be cloned for another brand (#188409). The fix is a
// contract, not a system:
//
//   1. A template declares its brand values in ONE marked block, using brand-neutral names:
//        /* brand-tokens:start */ :root { --brand-accent: …; --brand-font-display: …; } /* brand-tokens:end */
//      and the rest of its CSS reads only those, EVERY read with a fallback —
//      `var(--brand-radius, 6px)`, never a bare `var(--brand-radius)`. A brand may not define a key,
//      the replaced block then omits it, and a bare var() collapses (a radius-less brand rendered
//      square cards in the first test, 2026-10-07).
//   2. rebrand replaces that block with the target brand's values. `iris brands design-tokens
//      export <slug> --format css --prefix brand` prints exactly that block (#188413).
//
// IDENTITY comes from the brand (accents, fonts, radius). The GROUND — neutrals and semantic
// colours chosen for both themes — stays the template's own design decision: that is what keeps
// contrast and "semantic colour is not the accent" true after a rebrand. bg/ink/etc. are still
// exported for templates that deliberately opt in.

export const BRAND_BLOCK_START = "/* brand-tokens:start */"
export const BRAND_BLOCK_END = "/* brand-tokens:end */"

export const CONTRACT_KEYS = [
  "accent",
  "accent-2",
  "font-display",
  "font-body",
  "font-mono",
  "radius",
  "bg",
  "surface",
  "ink",
  "muted",
  "border",
  "ease",
  "duration",
] as const
export type ContractKey = (typeof CONTRACT_KEYS)[number]
export type BrandContract = Partial<Record<ContractKey, string>>

/**
 * A token value is written into a page's CSS, so it must not be able to close the declaration,
 * the rule, or the <style> element. Anything carrying ; { } < > \ or a newline is refused, not
 * escaped — a brand colour has no business containing them.
 */
export function safeCssValue(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined
  const s = v.trim()
  if (!s || s.length > 300) return undefined
  if (/[;{}<>\\\n\r]/.test(s)) return undefined
  return s
}

const isColor = (s: string) => /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|color\()/i.test(s)

/** colors.primary may be "#hex", { DEFAULT: "#hex" } or { 500: … }. Take DEFAULT, else the value. */
function color(colors: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const raw = colors[n]
    const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).DEFAULT : raw
    const s = safeCssValue(v)
    if (s && isColor(s)) return s
  }
  return undefined
}

/** Brands store fonts in three shapes today: heading/body objects, `font-family`, and `fontFamily`. */
function font(typo: Record<string, unknown>, ...names: string[]): string | undefined {
  for (const n of names) {
    const raw = typo[n]
    const v = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>).family : raw
    const s = safeCssValue(v)
    // Weight-only entries ("400") are not families.
    if (s && !/^\d+$/.test(s)) return s
  }
  return undefined
}

// ── Motion (#188412) ─────────────────────────────────────────────────────────────────────────
// A brand moves a certain way the same as it has a certain colour: two films or two pages for one
// brand should share an ease curve and a base duration. Stored as
//   design_tokens.motion = { character?, ease, duration_ms, spring: { stiffness, damping } }
// ease + duration reach pages through the contract (--brand-ease, --brand-duration); the spring is
// for code that animates with physics (the genesis-motion films), which reads it from the tokens.

export type BrandMotion = {
  character?: string
  ease?: string
  duration_ms?: number
  spring?: { stiffness: number; damping: number }
}

/** Three characters to start from. `smooth` is the genesis-motion default curve. */
export const MOTION_PRESETS: Record<"snappy" | "smooth" | "heavy", Required<Omit<BrandMotion, "character">>> = {
  snappy: { ease: "cubic-bezier(.2,.9,.3,1)", duration_ms: 180, spring: { stiffness: 420, damping: 30 } },
  smooth: { ease: "cubic-bezier(.45,0,.15,1)", duration_ms: 320, spring: { stiffness: 170, damping: 26 } },
  heavy: { ease: "cubic-bezier(.7,0,.2,1)", duration_ms: 600, spring: { stiffness: 90, damping: 20 } },
}

const EASE_KEYWORDS = new Set(["linear", "ease", "ease-in", "ease-out", "ease-in-out"])
const NUM = String.raw`\s*-?(?:\d+\.?\d*|\.\d+)\s*`

/** An easing a browser will accept: a keyword, cubic-bezier(x1,y1,x2,y2) with x in [0,1], or linear(…). */
export function safeEase(v: unknown): string | undefined {
  const s = safeCssValue(v)?.toLowerCase().replace(/\s+/g, " ")
  if (!s) return undefined
  if (EASE_KEYWORDS.has(s)) return s
  const cb = s.match(new RegExp(`^cubic-bezier\\((${NUM}),(${NUM}),(${NUM}),(${NUM})\\)$`))
  if (cb) {
    const [x1, , x2] = [Number(cb[1]), Number(cb[2]), Number(cb[3])]
    return x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1 ? s.replace(/\s+/g, "") : undefined
  }
  if (/^linear\(\s*[-\d.%\s,]+\)$/.test(s)) return s
  return undefined
}

/** 220, "220ms", "0.22s" → 220. Anything outside 0–10 s is refused. */
export function parseDurationMs(v: unknown): number | undefined {
  let n: number | undefined
  if (typeof v === "number") n = v
  else if (typeof v === "string") {
    const m = v.trim().match(/^(\d+\.?\d*|\.\d+)\s*(ms|s)?$/i)
    if (m) n = Number(m[1]) * (m[2]?.toLowerCase() === "s" ? 1000 : 1)
  }
  if (n === undefined || !Number.isFinite(n) || n < 0 || n > 10000) return undefined
  return Math.round(n)
}

/** Resolve a brand's stored design_tokens into the contract. Missing keys are reported, never guessed. */
export function brandContract(tokens: Record<string, unknown>): { values: BrandContract; missing: ContractKey[] } {
  const colors = (tokens.colors ?? {}) as Record<string, unknown>
  const typo = (tokens.typography ?? {}) as Record<string, unknown>
  const spacing = (tokens.spacing ?? {}) as Record<string, unknown>
  const radiusRaw = spacing["card-radius"] ?? spacing.radius ?? (tokens.radius as unknown) ??
    ((tokens.borderRadius as Record<string, unknown> | undefined)?.DEFAULT)

  const motion = (tokens.motion ?? {}) as Record<string, unknown>
  const ms = parseDurationMs(motion.duration_ms ?? motion.duration)

  const accent = color(colors, "primary", "accent")
  const values: BrandContract = {
    accent,
    "accent-2": color(colors, "secondary", "accent") ?? accent,
    "font-display": font(typo, "heading", "display", "font-family", "fontFamily", "family"),
    "font-body": font(typo, "body", "font-family", "fontFamily", "family"),
    "font-mono": font(typo, "mono", "font-mono", "fontMono"),
    radius: safeCssValue(radiusRaw),
    bg: color(colors, "background", "bg"),
    surface: color(colors, "surface", "card"),
    ink: color(colors, "text", "foreground", "ink"),
    muted: color(colors, "text-muted", "muted", "textMuted"),
    border: color(colors, "border"),
    ease: safeEase(motion.ease),
    duration: ms === undefined ? undefined : `${ms}ms`,
  }
  for (const k of CONTRACT_KEYS) if (values[k] === undefined) delete values[k]
  const missing = CONTRACT_KEYS.filter((k) => values[k] === undefined)
  return { values, missing }
}

/** The block a template carries, filled for one brand. Exactly what `export --prefix brand` prints. */
export function brandContractCss(values: BrandContract, label?: string): string {
  const lines = [`${BRAND_BLOCK_START}`]
  if (label) lines.push(`/* ${String(label).replace(/\*\//g, "")} */`)
  lines.push(":root {")
  for (const k of CONTRACT_KEYS) if (values[k] !== undefined) lines.push(`  --brand-${k}: ${values[k]};`)
  lines.push("}", BRAND_BLOCK_END)
  return lines.join("\n")
}

/**
 * Replace the marked block in a page's css or html. Returns how many blocks were replaced:
 * 0 means the page is not a template, and the caller must say so rather than claim a rebrand.
 */
export function applyBrandBlock(text: string, block: string): { text: string; replaced: number } {
  let replaced = 0
  const re = /\/\* brand-tokens:start \*\/[\s\S]*?\/\* brand-tokens:end \*\//g
  const out = text.replace(re, () => {
    replaced++
    return block
  })
  return { text: out, replaced }
}
