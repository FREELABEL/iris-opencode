/**
 * Genesis › Brand kits (#188816) — the desktop's read and write path to a brand's design tokens.
 *
 * A BRAND KIT is what fl-api stores at `brands.metadata.design_tokens`: colours, type, logo and
 * motion, plus the brand's voice personas. The platform already serves all of it (BrandController,
 * owner-scoped — you see and edit only your own brands); this module is the desktop's proxy.
 *
 * SAVES ARE PINNED to what was read. fl-api's PATCH design-tokens has no version check and
 * replaces a whole section, so two windows editing colours would silently keep only the last one.
 * The pane sends the section exactly as it read it; we re-read before writing and refuse when it
 * moved — the same rule the page editor follows (savePageDoc), for the same reason.
 */
import { FL_API, irisFetch, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/** The sections the pane may write. Logos are files and personas are their own resource. */
export const EDITABLE_SECTIONS = ["colors", "typography", "motion"] as const
export type EditableSection = (typeof EDITABLE_SECTIONS)[number]

export interface BrandSummary {
  id: number
  name: string
  slug: string
  status: string
  entityType?: string
  /** Up to six colours, in stored order, for the list row. */
  swatches: { name: string; value: string }[]
  logoUrl?: string
  updatedAt?: string
}

export interface BrandColor {
  name: string
  value: string
  /**
   * Which key holds the value. Both spellings are live in the data (2026-10-09): fl-api's
   * normaliser and the IRIS kit use `DEFAULT`; `iris brands dt import --css` writes `default`.
   * A save writes back under the SAME key, so a colour never ends up holding two values.
   */
  key: string
  /** Every other key the token carries (light/dark/variants) — kept so a save cannot drop them. */
  extra: Record<string, unknown>
}

export interface BrandKit {
  brand: { id: number; name: string; slug: string; status: string; description?: string }
  colors: BrandColor[]
  /** Font stacks only. Sizes and weights that some brands file under typography are in `typeScale`. */
  fonts: { role: string; family: string }[]
  typeScale: { role: string; value: string }[]
  logoUrl?: string
  motion?: { ease?: string; durationMs?: number; character?: string }
  personas: { name: string; isDefault: boolean; tone?: string }[]
  /** Each editable section exactly as read, serialised — echo it back on save. */
  sections: Record<EditableSection, string>
}

/**
 * Mirror of fl-api DesignTokenNormalizer::normalize — flat legacy values become nested ones.
 * Exported for tests: the pane must read old flat kits and new nested ones identically.
 */
export function normalizeTokens(raw: unknown): Record<string, any> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {}
  const t: Record<string, any> = JSON.parse(JSON.stringify(raw))
  if (t.colors && typeof t.colors === "object") {
    for (const [k, v] of Object.entries(t.colors)) if (typeof v === "string") t.colors[k] = { DEFAULT: v }
  }
  if (t.typography && typeof t.typography === "object") {
    for (const [k, v] of Object.entries(t.typography)) if (typeof v === "string") t.typography[k] = { family: v }
  }
  if (!t.logos && t.logo) {
    const logo = typeof t.logo === "string" ? { url: t.logo } : t.logo
    if (logo && typeof logo === "object" && logo.url) t.logos = { primary: logo }
  }
  return t
}

/** A CSS colour we can draw: hex, rgb(a), hsl(a). Anything else is shown as text, never a swatch. */
export function isDrawableColor(v: unknown): v is string {
  return typeof v === "string" && /^(#[0-9a-f]{3,8}|rgba?\(|hsla?\()/i.test(v.trim())
}

/** A font stack, as opposed to a size/weight/line-height someone filed under typography. */
export function isFontStack(v: unknown): v is string {
  if (typeof v !== "string") return false
  const s = v.trim()
  if (/^[\d.]+(px|rem|em|%)?$/i.test(s) || /^-?[\d.]+(px|rem|em)$/i.test(s)) return false
  return /[a-z]/i.test(s)
}

function colorsOf(tokens: Record<string, any>): BrandColor[] {
  const out: BrandColor[] = []
  for (const [name, v] of Object.entries(tokens.colors ?? {})) {
    const obj = v && typeof v === "object" ? (v as Record<string, unknown>) : { DEFAULT: v }
    const key = ["DEFAULT", "default", "value"].find((k) => typeof obj[k] === "string")
    if (!key) continue
    const { [key]: value, ...extra } = obj
    out.push({ name, value: value as string, key, extra })
  }
  return out
}

function summaryOf(r: any): BrandSummary {
  const tokens = normalizeTokens(r?.metadata?.design_tokens)
  return {
    id: Number(r.id),
    name: String(r.name ?? r.slug ?? "unnamed"),
    slug: String(r.slug ?? ""),
    status: String(r.status ?? "active"),
    entityType: typeof r.entity_type === "string" ? r.entity_type : undefined,
    swatches: colorsOf(tokens)
      .filter((c) => isDrawableColor(c.value))
      .slice(0, 6)
      .map((c) => ({ name: c.name, value: c.value })),
    logoUrl: typeof tokens.logos?.primary?.url === "string" ? tokens.logos.primary.url : undefined,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
  }
}

export function kitOf(brand: any, rawTokens: unknown): BrandKit {
  const tokens = normalizeTokens(rawTokens)
  const fonts: BrandKit["fonts"] = []
  const typeScale: BrandKit["typeScale"] = []
  for (const [role, v] of Object.entries(tokens.typography ?? {})) {
    const family = (v as any)?.family
    if (isFontStack(family)) fonts.push({ role, family })
    else if (family != null) typeScale.push({ role, value: String(family) })
  }
  const m = tokens.motion && typeof tokens.motion === "object" ? tokens.motion : undefined
  const personas = Array.isArray(brand?.personas) ? brand.personas : []
  return {
    brand: {
      id: Number(brand.id),
      name: String(brand.name ?? brand.slug ?? "unnamed"),
      slug: String(brand.slug ?? ""),
      status: String(brand.status ?? "active"),
      description: typeof brand.description === "string" && brand.description ? brand.description : undefined,
    },
    colors: colorsOf(tokens),
    fonts,
    typeScale,
    logoUrl: typeof tokens.logos?.primary?.url === "string" ? tokens.logos.primary.url : undefined,
    motion: m
      ? {
          ease: typeof m.ease === "string" ? m.ease : undefined,
          durationMs: typeof m.duration_ms === "number" ? m.duration_ms : undefined,
          character: typeof m.character === "string" ? m.character : undefined,
        }
      : undefined,
    personas: personas.map((p: any) => ({
      name: String(p.name ?? p.persona_name ?? "persona"),
      isDefault: Boolean(p.is_default),
      tone: typeof p.tone === "string" ? p.tone : typeof p.voice === "string" ? p.voice : undefined,
    })),
    sections: Object.fromEntries(EDITABLE_SECTIONS.map((s) => [s, JSON.stringify(tokens[s] ?? null)])) as Record<
      EditableSection,
      string
    >,
  }
}

export async function fetchBrands(): Promise<PlatformResult<{ brands: BrandSummary[] }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { brands: [] } }
  try {
    const res = await irisFetch(`/api/v1/brands?per_page=100`)
    if (!res.ok) return { measured: false, reason: `fl-api ${res.status}`, data: { brands: [] } }
    const json = (await res.json()) as any
    // successResponse(paginate()) → { data: { data: [...] } }; tolerate a bare list too.
    const rows = Array.isArray(json?.data?.data) ? json.data.data : Array.isArray(json?.data) ? json.data : []
    return { measured: true, data: { brands: rows.map(summaryOf) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { brands: [] } }
  }
}

export async function fetchBrandKit(id: number): Promise<PlatformResult<{ kit?: BrandKit }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: {} }
  try {
    const [b, t] = await Promise.all([
      irisFetch(`/api/v1/brands/${id}`),
      irisFetch(`/api/v1/brands/${id}/design-tokens`),
    ])
    if (!b.ok) return { measured: false, reason: b.status === 404 ? "no such brand on your account" : `fl-api ${b.status}`, data: {} }
    if (!t.ok) return { measured: false, reason: `design tokens: fl-api ${t.status}`, data: {} }
    const brand = ((await b.json()) as any)?.data
    const tokens = ((await t.json()) as any)?.data
    return { measured: true, data: { kit: kitOf(brand, tokens) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: {} }
  }
}

/**
 * Validate a section before it is sent. fl-api accepts any JSON here and the page that reads the
 * kit then renders garbage; refusing at the desktop names the problem while the person can fix it.
 */
export function sectionProblem(section: string, value: unknown): string | null {
  if (!(EDITABLE_SECTIONS as readonly string[]).includes(section)) return `"${section}" is not editable here`
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${section} must be an object`
  if (section === "colors") {
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      const d = v && typeof v === "object" ? (v.DEFAULT ?? v.default ?? v.value) : v
      if (!isDrawableColor(d)) return `colour "${k}" is not a hex, rgb() or hsl() value: ${JSON.stringify(d)}`
    }
  }
  if (section === "typography") {
    for (const [k, v] of Object.entries(value as Record<string, any>)) {
      const f = v && typeof v === "object" ? v.family : v
      if (typeof f !== "string" || !f.trim()) return `type role "${k}" has no value`
    }
  }
  return null
}

export async function saveBrandSection(input: {
  id: number
  section: string
  value: unknown
  /** The section as the pane read it (BrandKit.sections[section]). */
  expected: string
}): Promise<{ ok: boolean; reason?: string; kit?: BrandKit }> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  const problem = sectionProblem(input.section, input.value)
  if (problem) return { ok: false, reason: problem }
  try {
    const now = await irisFetch(`/api/v1/brands/${input.id}/design-tokens`)
    if (!now.ok) return { ok: false, reason: now.status === 404 ? "no such brand on your account" : `fl-api ${now.status}` }
    const current = normalizeTokens(((await now.json()) as any)?.data)
    if (JSON.stringify(current[input.section] ?? null) !== input.expected) {
      return { ok: false, reason: `the ${input.section} changed since you opened this kit — reload before saving` }
    }
    const res = await irisFetch(`/api/v1/brands/${input.id}/design-tokens`, FL_API, {
      method: "PATCH",
      body: JSON.stringify({ [input.section]: input.value }),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: String(j?.message ?? `fl-api ${res.status}`) }
    // Read back, so the pane shows what the server holds rather than what we hoped we sent.
    const again = await fetchBrandKit(input.id)
    return again.measured ? { ok: true, kit: again.data.kit } : { ok: true, reason: `saved; reload failed: ${again.reason}` }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The kit as CSS custom properties — what "Use" hands the agent, and what a page pastes in.
 * Names are sanitised to [a-z0-9-]; values are emitted only when they are drawable/a stack, so a
 * token value can never close the declaration and inject CSS.
 */
export function kitToCss(kit: BrandKit): string {
  const name = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "")
  const safe = (v: string) => v.replace(/[;{}<>]/g, "")
  const lines = [`/* ${safe(kit.brand.name)} — IRIS brand kit */`, ":root {"]
  for (const c of kit.colors) if (isDrawableColor(c.value)) lines.push(`  --color-${name(c.name)}: ${safe(c.value)};`)
  for (const f of kit.fonts) lines.push(`  --font-${name(f.role)}: ${safe(f.family)};`)
  if (kit.motion?.ease) lines.push(`  --ease: ${safe(kit.motion.ease)};`)
  if (kit.motion?.durationMs != null) lines.push(`  --duration: ${kit.motion.durationMs}ms;`)
  lines.push("}")
  return lines.join("\n")
}
