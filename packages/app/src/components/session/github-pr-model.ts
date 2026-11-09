/**
 * Pure parts of the in-app PR view (#192937), apart from the component so they are tested
 * without loading the Markdown renderer (its worker cannot load under bun test).
 */
/** Same rule as the engine's parsePrUrl: github.com/<owner>/<repo>/pull/<n>[/files|…]. */
export function isGithubPrUrl(input: string | undefined): boolean {
  if (!input) return false
  try {
    const u = new URL(input)
    if (u.protocol !== "https:" && u.protocol !== "http:") return false
    if (u.hostname !== "github.com" && u.hostname !== "www.github.com") return false
    return /^\/[A-Za-z0-9-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*(?:\/[a-z]*)?\/?$/.test(u.pathname)
  } catch {
    return false
  }
}

export type Check = { name: string; state: "success" | "failure" | "pending" | "neutral" | "skipped"; url?: string }
export type File = { path: string; status: string; additions: number; deletions: number; patch?: string; truncated?: boolean }
export type Comment = { author: string; body: string; at: string; kind: "comment" | "review"; state?: string }
export type Pr = {
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
  updatedAt: string
  additions: number
  deletions: number
  changedFiles: number
  commits: number
  checks: Check[]
  files: File[]
  comments: Comment[]
}
export type Load =
  | { state: "loading" }
  | { state: "ok"; pr: Pr }
  | { state: "no-access"; reason: string; signedIn: boolean }
  | { state: "error"; reason: string }

export const STATE_LABEL: Record<Pr["state"], string> = { open: "Open", draft: "Draft", merged: "Merged", closed: "Closed" }

export function ago(iso: string | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, (Date.now() - t) / 1000)
  if (s < 60) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/** "2 failing · 1 pending · 3 passed" — failing first, because that is what a person acts on. */
export function checksSummary(checks: Check[]): string {
  const n = (s: Check["state"]) => checks.filter((c) => c.state === s).length
  return [
    n("failure") && `${n("failure")} failing`,
    n("pending") && `${n("pending")} pending`,
    n("success") && `${n("success")} passed`,
    n("skipped") + n("neutral") && `${n("skipped") + n("neutral")} other`,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Each diff line with the class that colours it. Pure, so the colouring is tested. */
export function diffLines(patch: string): { text: string; kind: "add" | "del" | "hunk" | "ctx" }[] {
  return patch.split("\n").map((text) => ({
    text,
    kind: text.startsWith("@@") ? "hunk" : text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "ctx",
  }))
}

