/**
 * PLAYBOOKS, READ AS FLOW — the pure half of the Playbooks panel ("03 Flow", chosen from
 * heyiris.io/p/playbooks-panel-directions).
 *
 * The people opening this panel are not technical. They have three questions — what will this do
 * for me, will it bother me, is it any good — and a file name plus a paragraph answered none of
 * them. Everything here derives an answer from fields the record already carries, so nothing can
 * go stale: who does each step comes from the step's `mode`, how hands-off it is from counting the
 * steps that need a person, and the age from `publishedAt`.
 *
 * Kept free of Solid so it can be tested without a renderer.
 */

/** Who does a step. `unknown` is a step whose mode was not published — never guessed. */
export type Who = "think" | "auto" | "you" | "unknown"

const WHO_BY_MODE: Record<string, Exclude<Who, "unknown">> = {
  ai: "think",
  prompt: "think",
  agent: "think",
  shell: "auto",
  "hive-script": "auto",
  playbook: "auto",
  human: "you",
  manual: "you",
}

/** The step's `mode`, as who does it. An unrecognised or missing mode is `unknown`, not a guess. */
export function whoOf(mode: unknown): Who {
  if (typeof mode !== "string") return "unknown"
  return WHO_BY_MODE[mode.trim().toLowerCase()] ?? "unknown"
}

export const WHO_LABEL: Record<Who, string> = {
  think: "IRIS thinks",
  auto: "Runs on its own",
  you: "Needs you",
  unknown: "Not stated",
}

/**
 * ONE ICON, ONE MEANING, EVERYWHERE (Alex, 2026-10-09). The same glyph marks "who does it" in the
 * legend, the step list, the hands-off tag and the filter chips; an unstated step gets none rather
 * than a borrowed one. Names are keys of the app's own icon set (@opencode-ai/ui/icon).
 */
export const WHO_ICON: Record<Who, "sparkle" | "settings-gear" | "hand" | undefined> = {
  think: "sparkle",
  auto: "settings-gear",
  you: "hand",
  unknown: undefined,
}

/** Who can see it, as an icon — same keys as scopeWords. */
export const SCOPE_ICON: Record<string, "globe" | "lock" | "link" | "folder"> = {
  public: "globe",
  private: "lock",
  unlisted: "link",
  // folder, not checklist: checklist already means "number of steps" (one icon, one meaning).
  project: "folder",
}

export function scopeIcon(scope: unknown): "globe" | "lock" | "link" | "folder" | undefined {
  return typeof scope === "string" ? SCOPE_ICON[scope.trim().toLowerCase()] : undefined
}

/** The filter chips' icons: the hands-off meaning they select. "Anything" has none. */
export const FILTER_ICON: Record<HandsFilter, "settings-gear" | "hand" | undefined> = {
  any: undefined,
  auto: "settings-gear",
  once: "hand",
  charge: "hand",
}

/** The three the legend explains. `unknown` is drawn neutral and is not a category to learn. */
export const LEGEND: readonly Exclude<Who, "unknown">[] = ["think", "auto", "you"]

export interface FlowStep {
  who: Who
  title: string
}

/** The steps as the strip draws them — one entry per published step, in order. */
export function flowSteps(row: any): FlowStep[] {
  const steps = Array.isArray(row?.steps) ? row.steps : []
  return steps.map((s: any, i: number) => ({
    who: whoOf(s?.mode),
    title: typeof s?.title === "string" && s.title.trim() ? s.title.trim() : `Step ${i + 1}`,
  }))
}

/** How many steps need a person. */
export function humanSteps(row: any): number {
  return flowSteps(row).filter((s) => s.who === "you").length
}

/** "freelabel-ads" → "Freelabel ads". A plain sentence-case reading of a slug. */
/** "case_id" → "Case id": for labels built from field names (scope words, areas, "You'll need") — never titles. */
export function humanize(name: unknown): string {
  const s = String(name ?? "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!s) return ""
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/** A real, author-written title — not the slug. Empty when the playbook has none. */
export function playbookRealTitle(row: any): string {
  return typeof row?.title === "string" ? row.title.trim() : ""
}

/**
 * The row's display title: the author's `title` when it has one, otherwise the SLUG EXACTLY
 * ("freelabel-ads"). Not a tidied version — "Freelabel ads" read as half a sentence, and the slug
 * is what you type in the CLI, what is in the URL, and what people already know it by (Alex,
 * 2026-10-09). The UI draws a slug title in mono, so it reads as the identifier it is.
 */
export function playbookTitle(row: any): string {
  return playbookRealTitle(row) || String(row?.name ?? "").trim() || "Untitled playbook"
}

/** The slug shown UNDER a real title, so a titled playbook can still be found by its slug. */
export function playbookSlugLine(row: any): string | undefined {
  return playbookRealTitle(row) && row?.name ? String(row.name) : undefined
}

/**
 * The description's first sentence — the one-line outcome under the title. Cut at a word, never
 * mid-word, with an ellipsis only when something was actually cut.
 */
export function outcomeLine(description: unknown, max = 140): string {
  const d = String(description ?? "")
    .replace(/\s+/g, " ")
    .trim()
  if (!d) return ""
  const m = d.match(/^.*?[.!?](?=\s|$)/)
  const first = (m ? m[0] : d).trim()
  if (first.length <= max) return first
  const cut = first.slice(0, max)
  const at = cut.lastIndexOf(" ")
  return `${(at > max * 0.5 ? cut.slice(0, at) : cut).replace(/[\s,;:—-]+$/, "")}…`
}

export type HandsTone = "auto" | "you"

/**
 * How hands-off it is, as a tag: "Fully automatic", "Asks you once", "Asks you 3×".
 * Null when the playbook publishes no steps — there is nothing to count, so nothing is claimed.
 */
export function handsTag(row: any): { label: string; tone: HandsTone; count: number } | null {
  const steps = flowSteps(row)
  if (steps.length === 0) return null
  const n = steps.filter((s) => s.who === "you").length
  if (n === 0) return { label: "Fully automatic", tone: "auto", count: 0 }
  if (n === 1) return { label: "Asks you once", tone: "you", count: 1 }
  return { label: `Asks you ${n}×`, tone: "you", count: n }
}

export type HandsFilter = "any" | "auto" | "once" | "charge"

export const HANDS_FILTERS: readonly { id: HandsFilter; label: string }[] = [
  { id: "any", label: "Anything" },
  { id: "auto", label: "Fully automatic" },
  { id: "once", label: "Asks me once" },
  { id: "charge", label: "I stay in charge" },
]

/**
 * The filter chips. Client-side, over rows already fetched, so it composes with the server-side
 * search and the All / Project / Marketplace view. A playbook with no published steps cannot be
 * said to be any of the three, so only "Anything" shows it.
 */
export function matchesHands(row: any, filter: HandsFilter): boolean {
  if (filter === "any") return true
  const tag = handsTag(row)
  if (!tag) return false
  if (filter === "auto") return tag.count === 0
  if (filter === "once") return tag.count === 1
  return tag.count >= 2
}

const SCOPE_WORDS: Record<string, string> = {
  public: "Everyone",
  private: "Only you",
  unlisted: "Link only",
  project: "This project",
}

/** Who can see it, in plain words. Unknown scopes pass through rather than vanish. */
export function scopeWords(scope: unknown): string | undefined {
  if (typeof scope !== "string" || !scope.trim()) return undefined
  return SCOPE_WORDS[scope.trim().toLowerCase()] ?? humanize(scope)
}

/**
 * The area tag — ONLY when the record carries one. The platform's playbook rows have no
 * category today, so this is usually undefined; an invented area would be a claim about the
 * playbook nobody made.
 */
export function areaTag(row: any): string | undefined {
  const cat = typeof row?.category === "string" ? row.category.trim() : ""
  if (cat) return humanize(cat)
  const ind = Array.isArray(row?.industries)
    ? row.industries.find((x: unknown) => typeof x === "string" && x.trim())
    : undefined
  return ind ? humanize(ind) : undefined
}

/** "You'll need: A link and a bloq" — the required arguments, in plain words. "Nothing" when none. */
export function neededPhrase(args: unknown): string {
  const list = Array.isArray(args) ? args : []
  const names = list
    .filter((a: any) => a && typeof a === "object" && a.required === true && typeof a.name === "string")
    .map((a: any) => humanize(a.name).toLowerCase())
    .filter(Boolean)
  if (names.length === 0) return "Nothing"
  const words = names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** "2 weeks ago". Undefined for a missing or unreadable date — never a made-up age. */
export function updatedAgo(iso: unknown, now = Date.now()): string | undefined {
  if (typeof iso !== "string" || !iso) return undefined
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return undefined
  const days = Math.floor(Math.max(0, now - t) / 86_400_000)
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"} ago`
  if (days === 0) return "today"
  if (days === 1) return "yesterday"
  if (days < 14) return unit(days, "day")
  if (days < 60) return unit(Math.floor(days / 7), "week")
  if (days < 365) return unit(Math.floor(days / 30), "month")
  return unit(Math.floor(days / 365), "year")
}

/** The All view's source words for one row, in a fixed order: "project · installed · marketplace". */
export function playbookSources(r: any): string {
  const order = ["project", "installed", "account", "marketplace"]
  const have: string[] = Array.isArray(r?.sources) ? r.sources : []
  return order.filter((s) => have.includes(s)).join(" · ")
}

/** The strip's accessible name: "4 steps: Runs on its own, IRIS thinks, …". */
export function stripLabel(steps: FlowStep[]): string {
  if (steps.length === 0) return "Steps not published"
  return `${steps.length} step${steps.length === 1 ? "" : "s"}: ${steps.map((s) => WHO_LABEL[s.who]).join(", ")}`
}

/**
 * The document a person reads: the playbook's markdown WITHOUT its leading YAML settings block.
 * Rendered as markdown, that block came out as one run-on paragraph — "name: … description: …
 * allowed-tools:" and a bullet list of tool names — above the actual document. Its values are
 * already on the Info tab; the raw block stays on the JSON tab and in the file.
 */
export function playbookDocBody(content: string): string {
  const m = /^﻿?---[ \t]*\r?\n[\s\S]*?\r?\n---[ \t]*(\r?\n|$)/.exec(content ?? "")
  return m ? content.slice(m[0].length).replace(/^\s*\n/, "") : (content ?? "")
}
