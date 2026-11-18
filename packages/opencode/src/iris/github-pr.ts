/**
 * A pull request, drawn inside the app (#192937).
 *
 * github.com sends X-Frame-Options: DENY, so the side panel's Browser tab can never frame a PR —
 * every PR link the agent opened bounced to the system browser. Instead the sidecar reads the PR
 * from the GitHub API and the app draws it.
 *
 * Credentials, in order: GITHUB_TOKEN / GH_TOKEN, then `gh auth token` (the GitHub CLI login most
 * people who open PRs already have), then none — which still reads public repos. The token never
 * leaves this process; the app only ever sees the shaped PR.
 */

export type PrRef = { owner: string; repo: string; number: number }

/** github.com/<owner>/<repo>/pull/<n>[/files|/commits|/checks|#…] → the PR. Anything else → undefined. */
export function parsePrUrl(input: string | undefined): PrRef | undefined {
  if (!input) return undefined
  let u: URL
  try {
    u = new URL(input.trim())
  } catch {
    return undefined
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return undefined
  if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return undefined
  const m = /^\/([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/pull\/(\d+)(?:\/[a-z]*)?\/?$/.exec(u.pathname)
  if (!m) return undefined
  const number = Number(m[3])
  if (!Number.isSafeInteger(number) || number <= 0) return undefined
  return { owner: m[1], repo: m[2], number }
}

export type PrCheck = { name: string; state: "success" | "failure" | "pending" | "neutral" | "skipped"; url?: string }
export type PrFile = { path: string; status: string; additions: number; deletions: number; patch?: string; truncated?: boolean }
export type PrComment = { author: string; body: string; at: string; kind: "comment" | "review"; state?: string }

export type PrView = {
  url: string
  owner: string
  repo: string
  number: number
  title: string
  body: string
  state: "open" | "closed" | "merged" | "draft"
  author: string
  base: string
  head: string
  createdAt: string
  updatedAt: string
  mergedAt?: string
  additions: number
  deletions: number
  changedFiles: number
  commits: number
  mergeable?: string
  checks: PrCheck[]
  files: PrFile[]
  comments: PrComment[]
}

export type PrResult =
  | { state: "ok"; pr: PrView; signedIn: boolean }
  | { state: "no-access"; signedIn: boolean; reason: string }
  | { state: "invalid"; reason: string }
  | { state: "unreachable"; reason: string }

const API = "https://api.github.com"
const TIMEOUT_MS = 12_000
/** Lines of a single file's diff sent to the app. A lockfile diff would otherwise be megabytes. */
export const PATCH_LINES = 400

let cachedToken: { value: string | undefined; at: number } | undefined

async function ghCliToken(): Promise<string | undefined> {
  try {
    const p = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" })
    const timer = setTimeout(() => p.kill(), 4000)
    const out = await new Response(p.stdout).text()
    clearTimeout(timer)
    if ((await p.exited) !== 0) return undefined
    return out.trim() || undefined
  } catch {
    return undefined // no gh installed
  }
}

export async function githubToken(): Promise<string | undefined> {
  const env = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (env) return env
  // `gh auth token` is a process spawn; once a minute is plenty (a new `gh auth login` is seen soon).
  if (cachedToken && Date.now() - cachedToken.at < 60_000) return cachedToken.value
  const value = await ghCliToken()
  cachedToken = { value, at: Date.now() }
  return value
}

/** Cut a diff to PATCH_LINES lines. Pure, so the cap is tested without the network. */
export function capPatch(patch: string | undefined): { patch?: string; truncated?: boolean } {
  if (!patch) return {}
  const lines = patch.split("\n")
  if (lines.length <= PATCH_LINES) return { patch }
  return { patch: lines.slice(0, PATCH_LINES).join("\n"), truncated: true }
}

/** GitHub's check-run conclusion / commit-status state → one of five. */
export function checkState(status: string | null | undefined, conclusion: string | null | undefined): PrCheck["state"] {
  if (status && status !== "completed") return "pending"
  switch (conclusion) {
    case "success":
      return "success"
    case "failure":
    case "timed_out":
    case "cancelled":
    case "action_required":
    case "startup_failure":
    case "error":
      return "failure"
    case "skipped":
      return "skipped"
    case "pending":
    case null:
    case undefined:
      return "pending"
    default:
      return "neutral"
  }
}

type Fetcher = (path: string) => Promise<{ status: number; json: any }>

function makeFetcher(token: string | undefined): Fetcher {
  return async (path) => {
    const ctl = new AbortController()
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${API}${path}`, {
        signal: ctl.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "iris-desktop",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      })
      const json = res.ok ? await res.json() : undefined
      return { status: res.status, json }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** Shape GitHub's responses into what the app draws. Pure: tested with recorded payloads. */
export function shapePr(
  ref: PrRef,
  pr: any,
  files: any[],
  comments: any[],
  reviews: any[],
  checkRuns: any[],
  statuses: any[],
): PrView {
  const state: PrView["state"] = pr.merged_at ? "merged" : pr.state === "closed" ? "closed" : pr.draft ? "draft" : "open"
  const checks: PrCheck[] = [
    ...checkRuns.map((c) => ({ name: String(c.name), state: checkState(c.status, c.conclusion), url: c.html_url ?? undefined })),
    ...statuses.map((s) => ({ name: String(s.context), state: checkState("completed", s.state), url: s.target_url ?? undefined })),
  ]
  const thread: PrComment[] = [
    ...comments.map((c) => ({ author: c.user?.login ?? "unknown", body: c.body ?? "", at: c.created_at, kind: "comment" as const })),
    ...reviews
      .filter((r) => (r.body ?? "").trim() || r.state === "APPROVED" || r.state === "CHANGES_REQUESTED")
      .map((r) => ({ author: r.user?.login ?? "unknown", body: r.body ?? "", at: r.submitted_at, kind: "review" as const, state: r.state })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  return {
    url: pr.html_url ?? `https://github.com/${ref.owner}/${ref.repo}/pull/${ref.number}`,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: pr.title ?? "",
    body: pr.body ?? "",
    state,
    author: pr.user?.login ?? "unknown",
    base: pr.base?.ref ?? "",
    head: pr.head?.ref ?? "",
    createdAt: pr.created_at,
    updatedAt: pr.updated_at,
    ...(pr.merged_at ? { mergedAt: pr.merged_at } : {}),
    additions: pr.additions ?? 0,
    deletions: pr.deletions ?? 0,
    changedFiles: pr.changed_files ?? files.length,
    commits: pr.commits ?? 0,
    ...(pr.mergeable_state ? { mergeable: pr.mergeable_state } : {}),
    checks,
    files: files.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions ?? 0,
      deletions: f.deletions ?? 0,
      ...capPatch(f.patch),
    })),
    comments: thread,
  }
}

export async function readPr(url: string, fetcher?: Fetcher): Promise<PrResult> {
  const ref = parsePrUrl(url)
  if (!ref) return { state: "invalid", reason: "not a github.com pull request address" }
  const token = fetcher ? "test" : await githubToken()
  const get = fetcher ?? makeFetcher(token)
  const signedIn = !!token
  const base = `/repos/${ref.owner}/${ref.repo}`
  try {
    const pr = await get(`${base}/pulls/${ref.number}`)
    if (pr.status === 404 || pr.status === 401 || pr.status === 403)
      return {
        state: "no-access",
        signedIn,
        reason: signedIn
          ? `GitHub answered ${pr.status}: this GitHub login cannot see ${ref.owner}/${ref.repo}`
          : `GitHub answered ${pr.status}: private repos need a GitHub login on this computer (run gh auth login)`,
      }
    if (!pr.json) return { state: "unreachable", reason: `GitHub answered ${pr.status}` }
    const sha = pr.json.head?.sha
    const [files, comments, reviews, runs, statuses] = await Promise.all([
      get(`${base}/pulls/${ref.number}/files?per_page=100`),
      get(`${base}/issues/${ref.number}/comments?per_page=100`),
      get(`${base}/pulls/${ref.number}/reviews?per_page=100`),
      sha ? get(`${base}/commits/${sha}/check-runs?per_page=100`) : Promise.resolve({ status: 0, json: undefined }),
      sha ? get(`${base}/commits/${sha}/status`) : Promise.resolve({ status: 0, json: undefined }),
    ])
    return {
      state: "ok",
      signedIn,
      pr: shapePr(
        ref,
        pr.json,
        Array.isArray(files.json) ? files.json : [],
        Array.isArray(comments.json) ? comments.json : [],
        Array.isArray(reviews.json) ? reviews.json : [],
        Array.isArray(runs.json?.check_runs) ? runs.json.check_runs : [],
        Array.isArray(statuses.json?.statuses) ? statuses.json.statuses : [],
      ),
    }
  } catch (err) {
    return { state: "unreachable", reason: err instanceof Error ? err.message : String(err) }
  }
}
