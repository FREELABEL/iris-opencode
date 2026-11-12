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
  "press",
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
  /** What each option says (same order as options), when it differs from its value. */
  optionLabels?: string[]
  /** A radio or checkbox: whether it is chosen. */
  checked?: boolean
  /** The web address this element opens (its own link, or the link around it). */
  href?: string
  /** The site's ids on it or on its card: data-jk, data-id, data-product-id … */
  ids?: Record<string, string>
  /** Listed from an open pop-up; the page behind it is left out. */
  inDialog?: boolean
  /** Not a button in the markup but a box the site made clickable (pointer cursor, onclick):
   * Southwest's fare cells (#193331). Clicked the same way. */
  area?: boolean
  /** What sits on top of it where a person would click (a cookie overlay, a sticky bar). */
  covered?: string
}

/** How one `elements` listing was cut. */
export type ElementListing = {
  /** Every control on the page (or the open pop-up). */
  total: number
  /** Those that matched the query (all of them when there is none). */
  matched: number
  /** Matching controls left out because the list was full: above the screen, and below or beside it. */
  above: number
  below: number
  /** A blocking pop-up is open and only its controls were listed: how many are behind it. */
  behind?: number
  query?: string
  /** What the page looked like, for the bot-check test (humanCheckReason). */
  signals?: PageSignals
}

/** The few facts that tell a "prove you're human" or block page from a real one (#193355 item 11). */
export type PageSignals = {
  url: string
  title: string
  heading: string
  text: string
  textLength: number
  frames: string[]
  cfChallenge: boolean
  blockWidget: boolean
}


/**
 * The line under the list: what was left out and how to reach it. A list cut silently reads as
 * "this is everything", and the agent gives up on a page whose button is simply further down.
 */
export function listingFooter(listed: number, l: ElementListing | null): string {
  if (!l) return ""
  const behind = l.behind
    ? `${l.behind} more control${l.behind === 1 ? " is" : "s are"} BEHIND the pop-up on the page. To reach them, close it first (its close or accept button, or {"action":"press","key":"Escape"}).`
    : ""
  const rest = cutFooter(listed, l)
  return [rest, behind].filter(Boolean).join(" ")
}

function cutFooter(listed: number, l: ElementListing): string {
  if (l.query) {
    if (!l.matched) return `Nothing among the page's ${l.total} controls matches "${l.query}". Try a shorter word, or scroll and run elements without a query.`
    const more = l.matched - listed
    return `${l.matched} of the page's ${l.total} controls match "${l.query}"${more > 0 ? ` (${more} more not shown — narrow the query)` : ""}.`
  }
  const left = l.above + l.below
  if (left <= 0) return ""
  const where = [l.below ? `${l.below} below or beside the screen` : "", l.above ? `${l.above} above it` : ""].filter(Boolean).join(" and ")
  return `Showing ${listed} of ${l.total} controls, what is on screen first. Not listed: ${where}. Scroll there and run elements again, or ask for one by its words: {"action":"elements","query":"$155"}.`
}

/** A link as short as it can be read: a path on this page's site, the full address elsewhere. */
export function shortHref(href: string, pageUrl?: string): string {
  try {
    const u = new URL(href)
    const here = pageUrl ? new URL(pageUrl) : undefined
    const s = here && here.origin === u.origin ? u.pathname + u.search + u.hash : href
    return s.length > 120 ? s.slice(0, 119) + "…" : s
  } catch {
    return href.slice(0, 120)
  }
}

/** "30 Austin: DoubleTree University Area": the value to pass AND what it means. */
function optionText(e: PageElement, i: number): string {
  const v = e.options![i]!
  const l = e.optionLabels?.[i]
  return l && l !== v ? `${v} "${l.slice(0, 40)}"` : v
}

const CLICKABLE = new Set(["link", "button", "checkbox", "radio", "tab", "menuitem", "option", "switch"])
const TYPEABLE = new Set(["textbox", "searchbox", "combobox", "textarea"])
const SELECTABLE = new Set(["combobox", "listbox"])
const SCROLLS = ["up", "down", "top", "bottom"] as const

/** One line per element: what it is, what it says, and anything that makes it unusable. */
export function renderElements(els: PageElement[], pageUrl?: string): string {
  if (!els.length) return "No interactive elements on this page."

  const head = els.some((e) => e.inDialog) ? "A pop-up is open: these are its controls (the page behind it is inert).\n" : ""
  return head + els
    .map((e) => {
      const flags = [
        e.enabled ? "" : "disabled",
        e.checked === true ? "checked" : e.checked === false ? "not checked" : "",
        e.inViewport ? "" : "off-screen",
        e.area ? "click area" : "",
        e.covered ? `covered by "${e.covered}": a click lands on that, clear it first` : "",
        e.value ? `value: ${JSON.stringify(e.value.slice(0, 40))}` : "",
        e.options?.length
          ? `options: ${e.options.slice(0, 12).map((_, i) => optionText(e, i)).join(", ")}${e.options.length > 12 ? ` … (${e.options.length} in all)` : ""}`
          : "",
        // What it IS: where it goes and the site's ids for the record (a job, a product).
        e.href && e.role !== "textbox" ? `→ ${shortHref(e.href, pageUrl)}` : "",
        e.ids ? Object.entries(e.ids).map(([k, v]) => `${k}=${v.slice(0, 40)}`).join(" ") : "",
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
  const want = value.trim().toLowerCase()
  if (el.optionLabels?.some((l) => l.trim().toLowerCase() === want)) return null

  return `[${ref}] has no option ${JSON.stringify(value)} — it offers: ${options.slice(0, 20).map((_, i) => optionText(el, i)).join(", ")}`
}

/** Why this scroll cannot be done, or null. Four directions, named in the refusal. */
export function refuseScrollReason(direction: string): string | null {
  return (SCROLLS as readonly string[]).includes(direction)
    ? null
    : `scroll takes ${SCROLLS.join(", ")} — got ${JSON.stringify(direction)}`
}

const IRREVERSIBLE =
  /\b(delete|remove|destroy|erase|wipe|pay|buy|purchase|checkout|check out|order|send|submit|transfer|withdraw|confirm|cancel (my |your |the )?(subscription|booking|reservation|order|trip|flight)|unsubscribe|deactivate|archive|publish|post|sign out|log out|book|reserve|complete (my |your |the )?(booking|reservation|purchase|order|payment)|finish (my |your |the )?(booking|reservation)|make (a |the )?(reservation|booking|payment))\b/i

/**
 * Words that LOOK like a commit but are a list, a field or a setting (#193355): "Sort order",
 * "Order history", "Confirm dates", "Send code", "Post code". They are taken out before the test
 * above, so the same label still asks if it ALSO says pay, book, delete…
 */
const HARMLESS =
  /\b(sort (order|by)|order (history|status|details|summary|number|by)|track (my |your |an |the )?order|view (my |your |the )?orders?|my orders|past orders|confirm (the |your )?(dates?|selection|location|address|guests?|passengers?|travell?ers?|time|filters?|search|email|e-mail)|(re)?send (me )?(a |the |my )?(new )?(verification |security |login |sign-in |one[- ]time |confirmation )?(code|otp|pin|link)|post ?code|postal code|book(ing)? (details|summary|reference)|address book)\b/gi

/**
 * Does this control look like it cannot be undone?
 *
 * The cheap half of a risk gate: the agent must say it meant it, and the refusal names the word
 * that triggered it, so a wrong gate is obvious rather than mysterious. The page is untrusted
 * input — one of these clicks spends money, books a seat or sends something in the user's name.
 */
export function looksIrreversible(label: string): boolean {
  return IRREVERSIBLE.test(String(label ?? "").replace(HARMLESS, " "))
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"]

/**
 * A date as an <input type=date> takes it: YYYY-MM-DD, or null when the text is not a date.
 *
 * A date field ignores "12/10/2026" and stays empty, silently (#193355). US order first (M/D/Y),
 * day-first only when the first number cannot be a month. Month names in either order.
 */
export function normalizeDate(text: string): string | null {
  const t = String(text ?? "").trim().toLowerCase().replace(/,/g, " ").replace(/\s+/g, " ")
  const out = (y: number, m: number, d: number) => {
    const year = y < 100 ? 2000 + y : y
    const ok = m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(year, m, 0)).getUTCDate() && year >= 1000 && year <= 9999
    return ok ? `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}` : null
  }
  const iso = t.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/)
  if (iso) return out(+iso[1]!, +iso[2]!, +iso[3]!)
  const num = t.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/)
  if (num) {
    const a = +num[1]!
    const b = +num[2]!
    return a > 12 ? out(+num[3]!, b, a) : out(+num[3]!, a, b)
  }
  const month = (w: string) => MONTHS.indexOf(w.slice(0, 3)) + 1
  const md = t.match(/^(?:[a-z]+ )?([a-z]{3,9})\.? (\d{1,2})(?:st|nd|rd|th)? (\d{4})$/)
  if (md && month(md[1]!) > 0) return out(+md[3]!, month(md[1]!), +md[2]!)
  const dm = t.match(/^(?:[a-z]+ )?(\d{1,2})(?:st|nd|rd|th)? ([a-z]{3,9})\.? (\d{4})$/)
  if (dm && month(dm[2]!) > 0) return out(+dm[3]!, month(dm[2]!), +dm[1]!)
  return null
}

const BLOCK_PHRASES =
  /^(just a moment|attention required|access denied|blocked|you have been blocked|you've been blocked|request blocked|sorry, you have been blocked|access to this page has been denied|pardon our interruption|are you a (human|robot)|verify(ing)? you are (a )?human|please verify you are a human|checking (if the site connection is secure|your browser)|one more step|bot or not|security check|additional verification required)\s*[.!?…]*\s*([|–—-].*)?$/i

/**
 * Is this page a "prove you're human" check or a block page, and whose? null when it is a page.
 *
 * Measured live (#193355): Yelp and Hertz came back blank with 0 controls, Kayak sent the agent to
 * /help/bots.html, Expedia said "Bot or Not?". The agent read each as an empty or odd page and kept
 * trying. The check is for a PERSON; the agent's part is to say so and stop.
 */
export function humanCheckReason(s: PageSignals | null | undefined): string | null {
  if (!s) return null
  const frames = s.frames.join(" ")
  if (s.cfChallenge || /challenges\.cloudflare\.com/.test(frames) || /^(just a moment|attention required)/i.test(s.title.trim())) {
    return "a Cloudflare check"
  }
  if (/captcha-delivery\.com|datadome/i.test(frames)) return "a DataDome check"
  if (/px-captcha|perimeterx|human\.com/i.test(frames) || (s.textLength < 2000 && /press (&|and) hold/i.test(s.text))) {
    return "a PerimeterX check"
  }
  let path = ""
  try {
    path = new URL(s.url).pathname
  } catch {}
  if (/\/help\/bots?\b|\/(bot|captcha|blocked)(\.html?)?$/i.test(path)) return "the site's bot page"
  if (BLOCK_PHRASES.test(s.title.trim()) || (s.textLength < 3000 && BLOCK_PHRASES.test(s.heading.trim()))) {
    return "a block page"
  }
  if (s.blockWidget) return "a human check"
  if (s.textLength < 300 && /recaptcha|hcaptcha|turnstile|captcha/i.test(frames)) return "a captcha"
  if (s.textLength < 1500 && /verify (that )?you are (a )?human|complete the security check|not a robot/i.test(s.text)) {
    return "a human check"
  }
  return null
}

/** What the agent is told when it meets one: hand it to the person, never get past it. */
export function humanCheckAdvice(kind: string, target: "agent" | "panel"): string {
  const never = "It is for a PERSON: do not click, solve, retry or work around it, and do not switch browsers to get past it."
  return target === "panel"
    ? `STOP: this page is ${kind}, not the site. ${never} Tell the person in one short line to finish the check in the Browser; your next call waits for them.`
    : `STOP: this page is ${kind}, not the site: the site turned your browser away. ${never} Tell the person in one short line that the site asked for a human check, and leave that site to them (they can open it themselves).`
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

/**
 * What inspect found, for the agent: the real addresses, each with where it came from, then the
 * site's ids. An id is NOT an address: nothing here builds one from a pattern (#193242). If there
 * is no link, it says so and says how to get one honestly.
 */
export function renderInspect(ref: number, i: {
  tag: string
  attributes: Record<string, string>
  ids: Record<string, string>
  links: { url: string; source: string; where: string }[]
  ancestors: { tag: string; role?: string; id?: string; ids?: Record<string, string> }[]
  canonical?: string
  page: string
}): string {
  const lines = [`[${ref}] <${i.tag}> on ${i.page}`]
  if (i.links.length) {
    lines.push("links (real, from the page):")
    for (const l of i.links) lines.push(`  ${l.url}  · ${l.source}: ${l.where}`)
  } else {
    lines.push("links: none on it or around it")
  }
  const ids = Object.entries(i.ids)
  if (ids.length) lines.push(`ids: ${ids.map(([k, v]) => `${k}=${v}`).join(" ")}`)
  if (i.canonical && i.canonical !== i.page) lines.push(`this page's canonical address: ${i.canonical}`)
  const attrs = Object.entries(i.attributes).filter(([k]) => k !== "data-iris-ref")
  if (attrs.length) lines.push(`attributes: ${attrs.slice(0, 20).map(([k, v]) => `${k}=${JSON.stringify(v.slice(0, 80))}`).join(" ")}`)
  if (i.ancestors.length) {
    lines.push(
      `inside: ${i.ancestors
        .slice(0, 6)
        .map((a) => a.tag + (a.id ? `#${a.id}` : "") + (a.role ? `[${a.role}]` : "") + (a.ids ? ` {${Object.entries(a.ids).map(([k, v]) => `${k}=${v}`).join(" ")}}` : ""))
        .join(" < ")}`,
    )
  }
  if (!i.links.length) {
    lines.push(
      ids.length
        ? "No address here, only ids. Don't build a link from an id: click it and read the address after, or say you have the id only."
        : "No address here. Click it and read the address after, if you need one.",
    )
  }
  return lines.join("\n")
}
