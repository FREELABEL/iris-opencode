/**
 * Running an `iris …` command from a button (#194581) — the app side, pure.
 *
 * The engine owns the decision (packages/opencode/src/iris/cli-run.ts, `POST /iris/run`): it runs
 * only the installed IRIS CLI, as argv with no shell, and it refuses a write that was not
 * confirmed. The app asks once with `confirmed: false`: a READ runs at once; a WRITE comes back
 * `needsConfirm`, the app shows its confirm in words, and asks again with `confirmed: true`.
 */
import { shellWords } from "@/components/session/iris-agent-actions"

export type IrisRunResult = {
  ran: boolean
  kind: "read" | "write"
  needsConfirm?: boolean
  refused?: string
  code?: number
  stdout?: string
  stderr?: string
  truncated?: boolean
  timedOut?: boolean
  ms?: number
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>

/** `iris drives scan "/Volumes/A B"` → ["drives", "scan", "/Volumes/A B"], or why it cannot run. */
export function parseIrisLine(line: string): { argv: string[] } | { error: "empty" | "not-iris" | "chained" } {
  const text = line.trim()
  if (!text) return { error: "empty" }
  if (hasUnquotedSeparator(text)) return { error: "chained" }
  const words = shellWords(text)
  const first = words[0] ?? ""
  if (first !== "iris" && !/(^|\/)iris(\.exe)?$/.test(first)) return { error: "not-iris" }
  const argv = words.slice(1)
  if (!argv.length) return { error: "empty" }
  return { argv }
}

/** `;`, `&&`, `|`, a newline or `$(…)` outside quotes: more than one command, or a shell feature. */
export function hasUnquotedSeparator(line: string): boolean {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!
    if (quote) {
      if (c === "\\" && quote === '"') i++
      else if (c === quote) quote = undefined
      continue
    }
    if (c === "\\") {
      i++
      continue
    }
    if (c === "'" || c === '"') quote = c
    else if (c === ";" || c === "|" || c === "&" || c === "\n" || c === "`" || (c === "$" && line[i + 1] === "(")) return true
  }
  return false
}

/** The line a person would type for `argv` — for "Copy CLI" and the confirm. */
export function formatIrisLine(argv: readonly string[]): string {
  const q = (w: string) => (w === "" ? '""' : /^[\w@%+=:,./~-]+$/.test(w) ? w : `"${w.replace(/(["\\$`])/g, "\\$1")}"`)
  return ["iris", ...argv.map(q)].join(" ")
}

/** Ask the engine to run it. Never throws: an unreachable engine is a refusal in words. */
export async function runIris(fetch: Fetch, base: string, argv: readonly string[], confirmed: boolean): Promise<IrisRunResult> {
  try {
    const root = base.replace(/\/$/, "")
    const res = await fetch(`${root}/iris/run`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ argv, confirmed }),
    })
    if (!res.ok) return { ran: false, kind: "write", refused: `IRIS answered ${res.status}` }
    return (await res.json()) as IrisRunResult
  } catch {
    return { ran: false, kind: "write", refused: "IRIS isn't answering on this computer" }
  }
}

/** The first line worth showing from some output: not blank, not a banner rule. */
export function firstLine(text: string | undefined, max = 160): string {
  const line = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[─━=\-_*·•\s]+$/.test(l))
  if (!line) return ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

export type RunOutcome = { tone: "success" | "critical"; title: "done" | "failed" | "refused" | "timedOut"; detail: string }

/** What a finished run says, for a toast or the inline result. */
export function outcomeOf(r: IrisRunResult): RunOutcome {
  if (!r.ran) return { tone: "critical", title: "refused", detail: r.refused ?? "" }
  if (r.timedOut) return { tone: "critical", title: "timedOut", detail: firstLine(r.stderr) || firstLine(r.stdout) }
  if (r.code === 0) return { tone: "success", title: "done", detail: lastLine(r.stdout) }
  return { tone: "critical", title: "failed", detail: firstLine(r.stderr) || firstLine(r.stdout) || `exit ${r.code}` }
}

/** The last meaningful line — a CLI usually ends with what it did. */
export function lastLine(text: string | undefined, max = 160): string {
  const lines = (text ?? "")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^[─━=\-_*·•\s]+$/.test(l))
  const line = lines[lines.length - 1] ?? ""
  return line.length > max ? line.slice(0, max - 1) + "…" : line
}

/** Words CLI help shouts for emphasis ("bring THIS machine online"). Acronyms (SSH, VPN) stay. */
const SHOUTED = new Set(["THIS", "ONLY", "NOT", "NEVER", "ALL", "ANY", "ONE", "EVERY", "NO", "YOUR"])

/** CLI help as a sentence a person reads: first letter capital, no shouted words. */
export function plainHelp(help: string | undefined): string | undefined {
  const text = (help ?? "").trim()
  if (!text) return undefined
  const calm = text.replace(/\b[A-Z]{2,}\b/g, (w) => (SHOUTED.has(w) ? w.toLowerCase() : w))
  return calm.charAt(0).toUpperCase() + calm.slice(1)
}
