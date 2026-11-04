import type { HeartbeatRow } from "@/components/session/iris-heartbeats-model"
import type { AgentsPayload, HivePayload, InboxPayload } from "./home-today-model"

/**
 * Home's data, read once and kept outside the page (#192222). The page unmounts every time you
 * leave it, and /iris/heartbeats alone takes ~1.5 s, so every visit used to start blank. The same
 * rule as Playbooks and the Atlas copy: show the last good copy at once, refresh it behind the page,
 * and never let a failed read replace a good one.
 */

export type BeatsPayload = { measured: boolean; reason?: string | null; heartbeats: HeartbeatRow[] }
export type AccountsPayload = { accounts: { id: number; active?: boolean }[] }
export type BloqsPayload = { measured: boolean; total?: number; bloqs: unknown[] }
export type HomeDashboardData = {
  hive: HivePayload
  agents: AgentsPayload
  inbox: InboxPayload
  bloqs: BloqsPayload
  beats: BeatsPayload
  accounts: AccountsPayload
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

export async function fetchHomeDashboard(base: string, fetch: Fetch): Promise<HomeDashboardData> {
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
  const [hive, agents, inbox, bloqs, beats, accounts] = await Promise.all([
    get<HivePayload>("/iris/hive?perPage=200", { measured: false, nodes: [] }),
    get<AgentsPayload>("/iris/agents-mine", { measured: false, agents: [] }),
    get<InboxPayload>("/iris/inbox?perPage=1", { measured: false, unread: null }),
    get<BloqsPayload>("/iris/bloqs?perPage=1", { measured: false, bloqs: [] }),
    get<BeatsPayload>("/iris/heartbeats", { measured: false, heartbeats: [] }),
    get<AccountsPayload>("/iris/accounts", { accounts: [] }),
  ])
  return { hive, agents, inbox, bloqs, beats, accounts, at: Date.now() }
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
  storage?: { load(key: string): { value: T; at: number } | undefined; save(key: string, entry: { value: T; at: number }): void }
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
  const load = (key: string, fetch: () => Promise<T>): Promise<T> => {
    const running = inflight.get(key)
    if (running) return running
    const pending = fetch()
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
    read(key: string, fetch: () => Promise<T>): T | undefined {
      const a = age(key)
      if (a > opts.freshMs) void load(key, fetch).catch(() => {})
      return a <= opts.staleMs ? entryOf(key)?.value : undefined
    },
    /** Load in the background unless there is a copy younger than maxAgeMs. */
    warm(key: string, fetch: () => Promise<T>, maxAgeMs: number) {
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
const localCopy = {
  load(key: string) {
    try {
      const raw = localStorage.getItem(STORED + key)
      return raw ? (JSON.parse(raw) as { value: HomeDashboardData; at: number }) : undefined
    } catch {
      return undefined
    }
  },
  save(key: string, entry: { value: HomeDashboardData; at: number }) {
    try {
      localStorage.setItem(STORED + key, JSON.stringify(entry))
    } catch {}
  },
}

export const homeDashboard = createSwrCache<HomeDashboardData>({
  freshMs: 60_000,
  staleMs: 10 * 60_000,
  merge: keepGoodParts,
  storage: localCopy,
})
export const homeDashboardKey = (base: string) => base.replace(/\/$/, "")

/** Keep a copy at most five minutes old, so the first click on Home draws at once. */
export function warmHomeDashboard(base: string, fetch: Fetch) {
  homeDashboard.warm(homeDashboardKey(base), () => fetchHomeDashboard(base, fetch), 5 * 60_000)
}
