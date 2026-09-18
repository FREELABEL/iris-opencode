import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { homedir } from "os"
import { join, dirname } from "path"

/**
 * One web search over whichever search provider the user has connected (#185571).
 *
 * The providers were never the missing piece. Tavily and composio-search are ordinary
 * integrations, reachable today as `iris integrations exec tavily search` and
 * `iris integrations exec composio-search search` — with different function names,
 * different parameter names and different response shapes. That is what an agent hit on
 * 2026-09-15: ask what it can search with, exec each one, hand-merge the output. This module
 * is the thin layer that makes them one verb with one output shape.
 *
 * It spends the USER'S connection, never the platform key. Since fl-iris-api 2a498a3c
 * (#184594) a per-tenant integration refuses rather than falling back to the shared key, so
 * a result here is billed to whoever connected the provider — which is why a provider that
 * is not connected is REPORTED as not connected, not quietly substituted.
 *
 * Every provider that was skipped, missing or failed is named in `outcomes`. A search that
 * silently fell back to a second engine would give you results you could not attribute —
 * the same rule federated-search.ts is built on.
 */

export type WebProviderId = "tavily" | "composio-search"

export interface WebResult {
  title: string
  url: string
  snippet: string
  published: string | null
}

export interface WebSearchAnswer {
  provider: WebProviderId
  query: string
  answer: string | null
  results: WebResult[]
}

export type ProviderOutcome =
  | { provider: WebProviderId; state: "ok"; count: number }
  | { provider: WebProviderId; state: "error"; reason: string }
  | { provider: WebProviderId; state: "not_connected" }
  | { provider: WebProviderId; state: "not_tried" }

export interface SearchOptions {
  limit: number
  news: boolean
}

interface ProviderDef {
  id: WebProviderId
  label: string
  /** What it is, in one line — shown when nothing is connected. */
  blurb: string
  action(opts: SearchOptions): string
  params(query: string, opts: SearchOptions): Record<string, unknown>
  normalize(data: any, query: string, opts: SearchOptions): Omit<WebSearchAnswer, "provider">
}

const str = (v: unknown): string => (typeof v === "string" ? v : v == null ? "" : String(v))

const tavily: ProviderDef = {
  id: "tavily",
  label: "Tavily",
  blurb: "AI search — a synthesised answer plus sources",
  action: (o) => (o.news ? "search_news" : "search"),
  params: (query, o) => ({ query, max_results: o.limit, include_answer: true }),
  normalize(data, query, o) {
    const rows: any[] = Array.isArray(data?.results) ? data.results : []
    return {
      query: str(data?.query) || query,
      answer: data?.answer ? str(data.answer) : null,
      results: rows.slice(0, o.limit).map((r) => ({
        title: str(r?.title),
        url: str(r?.url),
        snippet: str(r?.content),
        published: r?.published_date ? str(r.published_date) : null,
      })),
    }
  },
}

/**
 * composio-search wraps SerpApi's Google engine, so the payload is SerpApi's, one level
 * down under `results`. Web results are `organic_results`, news is `news_results`; the
 * answer box is Google's featured snippet when it has one, and absent otherwise.
 */
const composioSearch: ProviderDef = {
  id: "composio-search",
  label: "Google (composio-search)",
  blurb: "Google results via SerpApi — no answer synthesis, just the ranking",
  action: (o) => (o.news ? "search_news" : "search"),
  params: (query) => ({ query }),
  normalize(data, query, o) {
    const r = data?.results && typeof data.results === "object" ? data.results : data ?? {}
    const rows: any[] = Array.isArray(o.news ? r.news_results : r.organic_results)
      ? (o.news ? r.news_results : r.organic_results)
      : []
    const box = r.answer_box
    const answer = box ? str(box.answer ?? box.snippet ?? box.result) || null : null
    return {
      query: str(r.search_parameters?.q) || query,
      answer,
      results: rows.slice(0, o.limit).map((x) => ({
        title: str(x?.title),
        url: str(x?.link),
        snippet: str(x?.snippet),
        published: x?.published_at ? str(x.published_at) : x?.date ? str(x.date) : null,
      })),
    }
  },
}

/** Default order when the user has not chosen: an answer beats a ranking. */
export const WEB_PROVIDERS: readonly ProviderDef[] = [tavily, composioSearch]
export const WEB_PROVIDER_IDS: readonly WebProviderId[] = WEB_PROVIDERS.map((p) => p.id)

export function providerDef(id: string): ProviderDef | undefined {
  return WEB_PROVIDERS.find((p) => p.id === id)
}

/** Accept the names people actually type. */
export function normalizeProviderName(raw: string): WebProviderId | null {
  const s = raw.trim().toLowerCase()
  if (s === "tavily") return "tavily"
  if (["composio-search", "composio", "google", "serpapi"].includes(s)) return "composio-search"
  return null
}

export interface Plan {
  order: WebProviderId[]
  outcomes: ProviderOutcome[]
  /** Set when the plan cannot run at all — the message says what to do about it. */
  error?: string
}

/**
 * Decide which providers to try, in what order.
 *
 * - `forced`: that provider only. If it is not connected, that is the answer — a forced
 *   provider that quietly became a different one would defeat the flag.
 * - otherwise: the saved preference first (when connected), then the default order.
 */
export function planProviders(connected: string[], opts: { forced?: string; preferred?: string }): Plan {
  const have = new Set(connected)
  const missing = WEB_PROVIDER_IDS.filter((p) => !have.has(p))

  if (opts.forced) {
    const id = normalizeProviderName(opts.forced)
    if (!id) {
      return {
        order: [],
        outcomes: [],
        error: `Unknown provider "${opts.forced}". Known: ${WEB_PROVIDER_IDS.join(", ")}`,
      }
    }
    if (!have.has(id)) {
      return {
        order: [],
        outcomes: [{ provider: id, state: "not_connected" }],
        error: `${id} is not connected on this account. Connect it: iris integrations connect ${id}`,
      }
    }
    return { order: [id], outcomes: [] }
  }

  const pref = opts.preferred ? normalizeProviderName(opts.preferred) : null
  const order = WEB_PROVIDER_IDS.filter((p) => have.has(p))
  if (pref && have.has(pref)) order.splice(order.indexOf(pref), 1), order.unshift(pref)

  const outcomes: ProviderOutcome[] = missing.map((provider) => ({ provider, state: "not_connected" as const }))
  if (!order.length) {
    return {
      order,
      outcomes,
      error:
        "No web search provider is connected. Connect one:\n" +
        WEB_PROVIDERS.map((p) => `  iris integrations connect ${p.id.padEnd(16)} ${p.blurb}`).join("\n"),
    }
  }
  return { order, outcomes }
}

/** Calls one integration function; resolves to its `data`, throws with the provider's own error. */
export type Exec = (integration: WebProviderId, action: string, params: Record<string, unknown>) => Promise<any>

/**
 * Try each provider in order until one answers. With `all`, run every one concurrently and
 * return all answers — for comparing engines, not for merging them.
 */
export async function runWebSearch(
  query: string,
  plan: Plan,
  exec: Exec,
  opts: SearchOptions & { all?: boolean },
): Promise<{ answers: WebSearchAnswer[]; outcomes: ProviderOutcome[] }> {
  const outcomes: ProviderOutcome[] = [...plan.outcomes]
  const answers: WebSearchAnswer[] = []

  const attempt = async (id: WebProviderId): Promise<WebSearchAnswer | null> => {
    const def = providerDef(id)!
    try {
      const data = await exec(id, def.action(opts), def.params(query, opts))
      const a = { provider: id, ...def.normalize(data, query, opts) }
      outcomes.push({ provider: id, state: "ok", count: a.results.length })
      return a
    } catch (e: any) {
      outcomes.push({ provider: id, state: "error", reason: str(e?.message ?? e) || "unknown error" })
      return null
    }
  }

  if (opts.all) {
    for (const a of await Promise.all(plan.order.map(attempt))) if (a) answers.push(a)
  } else {
    for (let i = 0; i < plan.order.length; i++) {
      const a = await attempt(plan.order[i])
      if (a) {
        answers.push(a)
        for (const rest of plan.order.slice(i + 1)) outcomes.push({ provider: rest, state: "not_tried" })
        break
      }
    }
  }
  // Report in a stable order so two runs are comparable line by line.
  outcomes.sort((a, b) => WEB_PROVIDER_IDS.indexOf(a.provider) - WEB_PROVIDER_IDS.indexOf(b.provider))
  return { answers, outcomes }
}

export function formatOutcome(o: ProviderOutcome): string {
  switch (o.state) {
    case "ok":
      return `${o.provider}: ${o.count} result(s)`
    case "error":
      return `${o.provider}: FAILED — ${o.reason}`
    case "not_connected":
      return `${o.provider}: not connected (iris integrations connect ${o.provider})`
    case "not_tried":
      return `${o.provider}: not needed`
  }
}

// ── saved preference: ~/.iris/config.json → search.web_provider ──

export const CONFIG_PATH = join(homedir(), ".iris", "config.json")

export function readPreferredProvider(path = CONFIG_PATH): string | undefined {
  try {
    if (!existsSync(path)) return undefined
    const v = JSON.parse(readFileSync(path, "utf-8"))?.search?.web_provider
    return typeof v === "string" && v ? v : undefined
  } catch {
    return undefined
  }
}

/** Merges into the existing config — it holds the auth token, so it is never rewritten wholesale. */
export function writePreferredProvider(id: WebProviderId, path = CONFIG_PATH): void {
  let cfg: any = {}
  if (existsSync(path)) {
    cfg = JSON.parse(readFileSync(path, "utf-8"))
  } else {
    mkdirSync(dirname(path), { recursive: true })
  }
  cfg.search = { ...(cfg.search ?? {}), web_provider: id }
  writeFileSync(path, JSON.stringify(cfg, null, 2) + "\n", { mode: 0o600 })
}
