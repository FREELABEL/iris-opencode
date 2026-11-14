// ============================================================================
// iris marketing — the rules, as pure functions (#193357, follows #193233)
//
// The CLI side of Desktop › Marketing. Desktop's engine has the same rules in
// packages/opencode/src/iris/{campaign-setup,marketing-create,page-pin}.ts on iris/1.18.23; the two
// branches share no code (the CLI ships from main), so they are copied here, with tests, and the
// copies must agree. What must match Desktop exactly:
//   - which boards are offered: the ones you own or edit (viewers never), with their list count;
//   - the slug a name becomes, and one retry with a short suffix when it is taken;
//   - the pin limits (12 pins, slug shape, 40-character labels) — fl-api AccountSettingKeys too;
//   - the words a refusal is told in: no ids, no HTTP codes.
// ============================================================================

export type MarketingBoard = { id: number; name: string; role: "owner" | "editor"; lists?: number }
export type MarketingKind = "campaign" | "landing" | "brand"
export const KINDS: Array<{ kind: MarketingKind; title: string; hint: string }> = [
  { kind: "campaign", title: "Campaign review", hint: "a private page where your team reviews and approves your ads" },
  { kind: "landing", title: "Landing page", hint: "a page for an offer or an event — a draft until you publish it" },
  { kind: "brand", title: "Brand kit", hint: "your logo, colours and type, for every page and ad you make" },
]
export const isKind = (k: unknown): k is MarketingKind => KINDS.some((x) => x.kind === k)

// ── boards ────────────────────────────────────────────────────────────────

/** fl-api /user/{id}/bloqs rows → the boards you may make things on. */
export function boardsFrom(raw: unknown): MarketingBoard[] {
  const rows = Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
  return rows.flatMap((b): MarketingBoard[] => {
    const id = Number(b?.id)
    if (!Number.isInteger(id) || id <= 0) return []
    const name = typeof b.name === "string" && b.name.trim() ? b.name.trim() : "Untitled board"
    const lists = Array.isArray(b.lists) ? { lists: b.lists.length } : {}
    if (b.is_owner === true) return [{ id, name, role: "owner", ...lists }]
    if (b.user_permission === "editor") return [{ id, name, role: "editor", ...lists }]
    return []
  })
}

/** Every word typed, in any order, matched against the name or the id ("905", "#905"). */
export function filterBoards(boards: MarketingBoard[], q: string): MarketingBoard[] {
  const words = String(q ?? "").toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return boards
  return boards.filter((b) => {
    const hay = `${b.name.toLowerCase()} #${b.id}`
    return words.every((w) => hay.includes(w) || hay.includes(`#${w.replace(/^#/, "")}`))
  })
}

/** "#905 · 5 lists" — the line Desktop's board step shows under a name. */
export function boardMeta(b: MarketingBoard): string {
  const n = b.lists
  return n === undefined ? `#${b.id}` : `#${b.id} · ${n} ${n === 1 ? "list" : "lists"}`
}

// ── names and slugs ───────────────────────────────────────────────────────

/** "Acme Shoes — Spring!" → "acme-shoes-spring". Empty when nothing usable is left. */
export function slugify(name: string): string {
  return String(name ?? "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "")
}

export const cleanName = (name: unknown) => (typeof name === "string" ? name.trim().replace(/\s+/g, " ").slice(0, 120) : "")

/** The retry slug: the base, cut to leave room, plus a short suffix. */
export const retrySlug = (base: string, suffix: string) => `${base.slice(0, 54)}-${suffix}`

/** A 409, or a 422 that names the slug as taken. */
export function slugTaken(status: number, body: string): boolean {
  if (status === 409) return true
  if (status !== 422) return false
  return /slug/i.test(body) && /(taken|exists|unique|already)/i.test(body)
}

/** What a refusal is told as, by kind. No ids, no HTTP codes. */
export function refusalWords(status: number, kind: Exclude<MarketingKind, "campaign">): string {
  const what = kind === "brand" ? "brand kit" : "landing page"
  if (status === 401) return "Sign in to IRIS first: iris auth login"
  if (status === 403) return `You can't add a ${what} to this board. Ask its owner to make you an editor. Nothing was made.`
  if (status === 404 || status === 405) return "This part of IRIS isn't switched on yet. Nothing was made — try again after the next update."
  if (status === 409 || status === 422) return `IRIS couldn't use that name for a ${what}. Try a different one. Nothing was made.`
  if (status === 429) return "Too many tries in a row. Wait a minute, then try again."
  if (status >= 500) return `IRIS couldn't make the ${what} right now. Nothing was made — try again in a moment.`
  return `IRIS couldn't make the ${what}. Nothing was made.`
}

/** The same starting page `iris pages create --template landing` and Desktop make: a hero and a footer. */
export function landingContent(slug: string, title: string, year = new Date().getFullYear()) {
  return {
    version: "1.0",
    type: "landing",
    theme: { mode: "dark", backgroundColor: "#000000", branding: { name: title, primaryColor: "#34d399" } },
    components: [
      { type: "Hero", id: `${slug}-hero`, props: { themeMode: "dark", title, subtitle: "", labelText: "NEW", labelColor: "#34d399", textAlign: "center" } },
      { type: "SiteFooter", id: `${slug}-footer`, props: { themeMode: "dark", brandName: title, copyright: `© ${year} ${title}`, links: [] } },
    ],
  }
}

// ── pins ──────────────────────────────────────────────────────────────────

export type Pin = { slug: string; label: string; signIn?: boolean }
export type Pins = { pins: Pin[]; selected?: string }
export const PIN_MAX = 12
export const PIN_SLUG = /^[a-z0-9][a-z0-9-]{0,190}$/
export const PIN_LABEL_MAX = 40
export const EMPTY_PINS: Pins = { pins: [] }

export const cleanLabel = (label: unknown, fallback: string) => {
  const s = typeof label === "string" ? label.replace(/\s+/g, " ").trim() : ""
  return (s || fallback).slice(0, PIN_LABEL_MAX)
}

/** A stored value read back — anything malformed is dropped, never trusted. */
export function parsePins(v: unknown): Pins {
  const raw = (v && typeof v === "object" ? (v as any).pins : null) ?? []
  const seen = new Set<string>()
  const pins: Pin[] = []
  for (const p of Array.isArray(raw) ? raw : []) {
    const slug = typeof p?.slug === "string" ? p.slug.trim().toLowerCase() : ""
    if (!PIN_SLUG.test(slug) || seen.has(slug) || pins.length >= PIN_MAX) continue
    seen.add(slug)
    pins.push({ slug, label: cleanLabel(p.label, slug), ...(p.signIn === true ? { signIn: true } : {}) })
  }
  const sel = typeof (v as any)?.selected === "string" ? (v as any).selected.toLowerCase() : undefined
  return { pins, ...(sel && seen.has(sel) ? { selected: sel } : {}) }
}

export type PinOp =
  | { op: "pin"; pin: Pin }
  | { op: "unpin"; slug: string }
  | { op: "rename"; slug: string; label: string }
  | { op: "move"; slug: string; by: number }

/**
 * Apply one change. Returns the new pins, or why not. Ops are written so re-applying one to a value
 * someone else changed meanwhile (a 409 from the server) still does what was asked.
 */
export function applyPinOp(cur: Pins, o: PinOp): { ok: true; pins: Pins; changed: boolean } | { ok: false; reason: string } {
  const pins = cur.pins.slice()
  const at = (slug: string) => pins.findIndex((p) => p.slug === slug.toLowerCase())
  if (o.op === "pin") {
    const i = at(o.pin.slug)
    if (i >= 0) return { ok: true, pins: { ...cur, selected: pins[i].slug }, changed: cur.selected !== pins[i].slug }
    if (pins.length >= PIN_MAX) return { ok: false, reason: `${PIN_MAX} pages are pinned — unpin one first.` }
    pins.push({ slug: o.pin.slug.toLowerCase(), label: cleanLabel(o.pin.label, o.pin.slug), ...(o.pin.signIn ? { signIn: true } : {}) })
    return { ok: true, pins: { pins, selected: o.pin.slug.toLowerCase() }, changed: true }
  }
  const i = at(o.slug)
  if (i < 0) return { ok: false, reason: `${o.slug} isn't pinned.` }
  if (o.op === "unpin") {
    pins.splice(i, 1)
    const selected = cur.selected === o.slug.toLowerCase() ? pins[Math.min(i, pins.length - 1)]?.slug : cur.selected
    return { ok: true, pins: { pins, ...(selected ? { selected } : {}) }, changed: true }
  }
  if (o.op === "rename") {
    const label = cleanLabel(o.label, pins[i].slug)
    if (label === pins[i].label) return { ok: true, pins: cur, changed: false }
    pins[i] = { ...pins[i], label }
    return { ok: true, pins: { ...cur, pins }, changed: true }
  }
  const j = Math.max(0, Math.min(pins.length - 1, i + o.by))
  if (j === i) return { ok: true, pins: cur, changed: false }
  const [p] = pins.splice(i, 1)
  pins.splice(j, 0, p)
  return { ok: true, pins: { ...cur, pins }, changed: true }
}

/** Open it signed in when it asks for a sign-in or isn't public — Desktop's rule (#192482). */
export function needsSignIn(p: { visibility?: unknown; requires_auth?: unknown; requiresAuth?: unknown }): boolean {
  const req = p.requires_auth ?? p.requiresAuth
  return req === true || (typeof p.visibility === "string" && p.visibility !== "" && p.visibility !== "public")
}

/** heyiris.io, never freelabel.net (#188508). The same fl-iris-api serves both hosts. */
export const PAGE_ORIGIN = process.env.IRIS_PAGE_ORIGIN ?? "https://heyiris.io"
export const pageUrl = (slug: string) => `${PAGE_ORIGIN}/p/${encodeURIComponent(String(slug).trim().toLowerCase())}`
