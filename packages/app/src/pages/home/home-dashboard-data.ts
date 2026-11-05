import type { HeartbeatRow } from "@/components/session/iris-heartbeats-model"
import type { AgentsPayload, HivePayload, InboxPayload } from "./home-today-model"
import type { FleetPayload } from "./home-fleet-model"

/**
 * Home's data, read once and kept outside the page (#192222). The page unmounts every time you
 * leave it, and /iris/heartbeats alone takes ~1.5 s, so every visit used to start blank. The same
 * rule as Playbooks and the Atlas copy: show the last good copy at once, refresh it behind the page,
 * and never let a failed read replace a good one.
 */

export type BeatsPayload = { measured: boolean; reason?: string | null; heartbeats: HeartbeatRow[] }
export type AccountsPayload = { accounts: { id: number; active?: boolean }[] }
export type BloqsPayload = { measured: boolean; total?: number; bloqs: unknown[] }
export type RecentItem = {
  id: number
  title: string
  bloqId: number
  bloqName?: string
  listName?: string
  createdAt?: string
  updatedAt?: string
}
export type RecentPayload = { measured: boolean; reason?: string; items: RecentItem[] }
export type InboxItem = {
  index: number
  read: boolean
  type: string
  from: string
  receivedAt?: string
  label: string
  preview?: string
}
export type InboxList = InboxPayload & { items?: InboxItem[] }
export type HomeDashboardData = {
  hive: HivePayload
  agents: AgentsPayload
  inbox: InboxList
  recent: RecentPayload
  bloqs: BloqsPayload
  beats: BeatsPayload
  accounts: AccountsPayload
  /** Sessions on every machine you have (#192626) — Hive › Sessions' read. */
  sessions: FleetPayload
  at: number
}

type Fetch = typeof globalThis.fetch

/** Parts that came back as a fallback because the read failed — a refresh keeps the last good part. */
const FAILED = new WeakSet<object>()
export function failedPart<T extends object>(fallback: T, reason: string): T {
  const part = { ...fallback, reason }
  FAILED.add(part)
  return part
}

/**
 * Each part lands on its own (#192535). This used to be one Promise.all, so Home showed nothing
 * until the slowest read finished — /iris/heartbeats, ~2.6 s — while the counts it could have drawn
 * had been back for two seconds. `onPart` hears every arrival; parts not yet back are placeholders
 * marked failed, so a merge keeps the last good copy of them instead of blanking it.
 */
export async function fetchHomeDashboard(
  base: string,
  fetch: Fetch,
  onPart?: (partial: HomeDashboardData) => void,
): Promise<HomeDashboardData> {
  const root = base.replace(/\/$/, "")
  const get = async <T extends object>(path: string, fallback: T): Promise<T> => {
    try {
      const res = await fetch(`${root}${path}`, { headers: { Accept: "application/json" } })
      if (!res.ok) return failedPart(fallback, `engine ${res.status}`)
      return (await res.json()) as T
    } catch (e) {
      return failedPart(fallback, e instanceof Error ? e.message : String(e))
    }
  }
  const empty = {
    hive: { measured: false, nodes: [] } as HivePayload,
    agents: { measured: false, agents: [] } as AgentsPayload,
    inbox: { measured: false, unread: null } as InboxList,
    bloqs: { measured: false, bloqs: [] } as BloqsPayload,
    beats: { measured: false, heartbeats: [] } as BeatsPayload,
    accounts: { accounts: [] } as AccountsPayload,
    recent: { measured: false, items: [] } as RecentPayload,
    sessions: { measured: false, nodes: [] } as FleetPayload,
  }
  type Part = keyof typeof empty
  const parts = Object.fromEntries(
    (Object.keys(empty) as Part[]).map((k) => [k, failedPart(empty[k], "loading")]),
  ) as unknown as Omit<HomeDashboardData, "at">
  const land = <K extends Part>(k: K, path: string) =>
    get(path, empty[k]).then((value) => {
      ;(parts as Record<Part, unknown>)[k] = value
      onPart?.({ ...parts, at: Date.now() })
    })
  await Promise.all([
    land("hive", "/iris/hive?perPage=200"),
    land("agents", "/iris/agents-mine"),
    land("inbox", "/iris/inbox?perPage=25"),
    land("bloqs", "/iris/bloqs?perPage=1"),
    land("beats", "/iris/heartbeats"),
    land("accounts", "/iris/accounts"),
    land("recent", "/iris/recent?perPage=50"),
    land("sessions", "/iris/hive/sessions"),
  ])
  return { ...parts, at: Date.now() }
}
export function keepGoodParts(prev: HomeDashboardData, next: HomeDashboardData): HomeDashboardData {
  const pick = <K extends Exclude<keyof HomeDashboardData, "at">>(k: K) => (FAILED.has(next[k]) ? prev[k] : next[k])
  return {
    hive: pick("hive"),
    agents: pick("agents"),
    inbox: pick("inbox"),
    bloqs: pick("bloqs"),
    beats: pick("beats"),
    accounts: pick("accounts"),
    recent: pick("recent"),
    sessions: pick("sessions"),
    at: next.at,
  }
}

/** Stale-while-revalidate per key: fresh copies are served as they are, stale ones served and refreshed. */
export function createSwrCache<T>(opts: {
  freshMs: number
  staleMs: number
  merge?: (prev: T, next: T) => T
  now?: () => number
  /** Where a copy outlives the page (a reload, a relaunch); read once per key, written after each read. */
  storage?: {
    load(key: string): { value: T; at: number } | undefined
    save(key: string, entry: { value: T; at: number }): void
  }
}) {
  const now = opts.now ?? Date.now
  const entries = new Map<string, { value: T; at: number }>()
  const inflight = new Map<string, Promise<T>>()
  const listeners = new Set<(key: string, value: T) => void>()
  const entryOf = (key: string) => {
    let entry = entries.get(key)
    if (!entry && opts.storage) {
      entry = opts.storage.load(key)
      if (entry) entries.set(key, entry)
    }
    return entry
  }
  const age = (key: string) => {
    const entry = entryOf(key)
    return entry ? now() - entry.at : Infinity
  }
  // `fetch` may report partial values as they arrive; listeners see them (merged over the last
  // good copy), but only the finished value is kept and stored.
  type Fetcher = (progress: (partial: T) => void) => Promise<T>
  const load = (key: string, fetch: Fetcher): Promise<T> => {
    const running = inflight.get(key)
    if (running) return running
    const pending = fetch((partial) => {
      const prev = entryOf(key)
      const value = prev && opts.merge ? opts.merge(prev.value, partial) : partial
      for (const fn of listeners) fn(key, value)
    })
      .then((next) => {
        const prev = entryOf(key)
        const value = prev && opts.merge ? opts.merge(prev.value, next) : next
        const entry = { value, at: now() }
        entries.set(key, entry)
        opts.storage?.save(key, entry)
        for (const fn of listeners) fn(key, value)
        return value
      })
      .finally(() => inflight.delete(key))
    inflight.set(key, pending)
    return pending
  }
  return {
    load,
    /** The copy if it is still usable (younger than staleMs); refreshed in the background once it is not fresh. */
    read(key: string, fetch: Fetcher): T | undefined {
      const a = age(key)
      if (a > opts.freshMs) void load(key, fetch).catch(() => {})
      return a <= opts.staleMs ? entryOf(key)?.value : undefined
    },
    /** Load in the background unless there is a copy younger than maxAgeMs. */
    warm(key: string, fetch: Fetcher, maxAgeMs: number) {
      if (age(key) > maxAgeMs) void load(key, fetch).catch(() => {})
    },
    subscribe(fn: (key: string, value: T) => void) {
      listeners.add(fn)
      return () => {
        listeners.delete(fn)
      }
    },
  }
}

/** A reload draws Home from the last copy (counts and names, nothing sensitive), still within staleMs. */
const STORED = "iris.home.dashboard:"
const FRESH_MS = 60_000
const localCopy = {
  load(key: string) {
    try {
      const raw = localStorage.getItem(STORED + key)
      if (!raw) return undefined
      const entry = JSON.parse(raw) as { value: HomeDashboardData; at: number }
      // The stored copy has no activity, inbox items or sessions (below), so it is never fresh: a
      // reload within a minute of the last read sat on "Reading…" until the next 60 s tick (#192626).
      return { ...entry, at: Math.min(entry.at, Date.now() - FRESH_MS - 1) }
    } catch {
      return undefined
    }
  },
  save(key: string, entry: { value: HomeDashboardData; at: number }) {
    try {
      // Counts only: item titles and messages stay off disk — some boards hold patient data, and the
      // Atlas offline copy keeps those off disk unless asked (includePhi). They refill on the next read.
      // Session titles are a first prompt as often as not (#192626): off disk too.
      const { recent, inbox, sessions } = entry.value
      const value = {
        ...entry.value,
        recent: { ...recent, measured: false, items: [] },
        inbox: { ...inbox, items: [] },
        sessions: { ...sessions, measured: false, nodes: [] },
      }
      localStorage.setItem(STORED + key, JSON.stringify({ ...entry, value }))
    } catch {}
  },
}

export const homeDashboard = createSwrCache<HomeDashboardData>({
  freshMs: FRESH_MS,
  staleMs: 10 * 60_000,
  merge: keepGoodParts,
  storage: localCopy,
})
export const homeDashboardKey = (base: string) => base.replace(/\/$/, "")

/** Keep a copy at most five minutes old, so the first click on Home draws at once. */
export function warmHomeDashboard(base: string, fetch: Fetch) {
  homeDashboard.warm(homeDashboardKey(base), (progress) => fetchHomeDashboard(base, fetch, progress), 5 * 60_000)
}

/** One page of a list held in full — Home's tabs show five rows and page through the rest. */
export function sliceOf<T>(all: readonly T[], page: number, size = 5) {
  const pages = Math.max(1, Math.ceil(all.length / size))
  const p = Math.min(Math.max(1, page), pages)
  return {
    items: all.slice((p - 1) * size, p * size),
    page: p,
    pages,
    total: all.length,
    from: all.length ? (p - 1) * size + 1 : 0,
    to: Math.min(p * size, all.length),
  }
}

/** "now", "5m", "3h", "2d" — the same short form the agents table uses. */
export function agoOf(iso: string | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return "—"
  const m = Math.max(0, Math.round((now - t) / 60_000))
  if (m < 1) return "now"
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h` : `${Math.round(h / 24)}d`
}

/** Created when nothing has touched it since (two minutes of slack); edited otherwise. */
export function verbOf(item: { createdAt?: string; updatedAt?: string }): "created" | "edited" {
  const c = item.createdAt ? Date.parse(item.createdAt) : NaN
  const u = item.updatedAt ? Date.parse(item.updatedAt) : NaN
  return Number.isFinite(c) && Number.isFinite(u) && u - c > 120_000 ? "edited" : "created"
}
