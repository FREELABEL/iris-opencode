// ============================================================================
// Brand-driven rebrand engine for cloning Genesis client sites.
//
// Powers `iris pages rebrand` and `iris sites clone`. The brand entity is the
// single source of truth for client identity (stored under
// design_tokens.profile). The engine swaps identity/contact from a brand into a
// cloned page's json_content, preserves template visuals, blanks anything the
// brand doesn't supply, and a leak scan refuses to publish if the SOURCE
// client's PII survived the transform.
//
// See plan: ~/.claude/plans/moonlit-snacking-quail.md
// ============================================================================

import { irisFetch } from "./iris-api"

export interface BrandProfile {
  name?: string
  tagline?: string
  logoUrl?: string
  faviconUrl?: string
  domain?: string
  bookingUrl?: string
  colors?: { primary?: string; secondary?: string }
  contact?: {
    phone?: string
    email?: string
    address?: { street?: string; city?: string; state?: string; zip?: string }
    coords?: { lat?: number; lng?: number }
  }
  social?: { instagram?: string; facebook?: string; tiktok?: string }
}

// Asset hosts whose URLs must NEVER be touched by the text pass — these are
// template images (hero/service photos) we intentionally carry to the new site.
const ASSET_HOST_RE =
  /cdn\.heyiris\.io|freelabel\.net\/clients|digitaloceanspaces|images\.unsplash|cloudfront\.|^data:/i

export function isAssetUrl(s: string): boolean {
  return ASSET_HOST_RE.test(s)
}

// Template-agnostic PII patterns (used by both the transform and the leak gate).
const PHONE_RE = /(?:\+?1[\s.\-]?)?\(?\d{3}\)?[\s.\-]\d{3}[\s.\-]\d{4}/g
const EMAIL_RE = /[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}/g

// Mirrors the normalizeHex fix in Render.vue — brand tokens sometimes store a
// color as a Tailwind-style scale object instead of a hex string.
function pickHex(v: unknown): string | undefined {
  if (typeof v === "string") return v
  if (v && typeof v === "object") {
    const o = v as Record<string, unknown>
    const pick = o["500"] ?? o["600"] ?? o["DEFAULT"] ?? Object.values(o).find((x) => typeof x === "string")
    return typeof pick === "string" ? pick : undefined
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Read a BrandProfile from a brand's design tokens (the source of truth).
// ---------------------------------------------------------------------------
export async function profileFromBrand(slug: string): Promise<BrandProfile> {
  const res = await irisFetch(`/api/v1/public/brands/${encodeURIComponent(slug)}/design-tokens`)
  if (!res.ok) {
    throw new Error(`Brand "${slug}" not found or has no design tokens (HTTP ${res.status})`)
  }
  const data = (await res.json()) as { name?: string; design_tokens?: Record<string, unknown> }
  const tokens = data?.design_tokens ?? {}
  const profile = (tokens.profile ?? {}) as BrandProfile
  const colors = (tokens.colors ?? {}) as Record<string, unknown>
  return {
    ...profile,
    name: profile.name ?? data?.name ?? slug,
    colors: {
      primary: profile.colors?.primary ?? pickHex(colors.primary),
      secondary: profile.colors?.secondary ?? pickHex(colors.secondary),
    },
  }
}

// ---------------------------------------------------------------------------
// Derive the SOURCE page's identity (so we know what to replace + hunt).
// ---------------------------------------------------------------------------
export function deriveSourceProfile(jc: any): BrandProfile {
  const comps: any[] = Array.isArray(jc?.components) ? jc.components : []
  const props = (type: string) => comps.find((c) => c?.type === type)?.props ?? {}
  const nav = props("SiteNavigation")
  const hero = props("Hero")
  const map = props("MapSection")
  const contact = props("ContactSection")
  const footer = props("SiteFooter")
  const ig = props("InstagramFeed")
  const branding = jc?.theme?.branding ?? {}
  const loc = map?.locations?.[0] ?? {}
  const ci = (kw: string): string | undefined =>
    (contact?.contactInfo ?? []).find((x: any) => String(x?.label ?? "").toLowerCase().includes(kw))?.value

  return {
    name: branding.name ?? nav?.logo?.text ?? footer?.brandName,
    tagline: footer?.tagline,
    bookingUrl: nav?.ctaButton?.url ?? hero?.primaryButtonUrl,
    logoUrl: branding.logoUrl ?? nav?.logo?.imageUrl,
    contact: {
      phone: loc?.phone ?? ci("phone"),
      email: loc?.email ?? ci("email"),
    },
    social: { instagram: ig?.instagram },
  }
}

// ---------------------------------------------------------------------------
// Apply a target profile onto a page's json_content.
// ---------------------------------------------------------------------------
const orBlank = (v: unknown): string => (v == null ? "" : String(v))

// Strip a personalized "... with/by <Name>" clause (founder names) from a string.
// "Book with Lisa" -> "Book";  "Lash artistry by Lisa Martinez · Austin" -> "Lash artistry · Austin"
function stripPersonal(s: string): string {
  return s.replace(/\s+(?:with|by)\s+[A-Z][\w.'-]*(?:\s+[A-Z][\w.'-]*)?/g, "").replace(/\s{2,}/g, " ").trim()
}

function addressLines(a?: BrandProfile["contact"]): { lines: string[]; oneLine: string } {
  const addr = a?.address
  if (!addr) return { lines: [], oneLine: "" }
  const cityState = [addr.city, addr.state].filter(Boolean).join(", ")
  const line2 = [cityState, addr.zip].filter(Boolean).join(" ")
  const lines = [addr.street, line2].filter(Boolean) as string[]
  const oneLine = [addr.street, addr.city, addr.state, addr.zip].filter(Boolean).join(", ")
  return { lines, oneLine }
}

export function applyProfile(jc: any, target: BrandProfile, source: BrandProfile): any {
  const comps: any[] = Array.isArray(jc?.components) ? jc.components : []
  const find = (type: string) => comps.find((c) => c?.type === type)
  const { lines: addrLines, oneLine: addrOneLine } = addressLines(target.contact)
  const booking = target.bookingUrl || "#"

  // --- theme.branding ---
  jc.theme = jc.theme ?? {}
  jc.theme.branding = jc.theme.branding ?? {}
  const br = jc.theme.branding
  br.name = orBlank(target.name)
  if (target.colors?.primary) br.primaryColor = target.colors.primary
  if (target.colors?.secondary) br.secondaryColor = target.colors.secondary
  br.logoUrl = orBlank(target.logoUrl)
  br.faviconUrl = orBlank(target.faviconUrl ?? target.logoUrl)

  // --- SiteNavigation ---
  const nav = find("SiteNavigation")?.props
  if (nav) {
    if (nav.logo) {
      nav.logo.text = (target.name ?? "").toUpperCase()
      nav.logo.imageUrl = orBlank(target.logoUrl) // blank → text wordmark shows
    }
    if (nav.ctaButton) {
      nav.ctaButton.url = booking
      if (typeof nav.ctaButton.text === "string") {
        const stripped = stripPersonal(nav.ctaButton.text)
        nav.ctaButton.text = stripped.length > 3 ? stripped : "Book Now"
      }
    }
  }

  // --- Hero ---
  const hero = find("Hero")?.props
  if (hero) {
    if ("primaryButtonUrl" in hero) hero.primaryButtonUrl = booking
    if ("logoImage" in hero) hero.logoImage = orBlank(target.logoUrl)
  }

  // --- MapSection ---
  const map = find("MapSection")?.props
  const loc = map?.locations?.[0]
  if (loc) {
    loc.name = target.name ? `${target.name} Studio` : ""
    loc.phone = orBlank(target.contact?.phone)
    loc.email = orBlank(target.contact?.email)
    loc.address = addrLines
    const coords = target.contact?.coords
    if (coords?.lat != null && coords?.lng != null) {
      loc.latitude = coords.lat
      loc.longitude = coords.lng
      loc.directionsUrl = `https://maps.google.com/?q=${coords.lat},${coords.lng}`
    } else {
      // Drop the previous client's pin entirely rather than carry it.
      if ("latitude" in loc) loc.latitude = null
      if ("longitude" in loc) loc.longitude = null
      loc.directionsUrl = ""
    }
  }
  if (map && "mapEmbedUrl" in map && !target.contact?.coords) map.mapEmbedUrl = ""

  // --- ContactSection ---
  const contact = find("ContactSection")?.props
  for (const item of contact?.contactInfo ?? []) {
    const label = String(item?.label ?? "").toLowerCase()
    if (label.includes("phone")) {
      item.value = orBlank(target.contact?.phone)
      if ("link" in item) item.link = target.contact?.phone ? `tel:${String(target.contact.phone).replace(/[^\d+]/g, "")}` : ""
    } else if (label.includes("email")) {
      item.value = orBlank(target.contact?.email)
      if ("link" in item) item.link = target.contact?.email ? `mailto:${target.contact.email}` : ""
    } else if (label.includes("location") || label.includes("address")) {
      item.value = addrOneLine
      if ("link" in item) item.link = ""
    } else if (label.includes("booking") || label.includes("book")) {
      item.value = target.bookingUrl ? `Book online at ${target.bookingUrl.replace(/^https?:\/\//, "")}` : ""
      if ("link" in item) item.link = booking
    }
  }

  // --- InstagramFeed ---
  const igc = find("InstagramFeed")?.props
  if (igc && "instagram" in igc) igc.instagram = orBlank(target.social?.instagram)

  // --- SiteFooter ---
  const footer = find("SiteFooter")?.props
  if (footer) {
    if ("brandName" in footer) footer.brandName = orBlank(target.name)
    if ("tagline" in footer) footer.tagline = orBlank(target.tagline)
    if ("copyright" in footer && target.name) footer.copyright = `© 2026 ${target.name}`
    if (footer.logo) {
      footer.logo.imageUrl = orBlank(target.logoUrl)
      if ("tagline" in footer.logo) footer.logo.tagline = orBlank(target.tagline)
    }
    if (footer.brandMark) footer.brandMark.imageUrl = orBlank(target.logoUrl)
    if (footer.socialLinks && typeof footer.socialLinks === "object" && !Array.isArray(footer.socialLinks)) {
      footer.socialLinks.instagram = target.social?.instagram
        ? `https://instagram.com/${String(target.social.instagram).replace(/^@/, "")}`
        : ""
    }
  }

  // --- top-level SEO / og ---
  if ("seo_title" in jc) jc.seo_title = target.name ? `${target.name}${target.tagline ? " — " + target.tagline : ""}` : ""
  if ("seo_description" in jc) jc.seo_description = orBlank(target.tagline)
  if ("seo_keywords" in jc) jc.seo_keywords = ""

  // --- text pass (always runs): swap the source brand name + sweep ANY phone/
  //     email/tel:/mailto: to the target's value (or blank). Skips asset URLs.
  //     The phone/email sweep is what makes the engine template-agnostic — PII
  //     in Hero buttons / footer columns / body copy gets handled too. ---
  const src = source.name?.trim()
  const dst = target.name?.trim()
  const forms: Array<[string, string]> =
    src && dst
      ? ([
          [src, dst],
          [src.toUpperCase(), dst.toUpperCase()],
          [src.toLowerCase().replace(/[^a-z0-9]+/g, ""), dst.toLowerCase().replace(/[^a-z0-9]+/g, "")], // moodybeauty
          [
            src.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
            dst.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, ""),
          ], // moody-beauty
        ].filter(([a]) => a.length > 0) as Array<[string, string]>)
      : []
  const tPhone = target.contact?.phone ?? ""
  const tEmail = target.contact?.email ?? ""
  const tDigits = tPhone.replace(/[^\d]/g, "")
  const transformStr = (s: string): string => {
    if (isAssetUrl(s)) return s
    let out = s
    for (const [a, b] of forms) if (a !== b) out = out.split(a).join(b)
    out = out.replace(PHONE_RE, tPhone)
    out = out.replace(EMAIL_RE, tEmail)
    out = out.replace(/tel:\+?\d{10,}/gi, tDigits ? `tel:${tDigits}` : "")
    out = out.replace(/mailto:[^"'\s)]+/gi, tEmail ? `mailto:${tEmail}` : "")
    return out
  }
  const walk = (o: any): any => {
    if (typeof o === "string") return transformStr(o)
    if (Array.isArray(o)) return o.map(walk)
    if (o && typeof o === "object") {
      for (const k of Object.keys(o)) o[k] = walk(o[k])
      return o
    }
    return o
  }
  walk(jc)

  return jc
}

// ---------------------------------------------------------------------------
// Leak scan — after transform, hunt for the SOURCE client's distinguishing
// values surviving anywhere in the JSON (the safety gate).
// ---------------------------------------------------------------------------
export interface Leak {
  path: string
  needle: string
  value: string
}

export function sourceNeedles(sourceJc: any, source: BrandProfile): string[] {
  const needles = new Set<string>()
  const add = (v?: string | null) => {
    const s = (v ?? "").trim()
    if (s && s.length > 4) needles.add(s)
  }
  add(source.name)
  add(source.contact?.phone)
  add(source.contact?.email)
  add(source.social?.instagram)
  // Founder / personal names embedded in taglines or CTAs ("... by Jane Doe", "Book with Lisa").
  const personalSources = [source.tagline, source.name].filter(Boolean) as string[]
  const comps0: any[] = Array.isArray(sourceJc?.components) ? sourceJc.components : []
  for (const c of comps0) {
    const t = c?.props?.ctaButton?.text ?? c?.props?.logo?.tagline ?? c?.props?.tagline
    if (typeof t === "string") personalSources.push(t)
  }
  for (const ps of personalSources) {
    const m = ps.match(/(?:by|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)/)
    if (m) add(m[1])
  }
  // Template-agnostic PII sweep: any phone or email ANYWHERE in the source page
  // becomes a needle, so the gate catches leaks regardless of which component
  // holds them (Hero buttons, footer columns, body copy, …).
  const sweep = (o: any) => {
    if (typeof o === "string") {
      if (isAssetUrl(o)) return
      for (const m of o.match(PHONE_RE) ?? []) add(m.trim())
      for (const m of o.match(EMAIL_RE) ?? []) add(m.trim())
      const tel = o.match(/tel:\+?([\d]{10,})/i)
      if (tel) add(tel[1])
    } else if (Array.isArray(o)) {
      o.forEach(sweep)
    } else if (o && typeof o === "object") {
      for (const k of Object.keys(o)) sweep(o[k])
    }
  }
  sweep(sourceJc)
  // booking handle (e.g. vagaro.com/<handle>) — the path segment, not the domain
  const booking = source.bookingUrl ?? ""
  const seg = booking.split("/").filter(Boolean).pop()
  if (seg && !/^https?:$/.test(seg)) add(seg)
  // address fragments from the source MapSection / ContactSection
  const comps: any[] = Array.isArray(sourceJc?.components) ? sourceJc.components : []
  for (const c of comps) {
    const loc = c?.props?.locations?.[0]
    if (loc?.address) {
      const lines = Array.isArray(loc.address) ? loc.address : [String(loc.address)]
      for (const ln of lines) {
        // street number + name fragment, and the zip
        const m = String(ln).match(/\b(\d{3,5}\s+[A-Za-z][\w .'-]+?)(?:,|$)/)
        if (m) add(m[1])
        const zip = String(ln).match(/\b(\d{5})\b/)
        if (zip) add(zip[1])
      }
    }
  }
  return [...needles]
}

export function scanForLeaks(jc: any, needles: string[]): Leak[] {
  const leaks: Leak[] = []
  if (!needles.length) return leaks
  const walk = (o: any, path: string) => {
    if (typeof o === "string") {
      if (isAssetUrl(o)) return
      for (const n of needles) {
        if (o.includes(n)) leaks.push({ path, needle: n, value: o.length > 80 ? o.slice(0, 77) + "…" : o })
      }
    } else if (Array.isArray(o)) {
      o.forEach((v, i) => walk(v, `${path}[${i}]`))
    } else if (o && typeof o === "object") {
      for (const k of Object.keys(o)) walk(o[k], path ? `${path}.${k}` : k)
    }
  }
  walk(jc, "")
  // dedupe by path+needle
  const seen = new Set<string>()
  return leaks.filter((l) => {
    const key = `${l.path}::${l.needle}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// Convenience: run the full rebrand transform + leak scan in one call.
export function rebrandJsonContent(
  sourceJc: any,
  target: BrandProfile,
): { json: any; leaks: Leak[]; source: BrandProfile } {
  const source = deriveSourceProfile(sourceJc)
  const needles = sourceNeedles(sourceJc, source)
  const json = applyProfile(sourceJc, target, source)
  const leaks = scanForLeaks(json, needles)
  return { json, leaks, source }
}
