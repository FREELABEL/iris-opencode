#!/usr/bin/env bun
/**
 * Generate the capability index — the map an agent uses to find anything IRIS can do.
 *
 * WHY THIS EXISTS
 * ---------------
 * IRIS has ~224 discrete capabilities: 120 top-level commands, 21 how-to recipes, 41
 * playbooks and 42 skills. What an agent could actually discover was a HAND-TYPED list of
 * 15 entries in a PHP heredoc, and an `iris_help` that matched exactly four keys
 * (leads/pages/agents/bloqs) before falling through to a generic overview.
 *
 * So the literal question "build a Genesis bespoke HTML page" was unanswerable, even though
 * the answer existed THREE times over — `iris how-to bespoke`, `iris playbook run bespoke`,
 * and a bespoke skill. The knowledge was there; the path from intent to it was not.
 *
 * A curated catalog cannot survive 224 entries. It had already drifted to 15 of 120. So this
 * DERIVES the index from what exists rather than describing it, and `capabilities:check`
 * fails CI when something is missing — new capabilities become discoverable by default
 * instead of when someone remembers.
 *
 *   bun run script/build-capabilities.ts            # writes capabilities.json
 *   bun run script/build-capabilities.ts --check    # exits 1 if stale (CI)
 */

import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from "fs"
import { join, dirname, basename } from "path"
import { homedir } from "os"

const ROOT = join(import.meta.dir, "..")
const OUT = join(ROOT, "capabilities.json")
const PROJECT = process.env.IRIS_PROJECT_ROOT || join(homedir(), "sites/freelabel")

type Entry = {
  kind: "command" | "how-to" | "playbook" | "skill"
  name: string
  describe: string
  aliases: string[]
  /** The exact thing to run. An index that tells you a capability exists but not how to
   *  invoke it has moved the problem rather than solved it. */
  run: string
  /** Free-text blob that search matches against. */
  haystack: string
}

// ── commands ────────────────────────────────────────────────────────────────
//
// Parsed STATICALLY from the cmd({...}) blocks rather than by booting yargs: importing
// every command file pulls in the whole CLI (and its side effects) just to read three
// strings, and a generator that can crash on an unrelated import is a generator nobody runs.
function collectCommands(): Entry[] {
  const dir = join(ROOT, "src/cli/cmd")
  const out: Entry[] = []

  // The AUTHORITATIVE top-level list is what index.ts actually registers. A first attempt
  // scraped every cmd({...}) block in the tree and produced 1299 "commands" — including 110
  // separate entries called `list`, because every group has one. `iris list` is not a thing,
  // so an index full of them is worse than no index: it answers with commands that do not
  // exist. Subcommands are indexed too, but always qualified by their parent.
  const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf-8")
  const registered = new Set(
    [...indexSrc.matchAll(/\.command\((?:reg\()?([A-Za-z0-9_]+Command)/g)].map((m) => m[1]),
  )

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const src = readFileSync(join(dir, file), "utf-8")

    // Which exported consts in this file are top-level commands?
    const exported = [...src.matchAll(/export const ([A-Za-z0-9_]+Command)\s*=\s*cmd\(\{([\s\S]{0,900}?)\}\)/g)]

    for (const [, constName, body] of exported) {
      if (!registered.has(constName)) continue

      const command = body.match(/command:\s*"([^"]+)"/)?.[1]
      if (!command) continue
      const describe = body.match(/describe:\s*"([^"]*)"/)?.[1] ?? ""
      const aliasRaw = body.match(/aliases:\s*\[([^\]]*)\]/)?.[1] ?? ""
      const aliases = [...aliasRaw.matchAll(/"([^"]+)"/g)].map((m) => m[1])
      const name = command.split(/\s+/)[0]
      if (name === "*" || name === "$0") continue // yargs internals, not capabilities

      // Subcommands of THIS group, qualified so the `run` string is executable as written.
      const subs: string[] = []
      for (const b of src.matchAll(/cmd\(\{([\s\S]{0,600}?)\}\)/g)) {
        const sc = b[1].match(/command:\s*"([^"]+)"/)?.[1]
        if (!sc) continue
        const sn = sc.split(/\s+/)[0]
        if (sn === name || sn === "*" || sn === "$0") continue
        const sd = b[1].match(/describe:\s*"([^"]*)"/)?.[1] ?? ""
        subs.push(sn)
        out.push({
          kind: "command",
          name: `${name} ${sn}`,
          describe: sd,
          aliases: [],
          run: `iris ${name} ${sc}`,
          haystack: [name, sn, sd, describe].join(" ").toLowerCase(),
        })
      }

      out.push({
        kind: "command",
        name,
        describe,
        aliases,
        run: `iris ${command}`,
        // Subcommand names go in the parent's haystack too, so searching "publish" finds
        // `pages` even when the user does not know it is a subcommand.
        haystack: [name, ...aliases, describe, command, ...subs].join(" ").toLowerCase(),
      })
    }
  }
  return out
}

// ── markdown-backed sources (how-to, playbooks, skills) ─────────────────────
function frontmatter(src: string): Record<string, string> {
  if (!src.startsWith("---")) return {}
  const end = src.indexOf("\n---", 3)
  if (end === -1) return {}
  const out: Record<string, string> = {}
  for (const line of src.slice(3, end).split("\n")) {
    const m = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/)
    if (m) out[m[1]] = m[2].trim().replace(/^["']|["']$/g, "")
  }
  return out
}

function collectMarkdown(
  dir: string,
  kind: Entry["kind"],
  run: (name: string) => string,
): Entry[] {
  if (!existsSync(dir)) return []
  const out: Entry[] = []

  for (const item of readdirSync(dir)) {
    // Skills are directories with a SKILL.md; how-tos are flat .md files.
    let file: string, name: string
    const full = join(dir, item)
    if (statSync(full).isDirectory()) {
      const candidates = ["SKILL.md", "PLAYBOOK.md", "skill.md", "playbook.md", `${item}.md`, "README.md"]
      const found = candidates.map((c) => join(full, c)).find((p) => existsSync(p))
      if (!found) continue
      file = found
      name = item
    } else {
      if (!item.endsWith(".md")) continue
      file = full
      name = basename(item, ".md")
    }
    if (name.toLowerCase() === "readme") continue

    const src = readFileSync(file, "utf-8")
    const fm = frontmatter(src)
    const describe = fm.description ?? src.match(/^#\s+(.+)$/m)?.[1] ?? ""

    out.push({
      kind,
      name: fm.name ?? name,
      describe,
      aliases: [],
      run: run(fm.name ?? name),
      // Include a slice of BODY text: the words someone searches for ("custom HTML",
      // "artifact") usually appear in prose, not in a title.
      haystack: [name, describe, src.slice(0, 4000)].join(" ").toLowerCase(),
    })
  }
  return out
}

/**
 * Intent → internal noun.
 *
 * THE ACTUAL GAP. Agents and humans arrive with an INTENT ("a branded HTML page", "an
 * artifact") and the CLI is organised by internal nouns ("bespoke", "Genesis", "bloq").
 * No amount of indexing bridges that, because the two vocabularies share no words — so
 * the mapping has to be stated. Every entry here was a real dead end.
 */
const TERMS: Record<string, string[]> = {
  bespoke: ["custom html", "hand-designed page", "artifact", "branded page", "one-pager", "landing page", "report page", "custom css"],
  pages: ["genesis", "page builder", "composable page", "publish a page", "web page", "site"],
  bloqs: ["board", "kanban", "list", "project", "workspace", "notes"],
  leads: ["crm", "contacts", "prospects", "pipeline"],
  agents: ["ai agent", "assistant", "bot"],
  hive: ["compute node", "distributed", "remote machine", "fleet", "daemon"],
  "data-sources": ["obsidian", "imessage", "apple mail", "calendar", "local data", "bridge"],
  integrations: ["oauth", "connect", "composio", "third party", "api key"],
  playbook: ["workflow", "recipe", "automation", "runbook"],
  "how-to": ["guide", "tutorial", "documentation", "docs", "instructions"],
  memory: ["remember", "recall", "knowledge base", "rag"],
  bug: ["issue", "report a problem", "defect", "ticket"],
}

const entries: Entry[] = [
  ...collectCommands(),
  ...collectMarkdown(join(homedir(), ".iris/how-to"), "how-to", (n) => `iris how-to ${n}`),
  // Project content lives in the workspace, not in this package. IRIS_PROJECT_ROOT lets CI
  // and the generator agree on where that is; the default is the repo this CLI ships beside.
  ...collectMarkdown(join(PROJECT, ".iris/playbooks"), "playbook", (n) => `iris playbook run ${n}`),
  ...collectMarkdown(join(PROJECT, ".claude/skills"), "skill", (n) => `iris playbook run ${n}`),
]

// Fold the terminology into each entry's haystack so an intent search reaches it.
for (const e of entries) {
  const syn = TERMS[e.name]
  if (syn) e.haystack += " " + syn.join(" ")
}

const index = {
  generated_note: "GENERATED by script/build-capabilities.ts — do not edit by hand. Run `bun run capabilities` to refresh.",
  counts: {
    command: entries.filter((e) => e.kind === "command").length,
    "how-to": entries.filter((e) => e.kind === "how-to").length,
    playbook: entries.filter((e) => e.kind === "playbook").length,
    skill: entries.filter((e) => e.kind === "skill").length,
    total: entries.length,
  },
  terms: TERMS,
  entries: entries.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name)),
}

const json = JSON.stringify(index, null, 2) + "\n"

if (process.argv.includes("--check")) {
  // DRIFT GUARD. Compares only the capability SET, not the whole file — timestamps and
  // ordering noise would make this fail for reasons nobody can act on, and a check that
  // cries wolf gets disabled.
  if (!existsSync(OUT)) {
    console.error("capabilities.json is missing — run: bun run capabilities")
    process.exit(1)
  }
  const prev = JSON.parse(readFileSync(OUT, "utf-8"))
  const key = (e: any) => `${e.kind}:${e.name}`
  const before = new Set<string>(((prev.entries ?? []) as any[]).map(key))
  const after = new Set<string>(entries.map(key))
  const added = [...after].filter((k) => !before.has(k))
  const removed = [...before].filter((k) => !after.has(k))

  if (added.length || removed.length) {
    console.error("capabilities.json is STALE — agents cannot discover what is not indexed.\n")
    if (added.length) console.error(`  missing from the index (${added.length}):\n    ${added.slice(0, 20).join("\n    ")}`)
    if (removed.length) console.error(`  indexed but gone (${removed.length}):\n    ${removed.slice(0, 20).join("\n    ")}`)
    console.error("\n  fix: bun run capabilities")
    process.exit(1)
  }
  console.log(`capabilities.json is current — ${entries.length} capabilities indexed.`)
  process.exit(0)
}

writeFileSync(OUT, json)
console.log(
  `wrote ${OUT}\n  ${index.counts.command} commands · ${index.counts["how-to"]} how-tos · ` +
  `${index.counts.playbook} playbooks · ${index.counts.skill} skills = ${index.counts.total} capabilities`,
)
