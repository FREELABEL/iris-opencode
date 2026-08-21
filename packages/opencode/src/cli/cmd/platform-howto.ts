import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, bold, highlight, printDivider } from "./iris-api"
import { homedir } from "os"
import { join, resolve } from "path"
import { existsSync, readdirSync, readFileSync } from "fs"
import { createHash } from "crypto"
import { irisFetch, IRIS_API } from "./iris-api"

const HOWTO_DIR = join(homedir(), ".iris", "how-to")

async function ensureDir() {
  const fs = await import("fs")
  if (!fs.existsSync(HOWTO_DIR)) {
    fs.mkdirSync(HOWTO_DIR, { recursive: true })
  }
}

async function listRecipes(): Promise<Array<{ name: string; title: string; path: string }>> {
  const fs = await import("fs")
  await ensureDir()
  if (!fs.existsSync(HOWTO_DIR)) return []

  const files = fs.readdirSync(HOWTO_DIR).filter((f: string) => f.endsWith(".md")).sort()
  return files.map((f: string) => {
    const fullPath = join(HOWTO_DIR, f)
    const content = fs.readFileSync(fullPath, "utf-8")
    const firstLine = content.split("\n").find((l: string) => l.startsWith("# "))
    const title = firstLine ? firstLine.replace(/^#\s+/, "").replace(/^How to:\s*/i, "") : f.replace(".md", "")
    return { name: f.replace(".md", ""), title, path: fullPath }
  })
}

// ── List ─────────────────────────────────────────────────────────────────────

/**
 * Body of `how-to list`, extracted so the bare `iris how-to` can reuse it
 * instead of duplicating the rendering (#178285).
 */
export async function runList(): Promise<void> {
  UI.empty()
  prompts.intro("◈  IRIS How-To Recipes")

  const recipes = await listRecipes()

  if (recipes.length === 0) {
    console.log()
    console.log(dim("  No recipes found in ~/.iris/how-to/"))
    console.log(dim("  Create one with: ") + highlight("iris how-to add <name>"))
    console.log()
  } else {
    printDivider()
    console.log()
    for (const r of recipes) {
      console.log(`  ${bold(r.name)}  ${dim("—")}  ${r.title}`)
    }
    console.log()
    console.log(dim(`  ${recipes.length} recipe(s) in ~/.iris/how-to/`))
    console.log(dim("  View one with: ") + highlight("iris how-to view <name>"))
    console.log()
  }
  prompts.outro("Done")
}

const HowToListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all available how-to recipes",
  builder: (y) => y,
  async handler() {
    await runList()
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
    const recipes = await listRecipes()
    const fs = await import("fs")

    const matches: Array<{ name: string; title: string; line: string; lineNum: number }> = []

    for (const r of recipes) {
      const content = fs.readFileSync(r.path, "utf-8")
      // Match in filename or title
      if (r.name.toLowerCase().includes(query) || r.title.toLowerCase().includes(query)) {
        matches.push({ name: r.name, title: r.title, line: r.title, lineNum: 0 })
        continue
      }
      // Match in content
      const lines = content.split("\n")
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(query)) {
          matches.push({ name: r.name, title: r.title, line: lines[i].trim(), lineNum: i + 1 })
          break // one match per file is enough
        }
      }
    }

    printDivider()
    if (matches.length === 0) {
      console.log()
      console.log(dim(`  No matches for "${query}" in ${recipes.length} recipe(s)`))
      console.log()
    } else {
      console.log()
      for (const m of matches) {
        console.log(`  ${bold(m.name)}  ${dim("—")}  ${m.title}`)
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

function readRecipes(dir: string) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") && f !== "README.md")
    .sort()
    .map((f) => {
      const slug = f.replace(/\.md$/, "")
      const raw = readFileSync(join(dir, f), "utf8")
      const lines = raw.split("\n")
      const title = (lines[0] || "").replace(/^#\s*/, "").trim() || slug
      // First non-empty, non-heading line becomes the card summary.
      const summary =
        lines.slice(1).find((l) => l.trim() && !l.trim().startsWith("#") && !l.trim().startsWith("```"))?.trim() ?? null
      const body_md = lines.slice(1).join("\n").trim()
      return { slug, title, summary, body_md, hash: createHash("sha256").update(body_md).digest("hex") }
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
          version: args["cli-version"],
          recipes: recipes.map(({ slug, title, summary, body_md }) => ({ slug, title, summary, body_md })),
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
      .option("title", { type: "string", describe: "recipe title (auto-prepended as # heading if missing)" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add How-To")

    const fs = await import("fs")
    const name = String(args.name).replace(/\.md$/, "").replace(/\s+/g, "-").toLowerCase()
    const filePath = join(HOWTO_DIR, `${name}.md`)
    await ensureDir()

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

    const action = exists ? "Updated" : "Created"
    prompts.log.info(`${action}: ~/.iris/how-to/${name}.md (${content.split("\n").length} lines)`)

    printDivider()
    console.log()
    console.log(dim("  Other agents can now read this recipe with:"))
    console.log(`    ${highlight(`iris how-to view ${name}`)}`)
    console.log()
    console.log(dim("  Or the agent will find it automatically when users ask related questions"))
    console.log(dim("  (the IRIS CLI system prompt checks ~/.iris/how-to/ first)."))
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
      .command(HowToRemoveCommand)
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
