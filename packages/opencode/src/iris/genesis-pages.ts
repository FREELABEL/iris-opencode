import { IRIS_API, irisFetch, resolveUserId, tokenSource, type PlatformResult } from "./platform"

/**
 * GENESIS › PAGES (#192632) — the desktop's read and act path for the account's own pages.
 *
 * READS: the list is paged BY THE PLATFORM (iris-api's paginator), so "1–24 of 1,038" is the
 * platform's own count and not the size of the first 50 rows. Published / Drafts filter there too
 * (`status=`). Visibility has no server filter (measured 2026-11-05: `visibility=` is ignored), so
 * "Private" is a scan of the account's list, cached for a minute, and says so when it was capped.
 *
 * WRITES — publish, unpublish, visibility, rollback — call the same platform routes the CLI uses
 * (`iris pages publish|unpublish|visibility|rollback`). Anything that WIDENS who can read a page,
 * and every rollback, is refused unless the caller says `confirm: true`: the panel's confirm
 * dialog is the person's yes, and a stray call without it changes nothing. Narrowing never asks.
 */

/** The seam a test replaces: the platform call and who is signed in. Production uses the real ones. */
export const genesisDeps = {
  fetch: (path: string, base: string, init?: RequestInit) => irisFetch(path, base, init),
  userId: () => resolveUserId(),
}

export type Visibility = "public" | "unlisted" | "private"
export const VISIBILITIES: Visibility[] = ["public", "unlisted", "private"]
export type StatusFilter = "all" | "published" | "draft" | "private"

export interface GenesisPage {
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
  /** The brand the page stores (pages.brand_id, #192665). Absent: the app infers one and says "guessed". */
  brandId?: number
}

const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined)
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^\d+$/.test(v) ? Number(v) : undefined)
/** The platform HTML-escapes titles ("Bottle Service, Afterparties &amp; Game Days"). */
const unescape = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">")

export function pageRow(p: any): GenesisPage {
  return {
    id: Number(p.id),
    title: unescape(String(p.title || p.slug || "Untitled")),
    slug: str(p.slug),
    status: String(p.status ?? "draft"),
    url: str(p.public_url),
    updatedAt: str(p.updated_at),
    createdAt: str(p.created_at),
    version: num(p.current_version),
    publishedAt: str(p.published_at),
    visibility: str(p.visibility),
    requiresAuth: typeof p.requires_auth === "boolean" ? p.requires_auth : undefined,
    category: str(p.category),
    description: str(p.seo_description) ? unescape(p.seo_description) : undefined,
    thumbnailUrl: str(p.thumbnail_url),
    ogImage: str(p.og_image),
    ownerType: str(p.owner_type),
    ownerId: num(p.owner_id),
    siteId: num(p.site_id),
    brandId: num(p.brand_id),
  }
}

/** Not openly public: unlisted, private, or behind a sign-in. What the "Private" filter means. */
export function isRestricted(p: Pick<GenesisPage, "visibility" | "requiresAuth">): boolean {
  return p.requiresAuth === true || p.visibility === "private" || p.visibility === "unlisted"
}

/** How far a mode reaches: private 0, unlisted 1, public 2. Absent means public (Page::effectiveVisibility). */
export function reach(mode: string | undefined): number {
  if (mode === "private") return 0
  if (mode === "unlisted") return 1
  return 2
}
export const isWidening = (from: string | undefined, to: string) => reach(to) > reach(from)

/** One page of iris-api's list query. `q` and `status` are filtered by the platform. */
function listUrl(userId: number, o: { bloqId: number; all: boolean; q?: string; status?: string; page: number; perPage: number }) {
  const parts = [`user_id=${userId}`, `per_page=${o.perPage}`, `page=${o.page}`]
  if (!o.all) parts.push("owner_type=bloq", `owner_id=${o.bloqId}`)
  if (o.q) parts.push(`search=${encodeURIComponent(o.q)}`)
  if (o.status) parts.push(`status=${o.status}`)
  return `/api/v1/pages?${parts.join("&")}`
}

/** A Laravel paginator, or a bare list. */
export function readPaginator(j: any): { rows: any[]; total?: number; lastPage?: number } {
  const d = j?.data ?? j
  if (Array.isArray(d)) return { rows: d, total: d.length, lastPage: 1 }
  const rows = Array.isArray(d?.data) ? d.data : []
  return { rows, total: num(d?.total), lastPage: num(d?.last_page) }
}

export interface PagesListing {
  pages: GenesisPage[]
  total: number | null
  totalIsExact: boolean
  hasMore: boolean
  counts: { all?: number; published?: number; draft?: number; private?: number }
}

/** The private scan is the expensive read; a minute is long enough to page through it. */
const SCAN_TTL_MS = 60_000
const SCAN_MAX_PAGES = 15
const scans = new Map<string, { at: number; rows: GenesisPage[]; capped: boolean }>()

export async function fetchPagesListing(input: {
  bloqId: number
  all: boolean
  q?: string
  filter: StatusFilter
  page: number
  perPage: number
}): Promise<PlatformResult<PagesListing>> {
  const empty: PagesListing = { pages: [], total: null, totalIsExact: false, hasMore: false, counts: {} }
  const userId = await genesisDeps.userId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  const q = input.q?.trim() || undefined
  const read = async (o: { status?: string; page: number; perPage: number }) => {
    const res = await genesisDeps.fetch(listUrl(userId, { bloqId: input.bloqId, all: input.all, q, ...o }), IRIS_API)
    if (!res.ok) throw new Error(`iris-api ${res.status}`)
    return readPaginator(await res.json())
  }
  const count = (status?: string) => read({ status, page: 1, perPage: 1 }).then((r) => r.total).catch(() => undefined)
  try {
    if (input.filter === "private") {
      const s = await scan(userId, input, q, read)
      const start = (input.page - 1) * input.perPage
      const [all, published, draft] = await Promise.all([count(), count("published"), count("draft")])
      return {
        measured: true,
        data: {
          pages: s.rows.slice(start, start + input.perPage),
          total: s.rows.length,
          totalIsExact: !s.capped,
          hasMore: start + input.perPage < s.rows.length,
          counts: defined({ all, published, draft, private: s.capped ? undefined : s.rows.length }),
        },
      }
    }
    const status = input.filter === "all" ? undefined : input.filter
    const [main, all, published, draft, board] = await Promise.all([
      read({ status, page: input.page, perPage: input.perPage }),
      status ? count() : Promise.resolve(undefined),
      status === "published" ? Promise.resolve(undefined) : count("published"),
      status === "draft" ? Promise.resolve(undefined) : count("draft"),
      // A board's own pages are usually one read, so its Private count comes with the list. The
      // whole account's is counted only when Private is asked for (or still cached from that).
      input.all ? Promise.resolve(undefined) : scan(userId, input, q, read).catch(() => undefined),
    ])
    const counts = { all: all ?? (status ? undefined : main.total), published: published ?? (status === "published" ? main.total : undefined), draft: draft ?? (status === "draft" ? main.total : undefined) }
    const cached = board ?? scans.get(scanKey(userId, input, q))
    const priv = cached && Date.now() - cached.at < SCAN_TTL_MS && !cached.capped ? cached.rows.length : undefined
    return {
      measured: true,
      data: {
        pages: main.rows.map(pageRow),
        total: main.total ?? null,
        totalIsExact: main.total != null,
        hasMore: main.lastPage != null ? input.page < main.lastPage : main.rows.length >= input.perPage,
        counts: defined({ ...counts, private: priv }),
      },
    }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

/** Not counted is absent, never null or 0. */
const defined = <T extends Record<string, number | undefined>>(o: T) =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v != null)) as Partial<Record<keyof T, number>>

const scanKey = (userId: number, i: { all: boolean; bloqId: number }, q?: string) => `${userId}|${i.all ? "all" : i.bloqId}|${q ?? ""}`

async function scan(
  userId: number,
  input: { all: boolean; bloqId: number },
  q: string | undefined,
  read: (o: { page: number; perPage: number }) => Promise<{ rows: any[]; lastPage?: number }>,
) {
  const key = scanKey(userId, input, q)
  const hit = scans.get(key)
  if (hit && Date.now() - hit.at < SCAN_TTL_MS) return hit
  const first = await read({ page: 1, perPage: 100 })
  const last = Math.min(first.lastPage ?? 1, SCAN_MAX_PAGES)
  const rest = await Promise.all(Array.from({ length: Math.max(0, last - 1) }, (_, i) => read({ page: i + 2, perPage: 100 })))
  const rows = [first, ...rest].flatMap((r) => r.rows).map(pageRow).filter(isRestricted)
  const out = { at: Date.now(), rows, capped: (first.lastPage ?? 1) > SCAN_MAX_PAGES }
  scans.set(key, out)
  return out
}

// ── One page's facts for the detail's side card ─────────────────────────────

export interface PageInfo {
  previewUrl?: string
  brandName?: string
  renderMode?: string
  ownerName?: string
  creator?: { id: number; name: string }
  updater?: { id: number; name: string }
  page: GenesisPage
}

const person = (u: any) => (u && num(u.id) != null ? { id: num(u.id)!, name: String(u.full_name || u.name || u.email || `user ${u.id}`) } : undefined)

/** The page's json_content can be megabytes; only these facts cross to the webview. */
export function infoOf(p: any): PageInfo {
  const jc = typeof p?.json_content === "string" ? safeJson(p.json_content) : p?.json_content
  return {
    previewUrl: str(p?.preview_url),
    brandName: str(jc?.theme?.branding?.name) ? unescape(jc.theme.branding.name) : undefined,
    renderMode: str(jc?.render_mode),
    ownerName: str(p?.owner?.name),
    creator: person(p?.creator),
    updater: person(p?.updater),
    page: pageRow(p ?? {}),
  }
}

const safeJson = (s: string) => {
  try {
    return JSON.parse(s)
  } catch {
    return undefined
  }
}

export async function fetchPageInfo(id: number): Promise<PlatformResult<PageInfo | undefined>> {
  const userId = await genesisDeps.userId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: undefined }
  try {
    const res = await genesisDeps.fetch(`/api/v1/pages/${id}`, IRIS_API)
    if (!res.ok) return { measured: false, reason: res.status === 404 ? "no such page on your account" : `iris-api ${res.status}`, data: undefined }
    const j = (await res.json()) as any
    return { measured: true, data: infoOf(j?.data ?? j) }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: undefined }
  }
}

// ── Versions ────────────────────────────────────────────────────────────────

export interface PageVersion {
  version: number
  createdAt?: string
  byId?: number
  summary?: string
}

/** `/pages/{id}/versions` is a Laravel paginator of rows with string-typed numbers (2026-11-05). */
export function versionRows(j: any): { versions: PageVersion[]; total?: number; lastPage?: number } {
  const p = readPaginator(j)
  const versions = p.rows.flatMap((v: any): PageVersion[] => {
    const version = num(v?.version_number ?? v?.version)
    return version == null ? [] : [{ version, createdAt: str(v?.created_at), byId: num(v?.changed_by ?? v?.created_by), summary: str(v?.change_summary) }]
  })
  return { versions, total: p.total, lastPage: p.lastPage }
}

export async function fetchPageVersions(id: number, page = 1): Promise<PlatformResult<{ versions: PageVersion[]; total?: number; hasMore: boolean }>> {
  const userId = await genesisDeps.userId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: { versions: [], hasMore: false } }
  try {
    const res = await genesisDeps.fetch(`/api/v1/pages/${id}/versions?page=${page}`, IRIS_API)
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { versions: [], hasMore: false } }
    const r = versionRows(await res.json())
    return { measured: true, data: { versions: r.versions, total: r.total, hasMore: r.lastPage != null && page < r.lastPage } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: { versions: [], hasMore: false } }
  }
}

export interface VersionRender {
  version: number
  by?: string
  createdAt?: string
  renderMode?: string
  /** A whole document for a sandboxed srcdoc frame, or absent with `reason`. */
  html?: string
}

/**
 * A past version, drawn without touching the page. A bespoke page (`render_mode: html`) is its own
 * HTML and CSS; a component page needs the platform's preview session, which refuses large pages
 * ("page_too_large") — then the reason says so instead of drawing the live page and calling it v3.
 */
export function versionDocument(jc: any, origin: string): string | undefined {
  if (!jc || jc.render_mode !== "html" || typeof jc.html !== "string") return undefined
  const css = typeof jc.css === "string" && jc.css ? `<style>${jc.css}</style>` : ""
  const base = `<base href="${origin.replace(/"/g, "")}/">`
  if (/<html[\s>]/i.test(jc.html)) return jc.html.replace(/<head([^>]*)>/i, `<head$1>${base}${css}`)
  return `<!doctype html><html><head><meta charset="utf-8">${base}${css}</head><body>${jc.html}</body></html>`
}

export async function fetchVersionRender(id: number, version: number): Promise<PlatformResult<VersionRender>> {
  const empty: VersionRender = { version }
  const userId = await genesisDeps.userId()
  if (!userId) return { measured: false, reason: `not signed in (token: ${tokenSource()})`, data: empty }
  try {
    const res = await genesisDeps.fetch(`/api/v1/pages/${id}/versions/${version}`, IRIS_API)
    if (!res.ok) return { measured: false, reason: res.status === 404 ? `there is no version ${version}` : `iris-api ${res.status}`, data: empty }
    const v = ((await res.json()) as any)?.data
    const jc = typeof v?.json_content === "string" ? safeJson(v.json_content) : v?.json_content
    const meta = { version, by: person(v?.changer)?.name, createdAt: str(v?.created_at), renderMode: str(jc?.render_mode) }
    const doc = versionDocument(jc, IRIS_API)
    if (doc) return { measured: true, data: { ...meta, html: doc } }
    if (!jc) return { measured: false, reason: "the platform keeps no content for this version", data: meta }
    const mint = await genesisDeps.fetch(`/api/v1/preview/sessions`, IRIS_API, { method: "POST", body: JSON.stringify({ page: { id, title: "", status: "draft", json_content: jc } }) })
    const m = (await mint.json().catch(() => ({}))) as any
    if (!mint.ok || !m?.session_id) {
      const why = m?.reason === "page_too_large" ? "this version is too large for the platform's preview" : (m?.error ?? `the preview was refused (HTTP ${mint.status})`)
      return { measured: false, reason: why, data: meta }
    }
    const r = await genesisDeps.fetch(`/api/v1/preview/${encodeURIComponent(String(m.session_id))}/render`, IRIS_API)
    if (!r.ok) return { measured: false, reason: `the preview render answered HTTP ${r.status}`, data: meta }
    const html = (await r.text()).replace(/<head([^>]*)>/i, `<head$1><base href="${IRIS_API}/">`)
    return { measured: true, data: { ...meta, html } }
  } catch (e) {
    return { measured: false, reason: e instanceof Error ? e.message : String(e), data: empty }
  }
}

// ── Acting on a page ────────────────────────────────────────────────────────

export interface PageActionResult {
  ok: boolean
  reason?: string
  page?: GenesisPage
}

const NEEDS_CONFIRM = "this makes the page reachable by more people — it needs the person's confirmation"

async function readPage(id: number) {
  const res = await genesisDeps.fetch(`/api/v1/pages/${id}`, IRIS_API)
  if (!res.ok) throw new Error(res.status === 404 ? "no such page on your account" : `iris-api ${res.status}`)
  return ((await res.json()) as any)?.data
}

async function failure(res: Response, what: string) {
  const j = (await res.json().catch(() => ({}))) as any
  return String(j?.message ?? j?.error ?? `${what}: iris-api ${res.status}`)
}

/**
 * After a change lands: a stale rendered page keeps serving the old reach, so purge it like the CLI
 * does (best effort), and forget the Private scan — it described the page before the change.
 */
const purge = (slug?: string) => {
  scans.clear()
  return slug ? genesisDeps.fetch("/api/internal/cache/purge-page", IRIS_API, { method: "POST", body: JSON.stringify({ slug }) }).catch(() => undefined) : undefined
}

export async function setPagePublished(input: { id: number; publish: boolean; confirm?: boolean }): Promise<PageActionResult> {
  if (input.publish && input.confirm !== true) return { ok: false, reason: NEEDS_CONFIRM }
  if (!(await genesisDeps.userId())) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  try {
    const res = await genesisDeps.fetch(`/api/v1/pages/${input.id}/${input.publish ? "publish" : "unpublish"}`, IRIS_API, { method: "POST" })
    if (!res.ok) return { ok: false, reason: await failure(res, input.publish ? "Publish" : "Unpublish") }
    const p = pageRow(await readPage(input.id))
    await purge(p.slug)
    return { ok: true, page: p }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function setPageVisibility(input: { id: number; mode: string; confirm?: boolean }): Promise<PageActionResult> {
  if (!(VISIBILITIES as string[]).includes(input.mode)) return { ok: false, reason: `"${input.mode}" is not public, unlisted or private` }
  if (!(await genesisDeps.userId())) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  try {
    // Widening is judged against what the platform holds NOW, not what the panel last drew.
    const before = pageRow(await readPage(input.id))
    if (isWidening(before.visibility, input.mode) && input.confirm !== true) return { ok: false, reason: NEEDS_CONFIRM, page: before }
    const res = await genesisDeps.fetch(`/api/v1/pages/${input.id}`, IRIS_API, { method: "PUT", body: JSON.stringify({ visibility: input.mode }) })
    if (!res.ok) return { ok: false, reason: await failure(res, "Set visibility") }
    const after = pageRow(await readPage(input.id))
    // The API accepting the PUT and dropping the field is "not applied", never success.
    if (after.visibility !== input.mode) return { ok: false, reason: `the platform still reports ${after.visibility ?? "no visibility"} — nothing changed`, page: after }
    await purge(after.slug)
    return { ok: true, page: after }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function rollbackPage(input: { id: number; version: number; confirm?: boolean }): Promise<PageActionResult> {
  if (input.confirm !== true) return { ok: false, reason: "a rollback replaces the page's content — it needs the person's confirmation" }
  if (!(await genesisDeps.userId())) return { ok: false, reason: `not signed in (token: ${tokenSource()})` }
  try {
    const res = await genesisDeps.fetch(`/api/v1/pages/${input.id}/rollback/${input.version}`, IRIS_API, { method: "POST" })
    if (!res.ok) return { ok: false, reason: res.status === 404 ? `there is no version ${input.version}` : await failure(res, "Rollback") }
    const p = pageRow(await readPage(input.id))
    await purge(p.slug)
    return { ok: true, page: p }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
