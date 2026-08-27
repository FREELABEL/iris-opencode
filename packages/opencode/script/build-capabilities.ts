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
import { execSync } from "child_process"

const ROOT = join(import.meta.dir, "..")
const OUT = join(ROOT, "capabilities.json")
const PROJECT = process.env.IRIS_PROJECT_ROOT || join(homedir(), "sites/freelabel")

/**
 * How-to recipes: prefer the REPO, fall back to the installed copy.
 *
 * This used to read only ~/.iris/how-to — the INSTALLED directory. That made the shipped
 * capability index depend on whatever the person running the build happened to have
 * installed locally: a recipe added in this repo was invisible to `iris find` until someone
 * installed it first, and a stale local install could ship entries for recipes that no
 * longer exist. Neither failure is visible in the output.
 *
 * scaffold/how-to is what the installer actually distributes, so it is the source of truth.
 * The ~/.iris fallback keeps this working when the script is run outside a repo checkout.
 */
const REPO_HOWTO = join(ROOT, "..", "..", "scaffold", "how-to")
const INSTALLED_HOWTO = join(homedir(), ".iris/how-to")
const HOWTO_DIR = existsSync(REPO_HOWTO) ? REPO_HOWTO : INSTALLED_HOWTO

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

/** The source text of one `cmd({ ... })` block, brace-matched. */
type Block = { command: string; describe: string; aliases: string[]; body: string; file: string }

/**
 * Extract the block starting at the `{` of `cmd({`. Brace-matched rather than
 * length-capped: an earlier version read a fixed 900 chars, which silently truncated any
 * group whose builder chain was longer than that — and the longest chains belong to the
 * biggest command groups, i.e. exactly the ones worth indexing.
 */
function readBlock(src: string, openIdx: number): string | null {
  let depth = 0
  for (let i = openIdx; i < src.length; i++) {
    const c = src[i]
    if (c === "{") depth++
    else if (c === "}") {
      depth--
      if (depth === 0) return src.slice(openIdx, i + 1)
    }
  }
  return null
}

/** qualified entry key -> absolute path of the file that defines it. */
const COMMAND_SOURCE = new Map<string, string>()

/**
 * Every `const X = cmd({...})` in the tree, keyed by const name — and there are
 * DUPLICATES, which is why this is a list rather than one block per name.
 *
 * 49 const names are defined in more than one file: `ListCommand` in 25 of them,
 * `CreateCommand` in 11, `StatusCommand` in 7. Keyed by bare name, the last file the
 * directory scan happened to reach won, and the index then described somebody else's
 * command: `automation create` was published as "create a new event" (platform-events.ts)
 * and `automation status` as "show the status of a sync/ingestion job" with the wrong
 * positional, `<jobId>` instead of `<runId>`. Agents discover commands through this file,
 * so a wrong describe is not cosmetic — it is a confident wrong answer.
 *
 * The same collision fed the staleness check: it asked which file defines `mint audit`,
 * was told platform-events.ts, found that file clean, and blocked a push over work that
 * only exists in an uncommitted platform-mint.ts.
 */
type BlockIndex = { byName: Map<string, Block[]>; imports: Map<string, Map<string, string>> }

function collectBlocks(dir: string): BlockIndex {
  const byName = new Map<string, Block[]>()
  // file -> (imported const name -> file that exports it). Resolving a child through the
  // parent's own import statement is the only answer that is right by construction; a
  // child genuinely does live in another file (PlaybookDraftCommand does).
  const imports = new Map<string, Map<string, string>>()
  const aliasPairs: Array<[string, string]> = []

  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue
    const abs = join(dir, file)
    const src = readFileSync(abs, "utf-8")

    const fileImports = new Map<string, string>()
    for (const m of src.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/([A-Za-z0-9._-]+)"/g)) {
      const target = join(dir, m[2].endsWith(".ts") ? m[2] : `${m[2]}.ts`)
      for (const raw of m[1].split(",")) {
        const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) fileImports.set(name, target)
      }
    }
    imports.set(abs, fileImports)

    // `cmd({...})` is the plain shape; `productCommand({...})` is the product front-door
    // shape (#181888), which spells the same two fields `name:` and `purpose:`. Matching
    // only `cmd(` silently dropped the first product built on the new helper from the
    // index — the command resolved for a human typing `iris lexicon` and did not exist
    // for any agent reading capabilities.json, which is the worse of the two failures.
    for (const m of src.matchAll(/(?:export\s+)?const ([A-Za-z0-9_]+(?:Command|Group))\s*=\s*(?:cmd|productCommand)\(\s*\{/g)) {
      const openIdx = m.index! + m[0].length - 1
      const body = readBlock(src, openIdx)
      if (!body) continue
      const command = body.match(/command:\s*"([^"]+)"/)?.[1] ?? body.match(/\bname:\s*"([^"]+)"/)?.[1]
      if (!command) continue
      const aliasRaw = body.match(/aliases:\s*\[([^\]]*)\]/)?.[1] ?? ""
      const block: Block = {
        command,
        describe: body.match(/describe:\s*"([^"]*)"/)?.[1] ?? body.match(/purpose:\s*"([^"]*)"/)?.[1] ?? "",
        aliases: [...aliasRaw.matchAll(/"([^"]+)"/g)].map((a) => a[1]),
        body,
        file: abs,
      }
      const list = byName.get(m[1]) ?? []
      list.push(block)
      byName.set(m[1], list)
    }

    // Re-export aliases: `export const PlatformHeartbeatCommand = HeartbeatCommand`.
    // index.ts registers the EXPORTED name, while the cmd({...}) block is keyed by the
    // original — so the walker looked up a name it had never collected and silently
    // skipped the command. `iris heartbeat` is a top-level product and was missing from
    // the index entirely because of this one line, with nothing anywhere reporting a gap.
    aliasPairs.push(...[...src.matchAll(/export\s+const\s+([A-Za-z0-9_]+(?:Command|Group))\s*=\s*([A-Za-z0-9_]+(?:Command|Group))\s*$/gm)].map((m) => [m[1], m[2]] as [string, string]))
  }

  // Resolve after every file is scanned — an alias may point at a block defined later.
  for (const [alias, target] of aliasPairs) {
    if (byName.has(alias)) continue
    const blocks = byName.get(target)
    if (blocks) byName.set(alias, blocks)
  }

  return { byName, imports }
}

/**
 * Which of the same-named blocks did THIS parent mean?
 *
 * Same file, then the file the parent imports it from, then a globally unique match.
 * Anything left is genuinely ambiguous and returns nothing rather than a coin flip —
 * an unindexed command is a gap, an misindexed one is a lie.
 */
function resolveBlock(index: BlockIndex, constName: string, fromFile: string | null): Block | undefined {
  const candidates = index.byName.get(constName)
  if (!candidates || candidates.length === 0) return undefined
  if (candidates.length === 1) return candidates[0]

  if (fromFile) {
    const here = candidates.find((c) => c.file === fromFile)
    if (here) return here

    const imported = index.imports.get(fromFile)?.get(constName)
    if (imported) {
      const viaImport = candidates.find((c) => c.file === imported)
      if (viaImport) return viaImport
    }
  }

  return undefined
}

function collectCommands(): Entry[] {
  const dir = join(ROOT, "src/cli/cmd")
  const out: Entry[] = []
  const blocks = collectBlocks(dir)

  // The AUTHORITATIVE top-level list is what index.ts actually registers. A first attempt
  // scraped every cmd({...}) block in the tree and produced 1299 "commands" — including 110
  // separate entries called `list`, because every group has one. `iris list` is not a thing,
  // so an index full of them is worse than no index: it answers with commands that do not
  // exist.
  const indexFile = join(ROOT, "src/index.ts")
  const indexSrc = readFileSync(indexFile, "utf-8")
  const registered = [...indexSrc.matchAll(/\.command\((?:reg\()?([A-Za-z0-9_]+Command)/g)].map((m) => m[1])

  // index.ts lives outside src/cli/cmd, so its imports are not in the map yet — and it is
  // the parent of every top-level verb, i.e. the one file whose resolution matters most.
  const indexImports = new Map<string, string>()
  for (const m of indexSrc.matchAll(/import\s*\{([^}]*)\}\s*from\s*"\.\/cli\/cmd\/([A-Za-z0-9._-]+)"/g)) {
    const target = join(dir, m[2].endsWith(".ts") ? m[2] : `${m[2]}.ts`)
    for (const raw of m[1].split(",")) {
      const name = raw.trim().split(/\s+as\s+/).pop()?.trim()
      if (name) indexImports.set(name, target)
    }
  }
  blocks.imports.set(indexFile, indexImports)

  /**
   * Walk the REAL builder tree — each group declares its children as `.command(XCommand)`.
   *
   * The flat per-file scan this replaces attributed every `cmd({...})` in a file to that
   * file's top-level command, which collapsed nesting: `discover promos list` and
   * `discover sponsors list` both became "discover list", 9 times over, advertising
   * `iris discover list` — a command that does not exist. Same defect as the phantom
   * top-level `list` entries, one level down and less visible.
   *
   * `seen` is per-path, so a command reachable from two groups is indexed under both, while
   * a cycle still terminates.
   */
  function walk(constName: string, prefix: string[], seen: Set<string>, depth: number, fromFile: string | null): string[] {
    const b = resolveBlock(blocks, constName, fromFile)
    if (!b || depth > 4 || seen.has(`${b.file}::${constName}`)) return []

    const token = b.command.split(/\s+/)[0]
    if (token === "*" || token === "$0") return [] // yargs internals, not capabilities

    const path = [...prefix, token]
    const rest = b.command.slice(token.length).trim()
    const nextSeen = new Set(seen).add(`${b.file}::${constName}`)

    // Direct children only — those named in THIS block's builder.
    const childNames = [...b.body.matchAll(/\.command\((?:reg\()?([A-Za-z0-9_]+(?:Command|Group))/g)].map((m) => m[1])
    const childTokens: string[] = []
    for (const child of childNames) {
      childTokens.push(...walk(child, path, nextSeen, depth + 1, b.file))
    }

    // Where this command is DEFINED. The check uses it to tell a command that is missing
    // from the index because someone has not regenerated (its file is committed — real
    // drift) from one that is missing because it does not exist outside a colleague's
    // uncommitted working tree (its file is dirty — not yours to index).
    COMMAND_SOURCE.set(`command:${path.join(" ")}`, b.file)

    // OPTION names and their describe text.
    //
    // Without this the index knows what a command is CALLED but not what it can DO, and
    // the difference is not academic: `atlas:item make-public` carries --allowed-emails
    // and --allowed-domains, whose entire purpose is gating a shared link to named people.
    // Searching "gate", "allowed emails" or "restrict who can read" returned NOTHING across
    // all 1518 capabilities, because the only place that language exists is an option
    // description — and the haystack was built from the command name, its aliases and its
    // one-line describe. A capability nobody can find is one nobody uses; this is the same
    // failure as a command that is registered but unreachable, one layer up.
    const optionTokens: string[] = []
    for (const m of b.body.matchAll(/\.option\(\s*["'`]([A-Za-z0-9_-]+)["'`]\s*,\s*\{([\s\S]{0,400}?)\}\s*\)/g)) {
      optionTokens.push(m[1])
      const d = m[2].match(/describ(?:e|tion)\s*:\s*["'`]([^"'`]+)["'`]/)
      if (d) optionTokens.push(d[1])
    }

    out.push({
      kind: "command",
      name: path.join(" "),
      describe: b.describe,
      aliases: prefix.length ? [] : b.aliases,
      // Fully qualified, so the string is executable exactly as printed.
      run: `iris ${path.join(" ")}${rest ? " " + rest : ""}`,
      // Descendant tokens go in the haystack too, so searching "publish" finds `pages`
      // even when the user does not know it is a subcommand.
      haystack: [...path, ...b.aliases, b.describe, ...childTokens, ...optionTokens]
        .join(" ")
        .toLowerCase(),
    })

    return [token, ...childTokens]
  }

  for (const constName of registered) walk(constName, [], new Set(), 0, indexFile)

  // A command reachable by two routes can still yield the same qualified name twice; keep
  // the richest description rather than emitting a visibly duplicated row.
  const byName = new Map<string, Entry>()
  for (const e of out) {
    const prev = byName.get(e.name)
    if (!prev || (e.describe?.length ?? 0) > (prev.describe?.length ?? 0)) byName.set(e.name, e)
  }
  return [...byName.values()]
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
  // A published note reads at /n/<uuid> and `atlas use` is the ONLY verb that returns its
  // text — but its own words ("pull a shared Atlas item's context") share nothing with how
  // anyone asks for it. Every phrasing below returned zero hits for `atlas use` on 2026-08-27,
  // which is how a five-step curl + HTML-scrape gets reinvented for a one-command job.
  "atlas use": [
    "read a note",
    "note text",
    "published note",
    "read a published page as text",
    "note markdown",
    "note content",
    "shared item",
    "public url text",
    "scrape a note",
    "extract text",
  ],
}

const entries: Entry[] = [
  ...collectCommands(),
  ...collectMarkdown(HOWTO_DIR, "how-to", (n) => `iris how-to ${n}`),
  // Project content lives in the workspace, not in this package. IRIS_PROJECT_ROOT lets CI
  // and the generator agree on where that is; the default is the repo this CLI ships beside.
  ...collectMarkdown(join(PROJECT, ".iris/playbooks"), "playbook", (n) => `iris playbook run ${n}`),
  ...collectMarkdown(join(PROJECT, ".claude/skills"), "skill", (n) => `iris playbook run ${n}`),
]

/**
 * WORKSPACE-SOURCED ENTRIES ARE ADDITIVE. A missing playbook means "not on THIS machine".
 *
 * Commands and how-tos live in this repo, so their absence is a deletion and pruning them is
 * correct. Playbooks and skills live in the WORKSPACE repo, and every machine has a different
 * slice of it — so regenerating here compares a partial view against a complete index and
 * writes the difference as removals.
 *
 * That is not hypothetical. Regenerating on a checkout without the legal-*, xart-exhibit-deck,
 * client-host-doctor and v6-workflows content dropped SEVENTEEN real capabilities out of the
 * index on main, silently, inside an ordinary `bun run capabilities`. They are real on another
 * machine; they were unindexed for everyone.
 *
 * So the generator can now ADD workspace entries and never silently REMOVE them. Deleting one
 * for real is `--prune`, which is the moment you assert your workspace is complete — an
 * explicit claim rather than an accident of which laptop ran the script.
 */
const PRUNE = process.argv.includes("--prune")

if (!PRUNE && !process.argv.includes("--check") && existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, "utf-8"))
    const key = (e: any) => `${e.kind}:${e.name}`
    const found = new Set(entries.map(key))
    const kept = ((prev.entries ?? []) as any[]).filter(
      (e) => (e.kind === "playbook" || e.kind === "skill") && !found.has(key(e)),
    )
    if (kept.length) {
      entries.push(...kept)
      console.warn(
        `note: kept ${kept.length} playbook/skill entr${kept.length === 1 ? "y" : "ies"} whose source is not in this ` +
          `workspace — they belong to a machine that has it.\n` +
          `      ${kept.map(key).slice(0, 8).join(", ")}${kept.length > 8 ? `, …${kept.length - 8} more` : ""}\n` +
          `      Run with --prune only if this workspace is COMPLETE and you mean to delete them.`,
      )
    }
  } catch {
    // An unreadable previous index must not stop a regeneration; it just cannot be preserved.
  }
}

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

  // ONLY COMPARE WHAT THIS CHECKOUT CAN SEE.
  //
  // Playbooks and skills live in the WORKSPACE repo, not in this package, and collectMarkdown
  // returns [] for a directory that is not there. On a CI runner that checks out only
  // iris-opencode, every one of them therefore reads as "indexed but gone" — 83 phantom
  // deletions — and the check can never pass no matter what anyone commits.
  //
  // Nobody had noticed because the workflow was never actually executing (#180527); the first
  // real run failed on this. The pre-push hook has always guarded it with a directory test.
  // Now the generator does, so the answer does not depend on which harness invoked it.
  const projectAvailable =
    existsSync(join(PROJECT, ".iris/playbooks")) || existsSync(join(PROJECT, ".claude/skills"))
  const comparable = (k: string) => projectAvailable || (k !== "playbook" && k !== "skill")

  const before = new Set<string>(
    ((prev.entries ?? []) as any[]).filter((e) => comparable(e.kind)).map(key),
  )
  const after = new Set<string>(entries.filter((e) => comparable(e.kind)).map(key))

  if (!projectAvailable) {
    // Say what was NOT checked. A narrowed check that does not announce its narrowing reads as
    // full coverage, which is the failure this whole guard exists to avoid.
    const skipped = ((prev.entries ?? []) as any[]).filter((e) => !comparable(e.kind)).length
    console.warn(
      `note: workspace content not present — ${skipped} playbook/skill entries were NOT checked.\n` +
        `      Set IRIS_PROJECT_ROOT to include them. Commands and how-tos are checked in full.`,
    )
  }
  const added = [...after].filter((k) => !before.has(k))
  const allRemoved = [...before].filter((k) => !after.has(k))

  // The SAME reasoning the generator applies, or the two disagree about the same file: a
  // playbook/skill that is absent here is absent from THIS WORKSPACE, not deleted. Blocking on
  // it makes the check unpassable on any machine holding a partial slice — which is every
  // machine — and an unpassable check is one people route around.
  //
  // Repo-sourced kinds are different: commands and how-tos live in this checkout, so their
  // absence IS a deletion and still blocks.
  const removed = allRemoved.filter((k) => !k.startsWith("playbook:") && !k.startsWith("skill:"))
  const workspaceMissing = allRemoved.filter((k) => k.startsWith("playbook:") || k.startsWith("skill:"))
  if (workspaceMissing.length) {
    console.warn(
      `note: ${workspaceMissing.length} indexed playbook/skill entr${workspaceMissing.length === 1 ? "y is" : "ies are"} ` +
        `not in this workspace — kept, because absence here is not deletion.\n` +
        `      ${workspaceMissing.slice(0, 6).join(", ")}${workspaceMissing.length > 6 ? `, …${workspaceMissing.length - 6} more` : ""}`,
    )
  }

  // IS THE TREE DIRTY? It changes what the drift means (#180517).
  //
  // This script derives the index from the WORKING TREE, but the thing being pushed is HEAD.
  // In a shared checkout those differ: agent A pushing a CLI fix was blocked because agent B
  // had an uncommitted command sitting in the tree, and the only way through was to commit an
  // index entry for a command that exists in nobody's HEAD — the index asserting a capability
  // that is not in the repository, which is the exact fault the guard exists to prevent.
  let dirty = false
  try {
    const status = execSync("git status --porcelain", {
      cwd: ROOT,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    })
    // Only sources this script actually reads can explain index drift. A dirty README cannot,
    // and treating it as an excuse would blunt the guard for no reason.
    dirty = status
      .split("\n")
      .some((l) => /\s(packages\/|scaffold\/)/.test(l) && !/capabilities\.json\s*$/.test(l))
  } catch {
    // Not a git checkout, or git unavailable — fall back to the strict behaviour.
  }

  // REMOVED is unambiguous either way: the index names something that no longer exists, and no
  // amount of uncommitted work explains that. ADDED on a dirty tree is ambiguous — it may be
  // your own unregenerated work, or it may be someone else's file you must not commit.
  // WHICH additions does a dirty tree actually excuse?
  //
  // Only the ones whose SOURCE is itself uncommitted. `iris atlas use` shipped unindexed
  // precisely because this exemption was all-or-nothing: its command was committed, but
  // some unrelated file in packages/ was dirty — and in a shared checkout something always
  // is — so the guard waved through drift that a COMMIT had introduced. The index then
  // decayed with the guard reporting success.
  //
  // A command whose defining file is clean exists in HEAD. Its absence from the index is
  // real, is yours to fix, and blocks.
  const dirtyFiles = new Set<string>()
  try {
    const status = execSync("git status --porcelain", { cwd: ROOT, encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] })
    for (const line of status.split("\n")) {
      const rel = line.slice(3).trim()
      if (rel) dirtyFiles.add(join(ROOT, "..", "..", rel))
    }
  } catch {
    // No git — treat every addition as ambiguous rather than inventing certainty.
  }
  const committedAdds = added.filter((k) => {
    const src = COMMAND_SOURCE.get(k)
    return !!src && !dirtyFiles.has(src)
  })

  if (removed.length || (added.length && !dirty) || committedAdds.length) {
    console.error("capabilities.json is STALE — agents cannot discover what is not indexed.\n")
    if (added.length) console.error(`  missing from the index (${added.length}):\n    ${added.slice(0, 20).join("\n    ")}`)
    if (committedAdds.length && dirty) {
      console.error(
        `\n  ${committedAdds.length} of these are COMMITTED — a dirty tree does not excuse them:\n    ` +
          committedAdds.slice(0, 20).join("\n    "),
      )
    }
    if (removed.length) console.error(`  indexed but gone (${removed.length}):\n    ${removed.slice(0, 20).join("\n    ")}`)
    console.error("\n  fix: bun run capabilities")
    process.exit(1)
  }

  if (added.length && dirty && !committedAdds.length) {
    console.warn(
      `capabilities.json is missing ${added.length} entr${added.length === 1 ? "y" : "ies"}, ` +
        `but the working tree is dirty — NOT blocking the push.\n` +
        `    ${added.slice(0, 10).join("\n    ")}\n` +
        `  If these are yours, commit the source and run: bun run capabilities\n` +
        `  If they belong to another agent, leave them — regenerating would commit an index\n` +
        `  entry for source that is not in the repository.`,
    )
    // NOT "current". The index really is missing entries; the push is allowed through because
    // the CAUSE is ambiguous, not because the drift is imaginary. Printing the success line here
    // would be a third contradictory signal in one output, which is the failure mode this whole
    // guard is meant to be an example of not doing.
    process.exit(0)
  }

  console.log(`capabilities.json is current — ${entries.length} capabilities indexed.`)
  process.exit(0)
}

writeFileSync(OUT, json)
console.log(
  `wrote ${OUT}\n  ${index.counts.command} commands · ${index.counts["how-to"]} how-tos · ` +
  `${index.counts.playbook} playbooks · ${index.counts.skill} skills = ${index.counts.total} capabilities`,
)
