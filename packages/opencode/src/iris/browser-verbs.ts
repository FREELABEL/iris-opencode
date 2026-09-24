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
export const VERBS = [
  "open",
  "read",
  "find",
  "window",
  "elements",
  "click",
  "type",
  "select",
  "scroll",
  "screenshot",
  "close",
] as const
export type Verb = (typeof VERBS)[number]

const FIND_MAX = 8
const FIND_CONTEXT = 1

/**
 * The header row for a matched TABLE row, or null when the match is ordinary prose.
 *
 * Measured in the app on 2026-09-24, the first real use of this tool: eleven calls to answer one
 * question. `find` returned `kimi-k3  67  67  67  0` — correct, and unreadable, because nothing
 * said which column was the Mean. The agent spent six of those calls hunting for the header and
 * then fell back to another tool entirely. A row without its header is a row you cannot use.
 *
 * innerText renders a table row as tab-separated cells, so: walk up from the match while the
 * lines still look like rows, and take the first one whose cells are mostly non-numeric. Stop at
 * a line with no tabs — that is the end of the table, not a header.
 */
function headerRowFor(lines: string[], at: number): string | null {
  if (!lines[at]?.includes("\t")) return null
  for (let i = at - 1; i >= 0 && i >= at - 40; i--) {
    const line = lines[i]
    if (!line?.includes("\t")) return null
    const cells = line.split("\t").map((c) => c.trim()).filter(Boolean)
    if (cells.length < 2) continue
    const numeric = cells.filter((c) => /^[\d.,%$\/\s-]+$/.test(c)).length
    if (numeric <= cells.length / 2) return line
  }

  return null
}

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
    const header = headerRowFor(lines, i)
    if (header && !(from <= lines.indexOf(header) && lines.indexOf(header) <= to)) {
      out.push(`  header: ${header}`)
    }
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

/**
 * The lines around one line number — zoom in on a hit instead of re-reading the page.
 *
 * `find` hands back line numbers and, until this existed, there was no way to use them: the agent
 * re-read the whole page with a bigger budget each time (2,000 → 1,800 → 9,000 characters on its
 * first real run). Cheaper for us, and it keeps the page out of the context window.
 */
export function windowOfLines(text: string, line: number, radius = 5): string {
  const lines = String(text ?? "").split("\n")
  const at = Math.trunc(line)
  if (!Number.isFinite(at) || at < 1 || at > lines.length) {
    throw new Error(`the page has ${lines.length} lines; there is no line ${line}`)
  }
  const from = Math.max(0, at - 1 - radius)
  const to = Math.min(lines.length - 1, at - 1 + radius)
  const out: string[] = []
  const header = headerRowFor(lines, at - 1)
  if (header && !(from <= lines.indexOf(header) && lines.indexOf(header) <= to)) out.push(`  header: ${header}`)
  for (let n = from; n <= to; n++) out.push(`${n === at - 1 ? "→" : " "} line ${n + 1}: ${lines[n]}`)

  return out.join("\n")
}

/**
 * S3 — acting on the page.
 *
 * Built in the shape the fast browser agents converged on, because the expensive part of driving a
 * browser is HOW MANY TIMES YOU ASK, not how clever the planner is. So:
 *
 *   1. The page becomes a NUMBERED MENU, rebuilt every step — a stale action space is a stale
 *      decision, and after one click the legal set has changed.
 *   2. A target is chosen by REF, and a ref that cannot take the operation is refused here. Not
 *      "the prompt says only click clickable things": a text field is not clickable, in code.
 *   3. The result is VERIFIED BY DIFF — url, title, page size, field values — never by asking
 *      whether it worked. The daemon's rule, earned: DONE is not independent evidence of success.
 *
 * Whether the next step is picked by this agent or by a typed decision model behind a seam
 * (#185842, #186466) does not change any of the above. That is a provider choice; this is the
 * action space it chooses from.
 */
export type PageElement = {
  ref: number
  role: string
  name: string
  tag: string
  value?: string
  enabled: boolean
  inViewport: boolean
  /** For a dropdown: what it can actually be set to. A closed set cannot be invented. */
  options?: string[]
}

const CLICKABLE = new Set(["link", "button", "checkbox", "radio", "tab", "menuitem", "option", "switch"])
const TYPEABLE = new Set(["textbox", "searchbox", "combobox", "textarea"])
const SELECTABLE = new Set(["combobox", "listbox"])
const SCROLLS = ["up", "down", "top", "bottom"] as const

/** One line per element: what it is, what it says, and anything that makes it unusable. */
export function renderElements(els: PageElement[]): string {
  if (!els.length) return "No interactive elements on this page."

  return els
    .map((e) => {
      const flags = [
        e.enabled ? "" : "disabled",
        e.inViewport ? "" : "off-screen",
        e.value ? `value: ${JSON.stringify(e.value.slice(0, 40))}` : "",
        e.options?.length ? `options: ${e.options.slice(0, 12).join(", ")}${e.options.length > 12 ? " …" : ""}` : "",
      ].filter(Boolean)

      return `[${e.ref}] ${e.role.padEnd(10)} ${e.name.slice(0, 60)}${flags.length ? `  · ${flags.join(" · ")}` : ""}`
    })
    .join("\n")
}

/** Why this ref cannot take this operation, or null when it can. */
export function refuseTargetReason(els: PageElement[], ref: number, op: "click" | "type" | "select"): string | null {
  const el = els.find((e) => e.ref === ref)
  if (!el) return `there is no [${ref}] on this page — it lists ${els.length} elements; run elements again`
  if (!el.enabled) return `[${ref}] ${el.name} is disabled`
  if (op === "click" && !CLICKABLE.has(el.role)) return `[${ref}] is a ${el.role} — not clickable`
  if (op === "type" && !TYPEABLE.has(el.role)) return `[${ref}] is a ${el.role} — not a text field`
  if (op === "select" && !(SELECTABLE.has(el.role) && el.options?.length)) {
    return `[${ref}] is a ${el.role} — not a dropdown with options`
  }

  return null
}

/**
 * Why this dropdown cannot take this value, or null when it can.
 *
 * The option set is CLOSED: a value the page does not offer comes back as a refusal that lists
 * what it does offer, rather than a set() that silently does nothing. Same property that makes a
 * typed picker honest — it can only choose what is there.
 */
export function refuseOptionReason(els: PageElement[], ref: number, value: string): string | null {
  const el = els.find((e) => e.ref === ref)
  if (!el) return `there is no [${ref}] on this page — run elements again`
  const options = el.options ?? []
  if (!options.length) return `[${ref}] has no options to choose from`
  if (options.includes(value)) return null

  return `[${ref}] has no option ${JSON.stringify(value)} — it offers: ${options.slice(0, 20).join(", ")}`
}

/** Why this scroll cannot be done, or null. Four directions, named in the refusal. */
export function refuseScrollReason(direction: string): string | null {
  return (SCROLLS as readonly string[]).includes(direction)
    ? null
    : `scroll takes ${SCROLLS.join(", ")} — got ${JSON.stringify(direction)}`
}

const IRREVERSIBLE =
  /\b(delete|remove|destroy|erase|wipe|pay|buy|purchase|checkout|order|send|submit|transfer|withdraw|confirm|cancel subscription|unsubscribe|deactivate|archive|publish|post|sign out|log out)\b/i

/**
 * Does this control look like it cannot be undone?
 *
 * The cheap half of a risk gate: the agent must say it meant it, and the refusal names the word
 * that triggered it, so a wrong gate is obvious rather than mysterious. The page is untrusted
 * input — one of these clicks spends money or sends something in the user's name.
 */
export function looksIrreversible(label: string): boolean {
  return IRREVERSIBLE.test(String(label ?? ""))
}

export type PageState = {
  url: string
  title: string
  textLength: number
  textHash: string
  values: Record<string, string>
}

/**
 * What actually changed, in the page's own terms.
 *
 * A click that changed nothing is the case a model is most likely to narrate as success, so that
 * is the sentence this returns plainly rather than an empty summary.
 */
export function describeChange(before: PageState, after: PageState): string {
  const parts: string[] = []
  if (before.url !== after.url) parts.push(`navigated to ${after.url}`)
  if (before.title !== after.title) parts.push(`title is now "${after.title}"`)
  for (const [ref, v] of Object.entries(after.values)) {
    if ((before.values[ref] ?? "") !== v) parts.push(`[${ref}] now holds ${JSON.stringify(v.slice(0, 60))}`)
  }
  if (before.textHash !== after.textHash && before.url === after.url) {
    const delta = after.textLength - before.textLength
    parts.push(`the page text changed (${delta >= 0 ? "+" : ""}${delta} characters)`)
  }

  return parts.length ? parts.join("; ") : "nothing changed — same url, same text, same field values"
}
