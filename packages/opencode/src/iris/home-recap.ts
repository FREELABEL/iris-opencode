/**
 * Home's "Today · across your projects", written by a model (#194315).
 *
 * The counted sentence in packages/app (recapOf) only sees board items. Most of a person's work
 * happens in their coding sessions, on every machine and in every agent (Claude Code, Codex,
 * Gemini, opencode…), so this writes one paragraph from both: today's board items and today's
 * sessions with their digests (first ask, last ask, last reply — iris-daemon lib/session-digest.js).
 *
 * The model and the prompt were chosen by a benchmark (Atlas #194315: 7 gateway models, 72 runs,
 * three days of input): Claude Haiku 5.5 with prompt v2 was the most accurate and the only one
 * that named everything waiting on the person. `IRIS_HOME_RECAP_MODEL` swaps the model,
 * `IRIS_HOME_RECAP=off` turns this off and Home keeps the counted sentence.
 *
 * One paragraph per day, cached on disk; written again only when the inputs changed AND the last
 * one is older than REFRESH_MS, so a heartbeat every minute does not mean a model call every minute.
 */
import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import path from "path"
import { IRIS_OPENAI_BASE } from "../provider/provider"
import { fleetFromNodes } from "./hive-sessions"
import { IRIS_API, dataDir, fetchRecentItems, irisFetch, resolveToken, resolveUserId, type RecentItem } from "./platform"

export const RECAP_MODEL = process.env.IRIS_HOME_RECAP_MODEL || "claude-haiku-5-5"
export const REFRESH_MS = 15 * 60_000
const AGENT_LISTS = /daily diary|agent work|agent deliverables|\(auto\)/i

export const PROMPT = `You write one short paragraph for the top of a person's IRIS Home screen, under the heading "Today · across your projects".

The input is JSON: the date, the board items that changed (title, project, list, by = "you" or "agent", created/edited), and the coding-agent sessions the person ran (agent, machine, project folder, branch, first_ask = what they asked for, last_reply = where it ended, status).

Most of a person's real work happens in their coding sessions. The board shows what got written down; the sessions show what got done. Summarise both.

Write 3 to 4 sentences, at most 100 words, plain English, second person ("you"), past tense.
- Group the day into its main threads of work. A thread can be a board project, a session, or both when they are about the same thing.
- Say what each thread achieved or where it stopped, using the sessions' last_reply (for example: fixed and merged, waiting on a decision, blocked on access). Describe the work, never a URL or a raw prompt.
- Cover at least the three most recent sessions unless they are about the same thing.
- If any session has status "needs_you", say what it is waiting on.
- Agents' own diaries and work logs get at most one short clause, with the count.
- Name board projects exactly as given.
- Never invent a number, name, PR, result or outcome that is not in the input.
- No markdown, no bullet points, no headings.

Input:
`

export type RecapSession = {
  agent: string
  machine: string
  project: string | null
  branch: string | null
  model: string | null
  status: string
  last_active: string | null
  first_ask: string | null
  last_ask: string | null
  last_reply: string | null
}
export type RecapInput = {
  date: string
  board_items: { title: string; project: string; list: string; by: "you" | "agent"; change: "created" | "edited" }[]
  sessions: RecapSession[]
}
export type HomeRecap = {
  measured: boolean
  reason?: string
  /** The paragraph, or null when there is nothing today, it is off, or the model failed. */
  text: string | null
  model: string | null
  generatedAt: string | null
  /** What the paragraph was written from. */
  items: number
  sessions: number
  agents: string[]
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v : null)
const after = (iso: string | undefined | null, t: number) => {
  const v = Date.parse(iso ?? "")
  return Number.isFinite(v) && v >= t
}

/** Today's inputs. Pure: board items, raw node JSON and the fleet's statuses in, the model's input out. */
export function inputOf(items: readonly RecentItem[], nodesJson: any, dayStart: number, now: number): RecapInput {
  const board_items = items
    .filter((i) => after(i.updatedAt ?? i.createdAt, dayStart))
    .map((i) => ({
      title: (i.title ?? "").slice(0, 140),
      project: i.bloqName ?? `#${i.bloqId}`,
      list: i.listName ?? "",
      by: (AGENT_LISTS.test(i.listName ?? "") ? "agent" : "you") as "you" | "agent",
      change: (Date.parse(i.updatedAt ?? "") - Date.parse(i.createdAt ?? "") > 120_000 ? "edited" : "created") as
        | "created"
        | "edited",
    }))
  // Statuses the way Hive shows them (an old report's status is "unknown"); the rest from the raw rows.
  const status = new Map<string, string>()
  for (const n of fleetFromNodes(nodesJson, now).nodes) for (const s of n.sessions) status.set(`${n.id}:${s.sessionId}`, s.status)
  const list: any[] = Array.isArray(nodesJson?.nodes) ? nodesJson.nodes : Array.isArray(nodesJson?.data) ? nodesJson.data : []
  const sessions: RecapSession[] = []
  for (const n of list) {
    for (const s of Array.isArray(n?.active_sessions) ? n.active_sessions : []) {
      if (!after(s?.updated_at, dayStart)) continue
      // Only rows Hive itself keeps: a machine that has not reported lately, and the second copy
      // of a session two machines both reported, are already dropped by fleetFromNodes.
      const key = `${String(n?.id ?? "")}:${s.session_id}`
      if (!status.has(key)) continue
      const d = s?.digest && typeof s.digest === "object" ? s.digest : {}
      sessions.push({
        agent: str(s.agent_name) ?? str(s.agent) ?? str(s.provider) ?? "unknown",
        machine: str(n?.name) ?? "unnamed",
        project: str(s.project_path) ? path.basename(s.project_path) : null,
        branch: str(s.git_branch),
        model: str(s.model),
        status: status.get(key) ?? "unknown",
        last_active: str(s.updated_at),
        first_ask: str(d.first_ask) ?? str(s.label) ?? str(s.name),
        last_ask: str(d.last_ask),
        last_reply: str(d.last_reply),
      })
    }
  }
  sessions.sort((a, b) => Date.parse(b.last_active ?? "") - Date.parse(a.last_active ?? ""))
  return { date: new Date(now).toDateString(), board_items, sessions: sessions.slice(0, 25) }
}

/** What the paragraph depends on, without the clocks — a new heartbeat with the same work is the same input. */
export function hashOf(input: RecapInput): string {
  const stable = { ...input, sessions: input.sessions.map(({ last_active, ...s }) => s) }
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex").slice(0, 16)
}

type Cached = { day: string; hash: string; text: string; model: string; at: number }

/** Write again? Only for a new day, or new inputs once the last paragraph is REFRESH_MS old. Pure. */
export function stale(cached: Cached | null, day: string, hash: string, now: number): boolean {
  if (!cached || cached.day !== day) return true
  if (cached.hash === hash) return false
  return now - cached.at >= REFRESH_MS
}

/** The model's answer as one plain paragraph; null when there is nothing usable. Pure. */
export function cleanOf(raw: unknown): string | null {
  if (typeof raw !== "string") return null
  const t = raw
    .replace(/^#+\s.*$/gm, "")
    .replace(/[*_`]+/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^"(.*)"$/, "$1")
  return t.length >= 20 ? t : null
}

const cacheFile = () => path.join(dataDir(), "home-recap.json")
let memory: Cached | null = null
function readCache(): Cached | null {
  if (memory) return memory
  try {
    if (existsSync(cacheFile())) memory = JSON.parse(readFileSync(cacheFile(), "utf8"))
  } catch {}
  return memory
}
function writeCache(c: Cached) {
  memory = c
  try {
    mkdirSync(path.dirname(cacheFile()), { recursive: true })
    writeFileSync(cacheFile(), JSON.stringify(c))
  } catch {}
}

async function complete(input: RecapInput): Promise<{ text: string | null; reason?: string }> {
  const token = resolveToken()
  if (!token) return { text: null, reason: "not signed in" }
  try {
    const res = await fetch(`${IRIS_OPENAI_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        model: RECAP_MODEL,
        messages: [{ role: "user", content: PROMPT + JSON.stringify(input) }],
        // Room for a model that thinks before it writes: at 320 the gateway's Haiku spent the whole
        // budget before the first word (finish: length, empty content). The paragraph is ~130 tokens.
        max_tokens: 2048,
        temperature: 0.2,
      }),
      signal: AbortSignal.timeout(45_000),
    })
    if (!res.ok) return { text: null, reason: `gateway ${res.status}` }
    const j: any = await res.json()
    const choice = j?.choices?.[0]
    const text = cleanOf(choice?.message?.content)
    if (text) return { text }
    // Say what came back, so "nothing usable" can be told apart from a cut-off or a refusal.
    const got = typeof choice?.message?.content === "string" ? choice.message.content.slice(0, 120) : JSON.stringify(j).slice(0, 160)
    return { text: null, reason: `the model returned nothing usable (finish: ${choice?.finish_reason ?? "none"}; got: ${got})` }
  } catch (e) {
    return { text: null, reason: e instanceof Error ? e.message : String(e) }
  }
}

export async function homeRecap(now = Date.now()): Promise<HomeRecap> {
  const none = (measured: boolean, reason?: string): HomeRecap => ({
    measured, reason, text: null, model: null, generatedAt: null, items: 0, sessions: 0, agents: [],
  })
  if (String(process.env.IRIS_HOME_RECAP || "").toLowerCase() === "off") return none(true, "off (IRIS_HOME_RECAP=off)")
  const userId = await resolveUserId()
  if (!userId) return none(false, "not signed in")
  const day0 = new Date(now)
  day0.setHours(0, 0, 0, 0)
  const [recent, nodesRes] = await Promise.all([
    fetchRecentItems(),
    irisFetch(`/api/v6/nodes/?user_id=${userId}&detailed=1`, IRIS_API).catch(() => null),
  ])
  const nodesJson = nodesRes && nodesRes.ok ? await nodesRes.json().catch(() => null) : null
  if (!recent.measured && !nodesJson) return none(false, recent.reason ?? "could not read boards or machines")
  const input = inputOf(recent.data.items, nodesJson, day0.getTime(), now)
  const base = {
    items: input.board_items.length,
    sessions: input.sessions.length,
    agents: [...new Set(input.sessions.map((s) => s.agent))],
  }
  if (!base.items && !base.sessions) return { ...none(true), ...base }
  const day = day0.toISOString().slice(0, 10)
  const hash = hashOf(input)
  const cached = readCache()
  if (cached && !stale(cached, day, hash, now)) {
    return { measured: true, text: cached.text, model: cached.model, generatedAt: new Date(cached.at).toISOString(), ...base }
  }
  const out = await complete(input)
  if (!out.text) {
    // Keep today's last good paragraph rather than blanking Home on one failed call.
    if (cached && cached.day === day) {
      return { measured: true, reason: out.reason, text: cached.text, model: cached.model, generatedAt: new Date(cached.at).toISOString(), ...base }
    }
    return { ...none(true, out.reason), ...base }
  }
  writeCache({ day, hash, text: out.text, model: RECAP_MODEL, at: now })
  return { measured: true, text: out.text, model: RECAP_MODEL, generatedAt: new Date(now).toISOString(), ...base }
}
