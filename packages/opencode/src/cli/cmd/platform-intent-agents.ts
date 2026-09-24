import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { irisFetch, resolveUserId } from "./iris-api"
import { searchCapabilities, type Entry, type Index } from "./platform-find"

/**
 * AGENT DISCOVERY for `iris intent` (#186666, A1).
 *
 * "Go get a client" is often a job for one of the account's own agents, not a single command.
 * This supplies those agents as candidates: fetched once, cached briefly, filtered to the ones a
 * person would actually hand work to, and pre-ranked with the same keyword + vocabulary search
 * `find` uses — so Jev chooses among a handful, in the same single call as the command.
 */

export type RawAgent = {
  id: number
  name: string
  type?: string
  active?: boolean
  description?: string | null
  last_active_at?: string | null
}
export type AgentCandidate = { id: number; name: string; describe: string; run: string; score: number }

/**
 * Never suggested: human team entries, inactive agents, and scratch/test agents. Measured on this
 * account: of the first 200 "agents", 18+ were humans and a dozen were BENCH/probe/control agents
 * made for experiments — suggesting one of those would be worse than suggesting nothing.
 */
const SCRATCH_NAME = /^(bench\b|model bench)|\[test\]|\b(test|probe|control|scratch)\b/i
const SCRATCH_DESC =
  /\b(test agent|benchmark|scratch|safe to delete|control for|temporary agent|experiment)\b|^\s*test\s*$/i
export function isDiscoverable(a: RawAgent): boolean {
  if (!a || typeof a.id !== "number" || !a.name) return false
  if ((a.type ?? "").toLowerCase() === "human") return false
  if (a.active === false) return false
  return !SCRATCH_NAME.test(a.name) && !SCRATCH_DESC.test(a.description ?? "")
}

/** `iris agents chat <id> "<request>"` — the request itself is the message. */
export const agentRun = (id: number, text: string) => `iris agents chat ${id} "${text.replace(/"/g, "'")}"`

/**
 * The best `limit` agents for the request. Keyword + find's vocabulary map first; if fewer match,
 * the most recently active fill the rest, so Jev still sees real options for a request whose
 * words no description shares ("go get a client" vs "prospecting and outreach").
 */
export function rankAgents(text: string, agents: RawAgent[], vocab: Index["terms"], limit = 8): AgentCandidate[] {
  const pool = agents.filter(isDiscoverable)
  if (!pool.length) return []
  const entries: Entry[] = pool.map((a) => ({
    kind: "command",
    name: a.name,
    describe: a.description ?? "",
    aliases: [],
    run: String(a.id),
    haystack: `${a.name} ${a.description ?? ""}`.toLowerCase(),
  }))
  const index: Index = { counts: {}, terms: vocab, entries }
  const hits = searchCapabilities(index, text.toLowerCase(), undefined, limit)
  const byId = new Map(pool.map((a) => [String(a.id), a]))
  const chosen = hits.map(({ e, s }) => ({ a: byId.get(e.run)!, s }))
  if (chosen.length < limit) {
    const have = new Set(chosen.map((c) => c.a.id))
    const recent = pool
      .filter((a) => !have.has(a.id))
      .sort((x, y) => String(y.last_active_at ?? "").localeCompare(String(x.last_active_at ?? "")))
    for (const a of recent.slice(0, limit - chosen.length)) chosen.push({ a, s: 0 })
  }
  return chosen.map(({ a, s }) => ({
    id: a.id,
    name: `agent ${a.id} · ${a.name}`,
    describe: `AGENT — hand the whole job to this agent: ${a.description?.trim() || "(no description)"}`,
    run: agentRun(a.id, text),
    score: s,
  }))
}

const TTL_MS = 10 * 60 * 1000
const cacheFile = () => join(homedir(), ".iris", "cache", "intent-agents.json")

/**
 * The account's agents, from a 10-minute cache or the API. Never throws and never blocks long:
 * agent discovery is an addition, and `intent` must still answer for commands without it.
 */
export async function loadAgents(timeoutMs = 4000): Promise<{ agents: RawAgent[]; source: string }> {
  const userId = await resolveUserId().catch(() => null)
  const file = cacheFile()
  try {
    if (existsSync(file)) {
      const c = JSON.parse(readFileSync(file, "utf-8"))
      if (c?.userId === userId && Date.now() - c.at < TTL_MS && Array.isArray(c.agents))
        return { agents: c.agents, source: "cache" }
    }
  } catch {}
  if (!userId) return { agents: [], source: "no user id" }
  try {
    const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents?per_page=500`, {
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!res.ok) return { agents: [], source: `HTTP ${res.status}` }
    const raw = (await res.json()) as any
    const list: RawAgent[] = (Array.isArray(raw?.data) ? raw.data : Array.isArray(raw) ? raw : []).map((a: any) => ({
      id: Number(a.id),
      name: String(a.name ?? ""),
      type: a.type,
      active: a.active,
      description: a.description ?? null,
      last_active_at: a.last_active_at ?? null,
    }))
    try {
      mkdirSync(join(homedir(), ".iris", "cache"), { recursive: true })
      writeFileSync(file, JSON.stringify({ userId, at: Date.now(), agents: list }))
    } catch {}
    return { agents: list, source: "api" }
  } catch (e) {
    return { agents: [], source: e instanceof Error ? e.message : String(e) }
  }
}
