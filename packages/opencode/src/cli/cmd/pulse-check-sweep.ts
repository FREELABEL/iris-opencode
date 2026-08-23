/**
 * Topic sweep — the loose-context half of `iris pulse check`.
 *
 * A lead has a row. A repo has a remote. A TOPIC has neither: "creator os" is a
 * thread of work whose only trace is the trail it left across everything you
 * touched. This module walks those trails on the local machine and reduces them
 * to the Observation shape the Signal Corpus already speaks, so a keyword becomes
 * a scoreable entity with history rather than a one-off grep.
 *
 * TWO RULES THIS FILE EXISTS TO ENFORCE:
 *
 * 1. A source that COULD NOT RUN is not a source that found nothing. A laptop
 *    without Full Disk Access cannot read iMessage; reporting that as "this topic
 *    is never discussed in messages" turns a permissions problem into a finding
 *    about the work, and they need opposite responses. Every sweep carries
 *    `searched` and, when false, a reason — TopicScorer excludes unsearched
 *    sources from breadth's denominator instead of counting them as misses.
 *
 * 2. A source that cannot see the PAST must not invent it. File mtimes tell you
 *    about now and nothing else, so the files collector omits `hitsPrior`
 *    entirely rather than sending zero. A fabricated zero baseline reads as
 *    explosive growth, which is the most flattering possible lie.
 */

import { execFileSync } from "child_process"
import { existsSync, readFileSync, readdirSync, statSync } from "fs"
import { join, basename, relative, dirname } from "path"
import { homedir } from "os"

export const TOPIC_SOURCES = ["git", "diary", "files", "claude_code", "opencode", "imessage", "email", "gmail", "bloq"] as const
export type TopicSource = typeof TOPIC_SOURCES[number]

/**
 * ASCII unit separator. Used as the field delimiter for git's --format and for
 * the iMessage SQL projection because it cannot occur in a commit subject, a
 * contact handle or a message body — a tab or a pipe can, and a split() on one
 * of those silently mangles any row whose content happens to contain it.
 */
const SEP = String.fromCharCode(31)

/** One thing one source found, kept human-readable for the brief. */
export interface Hit {
  /** ISO date of the artefact itself, not of the sweep. */
  when?: string
  /** Where it lives — a commit sha, a file path, a contact, a session title. */
  where: string
  /** Enough to judge relevance without opening it. */
  text?: string
}

export interface SourceSweep {
  source: TopicSource
  /** False means the collector could not look. See rule 1 above. */
  searched: boolean
  /** Why it could not look, or a caveat about how it did. */
  unavailableReason?: string
  hits: number
  /** Absent — not zero — when the source cannot reconstruct the prior window. */
  hitsPrior?: number
  lastHitEpoch?: number
  items: Hit[]
  /** Which spelling variants actually matched, for the brief. */
  matchedVariants?: string[]
  /** Set only when the keyword resolved to an Atlas board rather than to text. */
  board?: {
    id: number
    name: string
    lists: number
    items: number
    /** Lists holding nothing, or nothing touched in two windows. */
    silentLists: Array<{ id: number; name: string; items: number; newest: string | null }>
  }
}

export interface SweepOptions {
  keyword: string
  repo: string
  windowDays: number
  /** Max items kept per source for the brief. Counts are never capped. */
  limit: number
  sources: TopicSource[]
  bridgeUrl?: string
  /** Bridge auth token (~/.iris/bridge-token). Without it the bridge 401s. */
  bridgeKey?: string
  /**
   * Overrides the Messages database path. Exists so the iMessage collector can
   * be tested against a fixture: the real chat.db is one file at a fixed path
   * that no test may write to, which is why the three-places-a-message-lives bug
   * survived as long as it did.
   */
  messagesDb?: string
  /**
   * Injected rather than imported so this module stays free of the API layer and
   * its config loading — the collectors are the part worth unit-testing.
   */
  apiFetch?: (path: string) => Promise<Response>
  userId?: number
}

// ── keyword variants ────────────────────────────────────────────────────────

/**
 * "creator os" is also written creator-os, creator_os and creatoros depending on
 * whether it is prose, a branch name, a slug or a filename. Searching only the
 * literal phrase misses most of its own trail, which is the opposite of loose
 * context. Variants are reported back so a match on `creatoros` is not silently
 * presented as a match on the phrase.
 */
export function keywordVariants(keyword: string): string[] {
  const base = keyword.trim().toLowerCase().replace(/\s+/g, " ")

  // Tokenise on NON-ALPHANUMERICS, not on spaces. Splitting on spaces made the
  // variant set depend on how the subject happened to be punctuated: a board
  // called "MAYO — Life Atlas" produced `mayo-—-life-atlas` and `mayo—lifeatlas`
  // — an em-dash wedged between hyphens, matching nothing — while never
  // producing the plain `mayo-life-atlas` that the repo actually contains.
  //
  // Measured: `pulse check "MAYO — Life Atlas"` and `pulse check "mayo life
  // atlas"` returned DIFFERENT local results for the same subject (git 1/diary
  // 3/files 11 vs git 0/diary 4/files 8), neither a superset of the other. Same
  // failure shape as the cwd bug — one subject, two spellings, two confident
  // answers.
  const words = base.split(/[^a-z0-9]+/).filter(Boolean)

  // The raw phrase stays first so an exactly-punctuated match still works; the
  // token-derived forms are what make the two spellings converge.
  const out = new Set<string>([base])
  if (words.length > 1) {
    out.add(words.join(" "))
    out.add(words.join("-"))
    out.add(words.join("_"))
    out.add(words.join(""))
  } else if (words.length === 1) {
    out.add(words[0])
  }
  return [...out]
}

/**
 * The token SEQUENCE, matched with any separator — one pattern per subject.
 *
 * The variant list can only find separators someone thought to enumerate, so the
 * answer depended on how you happened to type the subject:
 *
 *     pulse check "MAYO — Life Atlas"   →  git 1 · diary 6 · files 13
 *     pulse check "mayo life atlas"     →  git 0 · diary 4 · files  8
 *
 * Same board. Two confident answers. Matching `mayo`, then up to a few
 * non-alphanumerics, then `life`, then `atlas` collapses every spelling onto one
 * question.
 *
 * THREE DELIBERATE DETAILS:
 *
 *  · The pattern is built from ALPHANUMERIC TOKENS, so regex metacharacters in
 *    the subject are separators by construction and never reach the engine as
 *    syntax. `$(whoami)` and `[a-z]` are inert without an escaping pass.
 *
 *  · `\n` is excluded from the separator class so a match cannot span a
 *    paragraph break — "…mayo." ending one line and "Life Atlas" starting the
 *    next is not an occurrence. (In POSIX ERE `[^a-z0-9\n]` additionally
 *    excludes a backslash, which is harmless: `n` is already covered by `a-z`.)
 *
 *  · The bound is 8, not 3, because grep counts BYTES under a C locale and an
 *    em-dash is three of them — " — " is five bytes. A tighter bound would have
 *    silently stopped matching the exact punctuation this fix exists for.
 *
 * Returns null when the subject has no alphanumerics at all: an empty pattern
 * matches every line, which is the loudest possible way to be wrong.
 */
export function keywordPattern(keyword: string): string | null {
  const tokens = keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
  if (tokens.length === 0) return null

  return tokens.join("[^a-z0-9\\n]{0,8}")
}

/** The subject reduced to its tokens — one label for every spelling of it. */
export function canonicalKeyword(keyword: string): string {
  return keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).join(" ")
}

/** The pattern as a JS regex, applied one LINE at a time exactly as grep does. */
function keywordRegex(keyword: string): RegExp | null {
  const pattern = keywordPattern(keyword)
  return pattern === null ? null : new RegExp(pattern, "i")
}

function matchesAny(haystack: string, variants: string[]): string[] {
  const lower = haystack.toLowerCase()
  return variants.filter((v) => lower.includes(v))
}

// ── shared helpers ──────────────────────────────────────────────────────────

function run(cmd: string, args: string[], cwd?: string, timeoutMs = 20000): string {
  try {
    return execFileSync(cmd, args, {
      cwd,
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim()
  } catch {
    return ""
  }
}

function unavailable(source: TopicSource, reason: string): SourceSweep {
  return { source, searched: false, unavailableReason: reason, hits: 0, items: [] }
}

function epochOf(iso: string | undefined): number | undefined {
  if (!iso) return undefined
  const t = Date.parse(iso)
  return Number.isNaN(t) ? undefined : Math.floor(t / 1000)
}

function finish(
  source: TopicSource,
  items: Hit[],
  hitsPrior: number | undefined,
  matched: Set<string>,
  limit: number,
): SourceSweep {
  const epochs = items.map((i) => epochOf(i.when)).filter((e): e is number => e !== undefined)
  return {
    source,
    searched: true,
    // The COUNT is the full result set; only the brief's item list is trimmed.
    hits: items.length,
    hitsPrior,
    lastHitEpoch: epochs.length ? Math.max(...epochs) : undefined,
    items: items.slice(0, limit),
    matchedVariants: [...matched],
  }
}

/**
 * Every git repository in the tree, parent included.
 *
 * Gitlinks are read from the INDEX (mode 160000), not from .gitmodules: this
 * monorepo has eleven nested repos and no .gitmodules at all, so the config
 * route returns an empty list and reports zero submodule activity — a false
 * negative shaped exactly like a quiet week.
 *
 * And an UNINITIALISED gitlink has no .git of its own, at which point
 * `git -C <dir>` silently walks UP and answers about the parent, double-counting
 * the parent's history as the submodule's. Requiring the toplevel to be the
 * directory itself is what refuses that.
 */
/**
 * The repository a person means when they say "this project".
 *
 * `rev-parse --show-toplevel` answers with the INNERMOST repo, which is correct
 * git and the wrong scope here: run from `iris-code/packages/opencode` it returns
 * `iris-code`, so the sweep saw 3 commits instead of the monorepo's 51 and could
 * not find the diary at all.
 *
 * So keep ascending — but only while the enclosing repo actually CONTAINS this
 * one as a gitlink. That is the precise statement of "this repo is a component
 * of that one", which is the monorepo case and nothing else. An unrelated
 * checkout that merely happens to sit inside another directory tree is not
 * absorbed, because its parent's index will not list it.
 */
export function resolveRepoRoot(dir: string): string | null {
  let top = run("git", ["-C", dir, "rev-parse", "--show-toplevel"]) || null
  if (!top) return null

  for (let depth = 0; depth < 8; depth++) {
    const parent = dirname(top)
    if (parent === top) break

    const outer = run("git", ["-C", parent, "rev-parse", "--show-toplevel"])
    if (!outer || outer === top) break

    const rel = relative(outer, top)
    const isComponent = run("git", ["-C", outer, "ls-files", "--stage", "--", rel])
      .split("\n")
      .some((l) => l.startsWith("160000"))

    if (!isComponent) break
    top = outer
  }

  return top
}

export function gitRepos(root: string): string[] {
  const repos: string[] = []

  // The strict "toplevel must equal the directory" test belongs to GITLINKS and
  // only to gitlinks: an uninitialised one has no .git, so `git -C` walks UP and
  // answers about the parent, double-counting the parent's history as the
  // submodule's.
  //
  // Applying that same test to the ROOT argument was a bug. Running from
  // packages/opencode reported "no git repository at …/packages/opencode" — a
  // directory that is plainly inside one — and git, files and diary all went
  // dark. The invariants held (they reported `not searched` rather than zero, so
  // breadth excluded them), which is exactly why it was easy to miss: the answer
  // was 34 hits instead of 51 and still said "heating up" in the headline.
  //
  // For the root, walking up is the CORRECT behaviour. Resolve it, then apply
  // the strict test to the gitlinks underneath.
  const resolved = resolveRepoRoot(root)
  if (!resolved) return repos
  repos.push(resolved)

  const isRealRepo = (dir: string) => run("git", ["-C", dir, "rev-parse", "--show-toplevel"]) === dir

  for (const line of run("git", ["-C", resolved, "ls-files", "--stage"]).split("\n")) {
    if (!line.startsWith("160000")) continue
    const rel = line.split("\t").slice(1).join("\t")
    if (!rel) continue
    const dir = join(resolved, rel)
    if (existsSync(dir) && isRealRepo(dir)) repos.push(dir)
  }

  return repos
}

// ── collectors ──────────────────────────────────────────────────────────────

/** Commit subjects and bodies across every repo in the tree. */
export function sweepGit(opts: SweepOptions): SourceSweep {
  const root = resolveRepoRoot(opts.repo)
  const repos = root ? gitRepos(root) : []
  if (repos.length === 0) return unavailable("git", `${opts.repo} is not inside a git repository`)

  const pattern = keywordPattern(opts.keyword)
  if (pattern === null) return unavailable("git", `"${opts.keyword}" has no searchable characters`)

  const matched = new Set<string>([canonicalKeyword(opts.keyword)])
  const items: Hit[] = []
  const seen = new Set<string>()
  let prior = 0

  const since = new Date(Date.now() - opts.windowDays * 864e5).toISOString()
  const priorSince = new Date(Date.now() - opts.windowDays * 2 * 864e5).toISOString()

  for (const repo of repos) {
    const name = repo === root ? basename(repo) : relative(root!, repo)
    // Deduped per repo: one commit matching three variants is one commit.
    const priorSeen = new Set<string>()

    // --all so work parked on an unmerged branch still counts; -i because commit
    // style is not consistent enough to make case meaningful; -E because the
    // pattern uses a bounded interval, which basic regex would need escaped.
    const current = run("git", [
      "-C", repo, "log", "--all", "-i", "-E", `--grep=${pattern}`,
      `--since=${since}`, `--format=%h${SEP}%aI${SEP}%s`, "--max-count=200",
    ])

    for (const line of current.split("\n").filter(Boolean)) {
      const [sha, date, subject] = line.split(SEP)
      const where = `${name}@${sha}`
      if (seen.has(where)) continue
      seen.add(where)
      items.push({ when: date, where, text: subject })
    }

    const before = run("git", [
      "-C", repo, "log", "--all", "-i", "-E", `--grep=${pattern}`,
      `--since=${priorSince}`, `--until=${since}`, "--format=%h", "--max-count=200",
    ])
    for (const sha of before.split("\n").filter(Boolean)) priorSeen.add(sha)

    prior += priorSeen.size
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  return finish("git", items, prior, matched, opts.limit)
}

/**
 * Daily diary entries. Dated from the FILENAME rather than mtime — a diary
 * reformatted last week is still a record of the day it describes, and mtime
 * would quietly re-date the whole archive to whenever it was last touched.
 */
export function sweepDiary(opts: SweepOptions): SourceSweep {
  // Resolved for the same reason git is: the diary lives at the repo root, and
  // running from a subdirectory is not a reason to stop being able to read it.
  const root = resolveRepoRoot(opts.repo) ?? opts.repo
  const dir = join(root, "daily-diary")
  if (!existsSync(dir)) return unavailable("diary", `no daily-diary directory in ${root}`)

  const re = keywordRegex(opts.keyword)
  if (re === null) return unavailable("diary", `"${opts.keyword}" has no searchable characters`)

  const matched = new Set<string>([canonicalKeyword(opts.keyword)])
  const items: Hit[] = []
  let prior = 0

  const cutoff = Date.now() - opts.windowDays * 864e5
  const priorCutoff = Date.now() - opts.windowDays * 2 * 864e5

  for (const file of readdirSync(dir).filter((f) => f.endsWith(".md"))) {
    let body: string
    try {
      body = readFileSync(join(dir, file), "utf8")
    } catch {
      continue
    }

    // LINE BY LINE, exactly as grep does it. Testing the whole file at once
    // would let a match span a paragraph break, and would also disagree with
    // every other collector — which is the failure this change exists to end.
    const line = firstMentionLine(body, re) ?? (re.test(file) ? file : null)
    if (line === null) continue

    const dated = file.match(/(\d{4}-\d{2}-\d{2})/)
    const when = dated ? new Date(`${dated[1]}T12:00:00Z`).toISOString() : undefined
    let at: number
    try {
      at = when ? Date.parse(when) : statSync(join(dir, file)).mtimeMs
    } catch {
      continue
    }

    if (at >= cutoff) {
      items.push({ when, where: `daily-diary/${file}`, text: line === file ? undefined : line })
    } else if (at >= priorCutoff) {
      prior++
    }
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  return finish("diary", items, prior, matched, opts.limit)
}

/** The line the keyword actually appears on — context beats a leading excerpt. */
function firstMentionLine(body: string, re: RegExp): string | undefined {
  for (const line of body.split("\n")) {
    if (re.test(line)) {
      return line.trim().replace(/\s+/g, " ").slice(0, 160)
    }
  }
  return undefined
}

/**
 * Tracked files whose CONTENT mentions the topic.
 *
 * Reports no prior window on purpose. A file's mtime says when it was last
 * written, not when the topic entered it, so there is no honest way to ask "how
 * many files mentioned this a month ago" from the working tree. Omitting the
 * metric costs this source its vote in momentum; sending zero would have handed
 * momentum a fake baseline instead.
 */
export function sweepFiles(opts: SweepOptions): SourceSweep {
  const root = resolveRepoRoot(opts.repo)
  const repos = root ? gitRepos(root) : []
  if (repos.length === 0) return unavailable("files", `${opts.repo} is not inside a git repository`)

  const pattern = keywordPattern(opts.keyword)
  if (pattern === null) return unavailable("files", `"${opts.keyword}" has no searchable characters`)

  const matched = new Set<string>([canonicalKeyword(opts.keyword)])
  const items: Hit[] = []
  const seen = new Set<string>()

  for (const repo of repos) {
    const prefix = repo === root ? "" : relative(root!, repo) + "/"
    const out = run("git", ["-C", repo, "grep", "-E", "-il", "--", pattern], undefined, 30000)
    for (const rel of out.split("\n").filter(Boolean)) {
      const where = prefix + rel
      if (seen.has(where)) continue
      seen.add(where)
      let when: string | undefined
      try {
        when = new Date(statSync(join(repo, rel)).mtime).toISOString()
      } catch {}
      items.push({ when, where })
    }
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  return finish("files", items, undefined, matched, opts.limit)
}

/**
 * Claude Code transcripts.
 *
 * Dated by file mtime, which is the session's LAST activity rather than the
 * moment the topic came up. That is an approximation, and it is written down
 * because it biases one way: a long-running session revisited yesterday reports
 * the topic as touched yesterday. For "is this thread warm" that is the useful
 * direction to be wrong in, but it is not a claim about when the work happened.
 */
export function sweepClaudeCode(opts: SweepOptions): SourceSweep {
  const root = join(homedir(), ".claude", "projects")
  if (!existsSync(root)) return unavailable("claude_code", "no ~/.claude/projects session store on this machine")
  return sweepSessionFiles("claude_code", root, ".jsonl", opts)
}

/**
 * opencode / iris CLI transcripts. Message parts are many small JSON files, so
 * matched parts are resolved back to their SESSION and counted once — twenty
 * matching parts in one conversation is one session that discussed the topic,
 * not twenty pieces of evidence.
 */
export function sweepOpencode(opts: SweepOptions): SourceSweep {
  const storage = join(homedir(), ".local", "share", "opencode", "storage")
  const partDir = join(storage, "part")
  if (!existsSync(partDir)) return unavailable("opencode", "no opencode storage on this machine")

  const pattern = keywordPattern(opts.keyword)
  if (pattern === null) return unavailable("opencode", `"${opts.keyword}" has no searchable characters`)

  const matched = new Set<string>([canonicalKeyword(opts.keyword)])
  const cutoff = Date.now() - opts.windowDays * 864e5
  const priorCutoff = Date.now() - opts.windowDays * 2 * 864e5

  const sessions = new Map<string, number>()
  const out = run("grep", ["-rEil", "--include=*.json", pattern, partDir], undefined, 60000)
  for (const file of out.split("\n").filter(Boolean)) {
    let sessionId: string | undefined
    let at: number
    try {
      sessionId = JSON.parse(readFileSync(file, "utf8"))?.sessionID
      at = statSync(file).mtimeMs
    } catch {
      continue
    }
    if (!sessionId) continue
    const existing = sessions.get(sessionId)
    if (existing === undefined || at > existing) sessions.set(sessionId, at)
  }

  const index = opencodeSessionIndex(join(storage, "session"))
  const items: Hit[] = []
  let prior = 0

  for (const [sessionId, at] of sessions) {
    if (at < priorCutoff) continue
    if (at < cutoff) {
      prior++
      continue
    }
    const meta = index.get(sessionId)
    items.push({
      when: new Date(at).toISOString(),
      where: meta?.directory ? `${basename(meta.directory)} · ${sessionId.slice(0, 12)}` : sessionId.slice(0, 12),
      text: meta?.title,
    })
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  return finish("opencode", items, prior, matched, opts.limit)
}

function opencodeSessionIndex(sessionRoot: string): Map<string, { title?: string; directory?: string }> {
  const index = new Map<string, { title?: string; directory?: string }>()
  if (!existsSync(sessionRoot)) return index
  for (const project of readdirSync(sessionRoot)) {
    const dir = join(sessionRoot, project)
    let files: string[]
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".json"))
    } catch {
      continue
    }
    for (const file of files) {
      try {
        const meta = JSON.parse(readFileSync(join(dir, file), "utf8"))
        if (meta?.id) index.set(meta.id, { title: meta.title, directory: meta.directory })
      } catch {}
    }
  }
  return index
}

/** Shared body for flat per-session transcript stores. */
function sweepSessionFiles(source: TopicSource, root: string, ext: string, opts: SweepOptions): SourceSweep {
  const pattern = keywordPattern(opts.keyword)
  if (pattern === null) return unavailable(source, `"${opts.keyword}" has no searchable characters`)

  const matched = new Set<string>([canonicalKeyword(opts.keyword)])
  const cutoff = Date.now() - opts.windowDays * 864e5
  const priorCutoff = Date.now() - opts.windowDays * 2 * 864e5

  const seen = new Map<string, number>()
  const out = run("grep", ["-rEil", `--include=*${ext}`, pattern, root], undefined, 60000)
  for (const file of out.split("\n").filter(Boolean)) {
    try {
      seen.set(file, statSync(file).mtimeMs)
    } catch {}
  }

  const items: Hit[] = []
  let prior = 0
  for (const [file, at] of seen) {
    if (at < priorCutoff) continue
    if (at < cutoff) {
      prior++
      continue
    }
    items.push({
      when: new Date(at).toISOString(),
      where: `${basename(join(file, ".."))}/${basename(file, ext)}`.slice(0, 90),
    })
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  return finish(source, items, prior, matched, opts.limit)
}

/**
 * attributedBody is an NSKeyedArchiver stream, not a string. A message's words
 * sit inside it as a readable run fenced by class names and length bytes.
 *
 * Nothing here pretends to be a real unarchiver. The goal is a snippet good
 * enough to judge relevance in a brief, so unprintable bytes and the archive's
 * own vocabulary are stripped and whatever survives is what the person wrote.
 */
/**
 * Tokens the archiver writes AFTER the message text: attribute runs, and for a
 * link preview an entire embedded bplist. Everything from the first of these
 * onward is structure, never content, so the text is cut here rather than
 * scrubbed token by token — scrubbing leaves the punctuation between them
 * ("iI = i *") and reads like corruption to whoever gets the brief.
 */
const ARCHIVE_TAIL = /\siI\s|NSMutableData|NSDictionary|NSKeyedArchiver|bplist00|NSNumber|NSValue|__kIM/

/** Tokens the archiver writes BEFORE the text. */
const ARCHIVE_HEAD =
  /streamtyped|NSMutableAttributedString|NSAttributedString|NSMutableString|NSAttributeInfo|NSString|NSObject|NSArray/g

export function decodeAttributedBody(raw: string): string {
  // U+FFFD is what the UTF-8 decoder leaves behind on the archive's binary runs.
  const printable = raw.replace(/[^\x20-\x7E\u00A0-\uFFFC\uFFFE-\uFFFF]+/g, " ")
  const cut = printable.split(ARCHIVE_TAIL)[0] ?? ""
  const text = cut.replace(ARCHIVE_HEAD, " ").replace(/\s+/g, " ").trim().replace(/^[^A-Za-z0-9]+/, "")

  // What is left often begins with the archived string's own length prefix —
  // one byte, printable whenever the message is 32-126 characters, glued to the
  // front of the first word ("Cok fine" for a 67-character message). It is only
  // stripped when that byte actually reads as the length of what follows, so a
  // sentence that genuinely starts with one letter is left alone.
  const head = text.charCodeAt(0)
  const rest = text.slice(1)
  const isLengthPrefix = head >= 32 && head <= 126 && Math.abs(head - rest.length) <= 12
  return (isLengthPrefix ? rest.trimStart() : text).slice(0, 160).trim()
}


/**
 * iMessage. The SQL is fed over STDIN rather than interpolated into a shell
 * command line: the keyword is user input, and `sqlite3 "db" "...$kw..."` would
 * let a backtick or a $( ) in a topic name run a subshell.
 *
 * A MESSAGE'S WORDS LIVE IN THREE PLACES AND THE OBVIOUS ONE HOLDS BARELY HALF.
 * The body text and the attachment filename are matched in SQL; the
 * attributedBody blob cannot be (see pass 2) and is matched here. Both passes
 * feed one map keyed by message id, so a message that matches twice is one hit.
 */
export function sweepImessage(opts: SweepOptions): SourceSweep {
  const db = opts.messagesDb ?? join(homedir(), "Library", "Messages", "chat.db")
  if (process.platform !== "darwin" && !opts.messagesDb)
    return unavailable("imessage", "iMessage is only readable on macOS")
  if (!existsSync(db)) return unavailable("imessage", `no Messages database at ${db}`)

  const variants = keywordVariants(opts.keyword)
  const matched = new Set<string>()
  let prior = 0

  // Apple stores message dates as nanoseconds since 2001-01-01.
  const APPLE_EPOCH = 978307200
  const cutoff = Math.floor(Date.now() / 1000) - opts.windowDays * 86400
  const priorCutoff = cutoff - opts.windowDays * 86400

  const like = (v: string) => "'%" + v.replace(/'/g, "''").replace(/[%_\\]/g, (c) => "\\" + c) + "%'"
  const anyVariant = (expr: string) => variants.map((v) => `${expr} LIKE ${like(v)} ESCAPE '\\'`).join(" OR ")
  // The field delimiter must not survive inside a field: a message body can
  // contain any byte, and one stray 0x1F silently shifts every later column.
  const clean = (x: string) => `REPLACE(REPLACE(REPLACE(${x}, char(31),' '), char(10),' '), char(13),' ')`
  const WINDOW = `(m.date/1000000000 + ${APPLE_EPOCH}) >= ${priorCutoff}`
  const STAMP = `(m.date/1000000000 + ${APPLE_EPOCH}) || '${SEP}' || COALESCE(h.id,'unknown') || '${SEP}' || m.is_from_me`

  const query = (sql: string, maxBuffer: number): string | SourceSweep => {
    try {
      return execFileSync("sqlite3", [db], {
        input: sql,
        encoding: "utf8",
        timeout: 20000,
        maxBuffer,
        stdio: ["pipe", "pipe", "pipe"],
      }).trim()
    } catch (err: any) {
      const msg = (err?.stderr || err?.message || "").toString()
      return unavailable(
        "imessage",
        /authorization denied|not permitted|unable to open/i.test(msg)
          ? "Full Disk Access required — System Settings › Privacy & Security › Full Disk Access, then restart the terminal"
          : `Messages database unreadable: ${msg.slice(0, 140)}`,
      )
    }
  }

  interface Row {
    at: number
    where: string
    text?: string
  }
  const rows = new Map<string, Row>()

  const record = (id: string, at: number, handle: string, fromMe: string, text?: string) => {
    if (at < cutoff) {
      prior++
      return
    }
    rows.set(id, { at, where: fromMe === "1" ? `me → ${handle}` : (handle ?? "unknown"), text })
  }

  // ── pass 1: what SQL can match — the body text and the attachment filename ──
  //
  // The filename half is the reason this pass exists at all. A document someone
  // sent you is the most valuable trail a topic can leave, and it lives in a
  // table this collector never joined: 58,118 rows on one machine, none of them
  // searchable, so `RevOps-SaveLifeAI.pdf` could not be found by "revenue ops".
  const sql1 = `WITH att AS (
  SELECT maj.message_id AS mid,
         GROUP_CONCAT(COALESCE(NULLIF(a.transfer_name,''), NULLIF(a.filename,''), ''), ' | ') AS names
  FROM message_attachment_join maj
  JOIN attachment a ON a.ROWID = maj.attachment_id
  GROUP BY maj.message_id
)
SELECT m.ROWID || '${SEP}' || ${STAMP} || '${SEP}'
    || ${clean("SUBSTR(COALESCE(m.text,''),1,160)")} || '${SEP}'
    || ${clean("COALESCE(att.names,'')")}
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
LEFT JOIN att ON att.mid = m.ROWID
WHERE ((${anyVariant("m.text")}) OR (${anyVariant("att.names")})) AND ${WINDOW}
ORDER BY m.date DESC LIMIT 400;`

  const out1 = query(sql1, 16 * 1024 * 1024)
  if (typeof out1 !== "string") return out1

  for (const line of out1.split("\n").filter(Boolean)) {
    const [id, ts, handle, fromMe, text, atts] = line.split(SEP)
    const at = Number(ts)
    if (!Number.isFinite(at)) continue
    const attachments = (atts ?? "").split(" | ").map((s) => s.trim()).filter(Boolean)
    const spoken = (text ?? "").trim()
    matchesAny([spoken, attachments.join(" ")].join(" "), variants).forEach((v) => matched.add(v))

    // "he sent a file about this" and "he mentioned this" deserve different
    // responses, so a filename match is labelled rather than folded into prose.
    const hitFiles = attachments.filter((n) => matchesAny(n, variants).length > 0)
    record(
      id,
      at,
      handle,
      fromMe,
      hitFiles.length ? `📎 ${hitFiles.join(", ")}${spoken ? ` — ${spoken}` : ""}` : spoken || undefined,
    )
  }

  // ── pass 2: what SQL CANNOT match — the attributedBody blob ────────────────
  //
  // `message.text` is NULL for anything Messages treats as rich (a shared link,
  // a reply, formatted text) with the words in the `attributedBody` blob instead.
  // Measured on one Mac over seven days: 738 messages, 323 with empty text, 318
  // of those carrying a blob — so matching `text` alone is blind to ~44% of a
  // real week, and reports searched:true while doing it.
  //
  // The obvious repair, `CAST(attributedBody AS TEXT) LIKE ...`, DOES NOT WORK
  // and fails silently: the cast stops at the first NUL byte, and an
  // NSKeyedArchiver stream has one within its first dozen bytes. Verified —
  // length(CAST(x'616263006465662e2e2e' AS TEXT)) is 3. It would have looked
  // like a fix and changed nothing.
  //
  // So the bytes come back as hex, which is NUL-safe and exact, and the match
  // happens here where it can be case-insensitive. 1KB per message is far past
  // where the text sits (the average blob is 438 bytes) and caps a 30-day sweep
  // at a couple of MB.
  const sql2 = `SELECT m.ROWID || '${SEP}' || ${STAMP} || '${SEP}' || hex(SUBSTR(m.attributedBody,1,1024))
FROM message m
LEFT JOIN handle h ON m.handle_id = h.ROWID
WHERE m.attributedBody IS NOT NULL AND (m.text IS NULL OR m.text = '') AND ${WINDOW}
ORDER BY m.date DESC LIMIT 4000;`

  const out2 = query(sql2, 64 * 1024 * 1024)
  if (typeof out2 !== "string") return out2

  for (const line of out2.split("\n").filter(Boolean)) {
    const [id, ts, handle, fromMe, hex] = line.split(SEP)
    const at = Number(ts)
    if (!Number.isFinite(at) || rows.has(id)) continue
    const spoken = decodeAttributedBody(Buffer.from(hex ?? "", "hex").toString("utf8"))
    const hit = matchesAny(spoken, variants)
    if (!hit.length) continue
    hit.forEach((v) => matched.add(v))
    record(id, at, handle, fromMe, spoken)
  }

  const items = [...rows.values()]
    .sort((a, b) => b.at - a.at)
    .map(({ at, where, text }) => ({ when: new Date(at * 1000).toISOString(), where, text }))

  return finish("imessage", items, prior, matched, opts.limit)
}

/**
 * Apple Mail, through the local IRIS bridge.
 *
 * Subject-only search. The bridge's mail endpoint was built to answer "what did
 * this PERSON send me" and its AppleScript filters on sender; a topic sweep asks
 * the orthogonal question. Where the bridge supports a subject-only query this
 * uses it, and where it does not the source reports itself unavailable WITH the
 * reason rather than returning an empty result that would read as "this topic
 * never came up over email".
 */
export async function sweepEmail(opts: SweepOptions): Promise<SourceSweep> {
  const bridge = (opts.bridgeUrl ?? "http://127.0.0.1:3200").replace(/\/$/, "")
  const headers: Record<string, string> = { Accept: "application/json" }
  if (opts.bridgeKey) headers["X-Bridge-Key"] = opts.bridgeKey
  const variants = keywordVariants(opts.keyword)
  const matched = new Set<string>()
  const items: Hit[] = []
  const seen = new Set<string>()

  // The endpoint caps days at 90. Ask for what it can give, and carry the
  // shortfall into the output rather than let a truncated window pass as the
  // requested one.
  const days = Math.min(90, Math.max(1, opts.windowDays))
  const caveat = days < opts.windowDays
    ? `searched ${days}d, not ${opts.windowDays}d — Apple Mail search caps at 90 days`
    : undefined

  try {
    const health = await fetch(`${bridge}/health`, { headers, signal: AbortSignal.timeout(3000) })
    if (!health.ok) return unavailable("email", `IRIS bridge at ${bridge} is not healthy (${health.status})`)
  } catch {
    return unavailable("email", `IRIS bridge not reachable at ${bridge} — Apple Mail search runs through it`)
  }

  /**
   * Mail.app is driven over AppleScript, and a COLD Mail fails the first script
   * it is handed — osascript returns "Command failed" and the bridge surfaces a
   * 500. Retrying the identical query a moment later succeeds; measured today,
   * every variant that 500'd inside a sweep returned 200 when run again by hand.
   *
   * Without the retry a transient cold start writes off the whole source for the
   * run, which under rule 1 is honest but useless — "not searched" for a reason
   * that would have cleared in two seconds. One retry, and only for the failure
   * shape that is actually transient.
   */
  const fetchVariant = async (variant: string, attempt = 0): Promise<Response | string> => {
    try {
      const res = await fetch(
        `${bridge}/api/mail/search?subject=${encodeURIComponent(variant)}&days=${days}&limit=25`,
        { headers, signal: AbortSignal.timeout(45000) },
      )
      if (res.status === 500 && attempt === 0) {
        await new Promise((r) => setTimeout(r, 2000))
        return fetchVariant(variant, 1)
      }
      return res
    } catch (e: any) {
      return `Apple Mail search failed: ${String(e?.message ?? e).slice(0, 140)}`
    }
  }

  for (const variant of variants) {
    const attempted = await fetchVariant(variant)
    if (typeof attempted === "string") return unavailable("email", attempted)
    const res: Response = attempted

    if (res.status === 401 || res.status === 403) {
      return unavailable(
        "email",
        "the IRIS bridge rejected the request — no ~/.iris/bridge-token on this machine, or it is stale",
      )
    }
    if (res.status === 400) {
      return unavailable(
        "email",
        "this bridge build requires a sender for mail search, so a topic-wide sweep is not possible — update the bridge to allow subject-only search",
      )
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "")
      return unavailable("email", `Apple Mail search returned ${res.status}: ${body.slice(0, 140)}`)
    }

    const body = (await res.json().catch(() => ({}))) as any
    for (const msg of (body?.messages ?? []) as any[]) {
      const where = `${msg?.sender ?? "unknown"} · ${msg?.subject ?? "(no subject)"}`.slice(0, 110)
      matched.add(variant)
      if (seen.has(where)) continue
      seen.add(where)
      const parsed = msg?.date ? new Date(msg.date) : null
      items.push({
        when: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined,
        where,
      })
    }
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  // Mail is searched over ONE window only — the endpoint has no until/before
  // parameter, so there is no prior window to report and none is invented.
  const sweep = finish("email", items, undefined, matched, opts.limit)
  if (caveat) sweep.unavailableReason = caveat
  return sweep
}

/**
 * Atlas boards — the source that closes the gap between what a keyword sweep can
 * see and what a person actually asked about.
 *
 * "pulse check my MAYO Life Atlas" is not a topic question. The Life Atlas is a
 * CONTAINER — bloq #544, twenty lists, a hundred-odd items — and sweeping the
 * six local sources for the string "life atlas" measures how much you have been
 * TALKING about the Atlas on this laptop, not the state of the Atlas. Those are
 * different questions and the second one is the one that was asked.
 *
 * So this source resolves the keyword against your boards first:
 *
 *   BOARD MATCH  — the keyword names a board. Sweep the board itself: items
 *                  touched in the window, the newest one, and which lists have
 *                  gone silent. A list that is fed by a scheduler and holds zero
 *                  items is a dead scheduler, and no amount of grep finds that.
 *
 *   TEXT MATCH   — it does not name a board. Fall back to searching item text
 *                  across every board, which is still a source the local six
 *                  cannot reach.
 *
 * The two are reported distinctly. Presenting "I read your board" and "I found
 * the phrase in some cards" as the same number would be its own small lie.
 */
export async function sweepBloq(opts: SweepOptions): Promise<SourceSweep> {
  if (!opts.apiFetch || !opts.userId) {
    return unavailable("bloq", "not signed in — Atlas boards need an authenticated session")
  }

  const cutoff = Date.now() - opts.windowDays * 864e5
  const priorCutoff = Date.now() - opts.windowDays * 2 * 864e5
  const variants = keywordVariants(opts.keyword)
  const matched = new Set<string>()

  let boards: any[]
  try {
    const res = await opts.apiFetch(`/api/v1/user/${opts.userId}/bloqs?simplified=1&per_page=500`)
    if (!res.ok) return unavailable("bloq", `board list returned ${res.status}`)
    boards = ((await res.json()) as any)?.data ?? []
  } catch (e: any) {
    return unavailable("bloq", `could not reach Atlas: ${String(e?.message ?? e).slice(0, 120)}`)
  }

  // Prefer an exact name match, then a containment match. Never guess between
  // two equally plausible boards — say which, and fall through to text search.
  const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()
  const target = norm(opts.keyword)
  const exact = boards.filter((b) => norm(String(b.name ?? "")) === target)
  const partial = boards.filter((b) => norm(String(b.name ?? "")).includes(target))
  const hits = exact.length ? exact : partial

  if (hits.length === 1) {
    return await sweepBoard(opts, hits[0], cutoff, priorCutoff)
  }

  const ambiguous = hits.length > 1
    ? `"${opts.keyword}" matches ${hits.length} boards (${hits.map((b: any) => "#" + b.id).join(", ")}) — name one exactly`
    : null

  // ── text match across boards ──────────────────────────────────────────────
  const items: Hit[] = []
  const seen = new Set<string>()
  let prior = 0

  for (const variant of variants) {
    let rows: any[]
    try {
      const params = new URLSearchParams({ search: variant, per_page: "100" })
      const res = await opts.apiFetch(`/api/v1/user/${opts.userId}/bloqs/content-items?${params}`)
      if (!res.ok) return unavailable("bloq", `item search returned ${res.status}`)
      rows = ((await res.json()) as any)?.data ?? []
    } catch (e: any) {
      return unavailable("bloq", `Atlas search failed: ${String(e?.message ?? e).slice(0, 120)}`)
    }

    for (const row of rows) {
      const at = Date.parse(row?.updated_at ?? row?.created_at ?? "")
      if (!Number.isFinite(at) || at < priorCutoff) continue
      const where = `#${row?.id} ${String(row?.list_name ?? row?.bloq_name ?? "")}`.trim().slice(0, 60)
      matched.add(variant)
      if (seen.has(where)) continue
      seen.add(where)
      if (at < cutoff) {
        prior++
        continue
      }
      items.push({ when: new Date(at).toISOString(), where, text: String(row?.title ?? "").slice(0, 110) })
    }
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  const sweep = finish("bloq", items, prior, matched, opts.limit)
  sweep.unavailableReason = ambiguous ?? "no board by this name — searched item text across your boards instead"
  return sweep
}

/** The keyword named a board. Report the board's own vital signs. */
async function sweepBoard(opts: SweepOptions, board: any, cutoff: number, priorCutoff: number): Promise<SourceSweep> {
  let full: any
  try {
    const res = await opts.apiFetch!(`/api/v1/user/${opts.userId}/bloqs/${board.id}`)
    if (!res.ok) return unavailable("bloq", `board #${board.id} returned ${res.status}`)
    const body = (await res.json()) as any
    full = body?.data ?? body
  } catch (e: any) {
    return unavailable("bloq", `could not read board #${board.id}: ${String(e?.message ?? e).slice(0, 120)}`)
  }

  const lists: any[] = full?.lists ?? []
  const items: Hit[] = []
  const silent: Array<{ id: number; name: string; items: number; newest: string | null }> = []
  let prior = 0
  let total = 0

  for (const list of lists) {
    const rows: any[] = list?.items ?? []
    total += rows.length
    let newest: number | null = null

    for (const row of rows) {
      const at = Date.parse(row?.updated_at ?? row?.created_at ?? "")
      if (!Number.isFinite(at)) continue
      if (newest === null || at > newest) newest = at
      if (at < priorCutoff) continue
      if (at < cutoff) {
        prior++
        continue
      }
      items.push({
        when: new Date(at).toISOString(),
        where: `${String(list?.name ?? "").slice(0, 30)} #${row?.id}`,
        text: String(row?.title ?? "").slice(0, 100),
      })
    }

    // A list with nothing in it, or nothing touched all window. The first is the
    // one that matters: an auto-generated list holding zero items is a scheduler
    // that has stopped running, and it looks exactly like a list nobody uses.
    if (rows.length === 0 || (newest !== null && newest < priorCutoff)) {
      silent.push({
        id: Number(list?.id),
        name: String(list?.name ?? ""),
        items: rows.length,
        newest: newest === null ? null : new Date(newest).toISOString(),
      })
    }
  }

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))

  const sweep = finish("bloq", items, prior, new Set([opts.keyword.toLowerCase()]), opts.limit)
  sweep.board = {
    id: Number(full?.id ?? board.id),
    name: String(full?.name ?? board.name ?? ""),
    lists: lists.length,
    items: total,
    silentLists: silent,
  }
  return sweep
}


/**
 * Gmail, through the platform's connected account.
 *
 * The `email` source above is APPLE MAIL over AppleScript, and it matches
 * SUBJECTS ONLY. `atlas:comms` ingests from the GMAIL API. Those are two
 * different stores answering to two different readers, and nothing reconciled
 * them: a mail that never landed in Apple Mail was invisible to a topic sweep
 * however well its subject matched, and a mail with NO subject was invisible
 * even when it had landed. Both were reported as `searched: true, hits: 0`.
 *
 * Gmail's own query language searches subject, body AND attachment filenames in
 * one pass, which is the whole of what the Apple Mail path cannot do. It also
 * takes both ends of a window, so this source reports a REAL prior count instead
 * of omitting it the way the Apple Mail path must.
 */
export async function sweepGmail(opts: SweepOptions): Promise<SourceSweep> {
  let gmail: any
  try {
    gmail = await import("../lib/gmail")
  } catch (e: any) {
    return unavailable("gmail", `Gmail library unavailable: ${String(e?.message ?? e).slice(0, 100)}`)
  }

  let token: string | null = null
  try {
    token = await gmail.getToken()
  } catch (e: any) {
    return unavailable("gmail", `Gmail auth check failed: ${String(e?.message ?? e).slice(0, 100)}`)
  }
  // "Not connected" and "connected and quiet" are opposite findings and need
  // opposite responses, so the reason travels rather than a zero.
  if (!token) return unavailable("gmail", gmail.lastError?.() ?? "no Gmail account connected")

  const variants = keywordVariants(opts.keyword)
  // Quoted so a multi-word topic stays a phrase; Gmail would otherwise AND the
  // words and match mail where they merely co-occur.
  const phrase = variants.map((v) => `"${v.replace(/"/g, "")}"`).join(" OR ")
  const days = Math.max(1, opts.windowDays)

  const search = async (window: string): Promise<any[] | null> => {
    try {
      return (await gmail.searchMessages(token, `(${phrase}) ${window}`, 50)) ?? []
    } catch {
      return null
    }
  }

  const current = await search(`newer_than:${days}d`)
  if (current === null) return unavailable("gmail", "Gmail search failed — the connected account may have expired")

  // A failed PRIOR query must not become a zero prior: that reads as explosive
  // growth, which is the most flattering possible lie (rule 2).
  const previous = await search(`older_than:${days}d newer_than:${days * 2}d`)

  const matched = new Set<string>()
  const items: Hit[] = current.map((m: any) => {
    const from = String(m?.from ?? "unknown")
    const subject = String(m?.subject ?? "").trim() || "(no subject)"
    const snippet = String(m?.snippet ?? "").trim()
    matchesAny([subject, snippet, from, String(m?.body_text ?? "")].join(" "), variants).forEach((v) => matched.add(v))
    const parsed = m?.date ? new Date(m.date) : null
    return {
      when: parsed && !Number.isNaN(parsed.getTime()) ? parsed.toISOString() : undefined,
      where: `${from} · ${subject}`.slice(0, 110),
      text: snippet || undefined,
    }
  })

  items.sort((a, b) => (b.when ?? "").localeCompare(a.when ?? ""))
  return finish("gmail", items, previous === null ? undefined : previous.length, matched, opts.limit)
}

// ── orchestration ───────────────────────────────────────────────────────────

export async function sweepAll(opts: SweepOptions, onStart?: (s: TopicSource) => void): Promise<SourceSweep[]> {
  const wanted = new Set(opts.sources)
  const out: SourceSweep[] = []

  // Deliberately sequential. These collectors are all disk- or AppleScript-bound
  // on one machine; running them at once makes the slowest one slower and the
  // progress line meaningless.
  const sync: Array<[TopicSource, () => SourceSweep]> = [
    ["git", () => sweepGit(opts)],
    ["diary", () => sweepDiary(opts)],
    ["files", () => sweepFiles(opts)],
    ["claude_code", () => sweepClaudeCode(opts)],
    ["opencode", () => sweepOpencode(opts)],
    ["imessage", () => sweepImessage(opts)],
  ]

  for (const [name, fn] of sync) {
    if (!wanted.has(name)) continue
    onStart?.(name)
    out.push(fn())
  }

  if (wanted.has("email")) {
    onStart?.("email")
    out.push(await sweepEmail(opts))
  }

  if (wanted.has("gmail")) {
    onStart?.("gmail")
    out.push(await sweepGmail(opts))
  }

  if (wanted.has("bloq")) {
    onStart?.("bloq")
    out.push(await sweepBloq(opts))
  }

  return out
}

export function topicSlug(keyword: string): string {
  return keyword.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "topic"
}

/**
 * Sweeps -> Observations.
 *
 * Metric names are namespaced by source because CorpusIngestService rolls
 * observations up with a FLAT merge, last write wins. A shared `hits` key would
 * let whichever collector ran last decide the topic's numbers and silently
 * discard the rest.
 *
 * CONTENT DOES NOT LEAVE THE MACHINE unless asked for. Commit subjects, diary
 * lines and file paths already live in a repo and travel by default; message
 * bodies, mail subjects and agent transcripts routinely carry credentials,
 * client data and private context, and a corpus is the wrong place for all of
 * it. The brief you read locally is complete either way — this governs only
 * what is uploaded.
 */
export function toObservations(
  keyword: string,
  sweeps: SourceSweep[],
  opts: { includeContext: boolean; windowDays: number; ownerUserId?: number },
): any[] {
  const externalId = `topic:${topicSlug(keyword)}`
  const observedAt = new Date().toISOString()

  return sweeps.map((s) => {
    const metrics: Record<string, number> = {}
    // An unsearched source contributes NO metrics. Emitting zeros here is what
    // would turn "could not look" into "looked and found nothing".
    if (s.searched) {
      metrics[`${s.source}_hits`] = s.hits
      if (s.hitsPrior !== undefined) metrics[`${s.source}_hits_prior`] = s.hitsPrior
      if (s.lastHitEpoch !== undefined) metrics[`${s.source}_last_hit_epoch`] = s.lastHitEpoch
    }

    const repoBorn = s.source === "git" || s.source === "diary" || s.source === "files"
    const share = opts.includeContext || repoBorn

    return {
      entity_type: "topic",
      external_id: externalId,
      source: s.source,
      observed_at: observedAt,
      metrics,
      text: share && s.items.length ? topicText(s) : null,
      payload: {
        searched: s.searched,
        unavailable_reason: s.unavailableReason ?? null,
        window_days: opts.windowDays,
        matched_variants: s.matchedVariants ?? [],
        content_included: share,
        // Locators only when content is withheld: knowing WHICH conversation to
        // open is useful and carries nothing private.
        locators: s.items.map((i) =>
          share ? { when: i.when, where: i.where, text: i.text } : { when: i.when, where: i.where },
        ),
      },
      display_name: keyword,
      handle: topicSlug(keyword),
      owner_user_id: opts.ownerUserId,
    }
  })
}

function topicText(s: SourceSweep): string {
  return s.items
    .map((i) => [i.where, i.text].filter(Boolean).join(" — "))
    .join(" | ")
    .slice(0, 4000)
}
