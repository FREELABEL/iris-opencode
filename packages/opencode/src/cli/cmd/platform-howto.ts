import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { dim, bold, highlight, printDivider } from "./iris-api"
import { homedir } from "os"
import { join } from "path"

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

const HowToListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all available how-to recipes",
  builder: (y) => y,
  async handler() {
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

const HowToSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find", "grep"],
  describe: "search how-to recipes by keyword",
  builder: (y) =>
    y.positional("query", { type: "string", demandOption: true, describe: "search term" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Search How-Tos")

    const query = String(args.query).toLowerCase()
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
  },
})

// ── Add / Update ─────────────────────────────────────────────────────────────

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

export const HowToCommand = cmd({
  command: "how-to",
  aliases: ["howto", "recipes"],
  describe: "manage IRIS how-to recipes — step-by-step guides for common workflows",
  builder: (yargs) =>
    yargs
      .command(HowToListCommand)
      .command(HowToViewCommand)
      .command(HowToSearchCommand)
      .command(HowToAddCommand)
      .command(HowToRemoveCommand)
      .demandCommand(),
  async handler() {},
})
