/**
 * The browser verbs, and the rules that decide what the agent may open. (#186665, slice 1)
 *
 * The agent's side of Genesis › Browser: a page it can open, search and photograph, next to
 * `genesis_artifact` (#186508), which is where the photograph lands. Read-only in this slice —
 * `click` and `type` arrive in S3 behind the same-origin rule, once the driver and these guards
 * have run inside Desktop.
 *
 * DETERMINISTIC ON PURPOSE (ADR-01). Verbs in, page facts out; no model inside the tool. The
 * bridge's LLM-driven browser agent was built the other way and produced the measurement that
 * argues against it: asked for a number 5,758 characters into a page it had been shown the first
 * 3,000 of, it answered "not found" 0/3 — confidently, because the excerpt held a DIFFERENT
 * table. What fixed it was not a bigger model or a longer excerpt but a way to SEARCH the page
 * (`find`), after which it located the row 4/4. So: make the page legible, and let the agent that
 * is already in front of the user do the deciding.
 *
 * PAGE TEXT IS UNTRUSTED INPUT (ADR-03). Everything a page says arrives here as data, never as
 * instruction, and the refusals below are lifted from the daemon's own lanes rather than
 * re-derived: credential-bearing URLs and private / LAN / link-local hosts are refused
 * (browser-use-task.js:27-40), navigation stays on the origin the agent opened.
 */

/** Read-only in slice 1. `click` and `type` are S3. */
export const VERBS = ["open", "read", "find", "screenshot", "close"] as const
export type Verb = (typeof VERBS)[number]

const FIND_MAX = 8
const FIND_CONTEXT = 1

/**
 * Search the page instead of reading it from the top.
 *
 * Returns the matching lines WITH their line numbers and their neighbours, so the next question
 * can be about a place. A person does not read a long page from the top to find one number.
 */
export function findInPage(
  text: string,
  query: string,
  opts: { max?: number; context?: number } = {},
): { matches: number; text: string } {
  const q = String(query ?? "").trim()
  if (!q) {
    throw new Error('find needs something to look for, e.g. {"action":"find","query":"kimi-k3"}')
  }
  const max = opts.max ?? FIND_MAX
  const context = opts.context ?? FIND_CONTEXT
  const lines = String(text ?? "").split("\n")
  const needle = q.toLowerCase()

  const hits: number[] = []
  for (let i = 0; i < lines.length; i++) if (lines[i].toLowerCase().includes(needle)) hits.push(i)

  if (hits.length === 0) {
    return { matches: 0, text: `No match for "${q}" — searched ${lines.length} lines of page text.` }
  }

  const blocks = hits.slice(0, max).map((i) => {
    const from = Math.max(0, i - context)
    const to = Math.min(lines.length - 1, i + context)
    const out: string[] = []
    for (let n = from; n <= to; n++) out.push(`${n === i ? "→" : " "} line ${n + 1}: ${lines[n]}`)
    return out.join("\n")
  })
  const more = hits.length > max ? `\n…and ${hits.length - max} more match(es); narrow the query to see them.` : ""

  return { matches: hits.length, text: `${hits.length} match(es) for "${q}" in ${lines.length} lines:\n${blocks.join("\n--\n")}${more}` }
}

/**
 * Cut long page text to a budget, and SAY SO in the same breath.
 *
 * An excerpt that does not announce itself reads as the whole page, and a fact below the cut
 * comes back as a confident "not found" — the exact failure `find` exists to end. So the notice
 * carries the real size and names the verb that reaches the rest.
 */
export function clampPageText(text: string, max: number): string {
  const s = String(text ?? "")
  if (s.length <= max) return s

  return `${s.slice(0, max)}\n\n[truncated — ${s.length} characters in total. Use find to search the whole page for what you need before answering.]`
}

const PRIVATE_V4 = [
  /^10\./,
  /^127\./,
  /^0\./,
  /^192\.168\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
]

/**
 * Why this URL must not be opened, or null when it may be.
 *
 * Three refusals, each one a thing a page or a prompt could otherwise talk the agent into:
 * a scheme that is not the web, a credential handed to a site in the URL, and an address that
 * only exists inside this machine or this network — including 169.254.169.254, which hands out
 * cloud credentials to anything that asks.
 */
export function refuseUrlReason(url: string): string | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return `not a URL: ${String(url).slice(0, 80)}`
  }

  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `only http and https pages can be opened (got ${u.protocol.replace(":", "")})`
  }
  if (u.username || u.password) {
    return "the URL carries a credential — open the page without it"
  }

  const host = u.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (host === "169.254.169.254") {
    return "refused: the cloud metadata address is not a page"
  }
  if (host === "localhost" || host === "::1" || host.endsWith(".local") || host.endsWith(".internal")) {
    return `refused: ${host} is a private host`
  }
  if (PRIVATE_V4.some((re) => re.test(host))) {
    return `refused: ${host} is a private address`
  }
  if (host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80")) {
    return `refused: ${host} is a private address`
  }

  return null
}

/**
 * Why the agent must not follow this navigation, or null when it may.
 *
 * The page does not get to choose where we go next. Without this, one visited page can walk the
 * agent across the web — and page text reaches the agent as data it has already been told to read.
 */
export function refuseNavigationReason(from: string, to: string): string | null {
  const refused = refuseUrlReason(to)
  if (refused) return refused
  try {
    const a = new URL(from)
    const b = new URL(to)
    if (a.origin !== b.origin) {
      return `refused: ${b.origin} is a different origin from ${a.origin} — open it deliberately if you meant to`
    }
  } catch {
    return "refused: could not compare origins"
  }

  return null
}
