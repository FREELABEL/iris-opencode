import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success, writeJson, IRIS_API } from "./iris-api"
import { existsSync, readFileSync, statSync } from "fs"
import { basename } from "path"
import { Glob } from "bun"
import { firstArray } from "../../util/array"

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
      const bloqs: any[] = firstArray(data?.data, data?.bloqs, (Array.isArray(data) ? data : []))
      spinner.stop(`${bloqs.length} bloq(s)`)

      if (args.json) { await writeJson(bloqs); prompts.outro("Done"); return }
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
      const content: any[] = firstArray(((await contentRes.json().catch(() => ({}))) as any)?.data)
      const files: any[] = firstArray(((await filesRes.json().catch(() => ({}))) as any)?.data)

      spinner.stop(String(bloq.title ?? `#${args.id}`))

      if (args.json) { await writeJson({ bloq, content, files }); prompts.outro("Done"); return }

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
// memory status — GET /api/v6/memory/status on iris-api
//
// The first subcommand here that is actually about MEMORY rather than about bloqs.
// Epic #183588. Reports the audit state of the agent memory store: how many memories
// are confirmed, corroborated, unverified, stale, superseded, or predate the audit
// layer — and, separately, how many are old AND highly rated AND never revalidated.
//
// That last number is the one worth having. A census of 162 real memories found
// business decisions from March 2026 sitting at importance 9-10, still eligible for
// injection into any agent prompt, with nothing anywhere recording whether they were
// still true. This command is what makes that visible instead of inferable.
// ============================================================================

const MemoryStatusCommand = cmd({
  command: "status",
  describe: "audit the agent memory store — what is confirmed, unverified, stale, or aging",
  builder: (yargs) =>
    yargs
      .option("agent", { describe: "limit to one agent id", type: "number" })
      .option("days", { describe: "age threshold for the aging count", type: "number", default: 90 })
      .option("min-importance", { describe: "importance floor for the aging count", type: "number", default: 9 })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Memory Status")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(); if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Auditing…")
    try {
      const qs = new URLSearchParams({ user_id: String(userId) })
      if (args.agent) qs.set("agent_id", String(args.agent))
      qs.set("older_than_days", String(args.days))
      qs.set("min_importance", String(args["min-importance"]))

      const res = await irisFetch(`/api/v6/memory/status?${qs.toString()}`, {}, IRIS_API)
      const ok = await handleApiError(res, "Memory status")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const total = Number(data?.total ?? 0)
      spinner.stop(`${total} memor${total === 1 ? "y" : "ies"}`)

      if (args.json) { await writeJson(data); prompts.outro("Done"); return }

      const conf = (data?.confidence ?? {}) as Record<string, number>
      // Weakest first — the order is the point, and it matches the model's own ranking.
      const ORDER = ["superseded", "unaudited", "unverified", "stale", "corroborated", "confirmed"] as const
      const GLOSS: Record<string, string> = {
        superseded: "replaced by something newer — never injected",
        unaudited: "predates the audit layer — unknown, not wrong",
        unverified: "one automatic extraction, never confirmed",
        stale: "was true once; nothing has checked it since",
        corroborated: "several independent extractions agreed",
        confirmed: "a human said so, recently",
      }

      printDivider()
      // Always print every state, including at zero. A section that vanishes when empty
      // reads as "not measured", and those two look identical from the outside.
      for (const k of ORDER) {
        const n = Number(conf[k] ?? 0)
        const pct = total > 0 ? ` ${dim(`${Math.round((n / total) * 100)}%`)}` : ""
        console.log(`  ${String(n).padStart(5)}  ${bold(k.padEnd(13))}${pct}  ${dim(GLOSS[k] ?? "")}`)
      }
      printDivider()

      const aging = data?.aging ?? {}
      const agingCount = Number(aging?.count ?? 0)
      if (agingCount === 0) {
        console.log(`  ${success("none")} older than ${aging?.older_than_days ?? args.days} days at importance ≥ ${aging?.min_importance ?? args["min-importance"]} without validation`)
      } else {
        console.log(
          `  ${bold(String(agingCount))} memor${agingCount === 1 ? "y" : "ies"} older than ${aging.older_than_days} days ` +
          `at importance ≥ ${aging.min_importance}, ${bold("never revalidated")}`,
        )
        if (aging.oldest_days) console.log(`    ${dim(`oldest: ${aging.oldest_days} days`)}`)
        const topics: any[] = Array.isArray(aging.top_topics) ? aging.top_topics : []
        // The count alone is a dead end. Naming the topics is what `refresh` starts from.
        if (topics.length) {
          console.log(`    ${dim("mostly:")} ${topics.map((t) => `${t.topic} ${dim(`×${t.count}`)}`).join(dim(" · "))}`)
        }
      }
      printDivider()
      prompts.outro(dim(agingCount > 0 ? "iris memory status --json  ·  refresh is next" : "iris memory status --json"))
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
  // #180717 asked for the word ALIAS specifically, and it earned its place: `memory list`
  // returns byte-identical output to `bloqs list`, so anyone told this is "memory" reasonably
  // infers a durable agent memory store that can be written to and queried.
  //
  // As of #183588 there IS one, and `status` reads it — but list/show/add/compose still go to
  // bloqs, so the describe line has to say which half is which. Dropping the ALIAS warning
  // now that one real subcommand exists would be the worse error of the two: it would imply
  // all five talk to the same store.
  describe: "audit agent memory (status) — list/show/add/compose remain ALIASES of bloqs",
  builder: (yargs) =>
    yargs
      .command(MemoryStatusCommand)
      .command(MemoryListCommand)
      .command(MemoryShowCommand)
      .command(MemoryAddCommand)
      .command(MemoryComposeCommand)
      .demandCommand(),
  async handler() {},
})
