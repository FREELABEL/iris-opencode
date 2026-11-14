#!/usr/bin/env bun
/**
 * public-audit — fail when anything sensitive is about to be published from this PUBLIC repo
 * or one of its release assets (#189852).
 *
 * WHY THE DENYLIST IS NOT HERE. A public script that lists what must not be published IS the
 * publication: a denylist of client names in this repo is our client list. So this file is only
 * the MATCHER. The terms live in a private repo and arrive at run time from one of:
 *
 *   PUBLIC_AUDIT_DENYLIST_FILE   path to the denylist file
 *   PUBLIC_AUDIT_DENYLIST_B64    base64 of the same file (how CI gets it, from a secret)
 *
 * With neither set it exits 2. It never passes on an empty input: an audit that is green because
 * it had nothing to check is the exact failure this exists to prevent, and it looks identical to
 * a clean repo in every CI summary.
 *
 * Findings are printed as file:line plus a rule id like `strings@12` — the LINE of the private
 * denylist that matched. Never the term, never the surrounding text: this runs in public CI logs,
 * and printing the match would publish the denylist one finding at a time.
 *
 * DENYLIST FORMAT (sections; full-line `#` comments; blank lines ignored):
 *
 *   [strings]     case-insensitive substrings forbidden in any tracked file at HEAD
 *   [paths]       globs no tracked path may match (and, with --history, no path ever added).
 *                 No slash: matches the basename anywhere.  Trailing slash: a directory anywhere.
 *                 Otherwise matched against the full path; a leading `**\/` also matches at root.
 *                 A leading `/` anchors to the repo root (`/logs/` is the top-level dir only).
 *   [sentinels]   case-insensitive strings planted in private prompts. Forbidden in tracked
 *                 files AND anywhere inside a release artifact, binaries included (byte search).
 *
 * CHECKS (exit 0 clean, 1 findings, 2 misconfigured):
 *
 *   --content           denylisted strings/sentinels in tracked files at HEAD
 *   --paths             tracked paths matching a [paths] glob
 *   --history           --paths, plus every path ever ADDED in `git log --all`
 *   --artifact <p>      file or dir; .tar.gz/.tgz/.tar/.zip are extracted. Fails on any *.map,
 *                       any `sourcesContent`, any sentinel. Repeatable.
 *   --runtime <bin>     the Bun runtime the binaries were compiled with. Bun itself contains
 *                       `sourcesContent` (4 hits in 1.3.11, every platform), so a compiled CLI
 *                       always does too; with this a BINARY may carry up to the runtime's count
 *                       and not one more. Text files never get the allowance.
 *   --repos <file>      `gh repo list <org> --visibility public` must EQUAL this allowlist
 *   --org <name>        org for --repos (default FREELABEL)
 *   --root <dir>        repo to audit (default: the git toplevel of the cwd)
 *   --json              machine-readable output
 *
 * With no check flags it runs --content --paths.
 *
 * NOT HERE: secret scanning (keys, tokens). CI runs gitleaks as its own step — a generic
 * secret scanner is a solved problem and a second, worse one in this file would only dilute it.
 */
import { existsSync, lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"
import { basename, join, relative, resolve } from "path"

export type Entry = { value: string; line: number }
export type Denylist = { strings: Entry[]; paths: Entry[]; sentinels: Entry[] }
export type Finding = {
  check: "content" | "paths" | "history" | "artifact" | "repos"
  path: string
  rule: string
  line?: number
  offset?: number
  detail?: string
}
export type RunOptions = {
  cwd?: string
  env?: Record<string, string | undefined>
  /** Injected for tests. Returns `owner/name` of every PUBLIC repo in the org. */
  gh?: (org: string) => Promise<string[]>
}
export type RunResult = { code: 0 | 1 | 2; output: string }

class Misconfigured extends Error {}

const SECTIONS = ["strings", "paths", "sentinels"] as const
const MIN_TERM = 3

export function parseDenylist(text: string): Denylist {
  const out: Denylist = { strings: [], paths: [], sentinels: [] }
  let section: (typeof SECTIONS)[number] | undefined
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim()
    if (!line || line.startsWith("#")) return
    const head = line.match(/^\[([a-z_-]+)\]$/i)
    if (head) {
      const name = head[1].toLowerCase()
      if (!(SECTIONS as readonly string[]).includes(name))
        throw new Misconfigured(`denylist line ${i + 1}: unknown section [${name}] (expected ${SECTIONS.join(", ")})`)
      section = name as (typeof SECTIONS)[number]
      return
    }
    if (!section) throw new Misconfigured(`denylist line ${i + 1}: entry before any [section] header`)
    if (section !== "paths" && line.length < MIN_TERM)
      throw new Misconfigured(`denylist line ${i + 1}: term shorter than ${MIN_TERM} chars would match everything`)
    out[section].push({ value: line, line: i + 1 })
  })
  return out
}

function loadDenylist(env: Record<string, string | undefined>): Denylist {
  const file = env.PUBLIC_AUDIT_DENYLIST_FILE
  const b64 = env.PUBLIC_AUDIT_DENYLIST_B64
  let text: string
  if (file) {
    if (!existsSync(file)) throw new Misconfigured(`PUBLIC_AUDIT_DENYLIST_FILE=${file} does not exist`)
    text = readFileSync(file, "utf8")
  } else if (b64 && b64.trim()) {
    text = Buffer.from(b64.trim(), "base64").toString("utf8")
  } else {
    throw new Misconfigured(
      "denylist not provided — set PUBLIC_AUDIT_DENYLIST_FILE or PUBLIC_AUDIT_DENYLIST_B64. " +
        "Refusing to pass an audit that had nothing to check.",
    )
  }
  return parseDenylist(text)
}

// ---------------------------------------------------------------- globs

export function globMatch(pattern: string, path: string): boolean {
  const m = (p: string, s: string) => new Bun.Glob(p).match(s)
  const parts = path.split("/")
  if (pattern.startsWith("/")) {
    // Anchored to the repo root, like .gitignore: `/logs/` is the top-level logs dir only.
    const p = pattern.slice(1)
    if (p.endsWith("/")) return parts.length > 1 && m(p.slice(0, -1), parts[0])
    return m(p, path)
  }
  if (pattern.endsWith("/")) {
    const dir = pattern.slice(0, -1)
    for (let i = 1; i < parts.length; i++) {
      const ancestor = parts.slice(0, i).join("/")
      if (
        dir.includes("/")
          ? m(dir, ancestor) || (dir.startsWith("**/") && m(dir.slice(3), ancestor))
          : m(dir, parts[i - 1])
      )
        return true
    }
    return false
  }
  if (!pattern.includes("/")) return m(pattern, parts[parts.length - 1])
  return m(pattern, path) || (pattern.startsWith("**/") && m(pattern.slice(3), path))
}

// ---------------------------------------------------------------- byte search

/** ASCII-lowercase copy, so a case-insensitive search works on any bytes, binaries included. */
function lower(buf: Uint8Array): Buffer {
  const out = Buffer.allocUnsafe(buf.length)
  for (let i = 0; i < buf.length; i++) {
    const c = buf[i]
    out[i] = c >= 65 && c <= 90 ? c + 32 : c
  }
  return out
}

function offsetsOf(hay: Buffer, needle: Buffer): number[] {
  const hits: number[] = []
  let at = hay.indexOf(needle)
  while (at !== -1) {
    hits.push(at)
    at = hay.indexOf(needle, at + needle.length)
  }
  return hits
}

function lineAt(buf: Uint8Array, offset: number, cache: { nl?: number[] }): number {
  if (!cache.nl) {
    cache.nl = []
    for (let i = 0; i < buf.length; i++) if (buf[i] === 10) cache.nl.push(i)
  }
  let lo = 0
  let hi = cache.nl.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (cache.nl[mid] < offset) lo = mid + 1
    else hi = mid
  }
  return lo + 1
}

type Term = { needle: Buffer; rule: string }
const terms = (entries: Entry[], kind: string): Term[] =>
  entries.map((e) => ({ needle: Buffer.from(e.value.toLowerCase()), rule: `${kind}@${e.line}` }))

// ---------------------------------------------------------------- git

function git(root: string, args: string[]): Buffer {
  const r = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Misconfigured(`git ${args.join(" ")} failed: ${r.stderr.toString().trim()}`)
  return r.stdout as Buffer
}

function splitZ(buf: Buffer): string[] {
  return buf
    .toString("utf8")
    .split("\0")
    .filter((s) => s.length > 0)
}

/** Every blob at HEAD, read through one `git cat-file --batch` (HEAD, not the working tree). */
async function headBlobs(root: string): Promise<{ path: string; data: Uint8Array }[]> {
  const entries = splitZ(git(root, ["ls-tree", "-r", "-z", "--full-tree", "HEAD"]))
    .map((rec) => {
      const tab = rec.indexOf("\t")
      const [, type, sha] = rec.slice(0, tab).split(" ")
      return { type, sha, path: rec.slice(tab + 1) }
    })
    .filter((e) => e.type === "blob")
  if (entries.length === 0) return []
  const shas = [...new Set(entries.map((e) => e.sha))]
  const proc = Bun.spawn(["git", "-C", root, "cat-file", "--batch"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" })
  proc.stdin.write(shas.join("\n") + "\n")
  proc.stdin.end()
  const out = new Uint8Array(await new Response(proc.stdout).arrayBuffer())
  if ((await proc.exited) !== 0) throw new Misconfigured("git cat-file --batch failed")
  const bySha = new Map<string, Uint8Array>()
  let pos = 0
  const dec = new TextDecoder()
  while (pos < out.length) {
    const nl = out.indexOf(10, pos)
    const [sha, kind, size] = dec.decode(out.subarray(pos, nl)).split(" ")
    if (kind === "missing") throw new Misconfigured(`blob ${sha} missing`)
    const n = Number(size)
    bySha.set(sha, out.subarray(nl + 1, nl + 1 + n))
    pos = nl + 1 + n + 1
  }
  return entries.map((e) => ({ path: e.path, data: bySha.get(e.sha)! }))
}

async function checkContent(root: string, deny: Denylist): Promise<Finding[]> {
  const all = [...terms(deny.strings, "strings"), ...terms(deny.sentinels, "sentinels")]
  const findings: Finding[] = []
  for (const blob of await headBlobs(root)) {
    const hay = lower(blob.data)
    const cache = {}
    const seen = new Set<string>()
    for (const t of all) {
      for (const off of offsetsOf(hay, t.needle)) {
        const line = lineAt(blob.data, off, cache)
        const key = `${line}:${t.rule}`
        if (seen.has(key)) continue
        seen.add(key)
        findings.push({ check: "content", path: blob.path, line, rule: t.rule })
      }
    }
  }
  return findings
}

function matchPaths(paths: string[], deny: Denylist, check: "paths" | "history"): Finding[] {
  const findings: Finding[] = []
  for (const p of paths) {
    const hit = deny.paths.find((g) => globMatch(g.value, p))
    if (hit) findings.push({ check, path: p, rule: `paths@${hit.line}` })
  }
  return findings
}

function checkPaths(root: string, deny: Denylist, history: boolean): Finding[] {
  const head = splitZ(git(root, ["ls-tree", "-r", "-z", "--name-only", "--full-tree", "HEAD"]))
  const findings = matchPaths(head, deny, "paths")
  if (history) {
    // --no-renames: a rename would otherwise show as R, hiding the new path from --diff-filter=A.
    const ever = splitZ(
      git(root, ["log", "--all", "--no-renames", "--diff-filter=A", "--name-only", "--format=", "-z"]),
    )
      .map((s) => s.replace(/^\n+/, ""))
      .filter(Boolean)
    const atHead = new Set(head)
    const onlyInHistory = [...new Set(ever)].filter((p) => !atHead.has(p))
    findings.push(...matchPaths(onlyInHistory, deny, "history"))
  }
  return findings
}

// ---------------------------------------------------------------- artifacts

const ARCHIVE = /\.(tar\.gz|tgz|tar|zip)$/i
const SOURCES_CONTENT = Buffer.from("sourcesContent")

function extract(file: string): string {
  const dir = mkdtempSync(join(tmpdir(), "public-audit-x-"))
  const cmd = /\.zip$/i.test(file)
    ? ["unzip", "-qq", "-o", file, "-d", dir]
    : ["tar", /\.tar$/i.test(file) ? "-xf" : "-xzf", file, "-C", dir]
  if (!Bun.which(cmd[0])) throw new Misconfigured(`${cmd[0]} not found — cannot inspect ${basename(file)}`)
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) {
    rmSync(dir, { recursive: true, force: true })
    throw new Misconfigured(`could not extract ${basename(file)}: ${r.stderr.toString().trim()}`)
  }
  return dir
}

type ArtifactRules = { sentinels: Term[]; runtimeSourcesContent: number }

const isBinary = (data: Uint8Array) => data.subarray(0, 8192).includes(0)

function scanArtifactFile(file: string, shown: string, rules: ArtifactRules, findings: Finding[]) {
  const { sentinels } = rules
  if (/\.map$/i.test(file)) findings.push({ check: "artifact", path: shown, rule: "sourcemap", detail: "*.map file" })
  const data = readFileSync(file)
  const hits = offsetsOf(data, SOURCES_CONTENT)
  // A compiled binary inherits the runtime's own hits; it may not carry one more than that.
  // A text file (a bundle, a map renamed to .js) never gets the allowance.
  const allowed = isBinary(data) ? rules.runtimeSourcesContent : 0
  if (hits.length > allowed)
    findings.push({
      check: "artifact",
      path: shown,
      offset: hits[0],
      rule: "sourcesContent",
      detail: allowed ? `${hits.length} hits, runtime baseline ${allowed}` : undefined,
    })
  if (sentinels.length === 0) return
  const hay = lower(data)
  for (const t of sentinels) {
    const at = hay.indexOf(t.needle)
    if (at !== -1) findings.push({ check: "artifact", path: shown, offset: at, rule: t.rule })
  }
}

function scanArtifact(path: string, shown: string, rules: ArtifactRules, findings: Finding[], depth = 0) {
  const st = lstatSync(path)
  if (st.isSymbolicLink()) return // never follow out of an extracted tree
  if (st.isDirectory()) {
    for (const name of readdirSync(path).sort())
      scanArtifact(join(path, name), `${shown}/${name}`, rules, findings, depth)
    return
  }
  if (!st.isFile()) return
  if (ARCHIVE.test(path)) {
    if (depth > 4) throw new Misconfigured(`archives nested deeper than 4 at ${shown}`)
    const dir = extract(path)
    try {
      for (const name of readdirSync(dir).sort())
        scanArtifact(join(dir, name), `${shown}!/${name}`.replace("!/./", "!/"), rules, findings, depth + 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    return
  }
  scanArtifactFile(path, shown, rules, findings)
}

function checkArtifacts(targets: string[], deny: Denylist, cwd: string, runtime?: string): Finding[] {
  let runtimeSourcesContent = 0
  if (runtime) {
    const abs = resolve(cwd, runtime)
    if (!existsSync(abs)) throw new Misconfigured(`--runtime ${runtime} does not exist`)
    runtimeSourcesContent = offsetsOf(readFileSync(abs), SOURCES_CONTENT).length
  }
  const rules: ArtifactRules = { sentinels: terms(deny.sentinels, "sentinels"), runtimeSourcesContent }
  const findings: Finding[] = []
  for (const t of targets) {
    const abs = resolve(cwd, t)
    if (!existsSync(abs)) throw new Misconfigured(`--artifact ${t} does not exist`)
    scanArtifact(abs, statSync(abs).isDirectory() ? relative(cwd, abs) || "." : basename(abs), rules, findings)
  }
  return findings
}

// ---------------------------------------------------------------- repos

async function ghPublicRepos(org: string): Promise<string[]> {
  const cmd = [
    "gh",
    "repo",
    "list",
    org,
    "--visibility",
    "public",
    "--limit",
    "1000",
    "--json",
    "nameWithOwner",
    "--jq",
    ".[].nameWithOwner",
  ]
  const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(r.stderr.toString().trim() || `gh exited ${r.exitCode}`)
  return r.stdout
    .toString()
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)
}

async function checkRepos(
  file: string,
  org: string,
  cwd: string,
  gh: (org: string) => Promise<string[]>,
): Promise<Finding[]> {
  const abs = resolve(cwd, file)
  if (!existsSync(abs)) throw new Misconfigured(`--repos ${file} does not exist`)
  const norm = (s: string) => (s.includes("/") ? s : `${org}/${s}`).toLowerCase()
  const allowed = new Map<string, string>()
  for (const raw of readFileSync(abs, "utf8").split(/\r?\n/)) {
    const s = raw.trim()
    if (s && !s.startsWith("#")) allowed.set(norm(s), s.includes("/") ? s : `${org}/${s}`)
  }
  let live: string[]
  try {
    live = await gh(org)
  } catch (e) {
    throw new Misconfigured(`could not list public repos of ${org}: ${(e as Error).message}`)
  }
  const liveSet = new Map(live.map((r) => [r.toLowerCase(), r]))
  const findings: Finding[] = []
  for (const [k, name] of liveSet)
    if (!allowed.has(k))
      findings.push({ check: "repos", path: name, rule: "unexpected-public", detail: "public but not allowlisted" })
  for (const [k, name] of allowed)
    if (!liveSet.has(k))
      findings.push({
        check: "repos",
        path: name,
        rule: "allowlisted-not-public",
        detail: "allowlisted but not public",
      })
  return findings
}

// ---------------------------------------------------------------- cli

type Args = {
  content: boolean
  paths: boolean
  history: boolean
  artifacts: string[]
  runtime?: string
  repos?: string
  org: string
  root?: string
  json: boolean
}

function parseArgs(argv: string[]): Args {
  const a: Args = { content: false, paths: false, history: false, artifacts: [], org: "FREELABEL", json: false }
  const value = (i: number, flag: string) => {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith("--")) throw new Misconfigured(`${flag} needs a value`)
    return v
  }
  for (let i = 0; i < argv.length; i++) {
    const f = argv[i]
    if (f === "--content") a.content = true
    else if (f === "--paths") a.paths = true
    else if (f === "--history") a.history = a.paths = true
    else if (f === "--json") a.json = true
    else if (f === "--artifact") a.artifacts.push(value(i++, f))
    else if (f === "--runtime") a.runtime = value(i++, f)
    else if (f === "--repos") a.repos = value(i++, f)
    else if (f === "--org") a.org = value(i++, f)
    else if (f === "--root") a.root = value(i++, f)
    else throw new Misconfigured(`unknown argument ${f}`)
  }
  if (!a.content && !a.paths && a.artifacts.length === 0 && !a.repos) a.content = a.paths = true
  return a
}

const CHECKS = ["content", "paths", "history", "artifact", "repos"] as const

function render(args: Args | undefined, ran: string[], findings: Finding[], error?: string): RunResult {
  const code: 0 | 1 | 2 = error ? 2 : findings.length ? 1 : 0
  const counts = Object.fromEntries(
    CHECKS.filter((c) => ran.includes(c)).map((c) => [c, findings.filter((f) => f.check === c).length]),
  )
  if (args?.json) {
    return {
      code,
      output: JSON.stringify({ exitCode: code, ok: code === 0, checks: ran, counts, findings, error }, null, 2),
    }
  }
  const lines: string[] = []
  if (error) {
    lines.push(`public-audit: MISCONFIGURED — ${error}`)
    return { code, output: lines.join("\n") }
  }
  for (const f of findings) {
    const where =
      f.line !== undefined ? `${f.path}:${f.line}` : f.offset !== undefined ? `${f.path} @byte ${f.offset}` : f.path
    lines.push(`${f.check.padEnd(9)} ${where}  [${f.rule}]${f.detail ? `  ${f.detail}` : ""}`)
  }
  if (findings.length) lines.push("")
  const summary = Object.entries(counts)
    .map(([c, n]) => `${c} ${n}`)
    .join(", ")
  lines.push(
    code === 0 ? `public-audit: clean (${summary})` : `public-audit: ${findings.length} finding(s) — ${summary}`,
  )
  if (findings.some((f) => /@\d+$/.test(f.rule)))
    lines.push("rule ids like strings@12 name a line of the private denylist; matched terms are never printed.")
  return { code, output: lines.join("\n") }
}

export async function run(argv: string[], opts: RunOptions = {}): Promise<RunResult> {
  const env = opts.env ?? process.env
  const cwd = opts.cwd ?? process.cwd()
  let args: Args | undefined
  const ran: string[] = []
  const findings: Finding[] = []
  try {
    args = parseArgs(argv)
    const needsDeny = args.content || args.paths || args.artifacts.length > 0
    const deny = needsDeny ? loadDenylist(env) : undefined
    if (deny) {
      if (args.content && deny.strings.length + deny.sentinels.length === 0)
        throw new Misconfigured("denylist has no [strings] or [sentinels] — the content check would check nothing")
      if (args.paths && deny.paths.length === 0)
        throw new Misconfigured("denylist has no [paths] — the paths check would check nothing")
      if (args.artifacts.length && deny.sentinels.length === 0)
        throw new Misconfigured("denylist has no [sentinels] — the artifact check would miss every leaked prompt")
    }
    if (args.content || args.paths) {
      const root = args.root ? resolve(cwd, args.root) : git(cwd, ["rev-parse", "--show-toplevel"]).toString().trim()
      if (args.content) {
        ran.push("content")
        findings.push(...(await checkContent(root, deny!)))
      }
      if (args.paths) {
        ran.push("paths")
        if (args.history) ran.push("history")
        findings.push(...checkPaths(root, deny!, args.history))
      }
    }
    if (args.artifacts.length) {
      ran.push("artifact")
      findings.push(...checkArtifacts(args.artifacts, deny!, cwd, args.runtime))
    }
    if (args.repos) {
      ran.push("repos")
      findings.push(...(await checkRepos(args.repos, args.org, cwd, opts.gh ?? ghPublicRepos)))
    }
    return render(args, ran, findings)
  } catch (e) {
    if (e instanceof Misconfigured) return render(args, ran, [], e.message)
    return render(args, ran, [], `unexpected error: ${(e as Error).stack ?? e}`)
  }
}

if (import.meta.main) {
  const r = await run(process.argv.slice(2))
  ;(r.code === 2 ? process.stderr : process.stdout).write(r.output + "\n")
  process.exit(r.code)
}
