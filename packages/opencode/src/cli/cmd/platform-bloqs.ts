import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, FL_API, promptOrFail, MissingFlagError, isNonInteractive, cli } from "./iris-api"
import { executePublish } from "./bloq-item-shared"
import path from "path"

// ============================================================================
// Display helpers
// ============================================================================

// Frontend host. Override with IRIS_FRONTEND_URL.
function frontendBase(): string {
  return (process.env.IRIS_FRONTEND_URL ?? "https://web.heyiris.io").replace(/\/+$/, "")
}

// Canonical web URL for a bloq/board. The frontend serves clean routes
// /iris/bloq/:id, /iris/:id and /bloq/:id. Requires the viewer to already be
// logged in — use a share link (below) for a passwordless deep-link.
function bloqWebUrl(id: string | number): string {
  return `${frontendBase()}/iris/bloq/${id}`
}

// Passwordless tokenized auth link — anyone with this URL can claim access and
// is logged straight into the board. Consumed by pages/invite/_token.vue.
function inviteWebUrl(token: string): string {
  return `${frontendBase()}/invite/${token}`
}

// Mint a share-link token for a bloq (POST /api/v1/user/bloqs/:id/share-link).
// Mirrors CoreService.createBloqShareLink — the atomic source of this flow.
async function mintShareLink(
  bloqId: number,
  userId: number,
  opts: { permission?: string; expiresAt?: string | null; maxUses?: number | null } = {},
): Promise<{ token: string; permission: string; expires_at: string | null; max_uses: number | null }> {
  const res = await irisFetch(`/api/v1/user/bloqs/${bloqId}/share-link`, {
    method: "POST",
    body: JSON.stringify({
      permission: opts.permission ?? "viewer",
      expires_at: opts.expiresAt ?? null,
      max_uses: opts.maxUses ?? null,
      user_id: userId,
    }),
  })
  if (!res.ok) {
    await handleApiError(res, "Create share link")
    throw new Error(`share-link failed (${res.status})`)
  }
  const json = (await res.json()) as { data?: any }
  const data = json?.data ?? {}
  if (!data.token) throw new Error("share-link response had no token")
  return data
}

function openBrowser(url: string): boolean {
  try {
    const { execSync } = require("child_process")
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open"
    execSync(`${opener} "${url}"`, { stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

function printBloq(b: Record<string, unknown>): void {
  const name = bold(String(b.name ?? `Bloq #${b.id}`))
  const id = dim(`#${b.id}`)
  console.log(`  ${name}  ${id}`)
  if (b.description) {
    console.log(`    ${dim(String(b.description).slice(0, 100))}`)
  }
  // Compact summary from nested lists
  const lists = Array.isArray(b.lists) ? b.lists as any[] : []
  if (lists.length > 0) {
    const totalItems = lists.reduce((sum: number, l: any) => sum + (l.items?.length ?? 0), 0)
    const nonEmpty = lists.filter((l: any) => l.items?.length > 0)
    const parts: string[] = []
    parts.push(`${lists.length} lists`)
    if (totalItems > 0) parts.push(`${totalItems} items`)
    // Show non-empty list names
    if (nonEmpty.length > 0 && nonEmpty.length <= 4) {
      const listNames = nonEmpty.map((l: any) => `${l.name} (${l.items.length})`).join(", ")
      console.log(`    ${dim(parts.join(" · ") + "  —  " + listNames)}`)
    } else {
      console.log(`    ${dim(parts.join(" · "))}`)
    }
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const BloqsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your knowledge bases",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("search", { alias: "s", describe: "search bloqs by name", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    cli.empty()
    cli.intro("◈  IRIS Bloqs")

    const token = await requireAuth()
    if (!token) { cli.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { cli.outro("Done"); return }

    const spinner = cli.spinner()
    spinner.start("Loading bloqs…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit), simplified: "1" })
      if (args.search) params.set("search", args.search)
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs?${params}`)
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "List bloqs")
        cli.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any[] }
      let bloqs: any[] = data?.data ?? []
      // Client-side filter fallback if API doesn't support search param
      if (args.search && bloqs.length > 0) {
        const q = args.search.toLowerCase()
        bloqs = bloqs.filter((b) => {
          const name = String(b.name ?? "").toLowerCase()
          const desc = String(b.description ?? "").toLowerCase()
          return name.includes(q) || desc.includes(q)
        })
      }
      spinner.stop(`${bloqs.length} bloq(s)${args.search ? ` matching "${args.search}"` : ""}`)

      if (args.json) {
        console.log(JSON.stringify(bloqs, null, 2))
        return
      }

      if (bloqs.length === 0) {
        cli.log.warn("No bloqs found")
        cli.outro(`Create one: ${dim("iris bloqs create")}`)
        return
      }

      printDivider()
      for (const b of bloqs) {
        printBloq(b)
        console.log()
      }
      printDivider()

      cli.outro(
        `${dim("iris bloqs get <id>")}  ·  ${dim("iris bloqs ingest <id> <file>")}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsGetCommand = cmd({
  command: "get <id>",
  describe: "show bloq details and lists",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("files", { describe: "list files attached to this bloq", type: "boolean", default: false })
      .option("items", { describe: "show recent items across all lists", type: "boolean", default: false })
      .option("list", { describe: "show items in a specific list (by ID)", type: "number" })
      .option("limit", { describe: "max items to show (default 10)", type: "number", default: 10 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Bloq #${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}`)
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        await handleApiError(res, "Get bloq")
        if (!args.json) prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any }
      const b = data?.data ?? data
      if (!b || (!b.name && !b.id)) {
        if (spinner) spinner.stop("Empty response", 1)
        if (!args.json) prompts.outro("Done")
        return
      }

      // Fetch lists
      let lists: any[] = []
      const listsRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/lists`)
      if (listsRes.ok) {
        const listsData = (await listsRes.json()) as { data?: any[] }
        lists = listsData?.data ?? []
      }

      if (args.json) {
        console.log(JSON.stringify({ ...b, web_url: bloqWebUrl(b.id), lists }, null, 2))
        return
      }

      spinner!.stop(String(b.name ?? `Bloq #${b.id}`))

      printDivider()
      // Fetch items first to get accurate counts
      let allItems: any[] = []
      const itemsRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/items?per_page=500`)
      if (itemsRes.ok) {
        const itemsData = (await itemsRes.json()) as { data?: any }
        const raw = itemsData?.data
        allItems = Array.isArray(raw) ? raw : (raw?.items ?? [])
      }

      // Fetch bloq-scoped agents, contacts, files in parallel
      const extractArr = async (r: Response) => {
        if (!r.ok) return []
        const j = (await r.json()) as any
        return j?.data ?? j ?? []
      }
      const [agentsRes, leadsRes, filesRes, schedulesRes] = await Promise.all([
        irisFetch(`/api/v1/users/${userId}/bloqs/agents?bloq_id=${args.id}&per_page=50`),
        irisFetch(`/api/v1/users/${userId}/leads?bloq_id=${args.id}&per_page=50`),
        irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/files`),
        irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?per_page=50`),
      ])
      const [agents, leads, files, schedules] = await Promise.all([
        extractArr(agentsRes), extractArr(leadsRes), extractArr(filesRes), extractArr(schedulesRes),
      ])
      // Filter schedules to agents in this bloq
      const agentIds = new Set(agents.map((a: any) => a.id))
      const bloqSchedules = schedules.filter((s: any) => agentIds.has(s.agent_id))

      printKV("ID", b.id)
      printKV("Name", b.name)
      printKV("Description", b.description)
      printKV("Created", b.created_at)
      printKV("URL", bloqWebUrl(b.id))
      console.log()

      // Entity summary bar
      const parts: string[] = []
      if (lists.length > 0) parts.push(`${lists.length} lists`)
      const itemCount = allItems.length || b.items_count || 0
      if (itemCount > 0) parts.push(`${itemCount} items`)
      if (agents.length > 0) parts.push(`${agents.length} agents`)
      if (leads.length > 0) parts.push(`${leads.length} contacts`)
      if (bloqSchedules.length > 0) parts.push(`${bloqSchedules.length} schedules`)
      if (files.length > 0) parts.push(`${files.length} files`)
      if (parts.length > 0) {
        console.log(`  ${parts.join(dim("  ·  "))}`)
        console.log()
      }

      // Build per-list item counts from actual data
      const listItemCounts: Record<number, number> = {}
      for (const item of allItems) {
        const lid = item.bloq_list_id ?? item.list_id
        if (lid) listItemCounts[lid] = (listItemCounts[lid] ?? 0) + 1
      }

      if (lists.length > 0) {
        console.log(`  ${dim("Lists:")}`)
        for (const l of lists) {
          const count = listItemCounts[l.id] ?? l.items_count ?? 0
          console.log(`    ${dim("—")} ${bold(String(l.name ?? l.id))} ${dim(`#${l.id}`)} ${dim(`(${count} items)`)}`)
          // Show top 3 item previews per list
          const listItems = allItems.filter((i: any) => (i.bloq_list_id ?? i.list_id) === l.id)
          const preview = listItems.slice(0, 3)
          for (const item of preview) {
            const contentObj = typeof item.content === "object" && item.content ? item.content : null
            const rawContent = typeof item.content === "string" ? item.content : ""
            const title = (typeof item.title === "string" && item.title)
              || (contentObj?.title ? String(contentObj.title) : "")
              || (rawContent ? rawContent.replace(/[#\n]/g, " ").trim().slice(0, 80) : "(untitled)")
            console.log(`      ${dim("•")} ${title}`)
          }
          const remaining = listItems.length - preview.length
          if (remaining > 0) {
            console.log(`      ${dim(`+ ${remaining} more`)}`)
          }
        }
        console.log()
      }

      // Show items if --items or --list requested
      if (args.items || args.list) {
        const limit = args.limit ?? 10
        let displayItems = allItems

        if (args.list) {
          displayItems = allItems.filter((i: any) => (i.bloq_list_id ?? i.list_id) === args.list)
          const listName = lists.find((l: any) => l.id === args.list)?.name ?? `List #${args.list}`
          console.log(`  ${bold("Items")} in ${bold(listName)} ${dim(`(${displayItems.length} total, showing ${Math.min(limit, displayItems.length)})`)}`)
        } else {
          console.log(`  ${bold("Recent Items")} ${dim(`(${allItems.length} total, showing ${Math.min(limit, allItems.length)})`)}`)
        }

        const shown = displayItems.slice(0, limit)
        for (const item of shown) {
          const title = item.title ?? "(untitled)"
          const listName = item.list_name ?? lists.find((l: any) => l.id === (item.bloq_list_id ?? item.list_id))?.name ?? ""
          const content = String(item.content ?? "").replace(/\n/g, " ").slice(0, 120)
          const date = item.created_at ? dim(new Date(item.created_at).toLocaleDateString()) : ""
          console.log(`    ${dim(`#${item.id}`)}  ${bold(title)}  ${dim(listName)}  ${date}`)
          if (content) console.log(`      ${dim(content)}`)
          if (item.is_public && (item.public_url || item.public_uuid)) {
            console.log(`      ${dim("public:")} ${item.public_url ?? item.public_uuid}`)
          }
        }

        if (displayItems.length > limit) {
          console.log(`    ${dim(`... ${displayItems.length - limit} more`)}`)
        }
        console.log()
      }

      // Load files if requested
      if (args.files) {
        const filesRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/files`)
        if (filesRes.ok) {
          const filesData = (await filesRes.json()) as { data?: any[] }
          const files: any[] = filesData?.data ?? []
          if (files.length > 0) {
            console.log(`  ${dim("Files:")}`)
            for (const f of files) {
              const name = f.original_name ?? f.name ?? f.filename ?? `File #${f.id}`
              const size = f.size ? dim(`(${formatBytes(f.size)})`) : ""
              console.log(`    ${dim("—")} ${name} ${size}`)
            }
            console.log()
          } else {
            console.log(`  ${dim("Files: none")}`)
            console.log()
          }
        }
      }

      if (agents.length > 0) {
        console.log(`  ${dim("Agents:")} ${dim(`(${agents.length})`)}`)
        for (const a of agents.slice(0, 3)) {
          const status = a.active ? "active" : "paused"
          const hb = a.heartbeat_mode && a.heartbeat_mode !== "off" ? dim(` [heartbeat]`) : ""
          console.log(`    ${dim("•")} ${a.name} ${dim(`#${a.id}`)} ${dim(status)}${hb}`)
        }
        if (agents.length > 3) console.log(`    ${dim(`+ ${agents.length - 3} more`)}`)
        console.log()
      }

      if (leads.length > 0) {
        console.log(`  ${dim("Contacts:")} ${dim(`(${leads.length})`)}`)
        for (const l of leads.slice(0, 3)) {
          const status = l.status ? dim(l.status) : ""
          console.log(`    ${dim("•")} ${l.name ?? l.nickname ?? "Unknown"} ${dim(`#${l.id}`)} ${status}`)
        }
        if (leads.length > 3) console.log(`    ${dim(`+ ${leads.length - 3} more`)}`)
        console.log()
      }

      printDivider()

      const getOutro = (args.items || args.list)
        ? `${dim("iris bloqs make-public <item-id>")}  Publish an item + get a shareable link`
        : `${dim("iris bloqs open " + args.id)}  ·  ${dim("iris bloqs invite " + args.id)}  Passwordless invite link`
      prompts.outro(getOutro)
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const BloqsCreateCommand = cmd({
  command: "create",
  describe: "create a new knowledge base",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "bloq name", type: "string" })
      .option("description", { describe: "bloq description", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Bloq")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "Bloq name",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    // --description is optional. In a TTY we still prompt for it; in
    // non-interactive mode we silently default to empty string instead of
    // hanging.
    let description = args.description
    if (description === undefined) {
      if (isNonInteractive()) {
        description = ""
      } else {
        description = (await prompts.text({
          message: "Description (optional)",
          placeholder: "e.g. Company knowledge base for Q1 2026",
        })) as string
        if (prompts.isCancel(description)) description = ""
      }
    }

    const spinner = prompts.spinner()
    spinner.start("Creating bloq…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({ name, description }),
      })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Create bloq")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: { bloq?: any } }
      const b = data?.data?.bloq ?? data?.data ?? data
      spinner.stop(`${success("✓")} Bloq created: ${bold(String(b.name ?? b.id))}`)

      printDivider()
      printKV("ID", b.id)
      printKV("Name", b.name)
      printDivider()

      prompts.outro(
        `${dim("iris bloqs ingest " + b.id + " ./document.pdf")}  Add knowledge`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

/**
 * Auto-detect which CSV column should be used as the bloq item title.
 */
function detectTitleColumn(headers: string[], rows: Record<string, string>[]): string {
  const namePatterns = ["name", "title", "item", "product", "subject", "label", "horse", "rider"]
  for (const pattern of namePatterns) {
    const match = headers.find((h) => h.toLowerCase().includes(pattern))
    if (match) return match
  }
  // Fallback: first column with unique string values
  for (const h of headers) {
    const vals = rows.map((r) => r[h]).filter(Boolean)
    const unique = new Set(vals)
    if (unique.size === vals.length && vals.every((v) => typeof v === "string" && !/^\d+(\.\d+)?$/.test(v))) {
      return h
    }
  }
  return headers[0]
}

/**
 * Parse CSV text into an array of objects using the first row as headers.
 */
function parseCsv(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean)
  if (lines.length < 2) return { headers: [], rows: [] }

  // Simple CSV parser — handles quoted fields with commas
  const parseLine = (line: string): string[] => {
    const fields: string[] = []
    let current = ""
    let inQuotes = false
    for (let i = 0; i < line.length; i++) {
      const ch = line[i]
      if (ch === '"') {
        if (inQuotes && line[i + 1] === '"') { current += '"'; i++ }
        else inQuotes = !inQuotes
      } else if (ch === "," && !inQuotes) {
        fields.push(current.trim())
        current = ""
      } else {
        current += ch
      }
    }
    fields.push(current.trim())
    return fields
  }

  const headers = parseLine(lines[0])
  const rows = lines.slice(1).map((line) => {
    const vals = parseLine(line)
    const obj: Record<string, string> = {}
    headers.forEach((h, i) => { obj[h] = vals[i] ?? "" })
    return obj
  })

  return { headers, rows }
}

const BloqsIngestCommand = cmd({
  command: "ingest <id> <file>",
  describe: "upload a file into a bloq (CSV files are parsed into a dataset item)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("file", { describe: "path to file", type: "string", demandOption: true })
      .option("list", { alias: "l", describe: "target list name", type: "string" })
      .option("as", { describe: "CSV mode: dataset (single item, default) or items (one item per row)", type: "string", choices: ["dataset", "items"], default: "dataset" })
      .option("key", { describe: "column name for upsert dedup on re-import (--as items only)", type: "string" })
      .option("title-column", { describe: "column to use as item title (auto-detected if omitted)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Ingest into Bloq #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const filename = path.basename(args.file)
    const ext = path.extname(args.file).toLowerCase()

    const spinner = prompts.spinner()

    try {
      const file = Bun.file(args.file)
      if (!(await file.exists())) {
        spinner.stop("File not found", 1)
        prompts.log.error(`Cannot read: ${args.file}`)
        prompts.outro("Done")
        return
      }

      // CSV files: parse rows into a structured dataset bloq item
      if (ext === ".csv") {
        spinner.start(`Parsing ${dim(filename)}…`)
        const text = await file.text()
        const { headers, rows } = parseCsv(text)

        if (rows.length === 0) {
          spinner.stop("Empty CSV", 1)
          prompts.log.error("No data rows found in CSV")
          prompts.outro("Done")
          return
        }

        spinner.stop(`${success("✓")} Parsed ${rows.length} rows × ${headers.length} columns`)

        // Preview first 3 rows
        for (const row of rows.slice(0, 3)) {
          const preview = headers.slice(0, 4).map((h) => `${dim(h)}=${row[h] ?? ""}`).join("  ")
          console.log(`    ${preview}`)
        }
        if (rows.length > 3) console.log(`    ${dim(`…and ${rows.length - 3} more`)}`)
        console.log()

        // Resolve target list
        let listId: number | null = null
        const listsRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/lists`)
        if (listsRes.ok) {
          const listsData = (await listsRes.json()) as { data?: any[] }
          const lists: any[] = listsData?.data ?? []
          if (args.list) {
            const match = lists.find((l: any) => (l.name ?? "").toLowerCase() === args.list!.toLowerCase())
            if (match) listId = match.id
          }
          if (!listId && lists.length > 0) listId = lists[0].id
        }

        if (!listId) {
          spinner.stop("No list found", 1)
          prompts.log.error("Bloq has no lists. Create one first.")
          prompts.outro("Done")
          return
        }

        const mode = args.as as string

        // ── Mode: items — one bloq item per CSV row ──
        if (mode === "items") {
          const titleCol = args["title-column"] ?? detectTitleColumn(headers, rows)
          const keyCol = args.key ?? null

          // Fetch existing items for dedup if --key is specified
          let existingItems: any[] = []
          if (keyCol) {
            spinner.start(`Checking for existing items (dedup by ${dim(keyCol)})…`)
            const existRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/items?per_page=500`)
            if (existRes.ok) {
              const existData = (await existRes.json()) as { data?: any }
              const raw = existData?.data?.items ?? existData?.data?.data ?? existData?.data ?? []
              existingItems = Array.isArray(raw) ? raw : Object.values(raw)
            }
            spinner.stop(`${existingItems.length} existing item(s)`)
          }

          // Dedup
          let toCreate = rows
          let toUpdate: { item: any; row: Record<string, string> }[] = []
          if (keyCol && existingItems.length > 0) {
            for (const row of rows) {
              const keyVal = row[keyCol]
              if (!keyVal) { toCreate.push(row); continue }
              const match = existingItems.find((item: any) => {
                if (item.title === keyVal) return true
                try {
                  const c = typeof item.content === "string" ? JSON.parse(item.content) : item.content
                  if (c?.type === "dataset") return false
                  return c?.[keyCol] === keyVal
                } catch { return false }
              })
              if (match) toUpdate.push({ item: match, row })
            }
            // Remove matched rows from toCreate
            const matchedKeys = new Set(toUpdate.map((u) => u.row[keyCol]))
            toCreate = rows.filter((r) => !matchedKeys.has(r[keyCol]) || !r[keyCol])
          }

          spinner.start(`Creating ${toCreate.length} item(s)${toUpdate.length > 0 ? `, updating ${toUpdate.length}` : ""}…`)

          let created = 0
          let updated = 0
          let failed = 0

          // Create new items
          for (const row of toCreate) {
            const title = row[titleCol] || `Row ${created + 1}`
            const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/items`, {
              method: "POST",
              body: JSON.stringify({
                title,
                content: JSON.stringify(row),
                type: "default",
                bloq_list_id: listId,
              }),
            })
            if (res.ok) created++
            else failed++
          }

          // Update existing items
          for (const { item, row } of toUpdate) {
            const title = row[titleCol] || item.title
            const res = await irisFetch(`/api/v1/user/bloqs/list/item/${item.id}`, {
              method: "PUT",
              body: JSON.stringify({
                title,
                content: JSON.stringify(row),
              }),
            })
            if (res.ok) updated++
            else failed++
          }

          spinner.stop(`${success("✓")} ${created} created, ${updated} updated${failed > 0 ? `, ${failed} failed` : ""}`)

          printDivider()
          printKV("Mode", "items (one per row)")
          printKV("Title Column", titleCol)
          if (keyCol) printKV("Dedup Key", keyCol)
          printKV("Created", created)
          if (updated > 0) printKV("Updated", updated)
          if (failed > 0) printKV("Failed", failed)
          printDivider()

          prompts.outro(dim(`iris bloqs get ${args.id}`))
          return
        }

        // ── Mode: dataset (default) — single bloq item with all rows ──
        spinner.start(`Saving dataset to Bloq #${args.id}…`)

        const dataset = {
          type: "dataset",
          source_file: filename,
          headers,
          row_count: rows.length,
          rows,
        }

        const itemRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/items`, {
          method: "POST",
          body: JSON.stringify({
            title: filename.replace(/\.csv$/i, ""),
            content: JSON.stringify(dataset),
            type: "default",
            bloq_list_id: listId,
          }),
        })

        if (!itemRes.ok) {
          spinner.stop("Failed", 1)
          await handleApiError(itemRes, "Create dataset item")
          prompts.outro("Done")
          return
        }

        const itemData = (await itemRes.json()) as { data?: any }
        const item = itemData?.data ?? itemData
        spinner.stop(`${success("✓")} Dataset saved — ${rows.length} rows`)

        printDivider()
        printKV("Item ID", item?.id ?? "(unknown)")
        printKV("Type", "dataset")
        printKV("Rows", rows.length)
        printKV("Columns", headers.join(", "))
        printDivider()

        prompts.outro(dim(`iris bloqs get ${args.id}`))
        return
      }

      // Non-CSV files: upload as cloud file attachment (existing behavior)
      spinner.start(`Uploading ${dim(filename)}…`)

      const blob = await file.arrayBuffer()
      const formData = new FormData()
      formData.append("file", new Blob([blob]), filename)
      formData.append("user_id", String(userId))
      formData.append("bloq_id", String(args.id))

      const res = await fetch(`${FL_API}/api/v1/cloud-files/upload`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
        body: formData,
      })

      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Ingest file")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any; message?: string }
      spinner.stop(`${success("✓")} ${filename} ingested`)

      if (data?.data?.id) {
        prompts.log.info(`File ID: ${dim(String(data.data.id))}`)
      }

      prompts.outro(dim(`iris bloqs get ${args.id}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsAddItemCommand = cmd({
  command: "add-item <bloq-id> <list-id> [content]",
  describe: "add a text item to a bloq list",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("list-id", { describe: "list ID", type: "number", demandOption: true })
      .positional("content", { describe: "item content", type: "string" })
      .option("title", { describe: "item title", type: "string" })
      .option("text", { describe: "item content (alternative to positional)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add Item — Bloq #${args["bloq-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    let content = args.content ?? args.text
    if (!content) {
      try {
        content = (await promptOrFail("content", () =>
          prompts.text({
            message: "Content to add",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(content)) { prompts.outro("Cancelled"); return }
    }

    let title = args.title
    if (title === undefined) {
      if (isNonInteractive()) {
        title = ""
      } else {
        title = (await prompts.text({
          message: "Title (optional)",
          placeholder: "e.g. Meeting notes 2026-04-01",
        })) as string
        if (prompts.isCancel(title)) title = ""
      }
    }

    const spinner = prompts.spinner()
    spinner.start("Adding item…")

    try {
      const payload: Record<string, unknown> = { content }
      if (title) payload.title = title

      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/${args["bloq-id"]}/lists/${args["list-id"]}/items`,
        { method: "POST", body: JSON.stringify(payload) },
      )
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Add item")
        prompts.outro("Done")
        return
      }

      const addBody = (await res.json().catch(() => null)) as { data?: any; id?: any } | null
      const newItemId = addBody?.data?.id ?? addBody?.id
      spinner.stop(`${success("✓")} Item added${newItemId ? ` (#${newItemId})` : ""}`)
      const hint = newItemId
        ? `iris bloqs get ${args["bloq-id"]}  |  iris bloqs share ${newItemId}  (publish + get a shareable link)`
        : `iris bloqs get ${args["bloq-id"]}`
      prompts.outro(dim(hint))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsDeleteItemCommand = cmd({
  command: "delete-item <item-id>",
  aliases: ["rm-item", "remove-item"],
  describe: "delete an item from a bloq list (soft delete, recoverable)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to delete", type: "number", demandOption: true })
      .option("force", { describe: "skip confirmation", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Item #${args["item-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    if (!args.force && !isNonInteractive()) {
      const confirmed = await prompts.confirm({ message: "Delete this item? (soft delete — recoverable)" })
      if (prompts.isCancel(confirmed) || !confirmed) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting item…")

    try {
      const res = await irisFetch(
        `/api/v1/user/bloqs/list/item/${args["item-id"]}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Delete item")
        prompts.outro("Done")
        return
      }

      spinner.stop(`${success("✓")} Item deleted`)
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsPublishCommand = cmd({
  command: "publish <file>",
  aliases: ["publish-md"],
  describe: "publish a markdown file as a public bloq item (returns a shareable URL; re-run to sync)",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "path to a markdown (.md) file", type: "string", demandOption: true })
      .option("bloq", { describe: "target bloq ID (default: prompt, or auto 'Published Docs')", type: "number" })
      .option("list", { describe: "target list (ID or name; created if missing)", type: "string" })
      .option("title", { describe: "override the item title", type: "string" })
      .option("private", { describe: "create/update without making it public", type: "boolean", default: false })
      .option("no-frontmatter", { describe: "don't write iris_item_id/iris_public_url back into the file", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    await executePublish(args as any)
  },
})

const BloqsMakePublicCommand = cmd({
  command: "make-public <item-id>",
  aliases: ["share", "publish-item"],
  describe: "make a bloq item publicly shareable and print its public URL",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to share", type: "number", demandOption: true })
      .option("password", { describe: "gate the public link behind a password (min 6 chars)", type: "string" })
      .option("expires", { describe: "expiry as an ISO date/time (e.g. 2026-12-31)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) {
      UI.empty()
      prompts.intro(`◈  Share Item #${args["item-id"]}`)
    }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Making item public…")

    try {
      // Access ladder: a password gates the link (access_level=password); an
      // expiry makes it expiring. Backend derives access_level from these.
      const shareBody: Record<string, unknown> = {}
      if (args.password) shareBody.password = args.password
      if (args.expires) shareBody.expires_at = args.expires
      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/list/item/${args["item-id"]}/make-public`,
        { method: "POST", body: JSON.stringify(shareBody) },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Make public")
        prompts.outro("Done")
        return
      }

      const body = (await res.json()) as { data?: any }
      const data = body?.data ?? body
      const url = data?.public_url ?? null

      if (args.json) { console.log(JSON.stringify({ success: true, ...data })); return }

      const level = data?.access_level ?? (args.password ? "password" : args.expires ? "expiring" : "public")
      spinner?.stop(`${success("✓")} Item is now shareable (${level})`)
      if (url) {
        console.log()
        console.log(`  ${bold("Public URL")}  ${url}`)
        console.log(`  ${dim(`uuid: ${data?.public_uuid ?? "?"}`)}`)
        if (data?.requires_password ?? args.password) console.log(`  ${dim("🔒 password required to view")}`)
        if (args.expires) console.log(`  ${dim(`⏱ expires ${args.expires}`)}`)
        console.log()
      } else {
        prompts.log.warn("Item made public but no URL was returned")
      }
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsMakePrivateCommand = cmd({
  command: "make-private <item-id>",
  aliases: ["unshare"],
  describe: "revoke public sharing for a bloq item",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to unshare", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) {
      UI.empty()
      prompts.intro(`◈  Unshare Item #${args["item-id"]}`)
    }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Making item private…")

    try {
      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/list/item/${args["item-id"]}/make-private`,
        { method: "POST", body: "{}" },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Make private")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, is_public: false })); return }
      spinner?.stop(`${success("✓")} Item is now private`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsCreateListCommand = cmd({
  command: "create-list <bloq-id> <name>",
  aliases: ["add-list", "new-list"],
  describe: "create a new list on a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("name", { describe: "list name", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Create List on Bloq #${args["bloq-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Creating list…")

    try {
      const res = await irisFetch(
        `/api/v1/user/bloqs/${args["bloq-id"]}/lists`,
        {
          method: "POST",
          body: JSON.stringify({ name: args.name }),
        },
      )
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Create list")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any }
      const list = data?.data ?? data
      spinner.stop(`${success("✓")} List created: ${bold(args.name)} (ID: ${list.id})`)
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsMoveItemCommand = cmd({
  command: "move-item <item-id> <target-list-id>",
  describe: "move an item to a different list",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to move", type: "number", demandOption: true })
      .positional("target-list-id", { describe: "destination list ID", type: "number", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Move Item #${args["item-id"]} → List #${args["target-list-id"]}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Moving item…")

    try {
      const res = await irisFetch(
        `/api/v1/user/bloqs/list/item/${args["item-id"]}`,
        { method: "PUT", body: JSON.stringify({ bloq_list_id: args["target-list-id"] }) },
      )
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Move item")
        prompts.outro("Done")
        return
      }

      spinner.stop(`${success("✓")} Item moved to list #${args["target-list-id"]}`)
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsComposeCommand = cmd({
  command: "compose",
  describe: "create a knowledge base with AI-assisted structure",
  builder: (yargs) =>
    yargs
      .option("name", { describe: "bloq name", type: "string" })
      .option("description", { describe: "bloq description / topic", type: "string" })
      .option("lists", { describe: "number of lists to create", type: "number", default: 3 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Compose Knowledge Base")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    // Step 1: Get name
    let name = args.name
    if (!name) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "What is this knowledge base about?",
            placeholder: "e.g. Q1 2026 Marketing Strategy",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    // Step 2: Get description / topic for AI (optional — defaults to name in non-TTY)
    let description = args.description
    if (description === undefined) {
      if (isNonInteractive()) {
        description = name
      } else {
        description = (await prompts.text({
          message: "Describe what kind of content it will hold",
          placeholder: "e.g. Campaign plans, performance metrics, competitor research",
        })) as string
        if (prompts.isCancel(description)) description = name
      }
    }

    // Step 3: Confirm list structure
    const numLists = args.lists
    const suggestedLists = generateListSuggestions(name, description ?? "", numLists)

    prompts.log.info(`${bold("Suggested structure:")}`)
    for (let i = 0; i < suggestedLists.length; i++) {
      prompts.log.info(`  ${dim(`${i + 1}.`)} ${suggestedLists[i]}`)
    }

    let confirmed: boolean | symbol
    if (isNonInteractive()) {
      // Auto-confirm in non-interactive mode (compose is invoked deliberately)
      confirmed = true
    } else {
      confirmed = await prompts.confirm({
        message: "Create with this structure?",
      })
    }
    if (prompts.isCancel(confirmed) || !confirmed) {
      prompts.outro("Cancelled")
      return
    }

    // Step 4: Create bloq
    const spinner = prompts.spinner()
    spinner.start("Creating knowledge base…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({ name, description }),
      })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Create bloq")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: { bloq?: any } }
      const bloq = data?.data?.bloq ?? data?.data ?? data
      const bloqId = bloq.id

      // Step 5: Create lists
      let listsCreated = 0
      for (const listName of suggestedLists) {
        const listRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`, {
          method: "POST",
          body: JSON.stringify({ name: listName }),
        })
        if (listRes.ok) listsCreated++
      }

      spinner.stop(`${success("✓")} Created: ${bold(name)} with ${listsCreated} list(s)`)

      printDivider()
      printKV("ID", bloqId)
      printKV("Name", name)
      printKV("Lists", listsCreated)
      printDivider()

      prompts.outro(
        `${dim(`iris bloqs get ${bloqId}`)}  ·  ${dim(`iris bloqs ingest ${bloqId} ./file.pdf`)}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find", "q"],
  describe: "search bloqs by name or description",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "search term", type: "string", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    // Delegate to list with --search flag
    await BloqsListCommand.handler({ ...args, search: args.query } as any)
  },
})

const BloqsRenameCommand = cmd({
  command: "rename <type> <id> [name]",
  aliases: ["mv"],
  describe: "rename a bloq, list, or item",
  builder: (yargs) =>
    yargs
      .positional("type", { describe: "what to rename", choices: ["bloq", "list", "item"] as const, demandOption: true })
      .positional("id", { describe: "ID of the bloq/list/item", type: "number", demandOption: true })
      .positional("name", { describe: "new name", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Rename ${args.type} #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    let name = args.name as string | undefined
    if (!name) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "New name",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          prompts.log.error(err.message)
          prompts.outro("Done")
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start(`Renaming ${args.type}…`)

    try {
      let res: Response

      switch (args.type) {
        case "bloq":
          res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}`, {
            method: "PUT",
            body: JSON.stringify({ name }),
          })
          break
        case "list":
          res = await irisFetch(`/api/v1/user/${userId}/bloqs/list/${args.id}`, {
            method: "PATCH",
            body: JSON.stringify({ name }),
          })
          break
        case "item":
          res = await irisFetch(`/api/v1/user/bloqs/list/item/${args.id}`, {
            method: "PUT",
            body: JSON.stringify({ title: name }),
          })
          break
        default:
          spinner.stop("Invalid type", 1)
          prompts.outro("Done")
          return
      }

      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, `Rename ${args.type}`)
        prompts.outro("Done")
        return
      }

      spinner.stop(`${success("✓")} Renamed to: ${bold(name!)}`)
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Attach / Detach leads
// ============================================================================

const BloqsAttachLeadCommand = cmd({
  command: "attach-lead <bloq-id> <lead-id>",
  aliases: ["add-lead"],
  describe: "attach a lead to this bloq project",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Attach Lead #${args["lead-id"]} → Bloq #${args["bloq-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Attaching…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/attach-bloq`, {
        method: "POST",
        body: JSON.stringify({ bloq_id: args["bloq-id"] }),
      })
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Attach lead")
        prompts.outro("Done")
        return
      }

      const data = await res.json().catch(() => ({})) as Record<string, unknown>
      if (args.json) { console.log(JSON.stringify({ success: true, bloq_id: args["bloq-id"], lead_id: args["lead-id"], ...data })); return }

      if (spinner) spinner.stop(`${success("✓")} Lead #${args["lead-id"]} attached to Bloq #${args["bloq-id"]}`)
      prompts.outro(dim(`iris leads get ${args["lead-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsDetachLeadCommand = cmd({
  command: "detach-lead <bloq-id> <lead-id>",
  aliases: ["remove-lead"],
  describe: "detach a lead from this bloq project",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("lead-id", { describe: "lead ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Detach Lead #${args["lead-id"]} from Bloq #${args["bloq-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Detaching…")

    try {
      const res = await irisFetch(`/api/v1/leads/${args["lead-id"]}/detach-bloq`, {
        method: "POST",
        body: JSON.stringify({ bloq_id: args["bloq-id"] }),
      })
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Detach lead")
        prompts.outro("Done")
        return
      }

      const data = await res.json().catch(() => ({})) as Record<string, unknown>
      if (args.json) { console.log(JSON.stringify({ success: true, bloq_id: args["bloq-id"], lead_id: args["lead-id"], ...data })); return }

      if (spinner) spinner.stop(`${success("✓")} Lead #${args["lead-id"]} detached from Bloq #${args["bloq-id"]}`)
      prompts.outro(dim(`iris leads get ${args["lead-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Contributors — list leads attached to a bloq
// ============================================================================

const BloqsContributorsCommand = cmd({
  command: "contributors <bloq-id>",
  aliases: ["contacts", "leads"],
  describe: "list leads/contacts attached to this bloq project",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Bloq #${args["bloq-id"]} Contributors`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const userId = await requireUserId()
      if (!userId) { if (spinner) spinner.stop("Failed", 1); return }

      const res = await irisFetch(`/api/v1/users/${userId}/leads?bloq_id=${args["bloq-id"]}&per_page=100`)
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "List contributors")
        prompts.outro("Done")
        return
      }

      const data = await res.json() as Record<string, unknown>
      const leads: any[] = (data as any)?.data ?? (data as any)?.leads ?? (Array.isArray(data) ? data : [])

      if (args.json) { console.log(JSON.stringify(leads, null, 2)); return }

      if (spinner) spinner.stop(`${leads.length} contributor(s)`)

      if (leads.length === 0) {
        prompts.log.warn("No leads attached to this bloq")
        prompts.outro(dim(`iris bloqs attach-lead ${args["bloq-id"]} <lead-id>`))
        return
      }

      console.log()
      for (const lead of leads) {
        const name = lead.name ?? lead.full_name ?? lead.company_name ?? "Unknown"
        const email = lead.email ?? ""
        const status = lead.status ?? lead.pivot?.status ?? ""
        const idLabel = dim(`#${lead.id}`)
        const emailLabel = email ? `  ${dim("→")} ${email}` : ""
        const statusLabel = status ? `  ${dim(`[${status}]`)}` : ""
        console.log(`  ${bold(String(name))}  ${idLabel}${emailLabel}${statusLabel}`)
      }
      console.log()
      prompts.outro(dim(`iris bloqs attach-lead ${args["bloq-id"]} <lead-id>  |  iris bloqs detach-lead ${args["bloq-id"]} <lead-id>`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Items — list items in a bloq (with optional search)
// ============================================================================

const BloqsItemsCommand = cmd({
  command: "items <bloq-id>",
  describe: "list items in a bloq (optionally filter by list or search)",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("list", { alias: "l", describe: "filter by list ID", type: "number" })
      .option("search", { alias: "s", describe: "search items by keyword", type: "string" })
      .option("status", { describe: "filter by status", type: "string" })
      .option("limit", { describe: "max items to return", type: "number", default: 50 })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Bloq #${args["bloq-id"]} Items`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      // Get items via bloq get endpoint (includes all lists with items)
      {
        const fallbackRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["bloq-id"]}`)
        if (fallbackRes.ok) {
          const bloq = await fallbackRes.json() as Record<string, any>
          const lists = bloq?.data?.lists ?? bloq?.lists ?? []
          let allItems: any[] = []
          for (const list of lists) {
            const listItems = list.items ?? []
            for (const item of listItems) {
              allItems.push({ ...item, list_id: list.id, list_name: list.name })
            }
          }

          // Apply client-side filtering
          if (args.search) {
            const q = String(args.search).toLowerCase()
            allItems = allItems.filter((i: any) =>
              (i.title ?? "").toLowerCase().includes(q) ||
              (i.content ?? "").toLowerCase().includes(q)
            )
          }
          if (args.status) {
            allItems = allItems.filter((i: any) => i.status === args.status)
          }
          if (args.list) {
            allItems = allItems.filter((i: any) => i.list_id === args.list || i.bloq_list_id === args.list)
          }
          allItems = allItems.slice(0, args.limit as number)

          if (args.json) { console.log(JSON.stringify(allItems, null, 2)); return }

          if (spinner) spinner.stop(`${allItems.length} item(s)`)

          if (allItems.length === 0) {
            prompts.log.warn(args.search ? `No items matching "${args.search}"` : "No items found")
            prompts.outro("Done")
            return
          }

          console.log()
          for (const item of allItems) {
            const title = (item.title ?? item.content ?? "").slice(0, 80)
            const statusLabel = item.status && item.status !== "active" ? `  ${dim(`[${item.status}]`)}` : ""
            const listLabel = item.list_name ? dim(` (${item.list_name})`) : ""
            console.log(`  ${dim(`#${item.id}`)}  ${title}${statusLabel}${listLabel}`)
            if (item.is_public && (item.public_url || item.public_uuid)) {
              console.log(`      ${dim("public:")} ${item.public_url ?? item.public_uuid}`)
            }
          }
          console.log()
          prompts.outro(dim("iris bloqs share <id>  (publish + shareable link)  |  iris bloqs update-item <id> --status <status>"))
          return
        }

        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: "Failed to load bloq" })); return }
        prompts.log.error("Failed to load bloq items")
        prompts.outro("Done")
        return
      }
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Update item (status, title, content)
// ============================================================================

const BloqsUpdateItemCommand = cmd({
  command: "update-item <item-id>",
  aliases: ["edit-item"],
  describe: "update a bloq item (status, title, or content)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID", type: "number", demandOption: true })
      .option("status", { describe: "set item status (active, pending, approved, rejected, todo, in-progress, done)", type: "string" })
      .option("title", { describe: "new title", type: "string" })
      .option("content", { describe: "new content", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Update Item #${args["item-id"]}`) }

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    if (args.status) payload.status = args.status
    if (args.title) payload.title = args.title
    if (args.content) payload.content = args.content

    if (Object.keys(payload).length === 0) {
      prompts.log.error("Provide at least one of: --status, --title, --content")
      prompts.outro("Done")
      process.exitCode = 2
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args["item-id"]}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "Update item")
        prompts.outro("Done")
        return
      }

      const parts: string[] = []
      if (args.status) parts.push(`status → ${args.status}`)
      if (args.title) parts.push(`title updated`)
      if (args.content) parts.push(`content updated`)

      spinner.stop(`${success("✓")} Item #${args["item-id"]} updated (${parts.join(", ")})`)
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Helpers
// ============================================================================

function generateListSuggestions(name: string, description: string, count: number): string[] {
  const topic = (description || name).toLowerCase()

  // Common patterns based on topic keywords
  if (topic.includes("marketing") || topic.includes("campaign")) {
    return ["Strategy & Plans", "Content & Assets", "Performance Metrics"].slice(0, count)
  }
  if (topic.includes("product") || topic.includes("roadmap")) {
    return ["Features & Requirements", "Research & Insights", "Decisions & Notes"].slice(0, count)
  }
  if (topic.includes("client") || topic.includes("customer")) {
    return ["Client Profiles", "Communications", "Deliverables"].slice(0, count)
  }
  if (topic.includes("research") || topic.includes("analysis")) {
    return ["Sources & Data", "Key Findings", "Recommendations"].slice(0, count)
  }
  if (topic.includes("project")) {
    return ["Tasks & Milestones", "Documentation", "Meeting Notes"].slice(0, count)
  }

  // Generic fallback
  return ["Reference Material", "Notes & Insights", "Action Items"].slice(0, count)
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ============================================================================
// Root command
// ============================================================================

const BloqsOpenCommand = cmd({
  command: "open <id>",
  aliases: ["url"],
  describe: "print (and open) the web URL for a bloq board",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("share", { describe: "mint a passwordless invite link instead of the plain board URL", type: "boolean", default: false })
      .option("permission", { describe: "share permission (viewer|editor)", type: "string", default: "viewer", choices: ["viewer", "editor"] })
      .option("print", { describe: "only print the URL, don't open a browser", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    let url = bloqWebUrl(args.id)

    if (args.share) {
      const token = await requireAuth()
      if (!token) return
      const userId = await requireUserId(args["user-id"])
      if (!userId) return
      try {
        const link = await mintShareLink(args.id, userId, { permission: args.permission })
        url = inviteWebUrl(link.token)
      } catch (err) {
        prompts.log.error(err instanceof Error ? err.message : String(err))
        return
      }
    }

    // Always print the URL so it's pipeable / clickable in the terminal.
    console.log(url)
    if (!args.print) {
      const opened = openBrowser(url)
      if (!opened) prompts.log.warn("Could not launch a browser — open the URL above manually.")
    }
  },
})

const BloqsShareCommand = cmd({
  // NB: `share` is already an alias of `make-public` (item-level). Board-level
  // passwordless links live under `invite` / `share-link` to avoid collision.
  command: "invite <id>",
  aliases: ["share-link", "link"],
  describe: "mint a passwordless invite link (tokenized auth) for a bloq board",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("permission", { describe: "access granted to the link (viewer|editor)", type: "string", default: "viewer", choices: ["viewer", "editor"] })
      .option("expires", { describe: "expiry as an ISO date/time (e.g. 2026-12-31)", type: "string" })
      .option("max-uses", { describe: "max number of redemptions", type: "number" })
      .option("open", { describe: "also open the link in a browser", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return

    let link: { token: string; permission: string; expires_at: string | null; max_uses: number | null }
    try {
      link = await mintShareLink(args.id, userId, {
        permission: args.permission,
        expiresAt: args.expires ?? null,
        maxUses: args["max-uses"] ?? null,
      })
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      return
    }

    const url = inviteWebUrl(link.token)

    if (args.json) {
      console.log(JSON.stringify({ ...link, url, board_url: bloqWebUrl(args.id) }, null, 2))
      return
    }

    console.log(url)
    const meta: string[] = [`${link.permission} access`]
    if (link.expires_at) meta.push(`expires ${link.expires_at}`)
    if (link.max_uses) meta.push(`max ${link.max_uses} uses`)
    console.log(dim(`  ${meta.join("  ·  ")}`))

    if (args.open) {
      const opened = openBrowser(url)
      if (!opened) prompts.log.warn("Could not launch a browser — open the URL above manually.")
    }
  },
})

const BloqsLinksCommand = cmd({
  command: "links <id>",
  aliases: ["invites", "share-links"],
  describe: "list passwordless invite links for a bloq board",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const res = await irisFetch(`/api/v1/user/bloqs/${args.id}/share-links`)
    if (!res.ok) { await handleApiError(res, "List share links"); return }
    const json = (await res.json()) as { data?: any[] }
    const links = json?.data ?? []

    if (args.json) {
      console.log(JSON.stringify(links.map((l) => ({ ...l, url: inviteWebUrl(l.token) })), null, 2))
      return
    }

    if (links.length === 0) {
      console.log(dim(`  No invite links. Create one: iris bloqs invite ${args.id}`))
      return
    }
    printDivider()
    for (const l of links) {
      const active = l.is_usable ?? l.is_active
      const flag = active ? success("●") : dim("○")
      const meta: string[] = [String(l.permission)]
      if (l.expires_at) meta.push(`exp ${String(l.expires_at).slice(0, 10)}`)
      meta.push(`${l.use_count ?? 0}${l.max_uses ? `/${l.max_uses}` : ""} uses`)
      console.log(`  ${flag} ${dim(`#${l.id}`)}  ${inviteWebUrl(l.token)}`)
      console.log(`      ${dim(meta.join("  ·  "))}`)
    }
    printDivider()
    console.log(dim(`  Revoke: iris bloqs revoke-link ${args.id} <link-id>`))
  },
})

const BloqsRevokeLinkCommand = cmd({
  command: "revoke-link <id> <linkId>",
  aliases: ["revoke-invite"],
  describe: "revoke (deactivate) a bloq invite link",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("linkId", { describe: "share-link ID (from `iris bloqs links`)", type: "number", demandOption: true }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const res = await irisFetch(`/api/v1/user/bloqs/${args.id}/share-link/${args.linkId}`, { method: "DELETE" })
    if (!res.ok) { await handleApiError(res, "Revoke share link"); return }
    console.log(success(`Revoked invite link #${args.linkId}`))
  },
})

export const PlatformBloqsCommand = cmd({
  command: "bloqs",
  aliases: ["kb", "knowledge", "memory", "projects", "atlas"],
  describe: "manage knowledge bases (bloqs)",
  builder: (yargs) =>
    yargs
      .command(BloqsListCommand)
      .command(BloqsGetCommand)
      .command(BloqsOpenCommand)
      .command(BloqsShareCommand)
      .command(BloqsLinksCommand)
      .command(BloqsRevokeLinkCommand)
      .command(BloqsCreateCommand)
      .command(BloqsIngestCommand)
      .command(BloqsAddItemCommand)
      .command(BloqsDeleteItemCommand)
      .command(BloqsPublishCommand)
      .command(BloqsMakePublicCommand)
      .command(BloqsMakePrivateCommand)
      .command(BloqsCreateListCommand)
      .command(BloqsMoveItemCommand)
      .command(BloqsComposeCommand)
      .command(BloqsRenameCommand)
      .command(BloqsSearchCommand)
      .command(BloqsAttachLeadCommand)
      .command(BloqsDetachLeadCommand)
      .command(BloqsUpdateItemCommand)
      .command(BloqsContributorsCommand)
      .command(BloqsItemsCommand)
      .demandCommand(),
  async handler() {},
})
