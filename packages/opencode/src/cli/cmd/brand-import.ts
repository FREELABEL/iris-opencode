// Design-token import from somewhere other than a hand-written CSS file (#188410, epic #188359).
//
//   iris brands dt import <slug> --url <client's own site>   static CSS the site already serves
//   iris brands dt import <slug> --design-md <file>          a DESIGN.md the person is licensed to use
//
// --url reads the stylesheets a site SERVES, not the styles a browser COMPUTES. That is a choice:
// the CLI is one binary on someone's laptop, and requiring a headless browser for an import adds a
// part that most imports do not need — modern sites keep their system in :root custom properties,
// which are right there in the CSS. A site that builds its styles in JavaScript at runtime yields
// little; the import says which contract keys it found and which it did not, and `--css` remains.
//
// It reads robots.txt first and stops if the path is disallowed. Onboarding a client's own site is
// the use; bulk-collecting other companies' identities is not, and this is not built for it.

import { safeCssValue } from "./brand-contract"

export type Tokens = Record<string, unknown>

// ── colour roles ──────────────────────────────────────────────────────────────────────────────

/** Colour names brandContract reads as roles. An UNMAPPED colour may not keep one of these names. */
const RESERVED = new Set(["primary", "accent", "secondary", "background", "bg", "surface", "card", "text", "foreground", "ink", "text-muted", "muted", "textmuted", "border"])

/**
 * Which contract role a colour's NAME claims. Ordered: the first rule that matches wins.
 * `primary-foreground` (shadcn: text ON the primary) is deliberately no role, and bare `muted`
 * (shadcn: a muted BACKGROUND) is not muted text.
 */
export function colorRole(name: string): string | undefined {
  const t = name.toLowerCase().replace(/^-+/, "").replace(/^(colors?|clr|c|brand-color)[-_.]/, "").split(/[-_.\s]+/).filter(Boolean)
  const has = (...w: string[]) => w.some((x) => t.includes(x))
  const onColor = has("foreground", "fg", "on", "contrast") && has("primary", "secondary", "accent", "brand", "destructive", "card", "popover")
  if (onColor) return undefined
  if (has("muted", "subtle", "secondary") && has("text", "foreground", "fg", "ink")) return "text-muted"
  if (has("border", "stroke", "divider", "outline")) return "border"
  if (has("surface", "card", "panel", "elevated")) return "surface"
  if (has("background", "bg", "canvas", "page") && !has("primary", "accent", "brand")) return "background"
  if (has("text", "foreground", "fg", "ink") && t.length <= 2) return "text"
  if (has("secondary")) return "secondary"
  if (t.length <= 2 && has("primary", "brand", "main") && !has("hover", "active", "light", "dark", "muted")) return "primary"
  if (t.length === 1 && t[0] === "accent") return "accent"
  return undefined
}

const HSL_TRIPLET = /^-?\d+(\.\d+)?(deg)?\s+\d+(\.\d+)?%\s+\d+(\.\d+)?%$/

/** A colour value, or undefined. shadcn's bare HSL triplets ("222 84% 5%") are wrapped in hsl(). */
export function asColor(v: string | undefined): string | undefined {
  const s = safeCssValue(v)
  if (!s) return undefined
  if (/^(#[0-9a-f]{3,8}|rgba?\(|hsla?\(|oklch\(|oklab\(|color\()/i.test(s)) return s
  if (HSL_TRIPLET.test(s)) return `hsl(${s})`
  return undefined
}

// ── CSS reading ───────────────────────────────────────────────────────────────────────────────

type Rule = { selector: string; decls: Record<string, string>; order: number }

/** Innermost rule blocks, in source order. Comments stripped first. Good enough for tokens; not a CSS parser. */
export function cssRules(css: string): Rule[] {
  const src = css.replace(/\/\*[\s\S]*?\*\//g, "")
  const out: Rule[] = []
  const re = /([^{}]+)\{([^{}]*)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const decls: Record<string, string> = {}
    for (const part of m[2].split(";")) {
      const i = part.indexOf(":")
      if (i < 0) continue
      const k = part.slice(0, i).trim().toLowerCase()
      const v = part.slice(i + 1).replace(/!important/i, "").trim()
      if (k && v && !(k in decls)) decls[k.startsWith("--") ? part.slice(0, i).trim() : k] = v
    }
    out.push({ selector: m[1].trim().replace(/^@[^]*?\s(?=\S+$)/, "").trim(), decls, order: out.length })
  }
  return out
}

const ROOTISH = /^(:root|html|:host|body|\*)(\s*,\s*(:root|html|:host|body|\*))*$/i

/** Custom properties declared on :root / html / body. The FIRST definition wins (later ones are usually dark-mode overrides). */
export function rootVars(rules: Rule[]): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const r of rules) {
    if (!ROOTISH.test(r.selector)) continue
    for (const [k, v] of Object.entries(r.decls)) if (k.startsWith("--") && !(k in vars)) vars[k] = v
  }
  return vars
}

/** var(--a, fallback) → its value, following references a few levels deep. */
export function resolveVar(v: string, vars: Record<string, string>, depth = 0): string {
  if (depth > 6) return v
  return v.replace(/var\(\s*(--[\w-]+)\s*(?:,\s*([^()]*(?:\([^()]*\))?[^()]*))?\)/g, (_, name: string, fb?: string) => {
    const hit = vars[name]
    if (hit !== undefined) return resolveVar(hit, vars, depth + 1)
    return fb !== undefined ? resolveVar(fb.trim(), vars, depth + 1) : `var(${name})`
  })
}

/** next/font and similar emit '__Inter_d65c78', '__Inter_Fallback_d65c78'. Keep the real family. */
export function cleanFontStack(stack: string, generic = "sans-serif"): string | undefined {
  const fams = stack
    .split(",")
    .map((f) => f.trim().replace(/^['"]|['"]$/g, ""))
    .filter((f) => f && !/_fallback_/i.test(f) && !/^var\(/.test(f) && !/emoji|symbol$/i.test(f))
    .map((f) => f.replace(/^__(.+?)_[0-9a-f]{5,8}$/i, "$1").replace(/_/g, " "))
  const uniq = [...new Set(fams)]
  if (!uniq.length) return undefined
  // Dropping a hashed fallback face can leave one family and nothing behind it.
  if (!uniq.some((f) => /^(serif|sans-serif|monospace|cursive|fantasy|system-ui|ui-[\w-]+)$/i.test(f))) uniq.push(generic)
  const out = uniq.map((f) => (/\s/.test(f) && !/^(ui-|system-ui|-apple-system)/.test(f) ? `"${f}"` : f)).join(", ")
  return safeCssValue(out)
}

function hexRgb(c: string): [number, number, number] | undefined {
  let m = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})([0-9a-f]{2})?$/i)
  if (m) {
    const h = m[1].length === 3 ? m[1].split("").map((x) => x + x).join("") : m[1]
    return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number]
  }
  m = c.match(/^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined
}

/** HSL saturation of a hex/rgb colour, 0–1; undefined for formats we cannot measure. */
export function saturation(c: string): number | undefined {
  const rgb = hexRgb(c)
  if (!rgb) return undefined
  const [r, g, b] = rgb.map((x) => x / 255)
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  if (max === min) return 0
  return (max - min) / (1 - Math.abs(2 * l - 1))
}

/** How far from grey a colour is, 0–1 (max−min channel). Near-black and near-white read as neutral. */
export function chroma(c: string): number | undefined {
  const rgb = hexRgb(c)
  if (rgb) return (Math.max(...rgb) - Math.min(...rgb)) / 255
  const h = c.match(/^hsla?\(\s*[-\d.]+(?:deg)?[\s,]+([\d.]+)%[\s,]+([\d.]+)%/i)
  if (h) {
    const sat = Number(h[1]) / 100
    const l = Number(h[2]) / 100
    return sat * (1 - Math.abs(2 * l - 1))
  }
  return undefined
}

const isNeutral = (c: string) => (chroma(c) ?? 1) < 0.08

function mostCommon(values: string[]): string | undefined {
  const n = new Map<string, number>()
  for (const v of values) n.set(v, (n.get(v) ?? 0) + 1)
  return [...n.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

// ── site → tokens ─────────────────────────────────────────────────────────────────────────────

/**
 * Tokens from a site's HTML and the stylesheets it links. Each value is taken from the most
 * explicit source available: a custom property whose NAME states the role, then the rule that
 * styles the element (body background, h1 font), then frequency across the CSS.
 */
export function siteTokens(html: string, sheets: string[]): Tokens {
  return siteImport(html, sheets).tokens
}

const TAILWIND_EASE = "cubic-bezier(.4,0,.2,1)"

/** siteTokens, plus what a person should know before trusting the result. */
export function siteImport(html: string, sheets: string[]): { tokens: Tokens; notes: string[] } {
  const notes: string[] = []
  const inline = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1])
  const rules = cssRules([...sheets, ...inline].join("\n"))
  const vars = rootVars(rules)
  const val = (v: string) => resolveVar(v, vars).trim()
  const sel = (re: RegExp) => rules.filter((r) => re.test(r.selector))

  const colors: Record<string, string> = {}
  for (const [name, raw] of Object.entries(vars)) {
    const c = asColor(val(raw))
    if (!c) continue
    const role = colorRole(name)
    // A grey "secondary" or "accent" is a component background (shadcn), not a second brand colour.
    if (role && (role === "secondary" || role === "accent") && isNeutral(c)) continue
    if (role && !(role in colors)) colors[role] = c
  }

  const firstDecl = (selRe: RegExp, ...props: string[]) => {
    for (const r of sel(selRe)) for (const p of props) if (r.decls[p]) return val(r.decls[p])
    return undefined
  }
  if (!colors.background) {
    const bg = asColor(firstDecl(/^(html|body)$/i, "background-color", "background")?.split(/\s+/)[0])
    if (bg) colors.background = bg
  }
  if (!colors.text) {
    const ink = asColor(firstDecl(/^(html|body)$/i, "color"))
    if (ink) colors.text = ink
  }
  if (!colors.primary) {
    const meta = html.match(/<meta[^>]+name=["']theme-color["'][^>]*content=["']([^"']+)["']/i)?.[1] ??
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]*name=["']theme-color["']/i)?.[1]
    const m = asColor(meta)
    if (m && (saturation(m) ?? 0) > 0.25) colors.primary = m
  }
  if (!colors.primary) {
    // The most-used SATURATED colour on buttons, links and fills is the accent more often than not.
    const seen: string[] = []
    for (const r of rules)
      for (const p of ["background-color", "background", "color", "border-color", "fill"]) {
        const v = r.decls[p] && val(r.decls[p])
        const c = v?.match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/i)?.[0]
        if (c && (saturation(c) ?? 0) > 0.35) seen.push(c.toLowerCase())
      }
    const top = mostCommon(seen)
    if (top) colors.primary = top
  }

  if (colors.primary && isNeutral(colors.primary)) {
    // The site's own default is grey/black. Saturated primaries under theme classes are listed,
    // not picked: choosing one would be a guess about which theme is the brand.
    const alts = new Set<string>()
    for (const r of rules) {
      if (ROOTISH.test(r.selector)) continue
      for (const [k, v] of Object.entries(r.decls)) {
        if (colorRole(k) !== "primary") continue
        const c = asColor(val(v))
        if (c && !isNeutral(c)) alts.add(c)
      }
    }
    notes.push(
      `accent is neutral (${colors.primary}) — that is what this site's :root declares.` +
        (alts.size ? ` Saturated primaries under theme classes: ${[...alts].slice(0, 5).join(", ")}. Set one with dt set if that is the brand.` : ""),
    )
  }

  const typography: Record<string, { family: string }> = {}
  const fontVar = (re: RegExp, generic?: string) => {
    const k = Object.keys(vars).find((n) => re.test(n) && !/-(weight|size|feature|variation)/.test(n))
    return k ? cleanFontStack(val(vars[k]), generic) : undefined
  }
  // A heading rule may be namespaced (".page h1"): any selector in the list ending in h1 counts.
  const H1 = /(^|[\s>+~,])h1\s*(,|$)/i
  const families = rules
    .map((r) => r.decls["font-family"] && val(r.decls["font-family"]))
    .filter((f): f is string => !!f && !/inherit|initial|unset/i.test(f) && !/mono|code|courier/i.test(f))
  const body = fontVar(/^--(brand-)?(font-)?(sans|body|text|base)(-font)?(-family)?$/i) ??
    cleanFontStack(firstDecl(/^(html|body)$/i, "font-family") ?? "") ??
    // No body rule: the stack most declarations use is the text face.
    cleanFontStack(mostCommon(families) ?? "")
  const display = fontVar(/^--(brand-)?(font-)?(display|heading|headline|title)(-font)?(-family)?$/i) ??
    cleanFontStack(firstDecl(H1, "font-family") ?? "")
  const mono = fontVar(/^--(brand-)?(font-)?(mono|code)(-font)?(-family)?$/i, "monospace") ??
    cleanFontStack(rules.map((r) => r.decls["font-family"]).find((f) => f && /mono|code|courier/i.test(f)) ?? "", "monospace")
  if (display) typography.heading = { family: display }
  if (body) typography.body = { family: body }
  if (mono) typography.mono = { family: mono }

  const radiusVar = [/^--(radius|border-radius|rounded)$/i, /^--(radius|border-radius|rounded)-(default|base|md)$/i]
    .map((re) => Object.keys(vars).find((n) => re.test(n)))
    .find(Boolean)
  let radius = radiusVar ? safeCssValue(val(vars[radiusVar])) : undefined
  if (!radius) {
    const rs = rules
      .map((r) => r.decls["border-radius"] && val(r.decls["border-radius"]))
      .filter((v): v is string => !!v && /^\d+(\.\d+)?(px|rem|em)$/.test(v) && parseFloat(v) > 0 && !(v.endsWith("px") && parseFloat(v) >= 40))
    radius = mostCommon(rs)
  }

  const motion = siteMotion(rules, vars)
  if (motion?.ease === TAILWIND_EASE) notes.push("motion is Tailwind's default curve — this site has not chosen its own; consider dt motion --character")

  const tokens: Tokens = {}
  if (Object.keys(colors).length) tokens.colors = colors
  if (Object.keys(typography).length) tokens.typography = typography
  if (radius) tokens.spacing = { radius }
  if (motion) tokens.motion = motion
  return { tokens, notes }
}

function siteMotion(rules: Rule[], vars: Record<string, string>): Record<string, unknown> | undefined {
  const val = (v: string) => resolveVar(v, vars)
  // Named in order of how clearly they state THE brand's motion. --ease-in alone never: it is an
  // entrance curve, and Tailwind defines it on every site.
  const pick = (res: RegExp[], ok: (v: string) => boolean) => {
    for (const re of res) {
      const hit = Object.entries(vars).find(([n, v]) => re.test(n) && ok(val(v)))
      if (hit) return hit
    }
    return undefined
  }
  const easeVar = pick(
    [/^--(brand-|motion-)?(ease|easing)(-(default|standard|base))?$/i, /^--default-transition-timing-function$/i, /^--ease-in-out$/i, /^--ease-out$/i],
    (v) => /cubic-bezier/i.test(v),
  )
  const durVar = pick(
    [/^--(brand-|motion-)?(duration|dur)(-(default|standard|base|normal))?$/i, /^--default-transition-duration$/i],
    (v) => /^\s*[\d.]+m?s\s*$/i.test(v),
  )
  const eases: string[] = []
  const durs: string[] = []
  for (const r of rules)
    for (const p of ["transition", "transition-timing-function", "transition-duration", "animation-timing-function"]) {
      const v = r.decls[p] && val(r.decls[p])
      if (!v) continue
      const e = v.match(/cubic-bezier\([^)]*\)/i)?.[0]
      if (e) eases.push(e.replace(/\s+/g, ""))
      const d = v.match(/(^|\s)(\d*\.?\d+m?s)\b/i)?.[2]
      if (d) durs.push(d)
    }
  const ease = easeVar ? val(easeVar[1]).match(/cubic-bezier\([^)]*\)/i)?.[0] : mostCommon(eases)
  const dur = durVar ? val(durVar[1]).trim() : mostCommon(durs)
  const out: Record<string, unknown> = {}
  if (ease) out.ease = ease.replace(/\s+/g, "")
  if (dur) {
    const ms = /ms$/i.test(dur) ? parseFloat(dur) : parseFloat(dur) * 1000
    if (Number.isFinite(ms) && ms > 0 && ms <= 10000) out.duration_ms = Math.round(ms)
  }
  return Object.keys(out).length ? out : undefined
}

// ── DESIGN.md → tokens ────────────────────────────────────────────────────────────────────────

/**
 * A DESIGN.md is a design system written for a model to read: YAML front matter carrying tokens
 * (colors, typography, rounded, spacing, components) and prose below it. Front matter is read
 * when present; otherwise the markdown is scanned for named colours and font families. Token
 * references like "{colors.primary}" are resolved.
 */
export function parseDesignMd(text: string, yamlParse: (s: string) => unknown = defaultYaml): Tokens {
  const fm = text.match(/^﻿?---\s*\n([\s\S]*?)\n---\s*(\n|$)/)
  if (fm) {
    let data: any
    try {
      data = yamlParse(fm[1])
    } catch {
      data = undefined
    }
    if (data && typeof data === "object") {
      const t = frontMatterTokens(data)
      if (Object.keys(t).length) return t
    }
  }
  return proseTokens(fm ? text.slice(fm[0].length) : text)
}

function defaultYaml(s: string): unknown {
  const Y = (globalThis as any).Bun?.YAML
  if (!Y) throw new Error("no YAML parser available")
  return Y.parse(s)
}

function frontMatterTokens(data: Record<string, any>): Tokens {
  const ref = (v: unknown): unknown => {
    if (typeof v !== "string") return v
    const m = v.match(/^\{([\w.-]+)\}$/)
    if (!m) return v
    return m[1].split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), data)
  }
  const tokens: Tokens = {}

  const colors: Record<string, string> = {}
  const src = data.colors ?? data.color ?? {}
  if (src && typeof src === "object") {
    for (const [name, raw] of Object.entries(src)) {
      const v = ref(typeof raw === "object" && raw ? ((raw as any).value ?? (raw as any).DEFAULT ?? (raw as any).hex) : raw)
      const c = asColor(typeof v === "string" ? v : undefined)
      if (!c) continue
      const role = colorRole(name)
      if (role) {
        if (!(role in colors)) colors[role] = c
      } else if (!RESERVED.has(name.toLowerCase())) colors[name] = c
    }
  }
  if (Object.keys(colors).length) tokens.colors = colors

  const typography: Record<string, { family: string }> = {}
  const typo = data.typography ?? data.fonts ?? {}
  if (typo && typeof typo === "object") {
    for (const [name, raw] of Object.entries(typo)) {
      const fam = ref(typeof raw === "object" && raw ? ((raw as any).fontFamily ?? (raw as any).family ?? (raw as any)["font-family"]) : raw)
      const stack = typeof fam === "string" ? cleanFontStack(fam, /mono|code/i.test(name) ? "monospace" : "sans-serif") : undefined
      if (!stack) continue
      const n = name.toLowerCase()
      const role = /mono|code/.test(n) || /mono/i.test(stack) ? "mono"
        : /display|headline|heading|title|^h[1-3]$/.test(n) ? "heading"
        : /body|text|paragraph|base|label/.test(n) ? "body" : undefined
      if (role && !typography[role]) typography[role] = { family: stack }
    }
  }
  if (Object.keys(typography).length) tokens.typography = typography

  const rounded = data.rounded ?? data.radius ?? data.radii ?? data.borderRadius
  const r = typeof rounded === "object" && rounded
    ? (rounded.md ?? rounded.DEFAULT ?? rounded.default ?? rounded.base ?? Object.values(rounded)[0])
    : rounded
  const radius = safeCssValue(typeof r === "number" ? `${r}px` : r)
  if (radius) tokens.spacing = { radius }

  const mo = data.motion ?? data.animation
  if (mo && typeof mo === "object") {
    const out: Record<string, unknown> = {}
    const e = ref(mo.ease ?? mo.easing)
    if (typeof e === "string") out.ease = e
    const d = mo.duration_ms ?? mo.duration
    if (d !== undefined) out.duration_ms = d
    if (mo.spring && typeof mo.spring === "object") out.spring = mo.spring
    if (Object.keys(out).length) tokens.motion = out
  }
  return tokens
}

/** No front matter: named colours ("Primary — #2B59FF", "| Background | `#fafaf7` |") and font families. */
function proseTokens(md: string): Tokens {
  const colors: Record<string, string> = {}
  for (const line of md.split(/\r?\n/)) {
    const hex = line.match(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/i)?.[0]
    if (!hex) continue
    const label = line
      .slice(0, line.indexOf(hex))
      .replace(/[`*_|>#\[\]()]/g, " ")
      .replace(/[:=—–-]+\s*$/, "")
      .trim()
      .toLowerCase()
    if (!label) continue
    const role = colorRole(label.replace(/\s+/g, "-"))
    if (role && !(role in colors)) colors[role] = hex
  }
  const typography: Record<string, { family: string }> = {}
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/(?:font[- ]?family|typeface|font)\s*[:=—–-]\s*([^\n|;]+)/i)
    if (!m) continue
    m[1] = m[1].replace(/[`*]/g, "")
    const role = /mono|code/i.test(line) ? "mono" : /display|head|title/i.test(line) ? "heading" : "body"
    const stack = cleanFontStack(m[1], role === "mono" ? "monospace" : "sans-serif")
    if (!stack) continue
    if (!typography[role]) typography[role] = { family: stack }
  }
  const tokens: Tokens = {}
  if (Object.keys(colors).length) tokens.colors = colors
  if (Object.keys(typography).length) tokens.typography = typography
  const radius = md.match(/radius[^\n\d]{0,20}(\d+(\.\d+)?(px|rem))/i)?.[1]
  if (radius) tokens.spacing = { radius }
  return tokens
}

// ── fetching a site, politely ─────────────────────────────────────────────────────────────────

export const IMPORT_UA = "IRIS-BrandImport/1.0 (+https://heyiris.io)"

/** Is `path` allowed for us by this robots.txt? Groups for our agent win over `*`; longest match wins. */
export function robotsAllows(robots: string, path: string, agent = "iris-brandimport"): boolean {
  const groups: { agents: string[]; rules: { allow: boolean; path: string }[] }[] = []
  let cur: (typeof groups)[number] | undefined
  let lastWasAgent = false
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim()
    const m = line.match(/^([\w-]+)\s*:\s*(.*)$/)
    if (!m) continue
    const key = m[1].toLowerCase()
    const v = m[2].trim()
    if (key === "user-agent") {
      if (!cur || !lastWasAgent) groups.push((cur = { agents: [], rules: [] }))
      cur.agents.push(v.toLowerCase())
      lastWasAgent = true
    } else {
      lastWasAgent = false
      if (cur && (key === "allow" || key === "disallow") && v) cur.rules.push({ allow: key === "allow", path: v })
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)))
  const pick = mine.length ? mine : groups.filter((g) => g.agents.includes("*"))
  let best: { allow: boolean; len: number } | undefined
  for (const g of pick)
    for (const r of g.rules) {
      const re = new RegExp("^" + r.path.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$"))
      if (re.test(path) && (!best || r.path.length > best.len || (r.path.length === best.len && r.allow)))
        best = { allow: r.allow, len: r.path.length }
    }
  return best ? best.allow : true
}

type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

async function text(f: Fetcher, url: string, max: number): Promise<{ ok: boolean; status: number; body: string; url: string }> {
  const res = await f(url, { headers: { "User-Agent": IMPORT_UA, Accept: "text/html,text/css,*/*" }, redirect: "follow", signal: AbortSignal.timeout(15000) })
  const body = res.ok ? (await res.text()).slice(0, max) : ""
  return { ok: res.ok, status: res.status, body, url: res.url || url }
}

/** The page and up to 10 stylesheets it links. Throws when robots.txt disallows or the page will not load. */
export async function fetchSite(target: string, f: Fetcher = fetch): Promise<{ url: string; html: string; sheets: string[]; notes: string[] }> {
  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(target) ? target : `https://${target}`)
  } catch {
    throw new Error(`not a URL: ${target}`)
  }
  if (!/^https?:$/.test(u.protocol)) throw new Error("only http(s) URLs")
  const notes: string[] = []

  const robots = await text(f, `${u.origin}/robots.txt`, 200_000).catch(() => undefined)
  if (robots?.ok && !robotsAllows(robots.body, u.pathname || "/"))
    throw new Error(`${u.origin}/robots.txt disallows ${u.pathname} — import from a CSS file instead (--css)`)

  const page = await text(f, u.toString(), 3_000_000)
  if (!page.ok) throw new Error(`${u} returned HTTP ${page.status}`)

  const hrefs = [...page.body.matchAll(/<link\b[^>]*>/gi)]
    .map((m) => m[0])
    .filter((tag) => /rel=["']?[^"'>]*stylesheet/i.test(tag))
    .map((tag) => tag.match(/href=["']([^"']+)["']/i)?.[1])
    .filter((h): h is string => !!h)
  const sheets: string[] = []
  for (const h of hrefs.slice(0, 10)) {
    try {
      const s = await text(f, new URL(h, page.url).toString(), 2_000_000)
      if (s.ok) sheets.push(s.body)
      else notes.push(`stylesheet ${h}: HTTP ${s.status}`)
    } catch (e) {
      notes.push(`stylesheet ${h}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  if (hrefs.length > 10) notes.push(`${hrefs.length - 10} more stylesheet(s) not read`)
  return { url: page.url, html: page.body, sheets, notes }
}
