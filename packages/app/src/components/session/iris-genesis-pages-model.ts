/**
 * GENESIS › PAGES (#192632) — the decisions behind the cards and the detail, pure so they are tested
 * without a DOM or a network: what each filter means, what the pager says, how old "updated" reads,
 * which brand a page belongs to, where a card's picture comes from, and — the one that matters —
 * which actions ask first and what the confirm says.
 *
 * THE CONFIRM RULE, from `iris pages visibility` (exposure-gate): anything that lets MORE people
 * read a page asks, in plain words naming who. Narrowing (unpublish, toward private) never asks —
 * it is recoverable, and it says afterwards what stopped working.
 */

export type Visibility = "public" | "unlisted" | "private"
export type PagesFilter = "all" | "published" | "draft" | "private"
export type PagesView = "grid" | "list"

export type GenesisPage = {
  id: number
  title: string
  slug?: string
  status: string
  url?: string
  updatedAt?: string
  createdAt?: string
  version?: number
  publishedAt?: string
  visibility?: string
  requiresAuth?: boolean
  category?: string
  description?: string
  thumbnailUrl?: string
  ogImage?: string
  ownerType?: string
  ownerId?: number
  siteId?: number
}

export type PagesPayload = {
  measured: boolean
  reason?: string
  page: number
  perPage: number
  total: number | null
  totalIsExact: boolean
  hasMore: boolean
  pages: GenesisPage[]
  counts?: Partial<Record<PagesFilter, number>>
}

export type BrandSummary = {
  id: number
  name: string
  slug: string
  status: string
  swatches: { name: string; value: string }[]
  logoUrl?: string
  bloqId?: number
}

export const FILTERS: { id: PagesFilter; label: string; hint: string }[] = [
  { id: "all", label: "All", hint: "Every page in this scope" },
  { id: "published", label: "Published", hint: "Live at their link" },
  { id: "draft", label: "Drafts", hint: "Not published yet" },
  { id: "private", label: "Private", hint: "Unlisted, private or sign-in only" },
]

export const PER_PAGE = 24

/** "1–24 of 1,038". An inexact total is a floor ("of 50+"); nothing shown is said in words. */
export function rangeLine(p: { page: number; perPage: number; shown: number; total: number | null; totalIsExact: boolean }): string {
  if (p.shown === 0) return p.page > 1 ? "Nothing on this page" : "No pages"
  const from = (p.page - 1) * p.perPage + 1
  const to = from + p.shown - 1
  const range = from === to ? `${from}` : `${from}–${to}`
  if (p.total == null) return range
  return `${range} of ${p.total.toLocaleString("en-US")}${p.totalIsExact ? "" : "+"}`
}

const UNITS: [number, string][] = [
  [60, "minute"],
  [60 * 24, "hour"],
  [60 * 24 * 7, "day"],
  [60 * 24 * 30, "week"],
  [60 * 24 * 365, "month"],
]

/** "just now", "5 minutes ago", "yesterday", "3 days ago", "2 weeks ago", "4 months ago", "2 years ago". */
export function relativeTime(iso: string | undefined, now: number): string | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return undefined
  const mins = Math.max(0, Math.floor((now - t) / 60_000))
  if (mins < 1) return "just now"
  const step = [1, 60, 60 * 24, 60 * 24 * 7, 60 * 24 * 30]
  for (const [i, [limit, unit]] of UNITS.entries()) {
    if (mins < limit) {
      const n = Math.floor(mins / step[i])
      if (unit === "day" && n === 1) return "yesterday"
      return `${n} ${unit}${n === 1 ? "" : "s"} ago`
    }
  }
  const years = Math.floor(mins / (60 * 24 * 365))
  return `${years} year${years === 1 ? "" : "s"} ago`
}

/** The exact time, for the hover on a relative one. */
export function exactTime(iso: string | undefined): string | undefined {
  if (!iso) return undefined
  const t = new Date(iso)
  if (!Number.isFinite(t.getTime())) return undefined
  return t.toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })
}

/** Absent or unknown visibility is public: the platform's own fail-open rule (Page::effectiveVisibility). */
export function visibilityOf(p: Pick<GenesisPage, "visibility">): Visibility {
  return p.visibility === "private" || p.visibility === "unlisted" ? p.visibility : "public"
}

export const VISIBILITY: Record<Visibility, { label: string; icon: "globe" | "link" | "lock"; hint: string }> = {
  public: { label: "Public", icon: "globe", hint: "Anyone can find and read it at its address" },
  unlisted: { label: "Unlisted", icon: "link", hint: "Only people with its private link can read it" },
  private: { label: "Private", icon: "lock", hint: "Its addresses are off; only share links reach it" },
}

export type StatusWord = { label: string; tone: "good" | "idle" | "warn" }
export function statusOf(p: Pick<GenesisPage, "status">): StatusWord {
  if (p.status === "published") return { label: "Published", tone: "good" }
  if (p.status === "archived") return { label: "Archived", tone: "idle" }
  return { label: "Draft", tone: "warn" }
}

const REACH: Record<Visibility, number> = { private: 0, unlisted: 1, public: 2 }
export const isWidening = (from: Visibility, to: Visibility) => REACH[to] > REACH[from]

export type PageAction =
  | { kind: "publish" }
  | { kind: "unpublish" }
  | { kind: "visibility"; to: Visibility }
  | { kind: "rollback"; version: number; when?: string }

export type Confirm = { title: string; body: string[]; confirmLabel: string; icon: "cloud-upload" | "globe" | "link" | "lock" | "arrow-undo-down"; tone?: "warn" }

const addr = (p: GenesisPage) => p.url ?? (p.slug ? `/p/${p.slug}` : "its address")

/**
 * The confirm for an action, or null when it needs none. Plain words: who will be able to read it,
 * and what changes for visitors — never "Are you sure?".
 */
export function confirmFor(p: GenesisPage, a: PageAction): Confirm | null {
  const vis = visibilityOf(p)
  const signIn = p.requiresAuth ? ["Visitors still have to sign in to read it."] : []
  if (a.kind === "unpublish") return null
  if (a.kind === "publish") {
    const who =
      vis === "public"
        ? [`Anyone with the link will be able to read this, at ${addr(p)}. Search engines may list it.`]
        : vis === "unlisted"
          ? ["Anyone with the page's private link will be able to read this. It stays out of listings and search."]
          : ["It goes live but stays private: only share links you hand out will reach it."]
    return { title: `Publish “${p.title}”?`, body: [...who, ...signIn], confirmLabel: "Publish", icon: "cloud-upload" }
  }
  if (a.kind === "visibility") {
    if (!isWidening(vis, a.to)) return null
    const live = p.status === "published"
    const who =
      a.to === "public"
        ? `Anyone will be able to find and read this at ${addr(p)} — it can be listed and indexed.`
        : "Anyone with the page's private link will be able to read this. It stays out of listings and search."
    return {
      title: `Make “${p.title}” ${VISIBILITY[a.to].label.toLowerCase()}?`,
      body: [live ? who : `${who} That starts when it is published — it is a draft now.`, ...signIn],
      confirmLabel: `Make ${VISIBILITY[a.to].label.toLowerCase()}`,
      icon: VISIBILITY[a.to].icon,
    }
  }
  return {
    title: `Roll “${p.title}” back to version ${a.version}?`,
    body: [
      `Version ${a.version}${a.when ? ` (${a.when})` : ""} replaces what is on the page now${p.version != null ? ` (version ${p.version})` : ""}.`,
      p.status === "published" ? "The page is published, so visitors see it straight away." : "The page is a draft, so nobody else sees it until it is published.",
      "Every version stays in this list.",
    ],
    confirmLabel: `Roll back to v${a.version}`,
    icon: "arrow-undo-down",
    tone: "warn",
  }
}

/** What a narrowing did, said after it happened — the links that stopped working. */
export function narrowedNote(p: GenesisPage, a: PageAction): string | undefined {
  if (a.kind === "unpublish") return `Back to draft. ${addr(p)} shows nothing until you publish it again.`
  if (a.kind === "visibility" && a.to === "unlisted") return `Unlisted. Links to /p/${p.slug ?? "…"} stop working; its private link still does.`
  if (a.kind === "visibility" && a.to === "private") return "Private. Its addresses are off; only share links reach it now."
  return undefined
}

/**
 * Which brand a page belongs to. The platform stores no page→brand link, so it is inferred, and the
 * card says how: the brand the page's own theme names; else the brand of the board that owns it
 * (several brands on one board → the one whose slug starts the page's slug); else a brand whose
 * slug starts the page's slug ("iris-desktop-…" → IRIS Desktop, the longest match wins).
 */
export type BrandMatch = { brand: BrandSummary; by: "page" | "board" | "slug" }
export function matchBrand(p: GenesisPage, brands: BrandSummary[], named?: string): BrandMatch | undefined {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "")
  if (named) {
    const n = norm(named)
    const hit = brands.find((b) => norm(b.name) === n) ?? brands.find((b) => norm(b.slug) === n)
    if (hit) return { brand: hit, by: "page" }
  }
  const slug = (p.slug ?? "").toLowerCase()
  const prefixed = (list: BrandSummary[]) =>
    list
      .filter((b) => b.slug && (slug === b.slug.toLowerCase() || slug.startsWith(`${b.slug.toLowerCase().replace(/_/g, "-")}-`)))
      .sort((a, b) => b.slug.length - a.slug.length)[0]
  if (p.ownerType === "bloq" && p.ownerId != null) {
    const onBoard = brands.filter((b) => b.bloqId === p.ownerId)
    if (onBoard.length === 1) return { brand: onBoard[0], by: "board" }
    const pick = prefixed(onBoard)
    if (pick) return { brand: pick, by: "board" }
  }
  const pick = prefixed(brands)
  return pick ? { brand: pick, by: "slug" } : undefined
}

export const BRAND_BY: Record<BrandMatch["by"], string> = {
  page: "the page's theme names this brand",
  board: "the brand of the board that owns this page",
  slug: "matched by the page's address",
}

/**
 * Where a card's picture comes from, best first. The platform's own screenshot and the og:image
 * cost one cached image each; a live frame costs a whole page load, so it is the fallback and only
 * for a page anyone can open (published, not private, no sign-in) — a draft or a gated page would
 * frame a 404 or a login wall and call it a thumbnail.
 */
export type ThumbSource = { kind: "image"; url: string } | { kind: "frame"; url: string }
export function thumbSources(p: GenesisPage): ThumbSource[] {
  const out: ThumbSource[] = []
  for (const u of [p.thumbnailUrl, p.ogImage]) if (u && /^https?:\/\//.test(u) && !out.some((s) => s.url === u)) out.push({ kind: "image", url: u })
  if (p.url && framesInApp(p.url) && p.status === "published" && !p.requiresAuth && visibilityOf(p) !== "private") out.push({ kind: "frame", url: p.url })
  return out
}

/**
 * The platform's own hosts send `frame-ancestors` naming the app (measured 2026-11-05). A client's
 * own domain may not — cottonwoodcreekbrewery.com redirects to its root, which sends
 * X-Frame-Options: sameorigin — and a refused frame draws the browser's error page in the card.
 * The detail asks the sidecar first (frame-check); a card is too cheap to ask for, so it only frames
 * these.
 */
const FRAMING_HOSTS = /^(?:[a-z0-9-]+\.)?(?:heyiris\.io|freelabel\.net)$/i
export function framesInApp(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && FRAMING_HOSTS.test(u.hostname)
  } catch {
    return false
  }
}

/** The detail preview's address: the live page, or a draft's tokenised preview, or nothing. */
export function previewAddress(p: GenesisPage, previewUrl?: string): string | undefined {
  if (p.status === "published" && p.url) return p.url
  return previewUrl
}

export const DEVICES = [
  { id: "desktop", label: "Desktop", width: 1280 },
  { id: "tablet", label: "Tablet", width: 820 },
  { id: "phone", label: "Phone", width: 390 },
] as const
export type DeviceId = (typeof DEVICES)[number]["id"]

/** Scale a device-width frame into the room there is; never up. */
export function frameScale(device: number, room: number): number {
  if (!(room > 0)) return 1
  return Math.min(1, room / device)
}

/** ↑↓ (and ←→ in a grid) move the focus; the ends stop rather than wrap. */
export function moveFocus(i: number, key: string, count: number, cols: number): number {
  if (count <= 0) return -1
  const at = i < 0 ? -1 : i
  const step = key === "ArrowDown" ? cols : key === "ArrowUp" ? -cols : key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0
  if (at < 0) return step < 0 ? count - 1 : 0
  return Math.max(0, Math.min(count - 1, at + step))
}

export const viewCommand = (slug?: string) => (slug ? `iris pages view ${slug}` : undefined)

export const PAGES_VIEW_KEY = "iris.genesis.pages.view"
export function readView(raw: string | null | undefined): PagesView {
  return raw === "list" ? "list" : "grid"
}
