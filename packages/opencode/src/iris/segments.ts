import { execFile } from "child_process"
import { GlobalBus } from "@/bus/global"
import { FL_API, irisFetch, type PlatformResult } from "./platform"
import { irisCliPath } from "./playbook-install"
import { postKey } from "./som-preflight"

/**
 * AUDIENCES (#193533 U2a, #193534 U2b, #193535 U2c; epic #193481): a board's saved segments, and
 * the ONE draft segment the person and the agent build together.
 *
 * The server half is fl-api's segments API (D3 #193484, fl-api PR #308; CLI `iris segment`, PR #590):
 *   GET/POST  /api/v1/bloqs/{bloq}/segments          GET/PATCH/DELETE /api/v1/segments/{id}
 *   GET       /api/v1/segments/{id}/members?page=    POST /api/v1/bloqs/{bloq}/segments/preview {filters}
 * Preview saves nothing. Every reader here shapes what fl-api sends defensively and fills nothing in.
 *
 * ONE DRAFT PER BOARD, HELD BY THE ENGINE. The Audiences panel and the agent's segment_* tools
 * edit the same object, so a filter the agent adds is the filter the person watches land. Each
 * change bumps `rev` (one counter across boards) and moves the focus to that board: the panel
 * follows whoever touched a draft last. The draft is in memory only — saved segments are fl-api's.
 *
 * LIVE (U2c). A change emits `iris.outreach.segment.updated` on the event stream; the panel also
 * polls the draft every 5 s while visible. fl-api's SegmentUpdated is broadcast on the private
 * channel `private-bloq.{id}` (event `outreach.segment.updated`); this engine has no broadcast
 * client or channel auth, so it does not subscribe, and a CLI edit arrives through the poll: a draft that still matches
 * its saved segment re-reads that segment on each read, and takes the server's filters when they
 * changed. A draft with unsaved edits keeps them.
 *
 * Nothing here sends a message. segment_find adds leads to a board (the CLI's `reachr scrape
 * --write`); targeting a campaign changes which segment it draws from on its next run.
 */

export const SEGMENT_EVENT = "iris.outreach.segment.updated"

/** fl-api's SegmentFilters::KEYS, in its order: the order the breakdown walks. */
export const FILTER_KEYS = [
  "source_post",
  "comment_contains",
  "discovery_mode",
  "status_in",
  "replied",
  "contacted",
  "niche_in",
  "role_in",
  "city_contains",
  "followers_min",
  "followers_max",
  "has_email",
] as const
export type FilterKey = (typeof FILTER_KEYS)[number]
export type FilterValue = string | number | boolean | string[]
export type SegmentFilter = { key: FilterKey; value: FilterValue }

const LISTS = new Set<FilterKey>(["status_in", "niche_in", "role_in"])
const FLAGS = new Set<FilterKey>(["replied", "contacted", "has_email"])
const NUMBERS = new Set<FilterKey>(["followers_min", "followers_max"])

export const isFilterKey = (k: unknown): k is FilterKey => typeof k === "string" && (FILTER_KEYS as readonly string[]).includes(k)

/**
 * A value as the agent or a URL gives it → the type fl-api takes. "a, b" is a list for the *_in
 * keys; yes/no/true/false for flags; a number for followers. A post URL becomes its shortcode.
 * Undefined when the text says nothing usable.
 */
export function parseFilterValue(key: FilterKey, raw: unknown): FilterValue | undefined {
  if (LISTS.has(key)) {
    const list = (Array.isArray(raw) ? raw.map(String) : String(raw ?? "").split(",")).map((s) => s.trim()).filter(Boolean)
    return list.length ? list : undefined
  }
  if (FLAGS.has(key)) {
    if (typeof raw === "boolean") return raw
    const s = String(raw ?? "").trim().toLowerCase()
    if (["yes", "true", "1", "y"].includes(s)) return true
    if (["no", "false", "0", "n"].includes(s)) return false
    return undefined
  }
  if (NUMBERS.has(key)) {
    const n = Number(String(raw ?? "").replace(/[,_\s]/g, "").replace(/k$/i, "000"))
    return String(raw ?? "").trim() && Number.isFinite(n) && n >= 0 ? Math.round(n) : undefined
  }
  const s = String(raw ?? "").trim()
  if (!s) return undefined
  return key === "source_post" ? (postKey(s) ?? s) : s
}

/** The ordered list → the `filters` object fl-api takes. fl-api re-orders keys into FILTER_KEYS order. */
export function filtersToApi(filters: SegmentFilter[]): Record<string, FilterValue> {
  return Object.fromEntries(filters.map((f) => [f.key, f.value]))
}

/** fl-api's `filters` (an object, or a list of {key,value}) → the ordered list. Unknown keys are dropped. */
export function filtersFromApi(raw: unknown): SegmentFilter[] {
  const pairs: [unknown, unknown][] = Array.isArray(raw)
    ? raw.map((f: any) => [f?.key ?? f?.filter, f?.value])
    : raw && typeof raw === "object"
      ? Object.entries(raw)
      : []
  return pairs.flatMap(([k, v]) => {
    if (!isFilterKey(k)) return []
    const value = parseFilterValue(k, v)
    return value === undefined ? [] : [{ key: k, value }]
  })
}

// ─── Shapes (fl-api PR #308, SomSegmentController / SegmentQuery) ───────────────

export type Segment = {
  id: number
  bloq_id: number
  name: string
  filters: SegmentFilter[]
  /** The breakdown's final `matched`; null when fl-api sent no breakdown. */
  member_count: number | null
  updated_at: string | null
}

/**
 * One step of fl-api's breakdown, in its fixed key order: `before` leads reached this filter,
 * `known` of them have the field, `matched` are left after it. `of` is the whole board.
 */
export type BreakdownRow = {
  key: FilterKey | string
  before: number
  known: number
  unknown: number
  matched: number
  of: number
  /** status / replied / contacted / has_email: every lead has the field. */
  always_known: boolean
}

export type MemberPage = { data: Member[]; total: number; page: number; last_page: number }

export type Member = {
  id: number
  handle: string | null
  name: string
  status: string
  comment: string
  niche: string | null
  role: string | null
  city: string | null
  /** null = unknown. fl-api already treats a 0 as unknown (the scraper wrote 0 for unread profiles). */
  followers: number | null
}

export type Preview = { total: number | null; of: number | null; breakdown: BreakdownRow[]; members: MemberPage }

const num = (v: unknown): number | null => {
  const n = Number(v)
  return v === null || v === undefined || v === "" || !Number.isFinite(n) ? null : n
}
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null)
const unwrap = (b: any) => (b && typeof b === "object" && "data" in b && b.data && typeof b.data === "object" && !Array.isArray(b.data) ? b.data : b)

export function shapeSegment(s: any): Segment {
  return {
    id: Number(s?.id),
    bloq_id: Number(s?.bloq_id),
    name: String(s?.name ?? ""),
    filters: filtersFromApi(s?.filters),
    member_count: num(s?.breakdown?.matched),
    updated_at: str(s?.updated_at),
  }
}

/** fl-api's member row (SegmentQuery::memberRow). The handle comes without its @. */
export function shapeMember(l: any): Member {
  const handle = str(l?.handle)
  const followers = num(l?.followers)
  return {
    id: Number(l?.id),
    handle: handle ? `@${handle.replace(/^@/, "")}` : null,
    name: str(l?.name) ?? `Lead ${l?.id}`,
    status: str(l?.status) ?? "—",
    comment: str(l?.comment) ?? "",
    niche: str(l?.niche),
    role: str(l?.role),
    city: str(l?.city),
    followers: followers && followers > 0 ? followers : null,
  }
}

/** `{data[], meta{total, per_page, current_page, last_page}}` — a preview's members, or the members route's data. */
export function shapePage(raw: any): MemberPage {
  const rows: any[] = Array.isArray(raw?.data) ? raw.data : []
  return {
    data: rows.map(shapeMember),
    total: num(raw?.meta?.total) ?? rows.length,
    page: num(raw?.meta?.current_page) ?? 1,
    last_page: num(raw?.meta?.last_page) ?? 1,
  }
}

/** The breakdown's steps, in the order fl-api walked them. */
export function shapeBreakdown(raw: any): BreakdownRow[] {
  const steps: any[] = Array.isArray(raw?.steps) ? raw.steps : []
  return steps.flatMap((r) => {
    const before = num(r?.before)
    const matched = num(r?.matched)
    if (typeof r?.key !== "string" || before === null || matched === null) return []
    const known = num(r?.known) ?? before
    return [{ key: r.key, before, known, unknown: num(r?.unknown) ?? before - known, matched, of: num(r?.of) ?? before, always_known: r?.field_always_known === true }]
  })
}

/** POST …/segments/preview's data: {bloq_id, filters, breakdown, members, saved:false}. */
export function shapePreview(raw: any): Preview {
  const d = unwrap(raw)
  return {
    total: num(d?.breakdown?.matched),
    of: num(d?.breakdown?.of),
    breakdown: shapeBreakdown(d?.breakdown),
    members: shapePage(d?.members),
  }
}

/** "788 of 849" when every lead could be judged; else "3 of 4 known · 6,046 unknown"; known 0 = "can't be judged yet". */
export function stepText(r: BreakdownRow): string {
  const n = (v: number) => v.toLocaleString("en-US")
  if (r.always_known || r.unknown === 0) return `${n(r.matched)} of ${n(r.before)}`
  if (r.known === 0) return `can't be judged yet · ${n(r.unknown)} unknown`
  return `${n(r.matched)} of ${n(r.known)} known · ${n(r.unknown)} unknown`
}

// ─── fl-api ───────────────────────────────────────────────────────────────────

type Exec = (file: string, args: string[], opts: { timeoutMs: number }) => Promise<{ code: number; stdout: string; stderr: string }>

/** The two ways out of this module, swappable in tests so a test can see which route was asked. */
export const SegmentIO = {
  fl: (path: string, init?: RequestInit) => irisFetch(path, FL_API, init),
  exec: ((file, args, opts) =>
    new Promise((resolve) => {
      execFile(file, args, { timeout: opts.timeoutMs, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
        const code = err ? (typeof (err as any).code === "number" ? (err as any).code : 1) : 0
        resolve({ code, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") || (err ? String(err.message) : "") })
      })
    })) as Exec,
  cli: () => irisCliPath(),
}

async function fl(path: string, init?: { method: string; body?: unknown }): Promise<{ ok: true; body: any } | { ok: false; reason: string }> {
  try {
    const res = await SegmentIO.fl(
      path,
      init ? { method: init.method, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) } : undefined,
    )
    const body = (await res.json().catch(() => null)) as any
    if (res.status === 404 && !body?.message && !body?.error) return { ok: false, reason: `fl-api has no ${path} yet (segments API, #193484)` }
    // A 422 names the bad key in `errors` ("Unknown filter key(s): … Allowed: …"); its `message` is generic.
    const detail = body?.errors && typeof body.errors === "object" ? Object.values(body.errors).flat().find((x) => typeof x === "string") : undefined
    if (!res.ok) return { ok: false, reason: (detail as string | undefined) ?? body?.error ?? body?.message ?? `fl-api ${res.status}` }
    return { ok: true, body }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function listSegments(bloq: number): Promise<PlatformResult<Segment[]>> {
  const r = await fl(`/api/v1/bloqs/${bloq}/segments`)
  if (!r.ok) return { measured: false, reason: r.reason, data: [] }
  const list = r.body?.data?.segments ?? r.body?.segments ?? r.body?.data ?? r.body
  return { measured: true, data: Array.isArray(list) ? list.map(shapeSegment) : [] }
}

export async function getSegment(id: number): Promise<PlatformResult<Segment | null>> {
  const r = await fl(`/api/v1/segments/${id}`)
  if (!r.ok) return { measured: false, reason: r.reason, data: null }
  return { measured: true, data: shapeSegment(r.body?.data?.segment ?? r.body?.segment ?? unwrap(r.body)) }
}

export async function segmentMembers(id: number, page = 1): Promise<PlatformResult<MemberPage>> {
  const r = await fl(`/api/v1/segments/${id}/members?page=${Math.max(1, Math.floor(page))}&per_page=25`)
  if (!r.ok) return { measured: false, reason: r.reason, data: { data: [], total: 0, page: 1, last_page: 1 } }
  return { measured: true, data: shapePage(unwrap(r.body)) }
}

/** Breakdown + the first page of members; saves nothing, fires no event. fl-api pages only saved segments. */
export async function previewSegment(bloq: number, filters: SegmentFilter[]): Promise<PlatformResult<Preview | null>> {
  const r = await fl(`/api/v1/bloqs/${bloq}/segments/preview`, { method: "POST", body: { filters: filtersToApi(filters), per_page: 25 } })
  if (!r.ok) return { measured: false, reason: r.reason, data: null }
  return { measured: true, data: shapePreview(r.body) }
}

/** POST a new segment, or PATCH the one the draft came from. */
async function writeSegment(bloq: number, id: number | null, name: string, filters: SegmentFilter[]) {
  const body = { name, filters: filtersToApi(filters) }
  const r = id ? await fl(`/api/v1/segments/${id}`, { method: "PATCH", body }) : await fl(`/api/v1/bloqs/${bloq}/segments`, { method: "POST", body })
  if (!r.ok) return { ok: false as const, reason: r.reason }
  return { ok: true as const, segment: shapeSegment(r.body?.data?.segment ?? r.body?.segment ?? unwrap(r.body)) }
}

/** Point a SOM campaign at a segment (D3 adds `segment_id`). The next run draws from it; nothing sends now. */
export async function targetCampaign(campaign: number, segment: number | null): Promise<PlatformResult<{ campaign: number; segment_id: number | null }>> {
  const r = await fl(`/api/v1/som/campaigns/${campaign}`, { method: "PUT", body: { segment_id: segment } })
  if (!r.ok) return { measured: false, reason: r.reason, data: { campaign, segment_id: segment } }
  const c = unwrap(r.body)?.campaign ?? unwrap(r.body)
  if (c && typeof c === "object" && "id" in c && !("segment_id" in c))
    return { measured: false, reason: "fl-api accepted the update but its campaign has no segment_id field yet (#193484)", data: { campaign, segment_id: null } }
  return { measured: true, data: { campaign, segment_id: num(c?.segment_id) ?? segment } }
}

// ─── The draft ────────────────────────────────────────────────────────────────

export type Draft = {
  bloq: number
  /** The saved segment this draft edits; null for a new one. */
  segment_id: number | null
  name: string
  filters: SegmentFilter[]
  /** Bumped on every change, across all boards. The panel adopts a draft with a higher rev. */
  rev: number
  /** The filters + name as last saved/read from fl-api; equal to the draft = nothing unsaved. */
  saved: string | null
  /** Who made the last change: "panel", "agent", "server" (a CLI edit read back), "today". */
  by: string
  updated_at: string
}

const drafts = new Map<number, Draft>()
let rev = 0
let focus: number | undefined

const snapshot = (d: Pick<Draft, "name" | "filters">) => JSON.stringify({ name: d.name, filters: d.filters })
export const unsaved = (d: Draft) => d.saved !== snapshot(d)

function emit(d: Draft, directory?: string) {
  GlobalBus.emit("event", { directory, payload: { type: SEGMENT_EVENT, properties: { bloq: d.bloq, rev: d.rev, segment_id: d.segment_id, by: d.by } } })
}

function put(d: Omit<Draft, "rev" | "updated_at">): Draft {
  const next = { ...d, rev: ++rev, updated_at: new Date().toISOString() }
  drafts.set(d.bloq, next)
  focus = d.bloq
  emit(next)
  return next
}

const fresh = (bloq: number): Draft => ({ bloq, segment_id: null, name: "", filters: [], rev: 0, saved: null, by: "", updated_at: new Date(0).toISOString() })

/**
 * The draft for a board, or (no board) the one touched last. A clean draft of a saved segment
 * re-reads it, so an edit from the CLI or another device lands here within one poll.
 */
export async function readDraft(bloq?: number): Promise<PlatformResult<Draft | null>> {
  const b = bloq ?? focus
  if (b === undefined) return { measured: true, data: null }
  const d = drafts.get(b) ?? fresh(b)
  if (!d.segment_id || unsaved(d)) return { measured: true, data: d }
  const s = await getSegment(d.segment_id)
  if (!s.measured || !s.data) return { measured: true, reason: s.reason, data: d }
  const server = snapshot(s.data)
  if (server === d.saved) return { measured: true, data: d }
  return { measured: true, data: put({ ...d, name: s.data.name, filters: s.data.filters, saved: server, by: "server" }) }
}

export type DraftChange = {
  bloq: number
  filters?: SegmentFilter[]
  name?: string
  /** Start over: a new, empty draft on this board. */
  reset?: boolean
  /** Open a saved segment into the draft. */
  load?: number
  by?: string
}

export async function changeDraft(c: DraftChange): Promise<PlatformResult<Draft>> {
  const by = c.by ?? "panel"
  if (c.load) {
    const s = await getSegment(c.load)
    if (!s.measured || !s.data) return { measured: false, reason: s.reason ?? `segment ${c.load} not found`, data: drafts.get(c.bloq) ?? fresh(c.bloq) }
    return { measured: true, data: put({ bloq: s.data.bloq_id || c.bloq, segment_id: s.data.id, name: s.data.name, filters: s.data.filters, saved: snapshot(s.data), by }) }
  }
  const base = c.reset ? fresh(c.bloq) : (drafts.get(c.bloq) ?? fresh(c.bloq))
  // fl-api walks (and stores) filters in FILTER_KEYS order; the draft keeps that order too, so
  // the panel's rows, the breakdown's steps and the saved segment line up one to one.
  const filters = (c.filters ?? base.filters).filter((f) => isFilterKey(f.key)).toSorted((a, b) => FILTER_KEYS.indexOf(a.key) - FILTER_KEYS.indexOf(b.key))
  return { measured: true, data: put({ ...base, filters, name: c.name ?? base.name, by }) }
}

/** Add a filter, or replace the value of one already there (it keeps its place in the order). */
export async function addFilter(bloq: number, key: FilterKey, raw: unknown, by = "agent"): Promise<PlatformResult<Draft>> {
  const value = parseFilterValue(key, raw)
  const d = drafts.get(bloq) ?? fresh(bloq)
  if (value === undefined) return { measured: false, reason: `"${String(raw)}" is not a value for ${key}`, data: d }
  const filters = d.filters.some((f) => f.key === key) ? d.filters.map((f) => (f.key === key ? { key, value } : f)) : [...d.filters, { key, value }]
  return changeDraft({ bloq, filters, by })
}

export async function removeFilter(bloq: number, key: FilterKey, by = "agent"): Promise<PlatformResult<Draft>> {
  const d = drafts.get(bloq) ?? fresh(bloq)
  if (!d.filters.some((f) => f.key === key)) return { measured: false, reason: `the draft has no ${key} filter`, data: d }
  return changeDraft({ bloq, filters: d.filters.filter((f) => f.key !== key), by })
}

export async function saveDraft(bloq: number, name?: string, by = "panel"): Promise<PlatformResult<Draft>> {
  const d = drafts.get(bloq) ?? fresh(bloq)
  const label = (name ?? d.name).trim()
  if (!label) return { measured: false, reason: "a segment needs a name", data: d }
  if (!d.filters.length) return { measured: false, reason: "a segment needs at least one filter", data: d }
  const w = await writeSegment(bloq, d.segment_id, label, d.filters)
  if (!w.ok) return { measured: false, reason: w.reason, data: d }
  const filters = w.segment.filters.length ? w.segment.filters : d.filters
  const saved = { name: w.segment.name || label, filters }
  return { measured: true, data: put({ ...d, segment_id: w.segment.id || d.segment_id, ...saved, saved: snapshot(saved), by }) }
}

/** Tests only. */
export function resetDrafts() {
  drafts.clear()
  rev = 0
  focus = undefined
}

// ─── Find (adds leads; never sends) ──────────────────────────────────────────

export type FindInput = { bloq: number; post_url?: string; urls?: string[]; limit?: number }
export type FindResult = { added: number | null; already: number | null; failed: number | null; found: number | null; source: string }

/**
 * The CLI's `iris reachr scrape <bloq> … --write`: a post's commenters (--instagram <post>) or the
 * people on public pages (urls). It ADDS leads to the board. It sends nothing — scrape has no send
 * path. Instagram reads need the logged-in session on the computer that runs it.
 */
export function findArgs(i: FindInput): string[] | string {
  const limit = i.limit && i.limit > 0 ? ["--limit", String(Math.min(500, Math.floor(i.limit)))] : []
  if (i.post_url) {
    if (!postKey(i.post_url)) return `not an Instagram post URL: ${i.post_url}`
    return ["reachr", "scrape", String(i.bloq), "--instagram", i.post_url, "--write", "--json", ...limit]
  }
  const urls = (i.urls ?? []).map((u) => u.trim()).filter(Boolean)
  if (!urls.length) return "give a post_url or at least one page URL"
  const bad = urls.find((u) => !/^https?:\/\//i.test(u))
  if (bad) return `only http(s) pages can be read: ${bad}`
  return ["reachr", "scrape", String(i.bloq), ...urls.slice(0, 10), "--write", "--json", ...limit]
}

export async function findPeople(i: FindInput): Promise<PlatformResult<FindResult | null>> {
  const args = findArgs(i)
  if (typeof args === "string") return { measured: false, reason: args, data: null }
  const cli = SegmentIO.cli()
  if (!cli) return { measured: false, reason: "the iris CLI is not installed on this computer (~/.iris/bin/iris)", data: null }
  const r = await SegmentIO.exec(cli, args, { timeoutMs: 10 * 60_000 })
  const source = i.post_url ? `commenters on ${i.post_url}` : `${(i.urls ?? []).length} page(s)`
  const body = (() => {
    try {
      return JSON.parse(r.stdout.slice(r.stdout.indexOf("{")))
    } catch {
      return null
    }
  })()
  if (r.code !== 0 || body?.error)
    return { measured: false, reason: str(body?.error) ?? ((r.stderr || r.stdout).trim().split("\n").at(-1) || `iris exited ${r.code}`), data: null }
  const count = (v: unknown) => (Array.isArray(v) ? v.length : null)
  return {
    measured: true,
    data: {
      added: count(body?.outcome?.created),
      already: count(body?.outcome?.existing),
      failed: count(body?.outcome?.failed),
      found: count(body?.leads),
      source,
    },
  }
}
