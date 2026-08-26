import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { irisFetch, IRIS_API, BRIDGE_URL, getBridgeToken, resolveUserId } from "./iris-api"

/**
 * Federated search across bloq items and the user's other content sources.
 *
 * Design rule, learned expensively: a source that is SKIPPED or UNREACHABLE must be named
 * in the output. A federated search whose bridge is down and silently returns fewer
 * results is worse than one that does not exist, because you would trust it. Silence read
 * as health is how 97 dead Composio connections and a false-green `doctor` survived weeks.
 *
 * Content is NOT copied into bloq items. Each source stays the single owner of its own
 * data and is queried live; we federate at query time and return pointers. Indexing vault
 * prose into bloqItems would create two truths that drift — the exact failure this whole
 * epic has been about.
 */

export type SourceName = "bloq" | "obsidian" | "drive" | "imessage" | "gmail"

/**
 * The canonical list, in one place.
 *
 * It used to be spelled out as a literal in three separate filters, and when
 * comms was added the type compiled while every one of those filters silently
 * dropped the new name — an unrecognised --source falling back to the default is
 * exactly the failure the comment below it warns about.
 */
export const SOURCE_NAMES: readonly SourceName[] = ["bloq", "obsidian", "drive", "imessage", "gmail"]

export interface FederatedResult {
  source: SourceName
  title: string
  /** Where it lives — a bloq list, a vault folder, a Drive path, a contact. */
  location?: string
  /** ISO date of the artefact, where the source knows one. */
  when?: string
  /** Enough context to judge relevance without opening it. */
  snippet?: string
  /** Whatever the source needs to fetch the full thing later. */
  ref?: string
}

export type SourceOutcome =
  | { source: SourceName; state: "ok"; count: number }
  | { source: SourceName; state: "skipped"; reason: string }
  | { source: SourceName; state: "error"; reason: string }

export interface FederatedSearchResult {
  results: FederatedResult[]
  outcomes: SourceOutcome[]
}

const CONFIG_PATH = join(homedir(), ".iris", "config.json")
const OBSIDIAN_CONFIG = join(homedir(), ".iris", "obsidian.json")
const BRIDGE_TOKEN_PATH = join(homedir(), ".iris", "bridge-token")

function readJson<T>(path: string): T | null {
  try {
    if (existsSync(path)) return JSON.parse(readFileSync(path, "utf-8")) as T
  } catch {}
  return null
}

/**
 * Which sources to search when the caller does not say.
 * `bloq` alone by default — turning on remote sources silently would change the meaning
 * of every existing `--search` invocation.
 */
export function defaultSources(): SourceName[] {
  const cfg = readJson<{ search?: { sources?: string[] } }>(CONFIG_PATH)
  const configured = cfg?.search?.sources
  if (Array.isArray(configured) && configured.length) {
    return configured.filter((s): s is SourceName => SOURCE_NAMES.includes(s as SourceName))
  }
  return ["bloq"]
}

/** Resolve --source/--include-all into a concrete, de-duplicated list. */
export function resolveSources(opts: { source?: string | string[]; includeAll?: boolean }): SourceName[] {
  if (opts.includeAll) return [...SOURCE_NAMES]
  if (opts.source) {
    const raw = Array.isArray(opts.source) ? opts.source : [opts.source]
    const picked = raw
      .flatMap((s) => String(s).split(","))
      .map((s) => s.trim().toLowerCase())
      .filter((s): s is SourceName => SOURCE_NAMES.includes(s as SourceName))
    // An unrecognised --source must not silently fall back to the default.
    if (picked.length) return [...new Set(picked)]
  }
  return defaultSources()
}

// ── bloq ──────────────────────────────────────────────────────────────────────
/**
 * #182461 — a bloq id is an OPTIONAL narrowing, not a precondition.
 *
 * This used to take a required `bloqId` and the caller skipped the whole source with
 * "no bloq context" whenever it was absent. So the one search that advertised itself as
 * covering everything you have written could not answer "where have I seen this name"
 * unless you already knew which project to look in — which is the opposite of the
 * question. A person mentioned across three boards returned nothing, and the skip
 * reason scrolled past as though it were a configuration nicety.
 *
 * With no bloq id we use the CROSS-PROJECT endpoint, which searches every board the
 * user owns and ANDs the query's tokens server-side. With one, the board-scoped
 * endpoint stays exact.
 */
async function searchBloq(
  query: string,
  bloqId: number | undefined,
  userId: number,
  limit: number,
): Promise<FederatedResult[]> {
  const params = new URLSearchParams({ search: query, per_page: String(limit) })
  // Number(undefined) is NaN, and callers build this from an optional flag — an
  // unguarded NaN would request `/bloqs/NaN/items` and surface as an HTTP error where
  // the honest reading is "no board was named, search them all".
  const scoped = Number.isFinite(bloqId as number) ? (bloqId as number) : undefined
  const path =
    scoped != null
      ? `/api/v1/user/${userId}/bloqs/${scoped}/items?${params}`
      : `/api/v1/user/${userId}/bloqs/content-items?${params}`
  const res = await irisFetch(path)
  if (!res.ok) throw new Error(`bloq items HTTP ${res.status}`)

  const data = (await res.json()) as any
  const items: any[] = data?.data?.items ?? data?.items ?? data?.data ?? []
  return (Array.isArray(items) ? items : []).map((i) => ({
    source: "bloq" as const,
    title: String(i.title ?? "(untitled)"),
    // Cross-project results MUST name their board — without it a hit is untraceable back
    // to where it lives, and the single most useful thing a search can say is "it is in
    // this project", because you rarely remember what a project is called.
    location: [i.bloq_name, i.list_name].filter(Boolean).join(" › ") || undefined,
    snippet: typeof i.content === "string" ? i.content.replace(/\s+/g, " ").slice(0, 140) : undefined,
    ref: i.id != null ? String(i.id) : undefined,
  }))
}

// ── obsidian (local bridge) ───────────────────────────────────────────────────
function bridgeToken(): string | null {
  try {
    if (existsSync(BRIDGE_TOKEN_PATH)) return readFileSync(BRIDGE_TOKEN_PATH, "utf-8").trim() || null
  } catch {}
  return getBridgeToken()
}

async function searchObsidian(query: string, limit: number): Promise<FederatedResult[]> {
  const vault = readJson<{ defaultVault?: string }>(OBSIDIAN_CONFIG)?.defaultVault
  const token = bridgeToken()
  const headers: Record<string, string> = { Accept: "application/json" }
  if (token) headers["X-Bridge-Key"] = token

  let vaultPath = vault
  if (!vaultPath) {
    const vres = await fetch(`${BRIDGE_URL}/api/obsidian/vaults`, { headers, signal: AbortSignal.timeout(15000) })
    if (!vres.ok) throw new Error(`bridge HTTP ${vres.status}`)
    const vaults = ((await vres.json()) as any)?.vaults ?? []
    if (!vaults.length) throw new Error("no vaults found")
    // Refuse to guess between vaults — searching the wrong one silently is the same
    // identity mistake the Composio self-heal made.
    if (vaults.length > 1) {
      throw new Error(`${vaults.length} vaults — set one with: iris obsidian use "<path>"`)
    }
    vaultPath = vaults[0].path
  }

  const params = new URLSearchParams({ vault: vaultPath!, q: query, limit: String(limit), body: "1" })
  const res = await fetch(`${BRIDGE_URL}/api/obsidian/search?${params}`, { headers, signal: AbortSignal.timeout(30000) })
  if (!res.ok) throw new Error(`bridge HTTP ${res.status}`)

  const results = ((await res.json()) as any)?.results ?? []
  return results.map((r: any) => ({
    source: "obsidian" as const,
    title: String(r.name ?? "(untitled)"),
    location: r.folder || undefined,
    snippet: r.snippet ?? undefined,
    ref: r.path,
  }))
}

// ── google drive ──────────────────────────────────────────────────────────────
async function searchDrive(query: string, userId: number, limit: number): Promise<FederatedResult[]> {
  const res = await irisFetch(
    `/api/v1/users/${userId}/integrations/execute-direct`,
    {
      method: "POST",
      body: JSON.stringify({
        integration: "google-drive",
        action: "search_files",
        params: { query, pageSize: limit, supportsAllDrives: true, includeItemsFromAllDrives: true },
      }),
    },
    IRIS_API,
  )

  const data = (await res.json().catch(() => ({}))) as any
  if (!res.ok || data?.success === false) {
    throw new Error(String(data?.error ?? `HTTP ${res.status}`).slice(0, 120))
  }

  const files = data?.data?.files ?? data?.data?.response_data?.files ?? []
  return (Array.isArray(files) ? files : []).slice(0, limit).map((f: any) => ({
    source: "drive" as const,
    title: String(f.name ?? "(untitled)"),
    location: (f.mimeType ?? "").replace("application/vnd.google-apps.", "") || undefined,
    ref: f.id,
  }))
}


// ── comms (iMessage + Gmail) ──────────────────────────────────────────────────
/**
 * `iris search` advertised "search everything you have written" and covered bloq
 * items, Obsidian and Drive. Not messages. Not mail. Searching it for something a
 * person had texted you returned nothing, with no indication that an entire class
 * of source had never been consulted — which is how a PDF sitting in
 * ~/Library/Messages/Attachments read as a document that never arrived (#181967).
 *
 * Both searchers DELEGATE to the pulse sweep rather than querying the stores
 * again. Reimplementing message reading per feature is what made the sweep blind
 * to attributedBody and to attachments in the first place (#181990); a third
 * implementation here would be the same mistake with the lesson still warm.
 */
async function searchImessage(query: string, limit: number): Promise<FederatedResult[]> {
  const { sweepImessage } = await import("./pulse-check-sweep")
  // A year, because search is a lookup rather than a momentum question — the
  // sweep's 30-day framing is wrong for "where have I seen this".
  const r = sweepImessage({ keyword: query, repo: process.cwd(), windowDays: 365, limit, sources: ["imessage"] })
  if (!r.searched) throw new Error(r.unavailableReason ?? "iMessage unreadable")
  return r.items.map((i) => ({
    source: "imessage" as const,
    title: i.text ? String(i.text).slice(0, 120) : "(attachment)",
    location: i.where,
    when: i.when,
  }))
}

async function searchGmailSource(query: string, limit: number): Promise<FederatedResult[]> {
  const { sweepGmail } = await import("./pulse-check-sweep")
  const r = await sweepGmail({ keyword: query, repo: process.cwd(), windowDays: 365, limit, sources: ["gmail"] })
  if (!r.searched) throw new Error(r.unavailableReason ?? "Gmail unavailable")
  return r.items.map((i) => ({
    source: "gmail" as const,
    title: String(i.where ?? "(no subject)"),
    snippet: i.text,
    when: i.when,
  }))
}

/**
 * Run the query across the chosen sources.
 *
 * Every source reports an outcome — ok, skipped or error — and one source failing never
 * fails the search. The caller is expected to SHOW the outcomes; a quiet failure here is
 * indistinguishable from "no matches", which is the whole thing we are guarding against.
 */
export async function federatedSearch(
  query: string,
  opts: { sources: SourceName[]; bloqId?: number; userId?: number; limit?: number },
): Promise<FederatedSearchResult> {
  const limit = opts.limit ?? 25
  const results: FederatedResult[] = []
  const outcomes: SourceOutcome[] = []

  const run = async (source: SourceName, fn: () => Promise<FederatedResult[]>, skipReason?: string) => {
    if (skipReason) {
      outcomes.push({ source, state: "skipped", reason: skipReason })
      return
    }
    try {
      const found = await fn()
      results.push(...found)
      outcomes.push({ source, state: "ok", count: found.length })
    } catch (e: any) {
      outcomes.push({ source, state: "error", reason: String(e?.message ?? e).slice(0, 120) })
    }
  }

  await Promise.all([
    opts.sources.includes("bloq")
      ? run(
          "bloq",
          () => searchBloq(query, opts.bloqId, opts.userId!, limit),
          // Only an unresolved USER is a genuine skip now. A missing bloq id just means
          // "search all of them" — the previous skip made the default case the broken one.
          opts.userId == null ? "not signed in" : undefined,
        )
      : Promise.resolve(),
    opts.sources.includes("obsidian") ? run("obsidian", () => searchObsidian(query, limit)) : Promise.resolve(),
    opts.sources.includes("drive")
      ? run("drive", () => searchDrive(query, opts.userId!, limit), opts.userId == null ? "not signed in" : undefined)
      : Promise.resolve(),
    opts.sources.includes("imessage")
      ? run(
          "imessage",
          () => searchImessage(query, limit),
          process.platform !== "darwin" ? "iMessage is only readable on macOS" : undefined,
        )
      : Promise.resolve(),
    opts.sources.includes("gmail") ? run("gmail", () => searchGmailSource(query, limit)) : Promise.resolve(),
  ])

  return { results, outcomes }
}

/** One-line summary naming every source's outcome. Never omit a failed source. */
export function formatOutcomes(outcomes: SourceOutcome[]): string {
  return outcomes
    .map((o) =>
      o.state === "ok"
        ? `${o.source} ${o.count}`
        : o.state === "skipped"
          ? `${o.source} SKIPPED (${o.reason})`
          : `${o.source} ERROR (${o.reason})`,
    )
    .join("  ·  ")
}
