import { cmd } from "./cmd"
import { UI } from "../ui"
import { dim, bold, highlight, printDivider } from "./iris-api"
import { readFileSync, existsSync } from "fs"
import { join } from "path"

// EMBEDDED at build time. This import is the only reason `iris find` works in a shipped
// binary: `bun build --compile` bundles JS and static imports, but it does NOT carry along
// files that are merely read with fs at runtime. The first release of this command loaded
// the index purely by path, which worked in dev (`bun run src/index.ts` reads the real file
// off disk) and failed on EVERY installed binary with "capability index not found" — the
// index shipped nowhere, and dev was the one surface that could never expose it.
// ~870KB of JSON against a ~100MB binary, to make the discovery layer actually reachable.
import embeddedIndex from "../../../capabilities.json"

/**
 * `iris find <intent>` — the entry point for "what can IRIS do about X".
 *
 * THE PROBLEM IT SOLVES. IRIS has 1,333 discoverable capabilities across commands,
 * how-tos, playbooks and skills. What an agent could previously discover was a hand-typed
 * list of 15, and an `iris_help` that matched four exact keys before falling through to a
 * generic overview. So "build a Genesis bespoke HTML page" was unanswerable — even though
 * the answer existed three times over as a how-to, a playbook and a skill.
 *
 * The gap is VOCABULARY, not indexing. People and agents arrive with an intent ("a branded
 * HTML page", "an artifact") while the CLI is organised by internal nouns ("bespoke",
 * "Genesis", "bloq"), and the two share no words. So the index carries an explicit
 * intent→noun map alongside the derived entries.
 *
 * Reads capabilities.json, which is GENERATED from the live command tree and the content
 * directories. A curated catalog cannot survive this surface area — it had already drifted
 * to 15 of 120 before anyone noticed.
 */

type Entry = {
  kind: "command" | "how-to" | "playbook" | "skill"
  name: string
  describe: string
  aliases: string[]
  run: string
  haystack: string
}

type Index = {
  counts: Record<string, number>
  terms: Record<string, string[]>
  entries: Entry[]
}

/**
 * Prefer a file on disk, fall back to the embedded copy.
 *
 * On-disk wins so a developer who regenerates the index sees the change immediately without
 * a rebuild. In a compiled binary these paths resolve inside bunfs and simply do not exist,
 * so every installed CLI transparently uses the embedded index — which is the case that was
 * broken before and is the one nearly every caller is in.
 *
 * `process.cwd()` is deliberately NOT a candidate: any directory containing an unrelated
 * `capabilities.json` would silently take over the search results.
 */
function loadIndex(): Index {
  for (const p of [
    join(import.meta.dir, "../../../capabilities.json"),
    join(import.meta.dir, "../../../../capabilities.json"),
  ]) {
    try {
      if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8"))
    } catch {
      // A malformed dev file must not take the command down — the embedded index is valid
      // by construction, so falling through always leaves `find` working.
    }
  }
  return embeddedIndex as Index
}

const KIND_LABEL: Record<string, string> = {
  command: "cmd",
  "how-to": "how-to",
  playbook: "play",
  skill: "skill",
}

/**
 * Score an entry against the query terms.
 *
 * Weighted so an EXACT capability name always outranks an incidental body mention —
 * searching "pages" must surface the `pages` command, not the twelve playbooks that
 * happen to say the word.
 */
function score(e: Entry, terms: string[], raw: string, rarity: Map<string, number>): number {
  let s = 0
  const name = e.name.toLowerCase()

  if (name === raw) s += 100
  if (e.aliases.some((a) => a.toLowerCase() === raw)) s += 90
  if (name.startsWith(raw)) s += 40

  for (const t of terms) {
    if (!t) continue
    if (name === t) s += 50
    else if (name.split(/[\s:-]/).includes(t)) s += 30
    else if (name.includes(t)) s += 15
    if (e.describe.toLowerCase().includes(t)) s += 10
    // Body hits weighted by RARITY. A flat score here meant "SiteFooter" — which appears in
    // exactly one guide and is the whole reason someone is searching — counted the same as
    // "error", which appears in hundreds. So the query "SiteFooter validation error" ranked
    // the generic `pages` docs above the one page that actually explains SiteFooter.
    // A term found in few places is far more discriminating than one found everywhere.
    if (e.haystack.includes(t)) s += rarity.get(t) ?? 3
  }

  // NOTHING MATCHED MEANS NOTHING MATCHED (#180505).
  //
  // The kind bonus below is a TIE-BREAK between entries that already matched, never a reason
  // to appear. Adding it unconditionally gave every how-to a score of 6 on ANY query, so a
  // query with no hits still returned twelve of them — sorted alphabetically, formatted
  // identically to real results, under the heading "12 capabilities". The handler's
  // "nothing matched" branch was unreachable, and `iris find zzqqxx` was indistinguishable
  // from `iris find newsroom` when the newsroom recipe genuinely did not exist.
  //
  // That matters more for agents than for people: an agent reads twelve confident rows and
  // concludes the capability exists, then routes to the closest wrong one.
  if (s === 0) return 0

  // A how-to or playbook is usually the better answer to an intent-shaped question than a
  // bare command: it explains the terminology and the order of operations, which is exactly
  // what someone who had to search does not yet have.
  if (e.kind === "how-to" || e.kind === "playbook") s += 6
  if (e.kind === "skill") s += 4

  return s
}

export const PlatformFindCommand = cmd({
  command: "find [query..]",
  aliases: ["search-commands", "capabilities", "what-can-i"],
  describe: "find any IRIS capability by intent — searches commands, how-tos, playbooks and skills",
  builder: (y) =>
    y
      .positional("query", { describe: "what you are trying to do", type: "string", array: true })
      .option("kind", {
        describe: "restrict to one kind",
        type: "string",
        choices: ["command", "how-to", "playbook", "skill"],
      })
      .option("limit", { describe: "max results", type: "number", default: 12 })
      .option("json", { describe: "JSON output (for agents)", type: "boolean", default: false }),

  async handler(args) {
    // Always resolves — the index is embedded, so there is no "unavailable" path to handle.
    const index = loadIndex()

    const raw = ((args.query as string[]) ?? []).join(" ").trim().toLowerCase()

    // No query: show the map rather than nothing. Someone typing bare `iris find` is asking
    // "what is there", and an empty prompt is a worse answer than an overview.
    if (!raw) {
      if (args.json) {
        console.log(JSON.stringify({ counts: index.counts, terms: index.terms }, null, 2))
        return
      }
      UI.empty()
      console.log(`  ${bold("IRIS capability map")}`)
      printDivider()
      for (const [k, v] of Object.entries(index.counts)) {
        if (k === "total") continue
        console.log(`  ${String(v).padStart(5)}  ${k}`)
      }
      console.log(`  ${dim("─────")}`)
      console.log(`  ${String(index.counts.total).padStart(5)}  ${bold("total")}`)
      printDivider()
      console.log(`  ${dim("search by what you want to DO:")}`)
      console.log(`    ${highlight('iris find "branded html page"')}`)
      console.log(`    ${highlight('iris find "connect an integration"')}`)
      console.log(`    ${highlight("iris find obsidian --kind=command")}`)
      UI.empty()
      return
    }

    const terms = raw.split(/\s+/).filter((t) => t.length > 1)

    // Expand the query through the terminology map, so intent words reach internal nouns.
    // This is the part that makes "artifact" find `bespoke`.
    const expanded = new Set(terms)
    for (const [noun, synonyms] of Object.entries(index.terms)) {
      if (synonyms.some((s) => raw.includes(s)) || terms.includes(noun)) {
        expanded.add(noun)
        for (const s of synonyms) for (const w of s.split(/\s+/)) expanded.add(w)
      }
    }

    let pool = index.entries
    if (args.kind) pool = pool.filter((e) => e.kind === args.kind)

    // How rare is each query term across the whole index? Cheap to compute (1,300 entries
    // x a handful of terms) and it is what lets a distinctive word beat a common one.
    const rarity = new Map<string, number>()
    for (const t of expanded) {
      const df = index.entries.reduce((n, e) => n + (e.haystack.includes(t) ? 1 : 0), 0)
      // 1 doc -> ~28pts, 10 -> ~18, 100 -> ~9, everywhere -> ~2. Floored so a common term
      // still counts for something; a word the user typed is never worth zero.
      const total = index.entries.length
      rarity.set(t, df === 0 ? 0 : Math.max(2, Math.round(12 * Math.log10(total / df))))
    }

    const hits = pool
      .map((e) => ({ e, s: score(e, [...expanded], raw, rarity) }))
      .filter((h) => h.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, Math.max(1, Number(args.limit) || 12))

    if (args.json) {
      console.log(JSON.stringify(
        { query: raw, matched: hits.length, results: hits.map((h) => ({ ...h.e, haystack: undefined, score: h.s })) },
        null, 2,
      ))
      return
    }

    UI.empty()
    if (!hits.length) {
      console.log(`  ${dim(`nothing matched "${raw}"`)}`)
      console.log(`  ${dim("try a broader word, or browse:")} ${highlight("iris find")}`)
      UI.empty()
      process.exitCode = 1
      return
    }

    console.log(`  ${bold(`${hits.length} capabilit${hits.length === 1 ? "y" : "ies"}`)} ${dim(`for "${raw}"`)}`)
    printDivider()
    for (const { e } of hits) {
      const tag = dim(`[${KIND_LABEL[e.kind] ?? e.kind}]`.padEnd(9))
      console.log(`  ${tag} ${bold(e.name)}`)
      if (e.describe) console.log(`  ${" ".repeat(9)} ${dim(e.describe.slice(0, 96))}`)
      console.log(`  ${" ".repeat(9)} ${highlight(e.run)}`)
    }
    printDivider()
    console.log(`  ${dim("machine-readable:")} ${highlight(`iris find "${raw}" --json`)}`)
    UI.empty()
  },
})
