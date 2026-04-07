import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"
import { existsSync, readFileSync, statSync } from "fs"
import { basename } from "path"
import { Glob } from "bun"

// ============================================================================
// memory list — GET /api/v1/user/{userId}/bloqs
// ============================================================================

const MemoryListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all knowledge bases (bloqs)",
  builder: (yargs) =>
    yargs
      .option("search", { alias: "s", describe: "search query", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Knowledge Bases")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(); if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const params = new URLSearchParams()
      if (args.search) params.set("search", args.search)
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs?${params}`)
      const ok = await handleApiError(res, "List bloqs")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const bloqs: any[] = data?.data ?? data?.bloqs ?? (Array.isArray(data) ? data : [])
      spinner.stop(`${bloqs.length} bloq(s)`)

      if (args.json) { console.log(JSON.stringify(bloqs, null, 2)); prompts.outro("Done"); return }
      if (bloqs.length === 0) { prompts.log.warn("No knowledge bases found"); prompts.outro(dim("iris memory compose")); return }

      printDivider()
      for (const b of bloqs) {
        console.log(`  ${bold(String(b.title ?? "Untitled"))}  ${dim(`#${b.id}`)}`)
        if (b.description) console.log(`    ${dim(String(b.description).slice(0, 80))}`)
      }
      printDivider()
      prompts.outro(dim("iris memory show <id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// memory show <id> — GET /api/v1/user/{userId}/bloqs/{id} + content + files
// ============================================================================

const MemoryShowCommand = cmd({
  command: "show <id>",
  describe: "show knowledge base details",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("files", { alias: "f", describe: "show files only", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Bloq #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(); if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const [bloqRes, contentRes, filesRes] = await Promise.all([
        irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}`),
        irisFetch(`/api/v1/user/bloqs/${args.id}/content`),
        irisFetch(`/api/v1/bloqs/${args.id}/files`),
      ])

      const bloq = ((await bloqRes.json()) as any)?.data ?? {}
      const content: any[] = ((await contentRes.json().catch(() => ({}))) as any)?.data ?? []
      const files: any[] = ((await filesRes.json().catch(() => ({}))) as any)?.data ?? []

      spinner.stop(String(bloq.title ?? `#${args.id}`))

      if (args.json) { console.log(JSON.stringify({ bloq, content, files }, null, 2)); prompts.outro("Done"); return }

      if (args.files) {
        printDivider()
        if (files.length === 0) prompts.log.warn("No files")
        else for (const f of files) console.log(`  ${bold(String(f.original_filename ?? f.filename ?? "?"))}  ${dim(`#${f.id} · ${f.size ?? 0}b`)}`)
        printDivider()
        prompts.outro("Done")
        return
      }

      printDivider()
      printKV("ID", bloq.id)
      printKV("Title", bloq.title)
      printKV("Description", bloq.description)
      printKV("Items", bloq.itemCount ?? bloq.item_count)
      printKV("Created", bloq.createdAt ?? bloq.created_at)
      console.log()
      console.log(`  ${dim("Content")}  ${dim(`(${content.length})`)}`)
      for (const c of content.slice(0, 10)) console.log(`    ${String(c.title ?? "Untitled")}  ${dim(`#${c.id}`)}`)
      console.log()
      console.log(`  ${dim("Files")}  ${dim(`(${files.length})`)}`)
      for (const f of files.slice(0, 10)) console.log(`    ${String(f.original_filename ?? f.filename ?? "?")}`)
      printDivider()
      prompts.outro(dim(`iris memory add ${args.id} --file=...`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// memory add <id> — upload files or text content
// ============================================================================

async function expandGlobs(patterns: string[]): Promise<string[]> {
  const out = new Set<string>()
  for (const p of patterns) {
    if (p.includes("*") || p.includes("?")) {
      const g = new Glob(p)
      for await (const f of g.scan(".")) {
        try { if (statSync(f).isFile()) out.add(f) } catch {}
      }
    } else if (existsSync(p) && statSync(p).isFile()) {
      out.add(p)
    }
  }
  return Array.from(out)
}

const MemoryAddCommand = cmd({
  command: "add <id>",
  describe: "add files or text to a knowledge base",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "file path or glob (repeatable)", type: "array", string: true, default: [] as string[] })
      .option("text", { alias: "t", describe: "text content to add", type: "string" })
      .option("title", { describe: "title for text content", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add to Bloq #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const patterns = (args.file as string[]) ?? []
    const files = patterns.length > 0 ? await expandGlobs(patterns) : []
    let added = 0

    if (files.length > 0) {
      const spinner = prompts.spinner()
      spinner.start(`Uploading ${files.length} file(s)…`)
      for (const f of files) {
        try {
          const buffer = readFileSync(f)
          const fd = new FormData()
          fd.append("bloq_id", String(args.id))
          fd.append("file", new Blob([new Uint8Array(buffer)]), basename(f))
          const res = await irisFetch(`/api/v1/cloud-files/upload`, { method: "POST", body: fd, headers: {} as any })
          if (res.ok) added++
          else prompts.log.warn(`Failed: ${basename(f)} (HTTP ${res.status})`)
        } catch (e) {
          prompts.log.warn(`Failed: ${basename(f)} — ${e instanceof Error ? e.message : String(e)}`)
        }
      }
      spinner.stop(`${success("✓")} Uploaded ${added}/${files.length}`)
    }

    if (args.text) {
      const title = args.title ?? `Note ${new Date().toISOString().slice(0, 19).replace("T", " ")}`
      const res = await irisFetch(`/api/v1/user/bloqs/${args.id}/content`, {
        method: "POST",
        body: JSON.stringify({ title, content: args.text }),
      })
      if (res.ok) { added++; prompts.log.success(`Added text: ${title}`) }
      else prompts.log.error(`Failed to add text (HTTP ${res.status})`)
    }

    if (added === 0) {
      prompts.log.warn("Nothing added. Use --file or --text.")
      prompts.outro("Done")
      return
    }
    prompts.outro(dim(`iris memory show ${args.id}`))
  },
})

// ============================================================================
// memory compose — interactive create wizard
// ============================================================================

const MemoryComposeCommand = cmd({
  command: "compose",
  describe: "create a new knowledge base interactively",
  builder: (yargs) =>
    yargs
      .option("title", { alias: "t", describe: "bloq title", type: "string" })
      .option("description", { alias: "d", describe: "description", type: "string" })
      .option("color", { describe: "color (blue, green, red, yellow, purple, orange, pink, gray)", type: "string", default: "blue" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Compose Knowledge Base")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(); if (!userId) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      title = (await prompts.text({ message: "Title", validate: (v) => (v && v.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }
    let description = args.description
    if (description === undefined) {
      description = (await prompts.text({ message: "Description (optional)", placeholder: "What is this for?" })) as string
      if (prompts.isCancel(description)) description = ""
    }

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({ title, description, color: args.color }),
      })
      const ok = await handleApiError(res, "Create bloq")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const bloq = ((await res.json()) as any)?.data ?? {}
      spinner.stop(`${success("✓")} Created bloq #${bloq.id}`)

      printDivider()
      printKV("ID", bloq.id)
      printKV("Title", bloq.title ?? title)
      printKV("Description", bloq.description ?? description)
      printDivider()
      prompts.outro(dim(`iris memory add ${bloq.id} --file=...`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformMemoryCommand = cmd({
  command: "memory",
  describe: "manage knowledge bases (bloqs) — list, show, add, compose",
  builder: (yargs) =>
    yargs
      .command(MemoryListCommand)
      .command(MemoryShowCommand)
      .command(MemoryAddCommand)
      .command(MemoryComposeCommand)
      .demandCommand(),
  async handler() {},
})
