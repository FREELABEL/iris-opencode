import { cmd } from "./cmd"
import { HowToBackupCommands } from "./howto-backup"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, highlight, printDivider, success } from "./iris-api"
import { homedir } from "os"
import { join, resolve } from "path"
import { existsSync, readdirSync, readFileSync } from "fs"
import { createHash } from "crypto"
import { irisFetch, IRIS_API } from "./iris-api"
import { Installation } from "../../installation"
import { firstArray } from "../../util/array"

const HOWTO_DIR = join(homedir(), ".iris", "how-to")

/** iris-api exports dim/bold/success/highlight but no warning; stranding needs to be loud. */
function warning(s: string): string {
  return `${UI.Style.TEXT_WARNING}${s}${UI.Style.TEXT_NORMAL}`
}

async function ensureDir() {
  const fs = await import("fs")
  if (!fs.existsSync(HOWTO_DIR)) {
    fs.mkdirSync(HOWTO_DIR, { recursive: true })
  }
}

/**
 * Remote fallback for recipes this machine does not have.
 *
 * `how-to` reads ~/.iris/how-to and nothing else, and the CLI ships NO recipes — a
 * fresh install has an empty directory (#181785). That was survivable while people
 * typed recipe names they already knew. It stopped being survivable when every
 * product's front door started advertising `iris how-to view <slug>` (#181888):
 * thirteen products now promise 2-4 recipes each, and on any machine but the one
 * that authored them all of it printed "not found".
 *
 * The recipes are already published and public at /api/v1/how-tos, so the promise
 * can simply be kept. Local still wins — this is a fallback, not a replacement, and
 * offline behaviour for recipes you DO have is unchanged.
 */
async function fetchRemoteRecipe(slug: string): Promise<string | null> {
  try {
    const res = await irisFetch(`/api/v1/how-tos/${encodeURIComponent(slug)}`, {}, IRIS_API)
    if (!res.ok) return null
    const body = (await res.json()) as any
    const rec = body?.data ?? body
    return typeof rec?.body_md === "string" && rec.body_md.trim() ? rec.body_md : null
  } catch {
    return null
  }
}

async function fetchRemoteRecipeList(): Promise<Array<{ name: string; title: string; meta: RecipeMeta; body: string }>> {
  try {
    const res = await irisFetch("/api/v1/how-tos?per_page=200", {}, IRIS_API)
    if (!res.ok) return []
    const body = (await res.json()) as any
    const rows: any[] = firstArray(body?.data)
    return rows.map((r) => ({
      name: String(r.slug ?? ""),
      title: String(r.title ?? r.slug ?? "").replace(/^How to:\s*/i, ""),
      meta: { category: r.category, level: r.level, tags: r.tags, duration_min: r.duration_min } as RecipeMeta,
      // Summary only — the list endpoint does not carry body_md, and pretending it
      // does would make search score against an empty string.
      body: String(r.summary ?? ""),
    }))
  } catch {
    return []
  }
}

type LocalRecipe = { name: string; title: string; path: string; meta: RecipeMeta; body: string }

async function listRecipes(): Promise<LocalRecipe[]> {
  const fs = await import("fs")
  await ensureDir()
  if (!fs.existsSync(HOWTO_DIR)) return []

  // README is documentation ABOUT the recipes, not a recipe — readRecipes() has always excluded
  // it and this path never did, so it has been showing up as a listable how-to.
  const files = fs
    .readdirSync(HOWTO_DIR)
    .filter((f: string) => f.endsWith(".md") && f !== "README.md")
    .sort()
  return files.map((f: string) => {
    const fullPath = join(HOWTO_DIR, f)
    // Front-matter is stripped here too, or every title would read "---".
    const { meta, body } = parseFrontMatter(fs.readFileSync(fullPath, "utf-8"))
    const firstLine = body.split("\n").find((l: string) => l.startsWith("# "))
    const title =
      meta.title ??
      (firstLine ? firstLine.replace(/^#\s+/, "").replace(/^How to:\s*/i, "") : f.replace(".md", ""))
    return { name: f.replace(".md", ""), title, path: fullPath, meta, body }
  })
}

/**
 * Local recipes, or the published set when this machine has none.
 *
 * Local ALWAYS wins when it has anything at all — this is a fallback for the empty
 * fresh-install case (#181785), not a merge, so a recipe you edited locally is never
 * shadowed by the published copy. Remote entries carry summary text rather than a
 * full body, so search still ranks them, just less sharply; `view` fetches the real
 * body when one is opened.
 */
async function listRecipesOrRemote(): Promise<LocalRecipe[]> {
  const local = await listRecipes()
  if (local.length) return local
  const remote = await fetchRemoteRecipeList()
  return remote.map((r) => ({ ...r, path: "" }))
}

/**
 * The SAME weights the API uses (HowToController::index).
 *
 * Two implementations of "search" that rank differently is a disagreement a user discovers, not
 * a detail — asking the terminal and the website the same question has to give the same answer.
 * The CLI reads local files rather than the API so it keeps working with no network; identical
 * scoring is what keeps that from becoming a divergence.
 */
function scoreRecipe(r: LocalRecipe, needle: string): number {
  let s = 0
  if (r.title.toLowerCase().includes(needle)) s += 100
  if (r.name.toLowerCase().includes(needle)) s += 60
  if ((r.meta.tags ?? []).some((t) => t.toLowerCase().includes(needle))) s += 40
  if (r.body.toLowerCase().includes(needle)) s += 5
  return s
}

const LEVEL_RANK: Record<string, number> = { beginner: 0, intermediate: 1, advanced: 2 }

/** Shared by `list` and the bare `iris how-to`. */
function applyFilters(
  recipes: LocalRecipe[],
  opts: { category?: string; level?: string; tags?: string[] },
): LocalRecipe[] {
  let out = recipes
  if (opts.category) {
    const c = opts.category.toLowerCase()
    out = out.filter((r) => (r.meta.category ?? "").toLowerCase().includes(c))
  }
  if (opts.level) out = out.filter((r) => r.meta.level === opts.level)
  // AND, matching the web and the API — a second tag has to narrow.
  for (const t of opts.tags ?? []) {
    out = out.filter((r) => (r.meta.tags ?? []).includes(t))
  }
  return out
}

function levelTag(level?: string): string {
  if (!level) return ""
  return dim(` [${level}]`)
}

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Body of `how-to list`, extracted so the bare `iris how-to` can reuse it
 * instead of duplicating the rendering (#178285).
 */
export async function runList(opts: { category?: string; level?: string; tags?: string[]; sort?: string } = {}): Promise<void> {
  UI.empty()
  prompts.intro("◈  IRIS How-To Recipes")

  const all = await listRecipesOrRemote()
  const recipes = applyFilters(all, opts)

  if (recipes.length === 0) {
    console.log()
    console.log(dim("  No recipes found in ~/.iris/how-to/ and none published."))
    console.log(dim("  Create one with: ") + highlight("iris how-to add <name>"))
    console.log()
  } else {
    const repoDir = resolveSourceDir()
    const stranded = new Set(strandedRecipes(repoDir))
    const filtering = Boolean(opts.category || opts.level || opts.tags?.length)

    const render = (r: LocalRecipe) => {
      const mark = stranded.has(r.name) ? warning(" ⚠ local-only") : ""
      const dur = r.meta.duration_min ? dim(` ${r.meta.duration_min}m`) : ""
      console.log(`  ${bold(r.name)}  ${dim("—")}  ${r.title}${levelTag(r.meta.level)}${dur}${mark}`)
    }

    printDivider()
    console.log()

    // Grouped by default. 46 undifferentiated lines in a terminal is the same failure as 46 on a
    // page, and grouping costs nothing. An explicit --sort means the reader picked an axis.
    if (!opts.sort && !filtering) {
      const byCat = new Map<string, LocalRecipe[]>()
      for (const r of recipes) {
        const key = r.meta.category ?? "Uncategorised"
        if (!byCat.has(key)) byCat.set(key, [])
        byCat.get(key)!.push(r)
      }
      const groups = [...byCat.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      for (const [name, rs] of groups) {
        console.log(`  ${highlight(name)} ${dim(String(rs.length))}`)
        for (const r of rs) render(r)
        console.log()
      }
    } else {
      const sorted = recipes.slice()
      if (opts.sort === "level") sorted.sort((a, b) => (LEVEL_RANK[a.meta.level ?? ""] ?? 99) - (LEVEL_RANK[b.meta.level ?? ""] ?? 99))
      else if (opts.sort === "duration") sorted.sort((a, b) => (a.meta.duration_min ?? 9999) - (b.meta.duration_min ?? 9999))
      else sorted.sort((a, b) => a.title.localeCompare(b.title))
      for (const r of sorted) render(r)
      console.log()
    }

    const scope = filtering ? `${recipes.length} of ${all.length}` : String(recipes.length)
    console.log(dim(`  ${scope} recipe(s) in ~/.iris/how-to/`))
    console.log(dim("  View one with: ") + highlight("iris how-to view <name>"))
    warnStranded(repoDir)
    console.log()
  }
  prompts.outro("Done")
}

const HowToListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list recipes — grouped by category, or filtered by --category/--level/--tag",
  builder: (y) =>
    y
      .option("category", { type: "string", describe: "filter by category (substring match)" })
      .option("level", {
        type: "string",
        choices: ["beginner", "intermediate", "advanced"],
        describe: "filter by level",
      })
      .option("tag", { type: "array", describe: "filter by tag (repeatable, AND)" })
      .option("sort", {
        type: "string",
        choices: ["title", "level", "duration"],
        describe: "flat list in this order instead of grouping by category",
      }),
  async handler(args) {
    await runList({
      category: args.category as string | undefined,
      level: args.level as string | undefined,
      tags: ((args.tag as string[] | undefined) ?? []).map(String),
      sort: args.sort as string | undefined,
    })
  },
})

// ── View ─────────────────────────────────────────────────────────────────────

const HowToViewCommand = cmd({
  command: "view <name>",
  aliases: ["read", "show"],
  describe: "display a how-to recipe",
  builder: (y) =>
    y.positional("name", { type: "string", demandOption: true, describe: "recipe name (without .md)" }),
  async handler(args) {
    const fs = await import("fs")
    const name = String(args.name).replace(/\.md$/, "")
    const filePath = join(HOWTO_DIR, `${name}.md`)

    if (!fs.existsSync(filePath)) {
      // Not here — but it may still exist, published, for everyone. See
      // fetchRemoteRecipe: the CLI ships no recipes, so on any machine that did not
      // author them this is the ONLY path that resolves.
      const remote = await fetchRemoteRecipe(name)
      if (remote) {
        console.log()
        console.log(remote)
        console.log(dim(`  (from ${IRIS_API}/api/v1/how-tos/${name} — not stored on this machine)`))
        return
      }

      // Try fuzzy match
      const recipes = await listRecipes()
      const match = recipes.find((r) => r.name.includes(name) || name.includes(r.name))
      if (match) {
        console.log(dim(`  No exact match for "${name}". Did you mean: ${highlight(match.name)}?`))
      } else {
        console.log(dim(`  Recipe "${name}" not found.`))
        console.log(dim("  Run: ") + highlight("iris how-to list") + dim(" to see available recipes"))
      }
      return
    }

    const content = fs.readFileSync(filePath, "utf-8")
    console.log()
    console.log(content)
  },
})

// ── Search ───────────────────────────────────────────────────────────────────

/**
 * Body of `how-to search`, extracted so a bare topic (`iris how-to hive`) can
 * route straight into it (#178286) without duplicating the matcher.
 */
export async function runSearch(rawQuery: string): Promise<void> {
  {
    UI.empty()
    prompts.intro("◈  Search How-Tos")

    const query = String(rawQuery).toLowerCase()
    const recipes = await listRecipesOrRemote()

    // RANKED, not first-match-wins. The previous version pushed results in directory order, so a
    // recipe that mentions the term once in passing could print above the one it names.
    const matches = recipes
      .map((r) => {
        const score = scoreRecipe(r, query)
        if (score === 0) return null
        let line = r.title
        let lineNum = 0
        if (!r.title.toLowerCase().includes(query) && !r.name.toLowerCase().includes(query)) {
          const lines = r.body.split("\n")
          const i = lines.findIndex((l) => l.toLowerCase().includes(query))
          if (i !== -1) {
            line = lines[i].trim()
            lineNum = i + 1
          }
        }
        return { name: r.name, title: r.title, line, lineNum, score, meta: r.meta }
      })
      .filter(Boolean)
      .sort((a, b) => b!.score - a!.score) as Array<{
      name: string
      title: string
      line: string
      lineNum: number
      score: number
      meta: RecipeMeta
    }>

    printDivider()
    if (matches.length === 0) {
      console.log()
      console.log(dim(`  No matches for "${query}" in ${recipes.length} recipe(s)`))
      console.log()
    } else {
      console.log()
      for (const m of matches) {
        console.log(`  ${bold(m.name)}  ${dim("—")}  ${m.title}${levelTag(m.meta.level)}`)
        if (m.lineNum > 0) {
          console.log(`    ${dim(`L${m.lineNum}:`)} ${m.line.slice(0, 100)}`)
        }
      }
      console.log()
      console.log(dim(`  ${matches.length} match(es). View with: `) + highlight("iris how-to view <name>"))
      console.log()
    }
    prompts.outro("Done")
  }
}

const HowToSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find", "grep"],
  describe: "search how-to recipes by keyword",
  builder: (y) =>
    y.positional("query", { type: "string", demandOption: true, describe: "search term" }),
  async handler(args) {
    await runSearch(String(args.query))
  },
})

// ── Add / Update ─────────────────────────────────────────────────────────────

/**
 * The repository is the source of truth, so `publish` reads the REPO, never ~/.iris/how-to.
 *
 * Those two directories look identical and are not: ~/.iris/how-to is what the installer
 * copied in, plus anything written locally by `iris how-to add`. Publishing from there would
 * push unreviewed files nobody merged — which is exactly how the genesis-sdk recipe came to
 * exist on one laptop and nowhere else. Reading scaffold/how-to makes "published" mean "in the
 * repository", and that is the only definition worth having.
 */
function resolveSourceDir(explicit?: string): string | null {
  const candidates = [
    explicit,
    "scaffold/how-to",
    join(process.cwd(), "scaffold", "how-to"),
    process.env.IRIS_CODE_ROOT ? join(process.env.IRIS_CODE_ROOT, "scaffold", "how-to") : undefined,
  ].filter(Boolean) as string[]

  for (const c of candidates) {
    const abs = resolve(c)
    if (existsSync(abs) && existsSync(join(abs, "README.md"))) return abs
  }
  return null
}

/**
 * Recipes that exist ONLY in ~/.iris/how-to and are therefore unpublishable.
 *
 * `publish` reading the repo is correct (see above) — but nothing used to SAY so, so a recipe
 * written with `how-to add` sat on one laptop forever and every surface reported success.
 * That is the same shape as a deploy check that cannot tell "deployed" from "not measured":
 * the absence was never rendered anywhere. Now `list` marks them and `publish` names them.
 */
function strandedRecipes(repoDir: string | null): string[] {
  if (!repoDir || !existsSync(HOWTO_DIR)) return []
  const inRepo = new Set(readdirSync(repoDir).filter((f: string) => f.endsWith(".md")))
  return readdirSync(HOWTO_DIR)
    .filter((f: string) => f.endsWith(".md") && f !== "README.md" && !inRepo.has(f))
    .map((f: string) => f.replace(/\.md$/, ""))
    .sort()
}

function warnStranded(repoDir: string | null): void {
  const stranded = strandedRecipes(repoDir)
  if (stranded.length === 0) return
  console.log()
  console.log(warning(`  ⚠ ${stranded.length} recipe(s) exist only in ~/.iris/how-to and will NEVER publish:`))
  for (const n of stranded.slice(0, 12)) console.log(dim("      ") + n)
  if (stranded.length > 12) console.log(dim(`      … and ${stranded.length - 12} more`))
  console.log(dim("  Move one into the repo with: ") + highlight("iris how-to promote <name>"))
}

/** The closed set. An extensible category list stops being navigation within a month. */
const CATEGORIES = [
  "Getting Started",
  "Agents & Automation",
  "Pages & Design",
  "Data & Atlas",
  "CRM & Sales",
  "Content & Media",
  "Infrastructure",
  "Finance",
  "Bounty & Community",
] as const

const LEVELS = ["beginner", "intermediate", "advanced"] as const

export type RecipeMeta = {
  category?: string
  level?: string
  tags?: string[]
  duration_min?: number
  prerequisites?: string[]
  title?: string
}

/**
 * Minimal YAML front-matter reader — deliberately not a YAML dependency.
 *
 * Only five keys are supported and they are all scalars or flat string lists, so a real parser
 * would buy nothing and cost a dependency in a CLI that ships as a single binary.
 *
 * ABSENCE IS UNTAGGED, NEVER INVALID. The 46 recipes migrate one at a time and both states have to
 * publish cleanly in between — a stricter reader would have forced a flag-day migration.
 */
function parseFrontMatter(raw: string): { meta: RecipeMeta; body: string } {
  if (!raw.startsWith("---\n")) return { meta: {}, body: raw }
  const end = raw.indexOf("\n---", 4)
  if (end === -1) return { meta: {}, body: raw }
  const block = raw.slice(4, end)
  const body = raw.slice(raw.indexOf("\n", end + 1) + 1)

  const meta: RecipeMeta = {}
  for (const line of block.split("\n")) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/)
    if (!m) continue
    const [, key, rawVal] = m
    const val = rawVal.trim()
    if (!val) continue
    if (key === "tags" || key === "prerequisites") {
      const list = val
        .replace(/^\[|\]$/g, "")
        .split(",")
        .map((t) => t.trim().replace(/^["']|["']$/g, ""))
        .filter(Boolean)
      if (list.length) (meta as any)[key] = list
    } else if (key === "duration_min") {
      const n = parseInt(val, 10)
      if (!Number.isNaN(n)) meta.duration_min = n
    } else if (key === "category" || key === "level" || key === "title") {
      ;(meta as any)[key] = val.replace(/^["']|["']$/g, "")
    }
  }
  return { meta, body }
}

/** Typos in a closed set are an open set with extra steps — refuse at publish, name the options. */
export function validateRecipeMeta(slug: string, meta: RecipeMeta): string[] {
  const errs: string[] = []
  if (meta.category && !(CATEGORIES as readonly string[]).includes(meta.category))
    errs.push(`${slug}: unknown category '${meta.category}' — expected one of ${CATEGORIES.join(" · ")}`)
  if (meta.level && !(LEVELS as readonly string[]).includes(meta.level))
    errs.push(`${slug}: unknown level '${meta.level}' — expected ${LEVELS.join(" | ")}`)
  return errs
}

function readRecipes(dir: string) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => {
      const slug = f.replace(/\.md$/, "")
      const rawFile = readFileSync(join(dir, f), "utf8")
      // Strip front-matter FIRST so every rule below sees exactly what it saw before this existed.
      const { meta, body: raw } = parseFrontMatter(rawFile)
      const lines = raw.split("\n")
      const title = meta.title || (lines[0] || "").replace(/^#\s*/, "").trim() || slug
      // First real PARAGRAPH becomes the card summary, not the first physical line.
      //
      // Two bugs lived here. Taking one line shipped `> **STOP — read the design standard
      // first:**` onto the index as literal asterisks; and because these files are soft-wrapped,
      // one line is usually half a sentence, so cards read "…how to check what" and stopped.
      // Join the paragraph, strip the inline markup, then cut on a sentence boundary.
      const rest = lines.slice(1)
      const startIdx = rest.findIndex((l) => {
        const t = l.trim()
        if (!t) return false
        return !t.startsWith("#") && !t.startsWith("```") && !t.startsWith(">") && !t.startsWith("|") && !t.startsWith("---")
      })
      let summary: string | null = null
      if (startIdx !== -1) {
        const para: string[] = []
        for (const l of rest.slice(startIdx)) {
          if (!l.trim()) break
          para.push(l.trim())
        }
        const flat = para
          .join(" ")
          .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")   // [text](url) -> text
          .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1") // **bold** / _em_ -> text
          .replace(/`([^`]+)`/g, "$1")                  // `code` -> code
          .replace(/[*_]{2,}/g, "")                     // a bold that opens and never closes
          .replace(/\s+/g, " ")
          .trim()
        // Cut on a sentence end if there is one in range, so a card never stops mid-clause.
        const cut = flat.slice(0, 240)
        const lastStop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "))
        summary = flat.length > 240 && lastStop > 80 ? cut.slice(0, lastStop + 1) : cut.trim()
      }
      const body_md = rest.join("\n").trim()
      return {
        slug,
        title,
        summary,
        body_md,
        category: meta.category ?? null,
        level: meta.level ?? null,
        tags: meta.tags ?? [],
        duration_min: meta.duration_min ?? null,
        prerequisites: meta.prerequisites ?? [],
        hash: createHash("sha256").update(body_md).digest("hex"),
      }
    })
}

const HowToPublishCommand = cmd({
  command: "publish",
  aliases: ["sync"],
  describe: "mirror the repository's recipes to the web at /how-to (reads scaffold/how-to)",
  builder: (y) =>
    y
      .option("dir", { type: "string", describe: "path to scaffold/how-to (default: found from cwd)" })
      .option("dry-run", { type: "boolean", default: false, describe: "show what would change, publish nothing" })
      .option("cli-version", { type: "string", describe: "CLI version to stamp on the published rows" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Publish How-Tos")

    const dir = resolveSourceDir(args.dir as string | undefined)
    if (!dir) {
      prompts.log.error("Could not find scaffold/how-to.")
      console.log(dim("  Run from the iris-code repo, or pass ") + highlight("--dir <path>"))
      console.log(dim("  Publishing from ~/.iris/how-to is refused: it may hold unreviewed local recipes."))
      prompts.outro("")
      return
    }

    const recipes = readRecipes(dir)
    console.log(dim(`  source  ${dir}`))
    console.log(dim(`  recipes ${recipes.length}`))

    const metaErrors = recipes.flatMap((r) =>
      validateRecipeMeta(r.slug, { category: r.category ?? undefined, level: r.level ?? undefined }),
    )
    if (metaErrors.length) {
      prompts.log.error(`${metaErrors.length} recipe(s) have invalid front-matter — nothing published.`)
      for (const e of metaErrors.slice(0, 10)) console.log(dim("    ") + e)
      prompts.outro("")
      return
    }

    const tagged = recipes.filter((r) => r.category).length
    if (tagged < recipes.length) {
      console.log(dim(`  tagged  ${tagged}/${recipes.length}`) + warning(`  (${recipes.length - tagged} untagged)`))
    } else {
      console.log(dim(`  tagged  ${tagged}/${recipes.length}`))
    }

    if (args["dry-run"]) {
      // Compare against what is live, so a dry run answers "what is stale?" rather than
      // just restating the file list.
      let live: Record<string, string> = {}
      try {
        const res = await irisFetch("/api/v1/how-tos", {}, IRIS_API)
        if (res.ok) {
          const body: any = await res.json()
          for (const r of body?.data ?? []) live[r.slug] = r.updated_at ?? ""
        }
      } catch { /* offline is not an error for a dry run */ }
      const fresh = recipes.filter((r) => !(r.slug in live))
      printDivider()
      console.log(`  ${bold(String(recipes.length))} would publish · ${bold(String(fresh.length))} not yet live`)
      for (const r of fresh.slice(0, 12)) console.log(dim("    + ") + r.slug)
      warnStranded(dir)
      printDivider()
      prompts.outro(dim("Dry run — nothing was published."))
      return
    }

    const res = await irisFetch(
      "/api/v1/how-tos-sync",
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          // Default to the running CLI version. `source_version` has been a column since the
          // table was created and was NULL on all 46 rows because nothing ever passed
          // --cli-version — which makes the whole staleness/re-shoot primitive (HOWTO-04) free
          // the moment it is actually stamped.
          version: args["cli-version"] ?? Installation.VERSION,
          recipes: recipes.map(
            ({ slug, title, summary, body_md, category, level, tags, duration_min, prerequisites }) => ({
              slug,
              title,
              summary,
              body_md,
              category,
              level,
              tags,
              duration_min,
              prerequisites,
            }),
          ),
        }),
      },
      IRIS_API,
    )

    if (!res.ok) {
      prompts.log.error(`Publish failed — HTTP ${res.status}`)
      console.log(dim("  " + (await res.text()).slice(0, 240)))
      prompts.outro("")
      return
    }

    const out: any = await res.json()
    printDivider()
    console.log(
      `  ${bold(String(out.created))} created · ${bold(String(out.updated))} updated · ` +
        `${dim(String(out.unchanged) + " unchanged")}` +
        (out.unpublished ? ` · ${bold(String(out.unpublished))} unpublished` : ""),
    )
    console.log(dim(`  ${out.total_published} live at `) + highlight("https://heyiris.io/how-to"))
    warnStranded(dir)
    printDivider()
    prompts.outro("")
  },
})

const HowToAddCommand = cmd({
  command: "add <name>",
  aliases: ["create", "write", "save"],
  describe: "create or update a how-to recipe (reads from --file, --content, or stdin)",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true, describe: "recipe name (becomes <name>.md)" })
      .option("file", { type: "string", describe: "read recipe content from this file path" })
      .option("content", { type: "string", describe: "recipe content as a string (for short recipes)" })
      .option("title", { type: "string", describe: "recipe title (auto-prepended as # heading if missing)" })
      .option("local", {
        type: "boolean",
        default: false,
        describe: "write ONLY to ~/.iris/how-to — the recipe will not be publishable",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add How-To")

    const fs = await import("fs")
    const name = String(args.name).replace(/\.md$/, "").replace(/\s+/g, "-").toLowerCase()
    await ensureDir()

    // The repo is the source of truth for anything publishable, so author THERE by default and
    // mirror to ~/.iris/how-to so `view` works immediately. Writing only to the home dir is now
    // an explicit --local choice rather than the silent default that stranded six recipes.
    const repoDir = args.local ? null : resolveSourceDir()
    const filePath = join(repoDir ?? HOWTO_DIR, `${name}.md`)

    let content = ""

    if (args.file) {
      // Read from file
      const srcPath = String(args.file)
      if (!fs.existsSync(srcPath)) {
        prompts.log.error(`File not found: ${srcPath}`)
        prompts.outro("Done")
        return
      }
      content = fs.readFileSync(srcPath, "utf-8")
    } else if (args.content) {
      content = String(args.content)
    } else if (!process.stdin.isTTY) {
      // Read from stdin (piped content)
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) {
        chunks.push(chunk as Buffer)
      }
      content = Buffer.concat(chunks).toString("utf-8")
    } else {
      // Interactive: open editor or prompt
      const result = await prompts.text({
        message: "Paste or type the recipe content (Ctrl+D when done):",
        placeholder: "# How to: ...\n\n## What this does\n...",
      })
      if (prompts.isCancel(result)) {
        prompts.outro("Cancelled")
        return
      }
      content = String(result)
    }

    if (!content.trim()) {
      prompts.log.error("No content provided. Use --file, --content, pipe stdin, or type interactively.")
      prompts.outro("Done")
      return
    }

    // Auto-prepend title heading if missing
    if (!content.startsWith("# ")) {
      const title = args.title || `How to: ${name.replace(/-/g, " ")}`
      content = `# ${title}\n\n${content}`
    }

    const exists = fs.existsSync(filePath)
    fs.writeFileSync(filePath, content, "utf-8")
    // Mirror into the home dir so `view`/`search` and the MCP resource see it without a reinstall.
    if (repoDir) fs.writeFileSync(join(HOWTO_DIR, `${name}.md`), content, "utf-8")

    const action = exists ? "Updated" : "Created"
    prompts.log.info(`${action}: ${filePath} (${content.split("\n").length} lines)`)

    printDivider()
    console.log()
    console.log(dim("  Read it with: ") + highlight(`iris how-to view ${name}`))
    console.log()
    if (repoDir) {
      console.log(dim("  Written to the repo, so it is version controlled and publishable."))
      console.log(dim("  Commit it, then: ") + highlight("iris how-to publish"))
    } else {
      console.log(warning("  ⚠ LOCAL ONLY — this recipe cannot be published."))
      console.log(dim("  `publish` reads scaffold/how-to in the iris-code repo, not ~/.iris/how-to,"))
      console.log(dim("  so nothing written here reaches ") + highlight("heyiris.io/how-to") + dim("."))
      console.log(dim("  To publish it: ") + highlight(`iris how-to promote ${name}`) + dim(" (from the repo)"))
    }
    console.log()
    prompts.outro("Done")
  },
})

// ── Social ───────────────────────────────────────────────────────────────────

/**
 * Turn a published recipe into carousel props + an X post.
 *
 * NO MODEL. A how-to is already structured content — title, summary, category, level, duration,
 * tags, section headings, a code block — and the CarouselSlide schema wants exactly those fields.
 * `remotion auto-carousel` exists for when you have only a topic; here we have the article, so
 * generating from it is a mapping, not an inference, and it cannot drift from what the recipe says.
 *
 * Emits props for `iris remotion carousel` rather than rendering directly: rendering, uploading
 * and publishing already exist and should not be re-implemented behind a second door.
 */
/**
 * The paragraph between the H1 and the first `##` — the recipe's actual opening line.
 *
 * extractSections() starts at the first `##`, so a recipe whose lede sits above it lost its best
 * sentence and the subtitle fell through to whatever the first section happened to open with. On
 * `bounty-os-hunter-journey` that was a bare URL, truncated mid-word. The lede is written to be
 * read first; use it when there is one.
 */
function extractLede(body: string): string | null {
  const lines = body.split("\n")
  const h1 = lines.findIndex((l) => l.startsWith("# "))
  if (h1 === -1) return null
  const buf: string[] = []
  for (const l of lines.slice(h1 + 1)) {
    const t = l.trim()
    if (t.startsWith("##")) break
    if (!t) {
      if (buf.length) break // first paragraph only
      continue
    }
    if (t.startsWith("|") || t.startsWith("```") || t.startsWith(">")) continue
    buf.push(t)
  }
  if (!buf.length) return null
  const flat = buf
    .join(" ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
  return flat || null
}

/** Trim to a length on a WORD boundary, for text too short to have a sentence end. */
function wordCut(text: string, max: number): string {
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const sp = cut.lastIndexOf(" ")
  return `${(sp > max * 0.5 ? cut.slice(0, sp) : cut).trim()}…`
}

/** Trim to a length, backing up to the last sentence end so the card never stops mid-clause. */
function sentenceCut(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined
  if (text.length <= max) return text
  const cut = text.slice(0, max)
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("? "), cut.lastIndexOf("! "))
  return stop > max * 0.4 ? cut.slice(0, stop + 1).trim() : cut.trim()
}

/**
 * The first run of >=2 consecutive indented lines, returned in the same shape as a regex match so
 * the caller does not care which form it found.
 *
 * Requires two lines so a single indented continuation inside a list or table is not mistaken for
 * code — one indented line is far more often prose wrapping than a command.
 */
function indentedBlock(body: string): RegExpMatchArray | null {
  const lines = body.split("\n")
  let run: string[] = []
  for (const l of lines) {
    if (/^(?: {4}|\t)\S/.test(l)) {
      run.push(l.replace(/^(?: {4}|\t)/, ""))
      continue
    }
    // A blank line inside an indented block is part of it; anything else ends the run.
    if (!l.trim() && run.length) continue
    if (run.length >= 2) break
    run = []
  }
  if (run.length < 2) return null
  return ["", run.join("\n")] as unknown as RegExpMatchArray
}

function extractSections(body: string): Array<{ heading: string; text: string }> {
  const out: Array<{ heading: string; text: string }> = []
  const lines = body.split("\n")
  let heading: string | null = null
  let buf: string[] = []
  const flush = () => {
    if (!heading) return
    const text = buf
      .join(" ")
      .replace(/`([^`]+)`/g, "$1")
      .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
      .replace(/[*_]{1,3}([^*_]+)[*_]{1,3}/g, "$1")
      .replace(/\s+/g, " ")
      .trim()
    out.push({ heading, text })
  }
  for (const l of lines) {
    const m = l.match(/^##\s+(.*)$/)
    if (m) {
      flush()
      heading = m[1].replace(/[*_`]/g, "").trim()
      buf = []
      continue
    }
    if (!heading) continue
    const t = l.trim()
    if (!t || t.startsWith("#") || t.startsWith("|") || t.startsWith("```")) continue
    if (buf.join(" ").length < 260) buf.push(t)
  }
  flush()
  return out
}

/**
 * First code block that looks like commands, not prose.
 *
 * Handles BOTH markdown code forms. Fenced is the common one, but an INDENTED block (four spaces
 * or a tab) is equally valid and three of the 46 recipes use it — they were silently losing their
 * terminal card while every other slide rendered, which reads as "this recipe has no commands"
 * rather than "the extractor only knows one syntax".
 */
function firstCodeBlock(body: string): string | undefined {
  const m = body.match(/```[a-z]*\n([\s\S]*?)```/) ?? indentedBlock(body)
  if (!m) return undefined
  // The card is ~52 monospace columns at this size. Longer lines wrap mid-word and read as
  // broken rather than dense, so they are cut rather than allowed to spill.
  const lines = m[1]
    .split("\n")
    .map((l) => l.trimEnd().replace(/\s{2,}/g, "  "))
    .filter((l) => l.trim() && !l.trim().startsWith("#"))
    .map((l) => (l.length > 52 ? `${l.slice(0, 49)}...` : l))
    .slice(0, 6)
  return lines.length ? lines.join("\n") : undefined
}

const HowToSocialCommand = cmd({
  command: "social <name>",
  aliases: ["carousel-props"],
  describe: "turn a recipe into carousel props + an X post (no AI — it maps the recipe)",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true, describe: "recipe slug" })
      .option("brand", { type: "string", default: "heyiris", describe: "brand slug — drives design tokens AND the call-to-action" })
      .option("url", {
        type: "string",
        describe: "canonical link for this recipe on the BRAND's own site (required for non-IRIS brands)",
      })
      .option("out", { type: "string", describe: "write props JSON here (default: ./<slug>-carousel.json)" })
      .option("json", { type: "boolean", default: false, describe: "print props to stdout instead" }),
  async handler(args) {
    const fs = await import("fs")
    const name = String(args.name).replace(/\.md$/, "")

    const repoDir = resolveSourceDir()
    const candidates = [repoDir ? join(repoDir, `${name}.md`) : "", join(HOWTO_DIR, `${name}.md`)].filter(Boolean)
    const path = candidates.find((p) => existsSync(p))
    if (!path) {
      UI.empty()
      prompts.intro("◈  How-To → Social")
      prompts.log.error(`No recipe named '${name}'.`)
      console.log(dim("  List them with: ") + highlight("iris how-to list"))
      prompts.outro("")
      return
    }

    const { meta, body } = parseFrontMatter(fs.readFileSync(path, "utf-8"))
    const titleLine = body.split("\n").find((l: string) => l.startsWith("# ")) ?? ""
    const fullTitle = titleLine.replace(/^#\s+/, "").trim() || name
    const headline = fullTitle.replace(/^How to:\s*/i, "").trim()
    const sections = extractSections(body)
    const lede = extractLede(body)
    // #182088 — the CTA and links must follow the BRAND, not the docs site.
    //
    // These recipes live at heyiris.io/how-to/<slug>. That is correct for IRIS and
    // wrong for every other brand: a FREELABEL post telling a musician to run
    // `iris how-to view <slug>` is an instruction they cannot follow, and a link to
    // IRIS docs is the wrong destination entirely. Nothing errored — the render
    // reported success and the creative simply belonged to another company.
    const brandSlug = String(args.brand)
    const isIris = brandSlug === "heyiris"
    const url = args.url ? String(args.url).replace(/^https?:\/\//, "") : isIris ? `heyiris.io/how-to/${name}` : ""

    const stats = [
      meta.duration_min ? { value: `${meta.duration_min}`, label: "min read" } : null,
      meta.level ? { value: meta.level, label: "level" } : null,
      { value: String(sections.length), label: "steps" },
    ].filter(Boolean)

    const props: Record<string, unknown> = {
      brand: String(args.brand),
      variant: "editorial",
      totalSlides: 9,
      category: meta.category ?? "How-To",
      headline,
      // Lede first — it is the sentence the author wrote to be read first — and cut on a SENTENCE
      // boundary, so a card never ends "…the money ledger and". A hard slice reads as a rendering
      // fault rather than an excerpt.
      subtitle: sentenceCut(lede ?? sections[0]?.text, 200),
      checklistTitle: "What you'll do",
      checklistTags: meta.tags ?? [],
      // Headings become checklist lines, and a heading is written for a document, not a card. Six
      // recipes carry ones past 60 characters, which overflow the pill rather than wrapping —
      // cut on a word boundary so it reads as an excerpt.
      checklistItems: sections.slice(0, 6).map((s) => wordCut(s.heading, 56)),
      bulletPoints: sections.slice(0, 3).map((s) => ({ title: s.heading, body: s.text.slice(0, 180) })),
      codeSnippet: firstCodeBlock(body),
      stats,
      statsHeadline: "At a glance",
      ctaHeadline: "Read the full recipe",
      // IRIS keeps the CLI framing because it is true for IRIS. Every other brand
      // gets the recipe's own headline and NO CLI incantation.
      ctaBody: isIris ? `Every recipe ships inside the IRIS CLI. ${headline}.` : `${headline}.`,
      ctaButtonText: url,
      // Empty for a non-IRIS brand ON PURPOSE: EditorialCarouselSlide falls back to
      // that brand's own configured ctaUrl when this is falsy (see #182087, which
      // had to be fixed first — a default in Root.tsx made the fallback
      // unreachable). Setting a hand-typed URL here would drift the moment the
      // brand config changes.
      ctaSubtext: isIris ? `iris how-to view ${name}` : "",
    }

    // X caption. Kept under 280 including the link, and assembled from the recipe's own words.
    const tagStr = (meta.tags ?? []).slice(0, 3).map((t) => `#${t.replace(/-/g, "")}`).join(" ")
    const lead = (lede ?? sections[0]?.text)?.split(/(?<=\.)\s/)[0] ?? ""
    // Never append a link we do not have. A caption ending in a bare newline is
    // survivable; one pointing at another company's docs is not.
    let xPost = url ? `${headline}\n\n${lead}\n\n${url}` : `${headline}\n\n${lead}`
    if (tagStr) xPost += `\n${tagStr}`
    if (xPost.length > 280) {
      xPost = url ? `${headline}\n\n${url}${tagStr ? `\n${tagStr}` : ""}` : `${headline}${tagStr ? `\n${tagStr}` : ""}`
    }

    if (args.json) {
      console.log(JSON.stringify({ props, xPost }, null, 2))
      return
    }

    const outPath = String(args.out || `${name}-carousel.json`)
    fs.writeFileSync(outPath, JSON.stringify(props, null, 2))

    UI.empty()
    prompts.intro("◈  How-To → Social")
    console.log(dim(`  recipe   ${name}`) + (meta.category ? dim(`  ·  ${meta.category}`) : ""))
    // Print the brand. The whole failure mode was that it was silent — creative
    // rendered under the wrong brand and nothing in the output said so.
    console.log(dim(`  brand    ${brandSlug}`) + (isIris ? "" : dim("  ·  non-IRIS: CTA follows this brand")))
    if (!isIris && !args.url) {
      console.log(
        warning(`  ⚠ no --url given, so the post carries NO link.`) +
          dim(` These recipes live on heyiris.io; linking a ${brandSlug} post there sends readers to another brand.`),
      )
      console.log(dim(`    Pass one:  iris how-to social ${name} --brand ${brandSlug} --url <brand-url>`))
    }
    console.log(dim(`  sections ${sections.length}`) + dim(`  ·  tags ${(meta.tags ?? []).length}`))
    if (!sections.length) {
      console.log(warning("  ⚠ no ## sections found — the slides will be thin"))
    }
    console.log(dim(`  props    ${outPath}`))
    printDivider()
    console.log()
    console.log(dim("  X POST") + dim(`  (${xPost.length}/280)`))
    for (const l of xPost.split("\n")) console.log(`    ${l}`)
    console.log()
    printDivider()
    console.log()
    console.log(dim("  Render 9 slides:  ") + highlight(`iris remotion carousel ${outPath}`))
    console.log(dim("  Post to X:        ") + highlight(`iris x post`))
    console.log(dim("  Review + publish: ") + highlight("iris remotion register <files..>"))
    console.log()
    prompts.outro("Done")
  },
})

// ── Promote ──────────────────────────────────────────────────────────────────

/**
 * Move a local-only recipe into the repo so it becomes publishable.
 *
 * This is the escape hatch for everything written before `add` defaulted to the repo. It copies
 * rather than moves: ~/.iris/how-to stays populated so `view`, `search` and the MCP resource keep
 * working with no reinstall.
 */
const HowToPromoteCommand = cmd({
  command: "promote [name]",
  aliases: ["publishable"],
  describe: "copy a local-only recipe into the repo so it can be published (--all for every one)",
  builder: (y) =>
    y
      .positional("name", { type: "string", describe: "recipe name (omit with --all)" })
      .option("all", { type: "boolean", default: false, describe: "promote every local-only recipe" })
      .option("dir", { type: "string", describe: "path to scaffold/how-to (default: found from cwd)" })
      .option("dry-run", { type: "boolean", default: false, describe: "show what would move, copy nothing" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Promote How-To")

    const fs = await import("fs")
    const dir = resolveSourceDir(args.dir as string | undefined)
    if (!dir) {
      prompts.log.error("Could not find scaffold/how-to.")
      console.log(dim("  Run from the iris-code repo, or pass ") + highlight("--dir <path>"))
      prompts.outro("")
      return
    }

    const stranded = strandedRecipes(dir)
    if (stranded.length === 0) {
      prompts.log.info("Nothing to promote — every local recipe is already in the repo.")
      prompts.outro("Done")
      return
    }

    let targets: string[]
    if (args.all) {
      targets = stranded
    } else if (args.name) {
      const n = String(args.name).replace(/\.md$/, "")
      if (!stranded.includes(n)) {
        prompts.log.error(`'${n}' is not a local-only recipe.`)
        console.log(dim("  Local-only right now: ") + stranded.join(", "))
        prompts.outro("")
        return
      }
      targets = [n]
    } else {
      console.log()
      console.log(dim(`  ${stranded.length} local-only recipe(s):`))
      for (const n of stranded) console.log("    " + bold(n))
      console.log()
      console.log(dim("  Promote one with: ") + highlight("iris how-to promote <name>"))
      console.log(dim("  Or all of them:   ") + highlight("iris how-to promote --all"))
      console.log()
      prompts.outro("Done")
      return
    }

    console.log(dim(`  target  ${dir}`))
    for (const n of targets) {
      const dest = join(dir, `${n}.md`)
      if (args["dry-run"]) {
        console.log(dim("    + ") + n)
        continue
      }
      fs.copyFileSync(join(HOWTO_DIR, `${n}.md`), dest)
      console.log(success("    ✓ ") + n)
    }

    printDivider()
    if (args["dry-run"]) {
      prompts.outro(dim("Dry run — nothing was copied."))
      return
    }
    console.log()
    console.log(dim("  Now version controlled. Review, commit, then: ") + highlight("iris how-to publish"))
    console.log(warning("  ⚠ /how-to is PUBLIC — read each one for client names or pricing first."))
    console.log()
    prompts.outro("Done")
  },
})

// ── Remove ───────────────────────────────────────────────────────────────────

const HowToRemoveCommand = cmd({
  command: "remove <name>",
  aliases: ["rm", "delete"],
  describe: "remove a how-to recipe",
  builder: (y) =>
    y.positional("name", { type: "string", demandOption: true }),
  async handler(args) {
    const fs = await import("fs")
    const name = String(args.name).replace(/\.md$/, "")
    const filePath = join(HOWTO_DIR, `${name}.md`)

    if (!fs.existsSync(filePath)) {
      console.log(dim(`  Recipe "${name}" not found.`))
      return
    }

    fs.unlinkSync(filePath)
    console.log(dim(`  Removed: ~/.iris/how-to/${name}.md`))
  },
})

// ── Root command ─────────────────────────────────────────────────────────────

/**
 * Subcommand names + aliases. A bare positional that matches one of these is
 * that subcommand; anything else is a search term (#178286). Kept explicit so
 * the default handler and the tests agree on the precedence rule.
 */
export const HOWTO_SUBCOMMANDS = [
  "list", "ls",
  "view", "read", "show",
  "search", "find", "grep",
  "add", "create", "write", "save",
  "remove", "rm", "delete",
]

/**
 * What a bare `iris how-to [topic]` should do (#178285/#178286). Pure, so the
 * precedence rule is testable without driving yargs or the filesystem.
 *
 *   (nothing)      -> list
 *   --search x     -> search x            (explicit wins; the escape hatch for
 *                                          a topic that shares a subcommand name)
 *   a topic        -> search topic
 *   a subcommand   -> list                (defensive only — yargs routes real
 *                                          subcommands before $0 is reached)
 */
export function resolveDefaultAction(
  topic?: unknown,
  search?: unknown,
): { action: "list" } | { action: "search"; query: string } {
  const explicit = typeof search === "string" ? search.trim() : ""
  if (explicit) return { action: "search", query: explicit }

  const t = typeof topic === "string" ? topic.trim() : ""
  if (!t) return { action: "list" }
  if (HOWTO_SUBCOMMANDS.includes(t.toLowerCase())) return { action: "list" }

  return { action: "search", query: t }
}

export const HowToCommand = cmd({
  command: "how-to",
  // #178285: users reach for the plural, and "how-tos" / "howtos" used to be
  // "Unknown command". Both forms now resolve, and so does every subcommand
  // under them, because aliases apply to the whole subtree.
  aliases: ["howto", "how-tos", "howtos", "recipes", "recipe"],
  describe: "manage IRIS how-to recipes — step-by-step guides for common workflows",
  builder: (yargs) =>
    yargs
      .command(HowToListCommand)
      .command(HowToViewCommand)
      .command(HowToSearchCommand)
      .command(HowToAddCommand)
      .command(HowToPublishCommand)
      .command(HowToPromoteCommand)
      .command(HowToSocialCommand)
      .command(HowToRemoveCommand)
      .command(HowToBackupCommands[0])
      // #178285/#178286: previously .demandCommand(), so a bare `iris how-to`
      // died with "Not enough non-option arguments: got 0, need at least 1" —
      // a parent command that refuses to do the obvious thing. Now:
      //   iris how-to            -> list
      //   iris how-to hive       -> search "hive"   (not a subcommand)
      //   iris how-to list       -> list            (subcommand still wins)
      //   iris how-to --search x -> search "x"      (explicit, for scripting)
      // The one ambiguous case is a topic that shares a subcommand's name; the
      // subcommand wins, which is the CLI convention, and --search is the way out.
      .command({
        command: "$0 [topic]",
        describe: false as unknown as string,
        builder: (y: any) =>
          y
            .positional("topic", { type: "string", describe: "search recipes for this topic" })
            .option("search", { type: "string", describe: "search term (explicit form)" }),
        handler: async (args: any) => {
          const action = resolveDefaultAction(args.topic, args.search)
          return action.action === "search" ? runSearch(action.query) : runList()
        },
      }),
  async handler() {},
})
