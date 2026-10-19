import os from "os"
import path from "path"
import fs from "fs"

// ============================================================================
// Connect-time profile for `iris mcp serve` (eval #189927, gap 1).
//
// An MCP server may return an `instructions` string on `initialize`. Clients put it in
// the model's context before the first turn — so a fresh Codex / Claude / Cursor session
// starts out knowing the user's rules instead of knowing nothing until it happens to
// call iris_memory. Before this, `iris mcp serve` returned no instructions at all.
//
// Three rules shape everything here:
//
//  1. NEVER BLOCK OR FAIL `initialize`. Reading Atlas means spawning `iris bloqs ...`,
//     which takes 2–6s per call — longer than some clients wait for a handshake. So the
//     server answers from a disk cache (or local-only text) instantly and refreshes in
//     the background; the next connect gets the fresh copy. `iris mcp profile` and
//     `iris mcp install` warm the cache so the very first connect is already personal.
//
//  2. ONLY THE USER'S OWN, DELIBERATE PROFILE. Fuzzy search would happily put a bug
//     report, a legal file or someone else's shared board into every agent's system
//     context. The profile comes from (a) ~/.iris/profile.md, (b) the Atlas item named
//     by IRIS_PROFILE_ITEM / config.json `profile_item`, or (c) an Atlas item titled
//     exactly "IRIS Profile" on a board the user owns. Nothing else.
//
//  3. SHORT. Instructions ride along in every session; they are capped well under 2k
//     chars and point at iris_memory for everything else.
// ============================================================================

export const MAX_INSTRUCTIONS = 1800
const MAX_PROFILE = 1000
const MAX_PROJECTS = 6
export const CACHE_TTL_MS = 6 * 60 * 60 * 1000
export const PROFILE_TITLE = "IRIS Profile"

/** Run an `iris` subcommand and return stdout; throw on failure. Injected for tests. */
export type IrisRunner = (args: string[]) => Promise<string>

export interface ProfileData {
  /** User-written rules: voice, never-do, preferences. */
  profile?: { text: string; source: string }
  /** Recently active boards the user owns. */
  projects?: { id: number; name: string }[]
  /** IANA timezone of this machine. */
  timezone?: string
}

export interface CachedInstructions {
  text: string
  built_at: string
  sources: string[]
}

function homeDir(): string {
  return process.env.OPENCODE_TEST_HOME || os.homedir()
}

export function cachePath(home = homeDir()): string {
  return path.join(home, ".iris", "cache", "mcp-instructions.json")
}

export function localProfilePath(home = homeDir()): string {
  return path.join(home, ".iris", "profile.md")
}

function machineTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || undefined
  } catch {
    return undefined
  }
}

function clip(text: string, max: number): string {
  const t = text.replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim()
  return t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…"
}

/** ~/.iris/profile.md — the user's configured profile, if they wrote one. Synchronous: it is a local file. */
export function readLocalProfile(home = homeDir()): ProfileData["profile"] | undefined {
  try {
    const text = fs.readFileSync(localProfilePath(home), "utf8").trim()
    if (text) return { text, source: "~/.iris/profile.md" }
  } catch {}
  return undefined
}

function configuredProfileItem(home: string): number | undefined {
  const fromEnv = Number(process.env.IRIS_PROFILE_ITEM)
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(home, ".iris", "config.json"), "utf8"))
    const id = Number(cfg?.profile_item)
    if (Number.isInteger(id) && id > 0) return id
  } catch {}
  return undefined
}

/** A title counts as the profile if it IS "IRIS Profile", optionally followed by a separator and a name. */
export function isProfileTitle(title: unknown): boolean {
  if (typeof title !== "string") return false
  return /^\s*iris profile(\s*([—–:\-|(]|$).*)?$/i.test(title)
}

function parseJson(out: string): any {
  const start = out.search(/[[{]/)
  return JSON.parse(start > 0 ? out.slice(start) : out)
}

/**
 * Gather everything from Atlas, through the same `iris bloqs ...` commands iris_memory
 * runs. Every source is independent and failure-tolerant: signed out, offline or slow
 * yields less data, never an exception.
 */
export async function gatherProfile(run: IrisRunner, home = homeDir()): Promise<ProfileData> {
  const data: ProfileData = { timezone: machineTimezone() }
  const local = readLocalProfile(home)
  if (local) data.profile = local

  const boardsP = run(["bloqs", "list", "--json"])
    .then((out) => {
      const j = parseJson(out)
      const rows: any[] = Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : []
      return rows
    })
    .catch(() => undefined)

  const pinned = configuredProfileItem(home)
  const searchP =
    local || pinned
      ? Promise.resolve(undefined)
      : run(["bloqs", "search", PROFILE_TITLE, "--items-only", "--local-only", "--limit", "10", "--json"])
          .then((out) => {
            const items: any[] = parseJson(out)?.items ?? []
            return items.filter((i) => isProfileTitle(i?.title))
          })
          .catch(() => undefined)

  const [boards, candidates] = await Promise.all([boardsP, searchP])

  if (boards) {
    data.projects = boards
      .filter((b) => b && b.is_owner !== false && typeof b.name === "string" && Number.isFinite(Number(b.id)))
      .filter((b) => !/\bdelete me\b|\btest\b|^untitled/i.test(b.name))
      .slice(0, MAX_PROJECTS)
      .map((b) => ({ id: Number(b.id), name: clip(String(b.name), 70) }))
  }

  if (!data.profile) {
    let itemId = pinned
    if (!itemId && candidates?.length) {
      // Never take a profile from a board the user does not own: a shared board's
      // "IRIS Profile" would be someone ELSE's rules in this user's every session.
      const notOwned = new Set((boards ?? []).filter((b) => b?.is_owner === false).map((b) => Number(b.id)))
      itemId = candidates.find((c) => !notOwned.has(Number(c.bloq_id)))?.id
    }
    if (itemId) {
      try {
        const item = parseJson(await run(["bloqs", "get-item", String(itemId), "--json"]))
        const body = typeof item?.content === "string" ? item.content : ""
        if (body.trim()) data.profile = { text: body, source: `Atlas item #${itemId}` }
      } catch {}
    }
  }

  return data
}

const MEMORY_GUIDE = [
  "How to use IRIS memory (tool iris_memory):",
  '- Search before you assume: for anything about the user\'s people, projects, decisions or preferences, call iris_memory {action:"search", query:"..."} first. action:"boards" is recency-ordered and truncated — not an inventory.',
  '- Read a board with {action:"items", bloq:<id>}; cite only item IDs you actually read.',
  '- Record decisions, lessons and preferences the user states with {action:"add"} so every other agent sees them.',
].join("\n")

/** Pure: render the instructions string from gathered data. Always ≤ MAX_INSTRUCTIONS. */
export function buildInstructions(data: ProfileData): string {
  const parts: string[] = [
    "You are connected to IRIS, the user's operating system and shared memory (Atlas). Every agent the user runs reads and writes the same memory.",
  ]

  if (data.profile?.text.trim()) {
    parts.push(`The user's rules (from ${data.profile.source}) — follow them:\n${clip(data.profile.text, MAX_PROFILE)}`)
  } else {
    parts.push(
      `No personal profile is set yet, so do not guess the user's preferences — search for them. (The user can add one in ~/.iris/profile.md or an Atlas item titled "${PROFILE_TITLE}".)`,
    )
  }

  const tzStated = /time\s?zone|\btz\b/i.test(data.profile?.text ?? "")
  if (data.timezone && !tzStated) parts.push(`Timezone: ${data.timezone} — read and write dates and times in it unless told otherwise.`)

  if (data.projects?.length) {
    parts.push(`Active projects (recently updated Atlas boards): ${data.projects.map((p) => `${p.name} (#${p.id})`).join("; ")}.`)
  }

  parts.push(MEMORY_GUIDE)

  let text = parts.join("\n\n")
  if (text.length > MAX_INSTRUCTIONS) {
    // Drop the project list first, then clip — the rules and the memory guide matter more.
    const withoutProjects = parts.filter((p) => !p.startsWith("Active projects")).join("\n\n")
    text = withoutProjects.length <= MAX_INSTRUCTIONS ? withoutProjects : clip(withoutProjects, MAX_INSTRUCTIONS)
  }
  return text
}

function sourcesOf(data: ProfileData): string[] {
  const s: string[] = []
  if (data.profile) s.push(data.profile.source)
  if (data.projects?.length) s.push("Atlas boards")
  if (data.timezone) s.push("machine timezone")
  return s
}

/**
 * The cached instructions — unless ~/.iris/profile.md was edited after they were built.
 * An edit to the user's own rules must show up on the next connect, not after the TTL.
 */
export function readCache(home = homeDir()): CachedInstructions | undefined {
  try {
    const c = JSON.parse(fs.readFileSync(cachePath(home), "utf8"))
    if (typeof c?.text !== "string" || !c.text || typeof c.built_at !== "string") return undefined
    try {
      if (fs.statSync(localProfilePath(home)).mtimeMs > Date.parse(c.built_at)) return undefined
    } catch {}
    return c
  } catch {}
  return undefined
}

export function isFresh(c: CachedInstructions | undefined, now = Date.now(), ttl = CACHE_TTL_MS): boolean {
  if (!c) return false
  const t = Date.parse(c.built_at)
  return Number.isFinite(t) && now - t < ttl
}

function writeCache(c: CachedInstructions, home: string): void {
  try {
    const p = cachePath(home)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, JSON.stringify(c, null, 2) + "\n", { encoding: "utf8", mode: 0o600 })
  } catch {}
}

/** Fetch from Atlas, render, and cache. Never throws. */
export async function refreshInstructions(run: IrisRunner, home = homeDir()): Promise<CachedInstructions> {
  let data: ProfileData
  try {
    data = await gatherProfile(run, home)
  } catch {
    data = { profile: readLocalProfile(home), timezone: machineTimezone() }
  }
  const entry: CachedInstructions = { text: buildInstructions(data), built_at: new Date().toISOString(), sources: sourcesOf(data) }
  // Do not let a signed-out / offline refresh overwrite a richer cached profile.
  const prev = readCache(home)
  if (prev && entry.sources.length < prev.sources.length && !data.projects && !data.profile) return prev
  writeCache(entry, home)
  return entry
}

/**
 * Instructions available RIGHT NOW, without touching the network: the cache if there is
 * one (fresh or stale — stale beats generic), else what can be built from local files.
 */
export function instructionsNow(home = homeDir()): string {
  return readCache(home)?.text ?? buildInstructions({ profile: readLocalProfile(home), timezone: machineTimezone() })
}
