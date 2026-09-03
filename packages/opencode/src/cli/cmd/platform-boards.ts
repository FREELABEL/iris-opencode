import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, resolveUserId, writeJson, failNoOp} from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, basename } from "path"

// ============================================================================
// Sync helpers
// ============================================================================

const SYNC_DIR = ".iris/boards"

function resolveSyncDir(bloqId?: number): string {
  let dir = process.cwd()
  for (let i = 0; i < 10; i++) {
    if (existsSync(join(dir, "fl-docker-dev"))) {
      const base = join(dir, SYNC_DIR)
      return bloqId ? join(base, String(bloqId)) : base
    }
    const parent = join(dir, "..")
    if (parent === dir) break
    dir = parent
  }
  const base = join(process.cwd(), SYNC_DIR)
  return bloqId ? join(base, String(bloqId)) : base
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")
}

function itemFilename(item: Record<string, unknown>): string {
  const title = String(item.title ?? "item")
  return `${item.id}-${slugify(title)}.json`
}

function findLocalFile(dir: string, id: number): string | undefined {
  if (!existsSync(dir)) return undefined
  const prefix = `${id}-`
  const files = require("fs").readdirSync(dir).filter((f: string) => f.startsWith(prefix) && f.endsWith(".json"))
  return files.length > 0 ? join(dir, files[0]) : undefined
}

// ============================================================================
// Display helpers
// ============================================================================

function statusColor(status: string): string {
  const colors: Record<string, string> = {
    active: UI.Style.TEXT_SUCCESS,
    pending: UI.Style.TEXT_WARNING,
    approved: UI.Style.TEXT_INFO,
    rejected: UI.Style.TEXT_DANGER,
  }
  const c = colors[status?.toLowerCase()] ?? UI.Style.TEXT_DIM
  return `${c}${status}${UI.Style.TEXT_NORMAL}`
}

function printItem(item: Record<string, unknown>): void {
  const title = bold(String(item.title ?? `Item #${item.id}`))
  const id = dim(`#${item.id}`)
  const status = item.status ? `  ${statusColor(String(item.status))}` : ""
  const type = item.type ? `  ${dim(String(item.type))}` : ""
  console.log(`  ${title}  ${id}${status}${type}`)
  if (item.description) {
    console.log(`    ${dim(String(item.description).slice(0, 100))}`)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const BoardsListCommand = cmd({
  command: "list <bloq-id>",
  describe: "list items in a bloq/board",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 30 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Board Items — Bloq #${args["bloq-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading items…")

    try {
      const userId = await resolveUserId()
      if (!userId) {
        spinner.stop("Failed", 1)
        prompts.log.error("Could not resolve user ID. Set IRIS_USER_ID or run iris-login.")
        prompts.outro("Done")
        return
      }
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["bloq-id"]}/items?${params}`)
      const ok = await handleApiError(res, "List items")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const rawItems = data?.data?.items ?? data?.data?.data ?? data?.data ?? []
      const items: any[] = Array.isArray(rawItems) ? rawItems : Object.values(rawItems)
      spinner.stop(`${items.length} item(s)`)

      if (items.length === 0) {
        prompts.log.warn("No items found")
        prompts.outro(`Create one: ${dim("iris boards create")}`)
        return
      }

      printDivider()
      for (const item of items) {
        printItem(item)
        console.log()
      }
      printDivider()

      prompts.outro(dim("iris boards get <item-id>  |  iris boards pull <item-id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BoardsGetCommand = cmd({
  command: "get <id>",
  describe: "show board item details",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "item ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Board Item #${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`)
      const ok = await handleApiError(res, "Get item")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); process.exitCode = 1; return }

      const data = (await res.json()) as { data?: any }
      const item = data?.data ?? data

      if (args.json) {
        await writeJson(item)
        return
      }

      spinner!.stop(String(item.title ?? `Item #${item.id}`))

      printDivider()
      printKV("ID", item.id)
      printKV("Title", item.title)
      printKV("Type", item.type)
      printKV("Status", item.status)
      printKV("List ID", item.bloq_list_id)
      printKV("Created", item.created_at)
      // #158272: the public URL used to be printed once by `make-public` and then
      // unrecoverable from the CLI — `get` already fetched the field, it just never
      // showed it.
      printKV("Public", item.is_public ? (item.public_url ?? "yes") : "no")

      if (item.description) {
        console.log()
        console.log(`  ${dim("Description:")}`)
        console.log(`  ${String(item.description).split("\n").join("\n  ")}`)
      }

      if (item.content) {
        console.log()
        const contentStr = typeof item.content === "string" ? item.content : JSON.stringify(item.content)
        console.log(`  ${dim("Content:")} ${contentStr.slice(0, 200)}${contentStr.length > 200 ? "…" : ""}`)
      }

      console.log()
      printDivider()

      prompts.outro(dim(`iris boards pull ${args.id}  |  iris boards diff ${args.id}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const BoardsCreateCommand = cmd({
  command: "create",
  describe: "create a new board item",
  builder: (yargs) =>
    yargs
      .option("bloq-id", { describe: "bloq ID (required)", type: "number", demandOption: true })
      .option("title", { describe: "item title", type: "string" })
      .option("description", { describe: "item description", type: "string" })
      // Mirrors BloqItemController::VALID_ITEM_TYPES (bug #177261). Previously this
      // list omitted diary/vehicle, which the API accepts.
      .option("type", { describe: "item type", type: "string", choices: ["default", "research", "content", "diary", "vehicle", "task"], default: "default" })
      // Without this the API drops every new item into the bloq's default list.
      // `iris boards list <bloq>` shows the real list per item, so an item filed
      // "into a project" would silently land somewhere else and read as filed.
      .option("list-id", { describe: "target list ID within the bloq (default: the bloq's default list)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Board Item")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    let title = args.title
    if (!title) {
      title = (await prompts.text({
        message: "Item title",
        validate: (x) => (x && x.length > 0 ? undefined : "Required"),
      })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating item…")

    try {
      const userId = await resolveUserId()
      if (!userId) { spinner.stop("Failed — no user ID", 1); prompts.outro("Done"); return }

      // `|| "task"` here defaulted to a value the API's create validator rejected
      // outright (bug #177261). yargs already defaults this to "default".
      const payload: Record<string, unknown> = { title, content: args.description || title, type: args.type || "default" }
      // The API's create validator reads `list_id`, NOT `bloq_list_id`. Since the field was
      // not in its validation rules, Laravel discarded it silently, $listId came out null, and
      // every item fell through to the auto-created "Generated Content" list — while the
      // command printed an item ID and a success line.
      //
      // Measured 2026-08-28: `--list-id 1029` (Todo) left Todo at 0 items and took Generated
      // Content from 12 to 13. Found by a client's agent, which then could not file its own
      // bug reports into the right list.
      //
      // Both keys are sent: `list_id` is what the endpoint reads today, `bloq_list_id` is what
      // the update endpoint (which works) uses, so this stays correct if they converge.
      if (args["list-id"] != null) {
        payload.list_id = args["list-id"]
        payload.bloq_list_id = args["list-id"]
      }

      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["bloq-id"]}/items`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Create item")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const item = data?.data ?? data
      spinner.stop(`${success("✓")} Item created: ${bold(String(item.title ?? item.id))}`)

      printDivider()
      printKV("ID", item.id)
      printKV("Title", item.title)
      printDivider()

      prompts.outro(dim(`iris boards get ${item.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BoardsUpdateCommand = cmd({
  command: "update <id>",
  describe: "update a board item",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "item ID", type: "number", demandOption: true })
      .option("title", { describe: "new title", type: "string" })
      .option("content", { describe: "new item body (alias of --description)", type: "string" })
      .option("content-file", { describe: "read the item body from a file (use - for stdin)", type: "string" })
      .option("description", { describe: "new item body (writes `content`)", type: "string" })
      .option("status", { describe: "new status", type: "string" })
      .option("type", { describe: "new type", type: "string" })
      // `boards push` diffs only title/content/status/type, so an edited
      // bloq_list_id in a pulled file reports "Already in sync" and the item
      // never moves. This is the only way to relist an item from the CLI.
      .option("list-id", { describe: "move the item to this list ID", type: "number" })
      // Filing something in the wrong project is the normal case, not the exceptional one.
      // Before this the only remedy was to recreate the item, which changes its id and
      // breaks every cross-reference and public share URL pointing at it.
      .option("bloq-id", {
        describe: "move the item to this bloq (project) — refused if it would drop a PHI/sensitive boundary",
        type: "number",
      }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update Item #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    // The board item body lives in `content` (this is what `create` writes to).
    // Writing to `description` here was a silent no-op (#157528). --description
    // is kept as the historical spelling; --content is the honest name, and
    // --content-file avoids argv limits + shell escaping for long bodies (#178191).
    let body: string | undefined
    const bodyFlags = [args.content, args["content-file"], args.description].filter((v) => v != null)
    if (bodyFlags.length > 1) {
      prompts.log.error("Use only one of --content, --content-file, or --description.")
      prompts.outro("Done")
      return
    }
    if (args["content-file"]) {
      const path = String(args["content-file"])
      try {
        body = path === "-"
          ? readFileSync(0, "utf-8")
          : readFileSync(path, "utf-8")
      } catch (err) {
        prompts.log.error(`Could not read ${path}: ${err instanceof Error ? err.message : String(err)}`)
        prompts.outro("Done")
        return
      }
      // An empty file would silently blank the item body — make that explicit.
      if (!body.trim()) {
        prompts.log.error(`${path} is empty — refusing to blank the item body.`)
        prompts.outro("Done")
        return
      }
    } else if (args.content != null) {
      body = String(args.content)
    } else if (args.description != null) {
      body = String(args.description)
    }

    const payload: Record<string, unknown> = {}
    if (args.title) payload.title = args.title
    if (body != null) payload.content = body
    if (args.status) payload.status = args.status
    if (args.type) payload.type = args.type
    if (args["list-id"] != null) payload.bloq_list_id = args["list-id"]
    if (args["bloq-id"] != null) payload.bloq_id = args["bloq-id"]

    if (Object.keys(payload).length === 0) {
      failNoOp("update", "Use --title, --content, --content-file, --status, --type, or --list-id")
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Update item")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const item = data?.data ?? data
      const displayTitle = item.title ?? args.title ?? `Item #${args.id}`
      spinner.stop(`${success("✓")} Updated: ${bold(String(displayTitle))}`)

      printDivider()
      printKV("ID", item.id ?? args.id)
      printKV("Title", displayTitle)
      printKV("Status", item.status)
      printDivider()

      prompts.outro(dim(`iris boards get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BoardsPullCommand = cmd({
  command: "pull <id>",
  describe: "download board item JSON to local file",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "item ID", type: "number", demandOption: true })
      .option("output", { alias: "o", describe: "output file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull Item #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching item…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`)
      const ok = await handleApiError(res, "Pull item")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const item = data?.data ?? data

      const bloqId = item.bloq_list?.bloq_id ?? item.bloq_id
      const dir = resolveSyncDir(bloqId)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })

      const filename = args.output ?? itemFilename(item)
      const filepath = filename.startsWith("/") ? filename : join(dir, filename)

      writeFileSync(filepath, JSON.stringify(item, null, 2))
      spinner.stop(success("Pulled"))

      printDivider()
      printKV("Title", item.title)
      printKV("ID", item.id)
      printKV("Type", item.type)
      printKV("Status", item.status)
      printKV("Saved to", filepath)
      printDivider()

      prompts.outro(dim(`iris boards push ${args.id}  |  iris boards diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BoardsPushCommand = cmd({
  command: "push <id>",
  describe: "upload local board item JSON to API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "item ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push Item #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()

    try {
      // Search across all bloq subdirs for the file
      const baseDir = resolveSyncDir()
      let filepath = args.file

      if (!filepath) {
        // Check base dir first, then subdirs
        filepath = findLocalFile(baseDir, args.id)
        if (!filepath && existsSync(baseDir)) {
          const subdirs = require("fs").readdirSync(baseDir).filter((f: string) => {
            try { return require("fs").statSync(join(baseDir, f)).isDirectory() } catch { return false }
          })
          for (const sub of subdirs) {
            filepath = findLocalFile(join(baseDir, sub), args.id)
            if (filepath) break
          }
        }
      }

      if (!filepath || !existsSync(filepath)) {
        spinner.start("")
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris boards pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      spinner.start(`Pushing ${basename(filepath)}…`)

      const item = JSON.parse(readFileSync(filepath, "utf-8"))

      // Send ONLY fields the caller actually changed. Echoing back every field from
      // `pull` meant re-submitting values the user never touched — and if the API's
      // write validator has drifted from what the read path emits (e.g. type "task",
      // created by BugReportController but absent from the update enum), an unmodified
      // round-trip is rejected outright. See bug #177261.
      const liveRes = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`)
      const liveOk = await handleApiError(liveRes, "Fetch item")
      if (!liveOk) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const liveData = (await liveRes.json()) as { data?: any }
      const live = liveData?.data ?? liveData

      const payload: Record<string, unknown> = {}
      for (const f of ["title", "description", "content", "type", "status"]) {
        if (item[f] === undefined) continue
        if (JSON.stringify(item[f] ?? null) !== JSON.stringify(live?.[f] ?? null)) {
          payload[f] = item[f]
        }
      }

      if (Object.keys(payload).length === 0) {
        spinner.stop(success("Already in sync"))
        printDivider()
        printKV("Title", live?.title ?? `#${args.id}`)
        printKV("ID", args.id)
        printDivider()
        prompts.outro("Done")
        return
      }

      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      const ok = await handleApiError(res, "Push item")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const result = data?.data ?? data
      spinner.stop(success("Pushed"))

      printDivider()
      printKV("Title", result.title)
      printKV("ID", args.id)
      printKV("Status", result.status)
      printKV("From", filepath)
      printDivider()

      prompts.outro(dim(`iris boards diff ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BoardsDiffCommand = cmd({
  command: "diff <id>",
  describe: "compare local board item JSON vs live API",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "item ID", type: "number", demandOption: true })
      .option("file", { alias: "f", describe: "local JSON file path", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff Item #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Comparing…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`)
      const ok = await handleApiError(res, "Fetch item")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const live = data?.data ?? data

      // Search for local file
      const baseDir = resolveSyncDir()
      let filepath = args.file
      if (!filepath) {
        filepath = findLocalFile(baseDir, args.id)
        if (!filepath && existsSync(baseDir)) {
          const subdirs = require("fs").readdirSync(baseDir).filter((f: string) => {
            try { return require("fs").statSync(join(baseDir, f)).isDirectory() } catch { return false }
          })
          for (const sub of subdirs) {
            filepath = findLocalFile(join(baseDir, sub), args.id)
            if (filepath) break
          }
        }
      }

      if (!filepath || !existsSync(filepath)) {
        spinner.stop("Failed", 1)
        prompts.log.error(`Local file not found. Run: ${highlight(`iris boards pull ${args.id}`)}`)
        prompts.outro("Done")
        return
      }

      const local = JSON.parse(readFileSync(filepath, "utf-8"))

      const fields = ["title", "description", "type", "status", "sort_order", "is_public"]
      const changes: { field: string; live: unknown; local: unknown }[] = []

      for (const f of fields) {
        const liveVal = JSON.stringify(live[f] ?? null)
        const localVal = JSON.stringify(local[f] ?? null)
        if (liveVal !== localVal) {
          changes.push({ field: f, live: live[f], local: local[f] })
        }
      }

      // Compare content
      if (JSON.stringify(live.content ?? null) !== JSON.stringify(local.content ?? null)) {
        changes.push({ field: "content", live: "(changed)", local: "(changed)" })
      }

      // Compare attachments
      if (JSON.stringify(live.attachments ?? null) !== JSON.stringify(local.attachments ?? null)) {
        changes.push({ field: "attachments", live: "(changed)", local: "(changed)" })
      }

      spinner.stop(changes.length === 0 ? success("In sync") : `${changes.length} difference(s)`)

      printDivider()
      printKV("Item", live.title ?? `#${args.id}`)
      printKV("Type", live.type)
      console.log()

      if (changes.length === 0) {
        console.log(`  ${success("No differences")}`)
      } else {
        for (const c of changes) {
          console.log(`  ${UI.Style.TEXT_WARNING}~ ${c.field}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_DANGER}- live:  ${String(c.live ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_SUCCESS}+ local: ${String(c.local ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
        }
      }
      console.log()
      printDivider()

      if (changes.length > 0) {
        prompts.outro(dim(`iris boards push ${args.id}  — to push local changes live`))
      } else {
        prompts.outro("Done")
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BoardsDeleteCommand = cmd({
  command: "delete <id>",
  describe: "delete a board item",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "item ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Item #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirmed = await prompts.confirm({ message: `Delete item #${args.id}? This cannot be undone.` })
      if (!confirmed || prompts.isCancel(confirmed)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete item")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(`${success("✓")} Item #${args.id} deleted`)
      prompts.outro(dim("iris boards list <bloq-id>"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformBoardsCommand = cmd({
  command: "boards",
  describe: "manage bloq board items — list, pull, push, diff, CRUD",
  builder: (yargs) =>
    yargs
      .command(BoardsListCommand)
      .command(BoardsGetCommand)
      .command(BoardsCreateCommand)
      .command(BoardsUpdateCommand)
      .command(BoardsPullCommand)
      .command(BoardsPushCommand)
      .command(BoardsDiffCommand)
      .command(BoardsDeleteCommand)
      .demandCommand(),
  async handler() {},
})
