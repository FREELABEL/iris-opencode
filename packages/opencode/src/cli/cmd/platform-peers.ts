import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { bold, dim, highlight, printDivider, writeJson } from "./iris-api"
import { downloadFile, metaAuthor, metaDate } from "./download"
import { fetchWithYtDlp, locateYtDlp, type FetchOptions } from "./media-fetch"
import { transcribeLocal, resolveWhisper, localWhisperInstallHint } from "../lib/transcription"
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs"
import { homedir, tmpdir } from "os"
import { join } from "path"

// ============================================================================
// iris peers — watch peer accounts (FL-CO-112, #191297, epic #191300)
//
// A creator pulls his competitors' latest reels every couple of days and lists the
// topics that did well for them that he hasn't covered. `iris download` takes one post
// at a time; this keeps a watch list, pulls each account's latest posts as METADATA
// (no video unless --transcribe), and ranks what worked against the user's own posts.
//
// Everything that decides something is a pure exported function, tested in
// platform-peers.test.ts. The handlers only do I/O. Nothing here runs on a schedule:
// background jobs need visible consent, so the user runs `pull` by hand.
// ============================================================================

export type PeerPlatform = "instagram" | "tiktok" | "youtube"
export const PLATFORMS: PeerPlatform[] = ["instagram", "tiktok", "youtube"]

export interface PeerEntry {
  /** Key for remove/pull and the folder name under ~/.iris/peers. Usually the handle. */
  id: string
  handle: string
  platform: PeerPlatform
  /** What yt-dlp is pointed at to list the account's posts. */
  url: string
  label?: string
  /** The user's own account — what `gaps` compares the peers against. At most one. */
  mine?: boolean
  added_at: string
}

export interface PeerPost {
  id: string
  url: string
  platform: string
  author: string | null
  date: string | null
  title: string | null
  caption: string | null
  views: number | null
  likes: number | null
  comments: number | null
  duration: number | null
  first_seen_at: string
  seen_at: string
  transcript?: string
  transcribed_at?: string
}

// ── storage ──────────────────────────────────────────────────────────────────

/** ~/.iris/peers, honouring IRIS_HOME like the other local stores (platform-node, kinetic). */
export function peersDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.IRIS_PEERS_HOME) return env.IRIS_PEERS_HOME
  return join(env.IRIS_HOME || join(homedir(), ".iris"), "peers")
}

function readJson<T>(path: string, fallback: T): T {
  if (!existsSync(path)) return fallback
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return fallback
  }
}

/** Write through a temp file so a crash mid-write never leaves half a watch list. */
function writeJsonFile(path: string, value: unknown): void {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n", "utf8")
  renameSync(tmp, path)
}

export function loadPeers(dir = peersDir()): PeerEntry[] {
  const v = readJson<{ peers?: PeerEntry[] }>(join(dir, "peers.json"), { peers: [] })
  return Array.isArray(v.peers) ? v.peers : []
}

export function savePeers(peers: PeerEntry[], dir = peersDir()): void {
  mkdirSync(dir, { recursive: true })
  writeJsonFile(join(dir, "peers.json"), { version: 1, peers })
}

/** Folder-safe form of an entry id. */
export function safeId(id: string): string {
  return id.replace(/[^A-Za-z0-9._-]/g, "_")
}

export function postsPath(id: string, dir = peersDir()): string {
  return join(dir, safeId(id), "posts.json")
}

export function loadPosts(id: string, dir = peersDir()): PeerPost[] {
  const v = readJson<{ posts?: PeerPost[] }>(postsPath(id, dir), { posts: [] })
  return Array.isArray(v.posts) ? v.posts : []
}

export function savePosts(id: string, posts: PeerPost[], dir = peersDir()): void {
  mkdirSync(join(dir, safeId(id)), { recursive: true })
  writeJsonFile(postsPath(id, dir), { version: 1, posts })
}

// ── handle / url normalisation ────────────────────────────────────────────────

export type ParsedTarget = { platform: PeerPlatform; handle: string; url: string }

/**
 * Turn what a person types — `@khaby.lame`, `natgeo`, a profile URL, or even one post's URL —
 * into the account and the URL that lists its posts. Returns an error string when it can't.
 *
 * A bare handle needs a platform; without --platform it is taken as Instagram, where creators
 * mostly watch each other. YouTube profiles list the /videos tab unless the URL names another
 * (`/shorts`, `/streams`) — a bare channel URL makes yt-dlp walk every tab.
 */
export function parseTarget(input: string, platform?: string): ParsedTarget | { error: string } {
  const raw = input.trim()
  if (!raw) return { error: "empty handle" }
  if (platform && !PLATFORMS.includes(platform as PeerPlatform)) {
    return { error: `unknown platform "${platform}" — use ${PLATFORMS.join(", ")}` }
  }

  const looksLikeUrl = /^https?:\/\//i.test(raw) || /^(www\.|m\.)?(instagram|tiktok|youtube)\.com\//i.test(raw)
  if (!looksLikeUrl) {
    const handle = raw.replace(/^@+/, "")
    if (!/^[A-Za-z0-9._-]+$/.test(handle)) return { error: `"${raw}" is not a handle or a URL` }
    const p = (platform as PeerPlatform) || "instagram"
    return { platform: p, handle, url: profileUrl(p, handle) }
  }

  let u: URL
  try {
    u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`)
  } catch {
    return { error: `"${raw}" is not a valid URL` }
  }
  const host = u.hostname.toLowerCase().replace(/^(www|m)\./, "")
  const parts = u.pathname.split("/").filter(Boolean)

  if (host === "instagram.com") {
    const reserved = new Set(["p", "reel", "reels", "tv", "stories", "explore", "accounts"])
    const first = parts[0]
    if (!first || reserved.has(first.toLowerCase())) {
      return { error: `${raw} is a single Instagram post, not a profile — add the account (e.g. instagram.com/<handle>)` }
    }
    return { platform: "instagram", handle: first, url: profileUrl("instagram", first) }
  }
  if (host === "tiktok.com") {
    const at = parts.find((p) => p.startsWith("@"))
    if (!at) return { error: `${raw} doesn't name a TikTok account (expected tiktok.com/@handle)` }
    const handle = at.slice(1)
    return { platform: "tiktok", handle, url: profileUrl("tiktok", handle) }
  }
  if (host === "youtube.com" || host === "youtu.be") {
    const tabs = new Set(["videos", "shorts", "streams", "featured"])
    let handle: string | null = null
    let base: string | null = null
    if (parts[0]?.startsWith("@")) {
      handle = parts[0].slice(1)
      base = `https://www.youtube.com/${parts[0]}`
    } else if ((parts[0] === "c" || parts[0] === "user" || parts[0] === "channel") && parts[1]) {
      handle = parts[1]
      base = `https://www.youtube.com/${parts[0]}/${parts[1]}`
    }
    if (!handle || !base) return { error: `${raw} doesn't name a YouTube channel (expected youtube.com/@handle)` }
    const rest = parts.slice(base.split("/").length - 3)
    const tab = rest.find((p) => tabs.has(p.toLowerCase()))
    const pick = tab && tab.toLowerCase() !== "featured" ? tab.toLowerCase() : "videos"
    return { platform: "youtube", handle, url: `${base}/${pick}` }
  }
  return { error: `${host} isn't supported yet — use an Instagram, TikTok or YouTube account` }
}

export function profileUrl(platform: PeerPlatform, handle: string): string {
  if (platform === "tiktok") return `https://www.tiktok.com/@${handle}`
  if (platform === "youtube") return `https://www.youtube.com/@${handle}/videos`
  return `https://www.instagram.com/${handle}/`
}

/**
 * Add (or update) entries. The same handle on two platforms is common — creators keep one name
 * everywhere — so the second gets `<handle>-<platform>` as its id instead of overwriting the first.
 * Marking one `mine` unmarks every other.
 */
export function addPeer(
  peers: PeerEntry[],
  t: ParsedTarget,
  opts: { label?: string; mine?: boolean; now: string },
): { peers: PeerEntry[]; entry: PeerEntry; created: boolean } {
  const existing = peers.find((p) => p.platform === t.platform && p.handle.toLowerCase() === t.handle.toLowerCase())
  let next = peers.map((p) => ({ ...p }))
  if (opts.mine) next = next.map((p) => ({ ...p, mine: undefined }))
  if (existing) {
    const i = next.findIndex((p) => p.id === existing.id)
    next[i] = {
      ...next[i],
      url: t.url,
      ...(opts.label !== undefined ? { label: opts.label } : {}),
      ...(opts.mine ? { mine: true } : {}),
    }
    return { peers: clean(next), entry: next[i], created: false }
  }
  const taken = new Set(next.map((p) => p.id.toLowerCase()))
  let id = t.handle
  if (taken.has(id.toLowerCase())) id = `${t.handle}-${t.platform}`
  const entry: PeerEntry = {
    id,
    handle: t.handle,
    platform: t.platform,
    url: t.url,
    ...(opts.label ? { label: opts.label } : {}),
    ...(opts.mine ? { mine: true } : {}),
    added_at: opts.now,
  }
  next.push(entry)
  return { peers: clean(next), entry, created: true }
}

function clean(peers: PeerEntry[]): PeerEntry[] {
  return peers.map((p) => {
    const { mine, ...rest } = p
    return mine ? { ...rest, mine: true } : rest
  })
}

/** Find an entry by id, or by handle (with or without @) when that is unambiguous. */
export function findPeer(peers: PeerEntry[], key: string): PeerEntry | null {
  const k = key.trim().replace(/^@+/, "").toLowerCase()
  const byId = peers.find((p) => p.id.toLowerCase() === k)
  if (byId) return byId
  const byHandle = peers.filter((p) => p.handle.toLowerCase() === k)
  return byHandle.length === 1 ? byHandle[0] : null
}

// ── yt-dlp JSON → post record ─────────────────────────────────────────────────

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null
}

/**
 * One line of `yt-dlp --dump-json` (or `--flat-playlist`) into the record we keep. Returns null
 * for lines that aren't a post (a playlist wrapper, a line with no id).
 */
export function postFromYtDlp(meta: any, now: string): PeerPost | null {
  if (!meta || typeof meta !== "object") return null
  if (meta._type === "playlist") return null
  const id = meta.id != null ? String(meta.id) : null
  if (!id) return null
  const url = meta.webpage_url || meta.original_url || (typeof meta.url === "string" && /^https?:/.test(meta.url) ? meta.url : null)
  if (!url) return null
  const title = typeof meta.title === "string" ? meta.title : null
  const caption = typeof meta.description === "string" && meta.description.trim() ? meta.description : null
  return {
    id,
    url,
    platform: String(meta.extractor_key || meta.ie_key || meta.extractor || "unknown").toLowerCase(),
    author: metaAuthor(meta) || meta.playlist_uploader || null,
    date: metaDate(meta),
    title,
    caption,
    views: num(meta.view_count),
    likes: num(meta.like_count),
    comments: num(meta.comment_count),
    duration: num(meta.duration),
    first_seen_at: now,
    seen_at: now,
  }
}

/** Parse yt-dlp's one-JSON-object-per-line stdout; garbage lines are skipped, not fatal. */
export function parseYtDlpLines(stdout: string, now: string): PeerPost[] {
  const out: PeerPost[] = []
  for (const line of (stdout || "").split("\n")) {
    const s = line.trim()
    if (!s.startsWith("{")) continue
    try {
      const p = postFromYtDlp(JSON.parse(s), now)
      if (p) out.push(p)
    } catch {}
  }
  return out
}

/**
 * Merge freshly pulled posts into what's stored. Keyed on id: metrics take the newer value
 * (a flat listing that has no likes must not erase likes a full pull found), first_seen_at and
 * any transcript are kept, seen_at moves to now. Newest first.
 */
export function mergePosts(stored: PeerPost[], fresh: PeerPost[]): { posts: PeerPost[]; added: number; updated: number } {
  const byId = new Map<string, PeerPost>()
  for (const p of stored) byId.set(p.id, p)
  let added = 0
  let updated = 0
  for (const f of fresh) {
    const old = byId.get(f.id)
    if (!old) {
      byId.set(f.id, f)
      added++
      continue
    }
    updated++
    byId.set(f.id, {
      ...old,
      url: f.url || old.url,
      author: f.author ?? old.author,
      date: f.date ?? old.date,
      title: f.title ?? old.title,
      caption: f.caption ?? old.caption,
      views: f.views ?? old.views,
      likes: f.likes ?? old.likes,
      comments: f.comments ?? old.comments,
      duration: f.duration ?? old.duration,
      first_seen_at: old.first_seen_at || f.first_seen_at,
      seen_at: f.seen_at,
    })
  }
  const posts = [...byId.values()].sort(
    (a, b) => (b.date ?? "").localeCompare(a.date ?? "") || b.seen_at.localeCompare(a.seen_at) || a.id.localeCompare(b.id),
  )
  return { posts, added, updated }
}

// ── failures, in words a person can act on ────────────────────────────────────

export type PullFailure = "login" | "broken" | "not_found" | "rate_limited" | "unsupported" | "other"

export function classifyPullError(stderr: string): PullFailure {
  const s = stderr || ""
  if (/log ?in|login required|cookies|checkpoint|not logged|authentication/i.test(s)) return "login"
  if (/rate.?limit|too many requests|\b429\b/i.test(s)) return "rate_limited"
  if (/marked as broken|unable to extract|currently broken/i.test(s)) return "broken"
  if (/does not exist|\b404\b|not found|this account is private|unavailable/i.test(s)) return "not_found"
  if (/unsupported url/i.test(s)) return "unsupported"
  return "other"
}

/** One plain sentence (or two) saying why an account didn't list, and what to do. */
export function pullFailureMessage(entry: Pick<PeerEntry, "id" | "platform">, kind: PullFailure, detail: string): string {
  const who = `@${entry.id} (${entry.platform})`
  const reelHint = `As a fallback, add posts one at a time: iris peers pull ${entry.id} --urls <post-url> …`
  if (entry.platform === "instagram" && (kind === "login" || kind === "broken" || kind === "rate_limited" || kind === "other")) {
    return [
      `${who}: Instagram wouldn't list this profile without a logged-in session.`,
      `  Export cookies from a browser where you're logged in to Instagram (a cookies.txt file) and run: iris peers pull ${entry.id} --cookies <cookies.txt>`,
      `  Note: yt-dlp currently marks its Instagram profile extractor as broken, so even with cookies this may fail. ${reelHint}`,
      `  yt-dlp said: ${detail}`,
    ].join("\n")
  }
  if (kind === "login") return `${who}: this account needs a logged-in session. Pass --cookies <cookies.txt>. yt-dlp said: ${detail}`
  if (kind === "rate_limited") return `${who}: the platform is rate-limiting us. Try again later with a smaller --latest. yt-dlp said: ${detail}`
  if (kind === "not_found") return `${who}: the account wasn't found or is private. Check the handle with iris peers list. yt-dlp said: ${detail}`
  if (kind === "broken") return `${who}: yt-dlp couldn't read this profile page (its extractor may be out of date — try yt-dlp -U). ${reelHint}`
  return `${who}: listing failed. yt-dlp said: ${detail}`
}

// ── pulling ────────────────────────────────────────────────────────────────────

export interface PullOptions {
  latest: number
  flat?: boolean
  cookies?: string
  /** Injected in tests so nothing touches the network. */
  run?: FetchOptions["run"]
}

/** The yt-dlp arguments for listing one account. Metadata only — never a video. */
export function listArgs(o: { latest: number; flat?: boolean; cookies?: string }): string[] {
  return [
    "--skip-download",
    "--dump-json",
    "--ignore-errors",
    "--playlist-end", String(Math.max(1, Math.floor(o.latest))),
    ...(o.flat ? ["--flat-playlist"] : []),
    ...(o.cookies ? ["--cookies", o.cookies] : []),
  ]
}

export interface PullResult {
  ok: boolean
  posts: PeerPost[]
  failure?: PullFailure
  error?: string
}

/**
 * List one account's latest posts. A run that printed some posts and then hit an error still
 * counts — --ignore-errors exits 1 while keeping every line it got.
 *
 * Cookies: YouTube and TikTok list fine without them, so no browser cookie store is touched
 * for those. Instagram needs a session — from --cookies, or the browser ladder in
 * fetchWithYtDlp as a best effort.
 */
export function pullAccount(ytdlp: string, entry: PeerEntry, o: PullOptions, now: string): PullResult {
  const r = fetchWithYtDlp(ytdlp, entry.url, {
    args: listArgs(o),
    cookies: o.cookies || entry.platform !== "instagram" ? "none" : "auto",
    timeoutMs: 180_000,
    selfUpdate: entry.platform === "youtube",
    verbose: false,
    run: o.run,
  })
  const posts = parseYtDlpLines(r.stdout ?? "", now).slice(0, o.latest)
  if (posts.length > 0) return { ok: true, posts }
  const detail = r.error || r.stderr || "no posts returned"
  return { ok: false, posts: [], failure: classifyPullError(r.stderr || r.error || ""), error: detail }
}

/** Single post URLs, for when a profile won't list (Instagram). */
export function pullUrls(ytdlp: string, urls: string[], o: { cookies?: string; run?: FetchOptions["run"] }, now: string): { posts: PeerPost[]; errors: string[] } {
  const posts: PeerPost[] = []
  const errors: string[] = []
  for (const url of urls) {
    const r = fetchWithYtDlp(ytdlp, url, {
      args: ["--skip-download", "--dump-json", "--no-playlist", ...(o.cookies ? ["--cookies", o.cookies] : [])],
      cookies: o.cookies ? "none" : "auto",
      timeoutMs: 60_000,
      selfUpdate: false,
      verbose: false,
      run: o.run,
    })
    const got = parseYtDlpLines(r.stdout ?? "", now)
    if (got.length) posts.push(got[0])
    else errors.push(`${url}: ${r.error || "no metadata"}`)
  }
  return { posts, errors }
}

// ── topics ─────────────────────────────────────────────────────────────────────

export const STOPWORDS = new Set(
  (
    "a about above after again against all also am an and any are aren't as at be because been before being below " +
    "between both but by can can't cannot could couldn't did didn't do does doesn't doing don't down during each few " +
    "for from further get got had hadn't has hasn't have haven't having he he'd he'll he's her here here's hers herself " +
    "him himself his how how's i i'd i'll i'm i've if in into is isn't it it's its itself just let's like me more most " +
    "mustn't my myself no nor not now of off on once only or other ought our ours ourselves out over own really same " +
    "shan't she she'd she'll she's should shouldn't so some such than that that's the their theirs them themselves then " +
    "there there's these they they'd they'll they're they've this those through to too under until up us very was wasn't " +
    "we we'd we'll we're we've were weren't what what's when when's where where's which while who who's whom why why's " +
    "will with won't would wouldn't you you'd you'll you're you've your yours yourself yourselves " +
    // social filler
    "video videos reel reels post posts watch follow comment comments link bio subscribe channel new today day thing things " +
    "know think make made going gonna wanna want one two way time back see look said say says much many every lot " +
    "full here's check share tag dm part episode official guys yes yeah okay ok lol omg via still even ever need " +
    "first last best good great right well take come came give put use used tell"
  ).split(/\s+/),
)

/** Hashtags that say "please show this to people", not what the post is about. */
export const NOISE_TAGS = new Set(
  (
    "fyp foryou foryoupage fy viral viralvideo trending trend explore explorepage reels reel reelsinstagram instagood " +
    "instagram tiktok youtube shorts short ytshorts youtubeshorts love like likes follow followme f4f l4l xyzbca capcut duet stitch"
  ).split(" "),
)

/**
 * Words and two-word phrases a post is about, from its title, caption and transcript.
 * Lowercased; URLs, @mentions, numbers and stopwords dropped; hashtags kept as words unless
 * they're reach-bait (#fyp). A phrase is two kept words that sat next to each other in the
 * text, so "iphone duo" survives and "duo the review" never forms. No LLM, same answer every run.
 */
export function extractKeywords(text: string): string[] {
  const t = (text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/www\.\S+/g, " ")
    .replace(/@[\p{L}\p{N}._]+/gu, " ")
    .replace(/#([\p{L}\p{N}_]+)/gu, (_m, tag: string) => (NOISE_TAGS.has(tag) ? " | " : ` ${tag} | `))
    .replace(/[’`]/g, "'")
  // Split into runs; a run boundary (punctuation, line break, removed token) breaks phrases.
  const runs = t.split(/[^\p{L}\p{N}'\s]+|\n+/u)
  const keep = (w: string) => w.length >= 3 && !STOPWORDS.has(w) && !/^\d+$/.test(w) && !NOISE_TAGS.has(w)
  const seen = new Set<string>()
  const out: string[] = []
  const push = (k: string) => {
    if (!seen.has(k)) {
      seen.add(k)
      out.push(k)
    }
  }
  for (const run of runs) {
    const words = run
      .split(/\s+/)
      .map((w) => w.replace(/^'+|'+$/g, "").replace(/'s$/, ""))
      .filter(Boolean)
    let prev: string | null = null
    for (const w of words) {
      if (!keep(w)) {
        prev = null
        continue
      }
      push(w)
      if (prev) push(`${prev} ${w}`)
      prev = w
    }
  }
  return out
}

export function postText(p: Pick<PeerPost, "title" | "caption" | "transcript">): string {
  // Instagram titles are "Video by <handle>" — a label, not a topic.
  const title = p.title && !/^video by /i.test(p.title) ? p.title : ""
  return [title, p.caption ?? "", p.transcript ?? ""].join("\n")
}

/** The few keywords that name the topic: phrases first (more specific), then words, in text order. */
export function topicLabel(keywords: string[], max = 3): string[] {
  const phrases = keywords.filter((k) => k.includes(" "))
  const words = keywords.filter((k) => !k.includes(" "))
  const out: string[] = []
  for (const k of [...phrases, ...words]) {
    if (out.length >= max) break
    if (out.some((o) => o.includes(k))) continue
    out.push(k)
  }
  return out
}

/**
 * How much of a post's subject the user has already covered: the share of the post's single
 * words that appear anywhere in the user's own posts. Words, not phrases — "iphone" in your
 * post counts as touching "iphone duo" — so the score errs toward "covered", which keeps the
 * not-covered list short and honest.
 */
export function coverageScore(postKeywords: string[], mine: Set<string>): number {
  const words = postKeywords.filter((k) => !k.includes(" "))
  if (words.length === 0) return 0
  const hit = words.filter((w) => mine.has(w)).length
  return Math.round((hit / words.length) * 100) / 100
}

export function median(xs: number[]): number | null {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (v.length === 0) return null
  const m = Math.floor(v.length / 2)
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2
}

/** Views when the platform reports them; Instagram without a login reports only likes. */
export function metricOf(p: Pick<PeerPost, "views" | "likes">): { value: number; metric: "views" | "likes" } | null {
  if (p.views != null) return { value: p.views, metric: "views" }
  if (p.likes != null) return { value: p.likes, metric: "likes" }
  return null
}

export interface GapRow {
  account: string
  label?: string
  url: string
  date: string | null
  views: number | null
  likes: number | null
  metric: "views" | "likes"
  /** This post's metric ÷ the account's median — 3.0 means three times its usual. */
  relative: number | null
  keywords: string[]
  topic: string[]
  overlap: number
  covered: boolean
}

export interface GapOptions {
  days: number
  top: number
  threshold: number
  sort: "relative" | "views"
  now: Date
}

function inWindow(p: PeerPost, cutoff: string): boolean {
  if (p.date) return p.date >= cutoff
  return (p.first_seen_at || "").slice(0, 10) >= cutoff
}

/**
 * Rank peer posts in the window and mark each covered or not against the user's own posts.
 *
 * Each account is measured against ITS OWN median (over the window, or every stored post when
 * the window holds fewer than three), so a 5k-follower account's 10× breakout outranks a big
 * account's ordinary day. Ties fall back to raw views, then URL, so output is stable.
 */
export function rankGaps(
  accounts: { entry: PeerEntry; posts: PeerPost[] }[],
  minePosts: PeerPost[],
  o: GapOptions,
): { rows: GapRow[]; considered: number } {
  const cutoff = new Date(o.now.getTime() - o.days * 86_400_000).toISOString().slice(0, 10)
  const mine = new Set<string>()
  for (const p of minePosts) for (const k of extractKeywords(postText(p))) if (!k.includes(" ")) mine.add(k)

  const rows: GapRow[] = []
  for (const { entry, posts } of accounts) {
    const win = posts.filter((p) => inWindow(p, cutoff))
    const basis = win.length >= 3 ? win : posts
    const metricKind = win.some((p) => p.views != null) ? "views" : "likes"
    const med = median(basis.map((p) => (metricKind === "views" ? p.views : p.likes)).filter((x): x is number => x != null))
    for (const p of win) {
      const value = metricKind === "views" ? p.views : p.likes
      if (value == null) continue
      const keywords = extractKeywords(postText(p))
      const overlap = coverageScore(keywords, mine)
      rows.push({
        account: entry.id,
        ...(entry.label ? { label: entry.label } : {}),
        url: p.url,
        date: p.date,
        views: p.views,
        likes: p.likes,
        metric: metricKind,
        relative: med && med > 0 ? Math.round((value / med) * 100) / 100 : null,
        keywords,
        topic: topicLabel(keywords),
        overlap,
        covered: minePosts.length > 0 && overlap >= o.threshold,
      })
    }
  }
  const raw = (r: GapRow) => (r.metric === "views" ? r.views : r.likes) ?? 0
  const considered = rows.length
  rows.sort((a, b) => {
    if (o.sort === "relative") {
      const d = (b.relative ?? 0) - (a.relative ?? 0)
      if (d) return d
    }
    return raw(b) - raw(a) || (b.relative ?? 0) - (a.relative ?? 0) || a.url.localeCompare(b.url)
  })
  return { rows, considered }
}

// ── output helpers ─────────────────────────────────────────────────────────────

export function compact(n: number | null | undefined): string {
  if (n == null) return "—"
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(n >= 10_000 ? 0 : 1)}k`
  return String(n)
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// ── commands ───────────────────────────────────────────────────────────────────

const PeersAddCommand = cmd({
  command: "add <targets..>",
  describe: "watch one or more accounts (handle or profile URL)",
  builder: (y) =>
    y
      .positional("targets", { type: "string", array: true, demandOption: true, describe: "@handle or profile URL" })
      .option("platform", { type: "string", choices: PLATFORMS, describe: "platform for bare handles (default instagram)" })
      .option("label", { type: "string", describe: "your note for the account, e.g. its scene" })
      .option("mine", { type: "boolean", default: false, describe: "this is YOUR account — gaps compares the peers against it" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const targets = (args.targets as string[]).map(String)
    if (args.mine && targets.length > 1) {
      prompts.log.error("--mine marks one account; add your own account on its own.")
      process.exitCode = 1
      return
    }
    let peers = loadPeers()
    const now = new Date().toISOString()
    const done: PeerEntry[] = []
    const errors: string[] = []
    for (const t of targets) {
      const parsed = parseTarget(t, args.platform as string | undefined)
      if ("error" in parsed) {
        errors.push(parsed.error)
        continue
      }
      const r = addPeer(peers, parsed, { label: args.label as string | undefined, mine: !!args.mine, now })
      peers = r.peers
      done.push(r.entry)
    }
    if (done.length) savePeers(peers)
    if (args.json) {
      await writeJson({ ok: errors.length === 0, added: done, errors })
    } else {
      for (const e of done) {
        console.log(`  ${highlight("+")} ${bold(e.id)} ${dim(`${e.platform} · ${e.url}`)}${e.mine ? " " + bold("(mine)") : ""}${e.label ? dim(` · ${e.label}`) : ""}`)
      }
      for (const e of errors) prompts.log.error(e)
      if (done.length) console.log(dim(`\n  Next: iris peers pull`))
    }
    if (errors.length) process.exitCode = 1
  },
})

const PeersRemoveCommand = cmd({
  command: "remove <handle>",
  aliases: ["rm"],
  describe: "stop watching an account (its saved posts stay on disk)",
  builder: (y) => y.positional("handle", { type: "string", demandOption: true }),
  async handler(args) {
    const peers = loadPeers()
    const hit = findPeer(peers, String(args.handle))
    if (!hit) {
      prompts.log.error(`Not watching "${args.handle}". See: iris peers list`)
      process.exitCode = 1
      return
    }
    savePeers(peers.filter((p) => p.id !== hit.id))
    console.log(`  ${dim("−")} ${bold(hit.id)} ${dim(`removed (posts kept in ${join(peersDir(), safeId(hit.id))})`)}`)
  },
})

const PeersListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "show the watch list",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    const peers = loadPeers()
    const rows = peers.map((p) => {
      const posts = loadPosts(p.id)
      const last = posts.reduce((m, x) => (x.seen_at > m ? x.seen_at : m), "")
      return { ...p, posts: posts.length, transcribed: posts.filter((x) => x.transcript).length, last_pulled: last || null }
    })
    if (args.json) {
      await writeJson({ dir: peersDir(), peers: rows })
      return
    }
    if (!rows.length) {
      console.log(dim("  Not watching anyone yet. Try: iris peers add https://www.tiktok.com/@someone"))
      return
    }
    printDivider()
    for (const r of rows) {
      console.log(
        `  ${bold(r.id.padEnd(22))} ${r.platform.padEnd(10)} ${String(r.posts).padStart(4)} posts  ${dim(r.last_pulled ? `pulled ${r.last_pulled.slice(0, 16).replace("T", " ")}` : "never pulled")}${r.mine ? "  " + bold("mine") : ""}${r.label ? dim(`  ${r.label}`) : ""}`,
      )
    }
    printDivider()
    console.log(dim(`  ${peersDir()}`))
  },
})

const PULL_EPILOG = [
  "Nothing here runs on its own — IRIS never schedules this for you.",
  "To refresh every two days yourself, add a line to your own crontab (crontab -e):",
  "  0 9 */2 * * iris peers pull --latest 12",
  "Instagram profiles usually need a logged-in session: --cookies <cookies.txt>.",
].join("\n")

const PeersPullCommand = cmd({
  command: "pull [handles..]",
  describe: "fetch each watched account's latest posts (metadata only; --transcribe adds audio→text)",
  builder: (y) =>
    y
      .positional("handles", { type: "string", array: true, describe: "only these accounts (default: all)" })
      .option("latest", { type: "number", default: 12, describe: "how many recent posts per account" })
      .option("transcribe", { type: "boolean", default: false, describe: "download audio for posts not yet transcribed and transcribe on-device (whisper.cpp)" })
      .option("flat", { type: "boolean", default: false, describe: "faster listing with fewer fields (no dates/likes on YouTube)" })
      .option("cookies", { type: "string", describe: "Netscape cookies.txt passed to yt-dlp (needed for most Instagram profiles)" })
      .option("urls", { type: "string", array: true, describe: "add these single post URLs to ONE account instead of listing its profile" })
      .option("delay", { type: "number", default: 3, describe: "seconds to wait between accounts" })
      .option("json", { type: "boolean", default: false })
      .epilog(PULL_EPILOG),
  async handler(args) {
    const json = !!args.json
    const peers = loadPeers()
    if (!peers.length) {
      prompts.log.error("Not watching anyone yet. Add an account: iris peers add <handle-or-url>")
      process.exitCode = 1
      return
    }
    const wanted = ((args.handles as string[] | undefined) ?? []).map(String)
    const targets: PeerEntry[] = []
    for (const w of wanted) {
      const hit = findPeer(peers, w)
      if (!hit) {
        prompts.log.error(`Not watching "${w}". See: iris peers list`)
        process.exitCode = 1
        return
      }
      targets.push(hit)
    }
    const list = targets.length ? targets : peers
    const urls = ((args.urls as string[] | undefined) ?? []).map(String)
    if (urls.length && list.length !== 1) {
      prompts.log.error("--urls adds posts to one account — name it: iris peers pull <handle> --urls <url> …")
      process.exitCode = 1
      return
    }
    if (args.cookies && !existsSync(String(args.cookies))) {
      prompts.log.error(`Cookies file not found: ${args.cookies}`)
      process.exitCode = 1
      return
    }

    if (!json) {
      UI.empty()
      prompts.intro("  Peers · pull")
    }
    const ytdlp = await locateYtDlp()
    if (!ytdlp) {
      process.exitCode = 1
      return
    }
    const latest = Math.max(1, Math.floor(Number(args.latest) || 12))
    const delayMs = Math.max(0, Number(args.delay ?? 3)) * 1000
    const cookies = args.cookies ? String(args.cookies) : undefined
    const summary: any[] = []
    let whisperMissing = false

    for (let i = 0; i < list.length; i++) {
      const entry = list[i]
      if (i > 0 && delayMs) await sleep(delayMs)
      const now = new Date().toISOString()
      const sp = json ? null : prompts.spinner()
      sp?.start(`@${entry.id} (${entry.platform}) — listing latest ${latest}…`)

      let fresh: PeerPost[]
      let failMsg: string | null = null
      let failure: PullFailure | undefined
      if (urls.length) {
        const r = pullUrls(ytdlp, urls, { cookies }, now)
        fresh = r.posts
        if (r.errors.length) failMsg = r.errors.join("\n")
      } else {
        const r = pullAccount(ytdlp, entry, { latest, flat: !!args.flat, cookies }, now)
        fresh = r.posts
        if (!r.ok) {
          failure = r.failure
          failMsg = pullFailureMessage(entry, r.failure ?? "other", r.error ?? "")
        }
      }

      const merged = mergePosts(loadPosts(entry.id), fresh)
      if (fresh.length) savePosts(entry.id, merged.posts)
      if (fresh.length) sp?.stop(`@${entry.id}: ${fresh.length} posts (${merged.added} new) → ${merged.posts.length} saved`)
      else sp?.stop(`@${entry.id}: nothing listed`, 1)
      if (failMsg && !json) prompts.log.warn(failMsg)

      // Transcribe only what's new to us — the posts just listed that have no transcript yet.
      let transcribed = 0
      const tErrors: string[] = []
      if (args.transcribe && fresh.length && !whisperMissing) {
        if (!resolveWhisper()) {
          whisperMissing = true
          const msg = `On-device transcription isn't installed. Install it: ${localWhisperInstallHint()}`
          tErrors.push(msg)
          if (!json) prompts.log.warn(msg)
        } else {
          const ids = new Set(fresh.map((f) => f.id))
          let posts = merged.posts
          for (const p of posts.filter((x) => ids.has(x.id) && !x.transcript)) {
            const tsp = json ? null : prompts.spinner()
            tsp?.start(`  transcribing ${p.url}`)
            const audio = join(tmpdir(), `iris-peer-${safeId(entry.id)}-${safeId(p.id)}.m4a`)
            try {
              const d = await downloadFile(ytdlp, p.url, audio, "bestaudio[ext=m4a]/bestaudio/best", undefined, { extractAudio: "m4a" })
              if (!d.ok || !existsSync(audio)) throw new Error(d.error || "audio download failed")
              const text = (await transcribeLocal(audio)).trim()
              posts = posts.map((x) => (x.id === p.id ? { ...x, transcript: text, transcribed_at: new Date().toISOString() } : x))
              savePosts(entry.id, posts)
              transcribed++
              tsp?.stop(`  transcribed ${p.id} (${text.split(/\s+/).filter(Boolean).length} words)`)
            } catch (e) {
              const m = `${p.url}: ${e instanceof Error ? e.message : String(e)}`
              tErrors.push(m)
              tsp?.stop(`  couldn't transcribe ${p.id}`, 1)
            } finally {
              try { if (existsSync(audio)) unlinkSync(audio) } catch {}
            }
          }
        }
      }

      summary.push({
        id: entry.id,
        platform: entry.platform,
        ok: fresh.length > 0,
        listed: fresh.length,
        added: merged.added,
        total: fresh.length ? merged.posts.length : loadPosts(entry.id).length,
        ...(args.transcribe ? { transcribed, transcribe_errors: tErrors } : {}),
        ...(failMsg ? { failure: failure ?? "partial", error: failMsg } : {}),
      })
    }

    const failed = summary.filter((s) => !s.ok).length
    if (failed === summary.length) process.exitCode = 1
    if (json) {
      await writeJson({ ok: failed === 0, dir: peersDir(), accounts: summary })
      return
    }
    prompts.outro(
      failed
        ? `${summary.length - failed}/${summary.length} accounts pulled — see the notes above for the rest`
        : `${summary.length} account${summary.length > 1 ? "s" : ""} pulled. Next: iris peers gaps`,
    )
  },
})

const PeersGapsCommand = cmd({
  command: "gaps",
  describe: "what worked for your peers that you haven't covered (ranked, no AI)",
  builder: (y) =>
    y
      .option("top", { type: "number", default: 10, describe: "how many to show" })
      .option("days", { type: "number", default: 30, describe: "only posts from the last N days" })
      .option("threshold", { type: "number", default: 0.5, describe: "overlap (0–1) at which a post counts as covered by yours" })
      .option("sort", { type: "string", choices: ["relative", "views"], default: "relative", describe: "relative = vs the account's own median; views = raw" })
      .option("all", { type: "boolean", default: false, describe: "include topics you already covered" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const peers = loadPeers()
    const mineEntry = peers.find((p) => p.mine)
    const accounts = peers.filter((p) => !p.mine).map((entry) => ({ entry, posts: loadPosts(entry.id) }))
    const minePosts = mineEntry ? loadPosts(mineEntry.id) : []
    const { rows, considered } = rankGaps(accounts, minePosts, {
      days: Number(args.days) || 30,
      top: Number(args.top) || 10,
      threshold: Number(args.threshold ?? 0.5),
      sort: args.sort === "views" ? "views" : "relative",
      now: new Date(),
    })
    const shown = (args.all ? rows : rows.filter((r) => !r.covered)).slice(0, Number(args.top) || 10)
    const notes: string[] = []
    if (!mineEntry) notes.push("No account is marked as yours, so nothing counts as covered. Add it: iris peers add <your-handle> --mine")
    else if (!minePosts.length) notes.push(`Your account @${mineEntry.id} has no pulled posts yet — run: iris peers pull ${mineEntry.id}`)
    if (!accounts.some((a) => a.posts.length)) notes.push("No peer posts pulled yet — run: iris peers pull")

    if (args.json) {
      await writeJson({ mine: mineEntry?.id ?? null, considered, covered: rows.filter((r) => r.covered).length, notes, gaps: shown })
      return
    }
    UI.empty()
    prompts.intro("  Peers · gaps")
    for (const n of notes) prompts.log.warn(n)
    if (!shown.length) {
      prompts.outro(considered ? "Nothing uncovered in the window — you've touched every topic that worked." : "No peer posts in the window.")
      return
    }
    printDivider()
    shown.forEach((r, i) => {
      const rel = r.relative != null ? `${r.relative.toFixed(1)}× usual` : "—"
      console.log(`  ${bold(String(i + 1).padStart(2))}. ${bold(r.topic.join(" · ") || "(no clear topic)")}`)
      console.log(
        `      ${highlight("@" + r.account)}  ${compact(r.metric === "views" ? r.views : r.likes)} ${r.metric}  ${rel}  ${dim(`overlap ${r.overlap.toFixed(2)}${r.covered ? " (covered)" : ""}`)}  ${dim(r.date ?? "")}`,
      )
      console.log(`      ${dim(r.url)}`)
    })
    printDivider()
    prompts.outro(`${shown.length} of ${considered} peer posts from the last ${Number(args.days) || 30} days`)
  },
})

/**
 * `iris peers` — watch peer accounts and list what worked for them that you haven't covered.
 * (`iris hive peers` is a different thing: Hive mesh nodes. This is creators.)
 */
export const PlatformPeersCommand = cmd({
  command: "peers",
  describe: "watch peer/competitor accounts: pull their latest posts, list topics that worked you haven't covered",
  builder: (y) =>
    y
      .command(PeersAddCommand)
      .command(PeersRemoveCommand)
      .command(PeersListCommand)
      .command(PeersPullCommand)
      .command(PeersGapsCommand)
      .demandCommand()
      .epilog(
        [
          "Example:",
          "  iris peers add @rival1 @rival2 --platform tiktok --label houston",
          "  iris peers add @me --platform tiktok --mine",
          "  iris peers pull --latest 12",
          "  iris peers gaps --days 30",
          "",
          "Stored in ~/.iris/peers. Nothing is scheduled: run pull yourself (see iris peers pull --help).",
        ].join("\n"),
      ),
  async handler() {},
})
