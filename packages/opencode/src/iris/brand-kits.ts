/**
 * Genesis › Brand kits (#188816, editor #192667) — the desktop's read and write path to a brand's
 * design tokens.
 *
 * A BRAND KIT is what fl-api stores at `brands.metadata.design_tokens`: colours, type, logo and
 * motion, plus the brand's voice personas. The platform already serves all of it (BrandController,
 * owner-scoped — you see and edit only your own brands); this module is the desktop's proxy.
 *
 * SAVES ARE PINNED to what was read. fl-api's PATCH design-tokens has no version check and
 * replaces each top-level section it is sent (DesignTokenNormalizer::mergeForUpdate), so two
 * windows editing colours would silently keep only the last one. The pane sends every section it
 * changed together with each section exactly as it read it; we re-read before writing and refuse
 * when any of them moved — the same rule the page editor follows (savePageDoc), for the same reason.
 * Every changed section goes out in ONE PATCH (the `iris brands dt push` call), so a save lands whole.
 *
 * LOGO VARIANTS live at `brand.logo` in the fixed shape of #192664 (B1): primary · on_dark ·
 * on_light · icon · social, each a URL. Older kits keep `logos.{primary,icon}.url`; those are read
 * too, and a save writes the variants to `brand.logo`, where the resolver reads them.
 */
import { FL_API, irisFetch, resolveToken, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/**
 * The sections the pane may write. `fonts`/`font` are where some kits keep their stacks instead of
 * `typography` (#192632); `brand` holds the logo variants and the voice/tone text. Personas are
 * their own resource and are not written here.
 */
export const EDITABLE_SECTIONS = ["colors", "typography", "fonts", "font", "motion", "brand"] as const
export type EditableSection = (typeof EDITABLE_SECTIONS)[number]

export const LOGO_VARIANTS = ["primary", "on_dark", "on_light", "icon", "social"] as const
export type LogoVariant = (typeof LOGO_VARIANTS)[number]

/** Platform calls, replaceable in tests (the routes are tested without reaching a brand). */
export const brandDeps = {
  userId: () => resolveUserId(),
  fetch: (path: string, init?: RequestInit) => irisFetch(path, FL_API, init),
  /** Multipart — NOT irisFetch, which sets content-type JSON; a form carries its own boundary. */
  upload: (form: FormData) => {
    const token = resolveToken()
    const headers: Record<string, string> = { Accept: "application/json" }
    if (token) headers["Authorization"] = `Bearer ${token}`
    return fetch(`${FL_API}/api/v1/cloud-files/upload`, { method: "POST", headers, body: form })
  },
  /** The logo probe's own fetch: plain, no credentials — a logo is a public image. */
  probe: (url: string, init?: RequestInit) => fetch(url, init),
}

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
  /** The board the brand belongs to (#192632) — how a page owned by that board finds its brand. */
  bloqId?: number
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
  /** Which section the stacks were read from — a save writes them back there. */
  fontSection: "typography" | "fonts" | "font"
  typeScale: { role: string; value: string }[]
  /** The primary mark (kept for older panes and the list). */
  logoUrl?: string
  /** Every logo variant the kit names, by the #192664 names. */
  logos: Partial<Record<LogoVariant, string>>
  motion?: { ease?: string; durationMs?: number; character?: string; stiffness?: number; damping?: number }
  /** `brand.voice` / `brand.tone` — the kit's own words on how it speaks. */
  voice?: string
  tone?: string
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
  // The IRIS kit keeps its marks under brand.logo as plain URLs — {primary, icon, social} (#192632).
  // Read there too, or the brand that names IRIS shows a letter where its logo is.
  const named = t.brand?.logo
  if (!t.logos && named) {
    const url = (v: unknown) => (typeof v === "string" && /^https?:\/\//.test(v) ? v : undefined)
    const primary = typeof named === "string" ? url(named) : url(named.primary) ?? url(named.icon)
    const icon = typeof named === "object" ? url(named.icon) : undefined
    if (primary) t.logos = { primary: { url: primary }, ...(icon ? { icon: { url: icon } } : {}) }
  }
  return t
}

const httpUrl = (v: unknown) => (typeof v === "string" && /^https?:\/\/\S+$/i.test(v.trim()) ? v.trim() : undefined)

/**
 * Every logo variant a kit names. `brand.logo` (the #192664 shape) wins over the older
 * `logos.{variant}.url`, which is read so a legacy kit still shows its mark.
 */
export function logosOf(raw: Record<string, any>): Partial<Record<LogoVariant, string>> {
  const out: Partial<Record<LogoVariant, string>> = {}
  const legacy = raw.logos && typeof raw.logos === "object" ? raw.logos : undefined
  if (legacy)
    for (const v of LOGO_VARIANTS) {
      const u = httpUrl(typeof legacy[v] === "string" ? legacy[v] : legacy[v]?.url)
      if (u) out[v] = u
    }
  if (!out.primary && raw.logo) out.primary = httpUrl(typeof raw.logo === "string" ? raw.logo : raw.logo?.url)
  const named = raw.brand?.logo
  if (typeof named === "string") {
    const u = httpUrl(named)
    if (u) out.primary = u
  } else if (named && typeof named === "object")
    for (const v of LOGO_VARIANTS) {
      const u = httpUrl(named[v])
      if (u) out[v] = u
    }
  for (const v of LOGO_VARIANTS) if (!out[v]) delete out[v]
  return out
}

/**
 * Font stacks a kit files OUTSIDE typography — `fonts: {sans: {DEFAULT}}` or `font: {mono: "…"}`
 * (the IRIS Desktop, Atlas, Genesis and Hive kits do, 2026-11-05). Read only when typography names
 * no stack, so a kit that has both is not listed twice.
 */
function looseFonts(t: Record<string, any>): { section?: "fonts" | "font"; fonts: { role: string; family: string }[] } {
  for (const key of ["fonts", "font"] as const) {
    const v = t[key]
    if (!v || typeof v !== "object" || Array.isArray(v)) continue
    const out = Object.entries(v)
      .map(([role, x]) => ({ role, family: typeof x === "string" ? x : (x as any)?.DEFAULT ?? (x as any)?.default ?? (x as any)?.family }))
      .filter((f): f is { role: string; family: string } => isFontStack(f.family))
    if (out.length) return { section: key, fonts: out }
  }
  return { fonts: [] }
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

/** An easing a browser accepts — the keywords, cubic-bezier() and steps(). Nothing that can close a rule. */
export function isEase(v: unknown): v is string {
  if (typeof v !== "string") return false
  const s = v.trim()
  return (
    /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end)$/.test(s) ||
    /^cubic-bezier\(\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*,\s*-?[\d.]+\s*\)$/.test(s) ||
    /^steps\(\s*\d+\s*(,\s*(start|end|jump-start|jump-end|jump-none|jump-both)\s*)?\)$/.test(s)
  )
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
  const raw = r?.metadata?.design_tokens
  const tokens = normalizeTokens(raw)
  const logos = logosOf(raw && typeof raw === "object" ? raw : {})
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
    // The small mark prefers the brand's icon: a "white transparent" primary disappears on a light row.
    logoUrl: logos.icon ?? logos.primary,
    updatedAt: typeof r.updated_at === "string" ? r.updated_at : undefined,
    bloqId: typeof r.bloq_id === "number" ? r.bloq_id : undefined,
  }
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : undefined)

export function kitOf(brand: any, rawTokens: unknown): BrandKit {
  const tokens = normalizeTokens(rawTokens)
  const raw = rawTokens && typeof rawTokens === "object" && !Array.isArray(rawTokens) ? (rawTokens as Record<string, any>) : {}
  const fonts: BrandKit["fonts"] = []
  const typeScale: BrandKit["typeScale"] = []
  for (const [role, v] of Object.entries(tokens.typography ?? {})) {
    const family = (v as any)?.family
    if (isFontStack(family)) fonts.push({ role, family })
    else if (family != null) typeScale.push({ role, value: String(family) })
  }
  let fontSection: BrandKit["fontSection"] = "typography"
  if (fonts.length === 0) {
    const loose = looseFonts(tokens)
    if (loose.section) {
      fontSection = loose.section
      fonts.push(...loose.fonts)
    }
  }
  const m = tokens.motion && typeof tokens.motion === "object" ? tokens.motion : undefined
  const personas = Array.isArray(brand?.personas) ? brand.personas : []
  const logos = logosOf(raw)
  const named = tokens.brand && typeof tokens.brand === "object" ? tokens.brand : {}
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
    fontSection,
    typeScale,
    logoUrl: logos.primary,
    logos,
    motion: m
      ? {
          ease: str(m.ease),
          durationMs: num(m.duration_ms),
          character: str(m.character),
          stiffness: num(m.spring?.stiffness),
          damping: num(m.spring?.damping),
        }
      : undefined,
    voice: str(named.voice),
    tone: str(named.tone),
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

const notSignedIn = () => `not signed in (token: ${tokenSource()})`

export async function fetchBrands(): Promise<PlatformResult<{ brands: BrandSummary[] }>> {
  const userId = await brandDeps.userId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { brands: [] } }
  try {
    const res = await brandDeps.fetch(`/api/v1/brands?per_page=100`)
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
  const userId = await brandDeps.userId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: {} }
  try {
    const [b, t] = await Promise.all([brandDeps.fetch(`/api/v1/brands/${id}`), brandDeps.fetch(`/api/v1/brands/${id}/design-tokens`)])
    if (!b.ok) return { measured: false, reason: b.status === 404 ? "no such brand on your account" : `fl-api ${b.status}`, data: {} }
    if (!t.ok) return { measured: false, reason: `design tokens: fl-api ${t.status}`, data: {} }
    const brand = ((await b.json()) as any)?.data
    const tokens = ((await t.json()) as any)?.data
    return { measured: true, data: { kit: kitOf(brand, tokens) } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: {} }
  }
}

const fontValue = (v: any) => (v && typeof v === "object" ? (v.family ?? v.DEFAULT ?? v.default) : v)

/**
 * Validate a section before it is sent. fl-api accepts any JSON here and the page that reads the
 * kit then renders garbage; refusing at the desktop names the problem while the person can fix it.
 */
export function sectionProblem(section: string, value: unknown): string | null {
  if (!(EDITABLE_SECTIONS as readonly string[]).includes(section)) return `"${section}" is not editable here`
  if (!value || typeof value !== "object" || Array.isArray(value)) return `${section} must be an object`
  const entries = Object.entries(value as Record<string, any>)
  if (section === "colors") {
    for (const [k, v] of entries) {
      const d = v && typeof v === "object" ? (v.DEFAULT ?? v.default ?? v.value) : v
      if (!isDrawableColor(d)) return `colour "${k}" is not a hex, rgb() or hsl() value: ${JSON.stringify(d)}`
    }
  }
  if (section === "typography" || section === "fonts" || section === "font") {
    for (const [k, v] of entries) {
      const f = fontValue(v)
      if (typeof f !== "string" || !f.trim()) return `type role "${k}" has no value`
      if (/[;{}<>]/.test(f)) return `type role "${k}" holds a character a stylesheet cannot take: ${JSON.stringify(f)}`
    }
  }
  if (section === "motion") {
    const m = value as Record<string, any>
    if (m.ease != null && !isEase(m.ease)) return `the ease is not one a browser accepts: ${JSON.stringify(m.ease)}`
    if (m.duration_ms != null && !(typeof m.duration_ms === "number" && m.duration_ms >= 0 && m.duration_ms <= 10000))
      return `the duration must be between 0 and 10000 ms`
    if (m.spring != null && !(Number(m.spring?.stiffness) > 0 && Number(m.spring?.damping) > 0))
      return `a spring needs both stiffness and damping, each above 0`
  }
  if (section === "brand") {
    const b = value as Record<string, any>
    if (b.logo != null) {
      if (typeof b.logo !== "object" || Array.isArray(b.logo)) return "brand.logo must be an object of variant URLs"
      for (const [k, u] of Object.entries(b.logo)) if (u != null && !httpUrl(u)) return `logo "${k}" is not an http(s) URL: ${JSON.stringify(u)}`
    }
    for (const k of ["voice", "tone"]) if (b[k] != null && typeof b[k] !== "string") return `brand.${k} must be text`
  }
  return null
}

/**
 * Save every section the pane changed, in ONE PATCH, each pinned to what the pane read. Refused
 * whole when any one moved: half a save would leave the kit in a state nobody chose.
 */
export async function saveBrandKit(input: {
  id: number
  /** Section → its whole new value (fl-api replaces sections whole). */
  changes: Record<string, unknown>
  /** Section → that section as the pane read it (BrandKit.sections[section]). */
  expected: Record<string, string>
}): Promise<{ ok: boolean; reason?: string; kit?: BrandKit; saved?: string[] }> {
  const userId = await brandDeps.userId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  const sections = Object.keys(input.changes)
  if (sections.length === 0) return { ok: false, reason: "nothing changed" }
  for (const s of sections) {
    const problem = sectionProblem(s, input.changes[s])
    if (problem) return { ok: false, reason: problem }
    if (typeof input.expected[s] !== "string") return { ok: false, reason: `the ${s} was sent without what it replaces — reload the kit` }
  }
  try {
    const now = await brandDeps.fetch(`/api/v1/brands/${input.id}/design-tokens`)
    if (!now.ok) return { ok: false, reason: now.status === 404 ? "no such brand on your account" : `fl-api ${now.status}` }
    const current = normalizeTokens(((await now.json()) as any)?.data)
    const moved = sections.filter((s) => JSON.stringify(current[s] ?? null) !== input.expected[s])
    if (moved.length) return { ok: false, reason: `the ${moved.join(" and ")} changed since you opened this kit — reload before saving` }
    const res = await brandDeps.fetch(`/api/v1/brands/${input.id}/design-tokens`, {
      method: "PATCH",
      body: JSON.stringify(Object.fromEntries(sections.map((s) => [s, input.changes[s]]))),
    })
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: String(j?.message ?? `fl-api ${res.status}`) }
    // Read back, so the pane shows what the server holds rather than what we hoped we sent.
    const again = await fetchBrandKit(input.id)
    return again.measured
      ? { ok: true, kit: again.data.kit, saved: sections }
      : { ok: true, saved: sections, reason: `saved; reload failed: ${again.reason}` }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** The single-section save the first pane used (#188816) — now one case of saveBrandKit. */
export function saveBrandSection(input: { id: number; section: string; value: unknown; expected: string }) {
  return saveBrandKit({ id: input.id, changes: { [input.section]: input.value }, expected: { [input.section]: input.expected } })
}

// ── logos: upload one, and look at one ─────────────────────────────────────────

const LOGO_TYPES = /^image\/(png|jpeg|webp|gif|svg\+xml)$/
export const LOGO_MAX_BYTES = 5 * 1024 * 1024

/**
 * Upload a logo file to the account's cloud files (fl-api /cloud-files/upload — the call
 * `iris cloud:upload` makes) and hand back its URL. This does NOT touch the kit: the URL goes into
 * the pane's draft, and the kit changes only through the confirmed save.
 */
export async function uploadBrandLogo(
  brandId: number,
  input: { name: string; type: string; data: string; variant?: string },
): Promise<{ ok: boolean; reason?: string; url?: string; fileId?: number }> {
  const userId = await brandDeps.userId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  if (!LOGO_TYPES.test(input.type)) return { ok: false, reason: `a logo must be a PNG, JPEG, WebP, GIF or SVG image (got ${input.type || "no type"})` }
  let bytes: Uint8Array<ArrayBuffer>
  try {
    const buf = Buffer.from(input.data.replace(/^data:[^;]+;base64,/, ""), "base64")
    bytes = new Uint8Array(new ArrayBuffer(buf.length))
    bytes.set(buf)
  } catch (e) {
    return { ok: false, reason: `not valid base64 — ${e instanceof Error ? e.message : String(e)}` }
  }
  if (bytes.length === 0) return { ok: false, reason: "empty file" }
  if (bytes.length > LOGO_MAX_BYTES) return { ok: false, reason: "a logo can be up to 5 MB" }
  const name = (input.name.trim() || "logo").replace(/[^\w.\- ]+/g, "_")
  const form = new FormData()
  form.append("file", new Blob([bytes], { type: input.type }), name)
  // "digital_product" is the upload type that accepts images (CloudFileController: text_extraction | digital_product | lead_source).
  form.append("type", "digital_product")
  form.append("user_id", String(userId))
  form.append("brand_id", String(brandId))
  form.append("title", input.variant ? `${name} (logo ${input.variant})` : name)
  try {
    const res = await brandDeps.upload(form)
    const j = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { ok: false, reason: String(j?.message ?? j?.error ?? `fl-api ${res.status}`) }
    const d = j?.data ?? j
    const url = httpUrl(d?.cdn_url) ?? httpUrl(d?.url) ?? httpUrl(d?.filepath)
    if (!url) return { ok: false, reason: "uploaded, but the platform returned no URL for the file" }
    return { ok: true, url, fileId: typeof d?.id === "number" ? d.id : undefined }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Hosts a probe must never reach: this machine and private networks. A logo is a public image. */
export function probeTarget(input: string): URL | undefined {
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
  const h = u.hostname.replace(/^\[|\]$/g, "").toLowerCase()
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal")) return undefined
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h)) return undefined
  if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return undefined
  return u
}

export const PROBE_MAX_BYTES = 3 * 1024 * 1024

/**
 * Fetch a logo for the pane to look at. The pane measures how light the mark is (to flag a mark
 * that disappears on its tile), which needs the pixels — and a canvas will not read pixels from a
 * cross-origin image without CORS headers most CDNs do not send. So the engine fetches it and hands
 * it back as a data URL. Also answers B1's question "is this URL a working image" (200, image/*).
 */
export async function probeLogo(input: string): Promise<{ ok: boolean; reason?: string; status?: number; contentType?: string; bytes?: number; dataUrl?: string }> {
  const url = probeTarget(input)
  if (!url) return { ok: false, reason: "not a public http(s) URL" }
  try {
    const res = await brandDeps.probe(url.toString(), { redirect: "follow", signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { ok: false, status: res.status, reason: `the URL answers ${res.status}` }
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase()
    if (!type.startsWith("image/")) return { ok: false, status: res.status, contentType: type, reason: `not an image (${type || "no content type"})` }
    const len = Number(res.headers.get("content-length") ?? 0)
    if (len > PROBE_MAX_BYTES) return { ok: false, status: res.status, contentType: type, bytes: len, reason: "larger than 3 MB" }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length > PROBE_MAX_BYTES) return { ok: false, status: res.status, contentType: type, bytes: buf.length, reason: "larger than 3 MB" }
    return { ok: true, status: res.status, contentType: type, bytes: buf.length, dataUrl: `data:${type};base64,${buf.toString("base64")}` }
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
