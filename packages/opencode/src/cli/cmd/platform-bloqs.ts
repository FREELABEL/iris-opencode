import { cmd } from "./cmd"
import { AtlasUseCommand } from "./platform-atlas-use"
import { buildListEnvelope } from "./list-envelope"
import { federatedSearch, resolveSources, formatOutcomes } from "./federated-search"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, FL_API, promptOrFail, MissingFlagError, isNonInteractive, cli, writeJson } from "./iris-api"
import { itemTitle, itemContentPreview, matchesSearchQuery, normalizeDueDate } from "./bloq-item-format"
import { executePublish } from "./bloq-item-shared"
import { detectKind, parseDelimited, parseXlsx, parseDocx, parsePlain, titleFromHtml, inferSchema, type TableData, type ColumnSchema } from "./ingest-formats"
import { RELATION_TYPES, isValidRelationType, formatRelationsGrouped, type RelationRow } from "./bloq-relation-format"
import { createPageFromJson } from "./platform-pages"
import { BloqsExportCommand } from "./platform-bloq-export"
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
  opts: {
    permission?: string
    expiresAt?: string | null
    maxUses?: number | null
    // #179082 — address the link to a person, and/or narrow what it grants.
    email?: string | null
    scopeType?: string | null
    scopeId?: number | null
  } = {},
): Promise<{ token: string; permission: string; expires_at: string | null; max_uses: number | null }> {
  const res = await irisFetch(`/api/v1/user/bloqs/${bloqId}/share-link`, {
    method: "POST",
    body: JSON.stringify({
      permission: opts.permission ?? "viewer",
      expires_at: opts.expiresAt ?? null,
      max_uses: opts.maxUses ?? null,
      user_id: userId,
      email: opts.email ?? null,
      scope_type: opts.scopeType ?? null,
      scope_id: opts.scopeId ?? null,
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
      // #180633: the default listing excludes system bloqs — agent workspaces and `app:*`
      // client dashboards. That default is fine; being unable to see them at all was not.
      // On this account thirteen were withheld with nothing in the output to say so.
      .option("all", {
        describe: "include system bloqs (agent workspaces, app: dashboards)",
        type: "boolean",
        default: false,
      })
      .option("type", { describe: "filter by type: user or system", type: "string" })
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
      if (args.all) params.set("include_system", "1")
      if (args.type) params.set("type", String(args.type))
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs?${params}`)
      if (!res.ok) {
        spinner.stop("Failed", 1)
        await handleApiError(res, "List bloqs")
        cli.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any[]; total?: number; meta?: { total?: number } }
      let bloqs: any[] = data?.data ?? []
      // The index endpoint reports how many exist. Capture it — dropping it is what
      // made `bloqs list` look complete while withholding 117 of 137 boards.
      const serverTotal = data?.total ?? data?.meta?.total
      // Client-side filter (the API index endpoint returns all bloqs and ignores
      // the search param). Tokenize + AND the terms so a natural name like
      // "Mayo Life Atlas" matches a stored "MAYO — Life Atlas" — a raw substring
      // match can't span the separator the DB stores.
      if (args.search && bloqs.length > 0) {
        bloqs = bloqs.filter((b) =>
          matchesSearchQuery(`${b.name ?? ""} ${b.description ?? ""}`, args.search as string),
        )
      }
      spinner.stop(`${bloqs.length} bloq(s)${args.search ? ` matching "${args.search}"` : ""}`)

      if (args.json) {
        // Envelope, not a bare array: an agent must be able to see that it is
        // holding a page rather than an inventory. Client-side search filtering
        // above changes the count, so a filtered result reports its own size and
        // is never labelled truncated against the server total.
        await writeJson(
          buildListEnvelope(bloqs, {
            total: args.search ? bloqs.length : serverTotal,
            limit: args.search ? undefined : Number(args.limit),
            resource: "bloqs",
          }),
        )
        return
      }

      // #180633: say that the list is filtered. Previously a board you could open by ID was
      // simply absent here, which is indistinguishable from not having access to it — that is
      // how a working grant on bloq #600 read as a failed one. The hint is unconditional rather
      // than a count: the index endpoint does not report how many it withheld, and inventing a
      // number the server did not send would be worse than naming the flag.
      if (!args.all && !args.type) {
        cli.log.info(dim("system bloqs hidden (agent workspaces, app: dashboards) — see --all"))
      }

      if (bloqs.length === 0) {
        if (args.search) {
          cli.log.warn(`No bloqs matched "${args.search}"`)
          cli.outro(`Try fewer words or ${dim("iris bloqs list")}`)
        } else {
          cli.log.warn("No bloqs found")
          cli.outro(`Create one: ${dim("iris bloqs create")}`)
        }
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

/**
 * Resolve a bloq ID from a numeric ID or a name (#162334). Mirrors the leads
 * `get <name-or-id>` resolver so users who know a bloq's name but not its ID
 * have a path in. The bloqs index returns all of a user's bloqs, so we filter
 * client-side with the same tokenized matcher `bloqs search` uses. Returns the
 * numeric ID, or null (already having printed the reason) on no/ambiguous match.
 */
export async function resolveBloqId(idOrQuery: string | number, userId: number, json: boolean): Promise<number | null> {
  const numeric = Number(idOrQuery)
  if (Number.isInteger(numeric) && String(idOrQuery).trim() !== "") return numeric

  const query = String(idOrQuery)
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs?simplified=1&per_page=500`)
  if (!res.ok) {
    if (!json) prompts.log.error("Could not look up bloqs by name")
    process.exitCode = 1
    return null
  }
  const data = (await res.json()) as { data?: any[] }
  const matches = (data?.data ?? []).filter((b) => matchesSearchQuery(String(b.name ?? ""), query))

  if (matches.length === 0) {
    if (json) await writeJson({ error: `No bloq matched "${query}"` })
    else prompts.log.warn(`No bloq matched "${query}" — try ${dim("iris bloqs list")}`)
    process.exitCode = 1
    return null
  }
  if (matches.length === 1) return matches[0].id
  // Ambiguous — never guess. List candidates (non-interactive) or prompt.
  if (json || isNonInteractive()) {
    if (json) await writeJson({ error: "ambiguous", matches: matches.map((m) => ({ id: m.id, name: m.name })) })
    else {
      prompts.log.warn(`${matches.length} bloqs match "${query}" — specify by ID:`)
      for (const m of matches) prompts.log.info(`  #${m.id}  ${m.name ?? "Unknown"}`)
    }
    process.exitCode = 1
    return null
  }
  const choice = await prompts.select({
    message: "Which bloq?",
    options: matches.map((m) => ({ value: m.id, label: `#${m.id}  ${m.name ?? "Unknown"}` })),
  })
  if (prompts.isCancel(choice)) return null
  return choice as number
}

const BloqsGetCommand = cmd({
  command: "get <id>",
  describe: "show bloq details and lists (accepts a bloq ID or name)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID or name", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("files", { describe: "list files attached to this bloq", type: "boolean", default: false })
      .option("items", { describe: "show recent items across all lists", type: "boolean", default: false })
      .option("list", { describe: "show items in a specific list (by ID)", type: "number" })
      .option("limit", { describe: "max items to show (default 10)", type: "number", default: 10 })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Bloq ${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    // Resolve name → numeric ID (#162334). Numeric IDs pass straight through.
    const resolvedId = await resolveBloqId(args.id as any, userId, Boolean(args.json))
    if (resolvedId === null) { if (!args.json) prompts.outro("Done"); return }
    args.id = resolvedId as any

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

      // #181260 — a board's RELATIONS belong in `get`, not behind a command nobody runs.
      //
      // relate/relations already worked and the data was real: #571 carried six edges (a parent
      // company, a feeds_into, and three client projects hanging off it) and NOT ONE of them
      // appeared here. The graph was visible only to someone who already knew it existed, which
      // defeats the point of building it — you discover a board's neighbours by looking at the
      // board. Same shape as the capability index and the scaffold manifest: a thing that is
      // correct, present, and reaches nobody.
      //
      // Non-fatal by design. A board with no relations, or an endpoint that 404s, must not turn
      // `bloqs get` into an error — this is a decoration on the answer, not the answer.
      let relations: RelationRow[] = []
      try {
        const relRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/relations`)
        if (relRes.ok) {
          const relBody = (await relRes.json().catch(() => ({}))) as { data?: RelationRow[] }
          relations = relBody.data ?? []
        }
      } catch {
        // leave empty — see above
      }

      if (args.json) {
        // Included so an agent reading a board gets its neighbours in the SAME call. Having to
        // know to make a second request is the machine-readable version of the same bug.
        await writeJson({ ...b, web_url: bloqWebUrl(b.id), lists, relations })
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
            console.log(`      ${dim("•")} ${itemTitle(item)}`)
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
          const title = itemTitle(item)
          const listName = item.list_name ?? lists.find((l: any) => l.id === (item.bloq_list_id ?? item.list_id))?.name ?? ""
          const content = itemContentPreview(item, 120)
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

      // Printed AFTER lists/agents/contacts and before the divider: the board's own contents
      // come first, then what it connects to. Reuses the exact grouping `bloqs relations` uses,
      // so the two commands can never drift into describing the same edges differently.
      if (relations.length > 0) {
        console.log(`  ${dim("Related projects:")} ${dim(`(${relations.length})`)}`)
        console.log(formatRelationsGrouped(relations))
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
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Create Bloq") }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    let name = args.name
    if (!name && !args.slug) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "Bloq name",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          if (args.json) console.log(JSON.stringify({ success: false, error: err.message }))
          else { prompts.log.error(err.message); prompts.outro("Done") }
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
      if (isNonInteractive() || args.json) {
        description = ""
      } else {
        description = (await prompts.text({
          message: "Description (optional)",
          placeholder: "e.g. Company knowledge base for Q1 2026",
        })) as string
        if (prompts.isCancel(description)) description = ""
      }
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Creating bloq…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({ name, description }),
      })
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Create bloq")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: { bloq?: any } }
      const b = data?.data?.bloq ?? data?.data ?? data
      if (args.json) { console.log(JSON.stringify({ success: true, id: b.id, name: b.name })); return }
      spinner?.stop(`${success("✓")} Bloq created: ${bold(String(b.name ?? b.id))}`)

      printDivider()
      printKV("ID", b.id)
      printKV("Name", b.name)
      printDivider()

      prompts.outro(
        `${dim("iris bloqs ingest " + b.id + " ./document.pdf")}  Add knowledge`,
      )
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

/**
 * Rename a bloq.
 *
 * There was no way to do this from the CLI: `create` existed, `delete` existed, and a bloq
 * created with a name you later regretted could only be fixed in the web UI or by deleting and
 * recreating it — which loses the id every item, lead and agent already points at.
 *
 * The API accepts `name` only (BloqController@update validates exactly that), so this does not
 * pretend to edit anything else.
 */
const BloqsUpdateCommand = cmd({
  command: "update <id>",
  aliases: ["rename"],
  describe: "rename a bloq, or set its slug",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("name", { describe: "new bloq name", type: "string" })
      .option("slug", {
        describe: "URL slug — required for a booking page (lowercase-with-hyphens)",
        type: "string",
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Update Bloq ${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    let name = args.name
    if (!name) {
      try {
        name = (await promptOrFail("name", () =>
          prompts.text({
            message: "New bloq name",
            validate: (x) => (x && x.length > 0 ? undefined : "Required"),
          }),
        )) as string
      } catch (err) {
        if (err instanceof MissingFlagError) {
          if (args.json) console.log(JSON.stringify({ success: false, error: err.message }))
          else { prompts.log.error(err.message); prompts.outro("Done") }
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Updating bloq…")

    try {
      // Send only what was asked for. `slug` is what gives a bloq a booking page —
      // PublicBookingController resolves it with Bloq::where('slug', $slug), and until
      // fl-api validated the field this endpoint accepted it and silently dropped it (#181099).
      const payload: Record<string, unknown> = {}
      if (name) payload.name = name
      if (args.slug !== undefined) payload.slug = args.slug
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Update bloq")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any }
      const b = data?.data?.bloq ?? data?.data ?? data
      // Confirm against the RETURNED record, not the request. This endpoint used to answer
      // 200 with the full bloq while having written nothing.
      if (args.slug !== undefined && b && b.slug !== args.slug) {
        spinner?.stop("Not applied", 1)
        const msg = `The API accepted the request but the slug reads back as ${JSON.stringify(b.slug)}, not ${JSON.stringify(args.slug)}.`
        if (args.json) { console.log(JSON.stringify({ success: false, error: msg })); process.exitCode = 1; return }
        prompts.log.error(msg)
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: b?.id ?? args.id, name: b?.name ?? name, slug: b?.slug ?? args.slug })); return }
      spinner?.stop(`${success("✓")} Updated: ${bold(String(b?.name ?? name ?? b?.slug ?? args.slug))}`)

      printDivider()
      printKV("ID", b?.id ?? args.id)
      if (b?.name ?? name) printKV("Name", b?.name ?? name)
      if (b?.slug ?? args.slug) printKV("Slug", b?.slug ?? args.slug)
      printDivider()

      prompts.outro(`${dim("iris bloqs get " + (b?.id ?? args.id))}  View it`)
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
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


function truncate(v: string, n: number): string {
  return v.length > n ? v.slice(0, n - 1) + "…" : v
}

/**
 * The list an ingested item lands in.
 *
 * ASKING FOR A LIST AND SILENTLY GETTING A DIFFERENT ONE IS THE WORST OUTCOME HERE. The
 * previous resolution fell back to `lists[0]` whenever the name did not match, so
 * `--list "Ingest test"` quietly dropped a dataset into "Generated Content" and reported
 * success — measured, not hypothetical: item #181317 landed there during this command's
 * own test run. The data is not lost, but it is somewhere nobody will look for it, and the
 * output said it worked.
 *
 * So: a list you NAMED must exist, or this fails and tells you what does exist. The
 * first-list default applies only when you named nothing at all.
 */
async function resolveIngestList(
  userId: number,
  bloqId: number,
  want?: string,
): Promise<{ id: number } | { error: string }> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`)
  if (!res.ok) return { error: `Could not read the lists on bloq ${bloqId} (HTTP ${res.status}).` }
  const data = (await res.json()) as { data?: any[] }
  const lists: any[] = data?.data ?? []
  if (!lists.length) return { error: `Bloq ${bloqId} has no lists to ingest into.` }

  if (want !== undefined && String(want).trim() !== "") {
    const w = String(want).trim()
    // An id is unambiguous; a name is matched exactly, then case-insensitively.
    const byId = /^\d+$/.test(w) ? lists.find((l: any) => String(l.id) === w) : null
    const exact = lists.find((l: any) => String(l.name ?? "") === w)
    const loose = lists.find((l: any) => String(l.name ?? "").toLowerCase() === w.toLowerCase())
    const hit = byId ?? exact ?? loose
    if (!hit) {
      return {
        error:
          `No list "${w}" on bloq ${bloqId}. Nothing was written.\n  Lists here: ` +
          lists.slice(0, 12).map((l: any) => `${l.name} (${l.id})`).join(", ") +
          (lists.length > 12 ? `, …${lists.length - 12} more` : ""),
      }
    }
    return { id: hit.id }
  }
  return { id: lists[0].id }
}

const BloqsIngestCommand = cmd({
  command: "ingest <id> <file>",
  describe: "ingest a file into a bloq — CSV/Excel become datasets, MD/TXT/DOCX become documents, HTML becomes an artifact",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("file", { describe: "path to file", type: "string", demandOption: true })
      .option("list", { alias: "l", describe: "target list name", type: "string" })
      .option("as", { describe: "CSV mode: dataset (single item, default) or items (one item per row)", type: "string", choices: ["dataset", "items"], default: "dataset" })
      .option("key", { describe: "column name for upsert dedup on re-import (--as items only)", type: "string" })
      .option("title-column", { describe: "column to use as item title (auto-detected if omitted)", type: "string" })
      .option("title", { describe: "item title for a document/artifact (derived from the file if omitted)", type: "string" })
      .option("sheet", { describe: "which worksheet to read (.xlsx; default: the first)", type: "string" })
      .option("schema-only", { describe: "print the inferred schema and write nothing", type: "boolean", default: false })
      .option("yes", { describe: "accept the inferred schema without prompting", type: "boolean", default: false, alias: "y" })
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

      const kind = detectKind(args.file)

      // TABULAR — csv/tsv/xlsx all become the same {headers, rows}, so everything
      // downstream (dataset item, --as items, --key upsert) is shared rather than
      // reimplemented per format.
      if (kind === "table") {
        spinner.start(`Reading ${dim(filename)}…`)
        let table: TableData
        try {
          if (ext === ".xlsx" || ext === ".xlsm" || ext === ".xls") {
            table = await parseXlsx(args.file, args.sheet)
          } else {
            table = parseDelimited(await file.text(), ext === ".tsv" ? "\t" : ",")
          }
        } catch (e) {
          spinner.stop("Could not read the file", 1)
          prompts.log.error(e instanceof Error ? e.message : String(e))
          prompts.outro("Done")
          return
        }
        const { headers, rows } = table

        if (rows.length === 0) {
          spinner.stop("No rows", 1)
          prompts.log.error(`No data rows found in ${filename}. A header row alone is not a dataset.`)
          prompts.outro("Done")
          return
        }

        spinner.stop(`${success("✓")} Read ${rows.length} rows × ${headers.length} columns`)

        // A workbook with several sheets: say which one was read. Importing sheet 1 and
        // reporting success would let the other sheets disappear without a word.
        if (table.sheets && table.sheets.length > 1) {
          console.log(`    ${dim(`sheet "${table.sheetUsed}" of ${table.sheets.length}: ${table.sheets.join(", ")}`)}`)
          console.log(`    ${dim(`only this sheet was read — re-run with --sheet "<name>" for another`)}`)
        }
        console.log()

        // ── STEP ONE: the schema, before anything is written ──────────────────
        // The old preview printed three rows, which shows the DATA and hides the SHAPE.
        // A column that is 80% blank, or a date column Excel handed over as a number,
        // is invisible in three rows and obvious in a schema.
        const schema: ColumnSchema[] = inferSchema(headers, rows)
        console.log(`  ${bold("Schema")} ${dim(`— inferred from ${Math.min(rows.length, 500)} rows`)}`)
        console.log(`  ${dim("─".repeat(58))}`)
        for (const c of schema) {
          const flags: string[] = []
          if (c.blank) flags.push(`${Math.round((c.blank / Math.min(rows.length, 500)) * 100)}% blank`)
          if (c.type !== "empty" && c.distinct <= 12 && rows.length > 20) flags.push(`${c.distinct} values`)
          const name = c.name.length > 24 ? c.name.slice(0, 23) + "…" : c.name
          // Pad on the PLAIN strings; padEnd counts ANSI escape bytes as width and the
          // columns drift apart by however many colour codes each row happens to carry.
          const flagText = flags.join(", ")
          console.log(
            `  ${name.padEnd(24)} ${c.type.padEnd(9)}${" ".repeat(Math.max(1, 22 - flagText.length))}` +
            `${dim(flagText)}  ${dim(c.sample ? "e.g. " + truncate(c.sample, 22) : "")}`,
          )
        }
        console.log(`  ${dim("─".repeat(58))}`)
        const emptyCols = schema.filter((c) => c.type === "empty")
        if (emptyCols.length) {
          console.log(`  ${dim(`${emptyCols.length} column(s) are entirely empty: ${emptyCols.map((c) => c.name).join(", ")}`)}`)
        }
        console.log()

        // --schema-only stops here: read the shape, fix the file, run it again. Nothing
        // was written, so there is nothing to undo.
        if (args["schema-only"]) {
          prompts.log.info("Schema only — nothing was written.")
          prompts.outro(dim(`ingest for real: iris atlas ingest ${args.id} ${JSON.stringify(args.file)}`))
          return
        }

        // ── STEP TWO: confirm, then write ────────────────────────────────────
        if (!args.yes) {
          if (isNonInteractive()) {
            prompts.log.error("Refusing to import unconfirmed in a non-interactive shell.")
            prompts.log.info("Re-run with --yes to accept this schema, or --schema-only to inspect it.")
            prompts.outro("Done")
            process.exitCode = 1
            return
          }
          const ok = await prompts.confirm({ message: `Import ${rows.length} rows with this schema?` })
          if (!ok || typeof ok === "symbol") {
            prompts.log.info("Nothing was written.")
            prompts.outro("Done")
            return
          }
        }

        // Resolve target list
        // Same resolution the document path uses — a named list that does not exist is an
        // error here too, not a quiet redirect into whichever list happens to be first.
        const resolvedList = await resolveIngestList(userId, args.id, args.list)
        const listId: number | null = "error" in resolvedList ? null : resolvedList.id

        if (!listId) {
          spinner.stop("No list", 1)
          prompts.log.error("error" in resolvedList ? resolvedList.error : "Bloq has no lists. Create one first.")
          process.exitCode = 1
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

        // POSTED TO THE LIST, not to the bloq with the list in the body.
        //
        // `/bloqs/{id}/items` with `bloq_list_id` in the payload does not honour it: the
        // dataset lands in whatever list the server picks (observed: "Generated Content")
        // while the CLI reports the list you asked for. The list-scoped route puts the item
        // where the path says, and is the same one the document/artifact path uses — one
        // create route for every kind of ingest, so this cannot drift again.
        const itemRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/lists/${listId}/items`, {
          method: "POST",
          body: JSON.stringify({
            title: (args.title as string) || filename.replace(/\.(csv|tsv|xlsx|xlsm|xls)$/i, ""),
            content: JSON.stringify(dataset),
            type: "default",
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

      // DOCUMENT / ARTIFACT — becomes a real Atlas item with a body, not a blob.
      //
      // Previously a .md, .docx or .html file uploaded as an attachment: it existed in the
      // bloq, and was unsearchable, unreadable by an agent, and impossible to share as a
      // page. The content is right there in the file; storing it as an opaque upload was a
      // decision not to read it.
      if (kind === "document" || kind === "artifact") {
        spinner.start(`Reading ${dim(filename)}…`)
        let content = ""
        let derivedTitle: string | null = null
        let contentFormat: "html" | undefined

        try {
          if (kind === "artifact") {
            content = await file.text()
            derivedTitle = titleFromHtml(content, args.file)
            contentFormat = "html"
          } else if (ext === ".docx") {
            const d = await parseDocx(args.file)
            content = d.markdown
            derivedTitle = d.title
          } else {
            const d = parsePlain(args.file)
            content = d.markdown
            derivedTitle = d.title
          }
        } catch (e) {
          spinner.stop("Could not read the file", 1)
          prompts.log.error(e instanceof Error ? e.message : String(e))
          prompts.log.info("If this is not really that format, ingest it as an attachment by renaming it.")
          prompts.outro("Done")
          return
        }

        if (!content.trim()) {
          spinner.stop("Nothing to store", 1)
          prompts.log.error(`${filename} has no readable text content.`)
          prompts.outro("Done")
          return
        }

        const title = (args.title as string) || derivedTitle || path.basename(args.file, ext)
        spinner.stop(`${success("✓")} Read ${content.length.toLocaleString()} characters`)
        console.log(`    ${dim("title:")} ${title}`)
        console.log(`    ${dim("stored as:")} ${contentFormat === "html" ? "HTML artifact" : "document (markdown)"}`)
        console.log()

        const resolved = await resolveIngestList(userId, args.id, args.list)
        if ("error" in resolved) {
          prompts.log.error(resolved.error)
          prompts.outro("Done")
          process.exitCode = 1
          return
        }
        const listId = resolved.id

        spinner.start("Creating item…")
        const payload: Record<string, unknown> = { title, content }
        if (contentFormat) payload.content_format = contentFormat
        const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/lists/${listId}/items`, {
          method: "POST",
          body: JSON.stringify(payload),
        })
        if (!res.ok) {
          spinner.stop("Failed", 1)
          await handleApiError(res, "Create item")
          prompts.outro("Done")
          return
        }
        const body = (await res.json()) as { data?: any }
        const item = body?.data?.data ?? body?.data ?? body
        spinner.stop(`${success("✓")} ${filename} ingested`)

        printDivider()
        printKV("Item ID", item?.id ?? "(unknown)")
        printKV("Type", contentFormat === "html" ? "artifact (html)" : "document")
        printKV("Characters", content.length.toLocaleString())
        printDivider()
        prompts.outro(dim(item?.id ? `iris atlas make-public ${item.id}` : `iris bloqs get ${args.id}`))
        return
      }

      // Anything else: upload as a cloud file attachment (existing behaviour).
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
      .option("due", { describe: "due date (ISO, e.g. 2026-07-22)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Add Item — Bloq #${args["bloq-id"]}`) }

    // Validate --due up front so we fail fast with a clear message.
    let dueDate: string | undefined
    if (args.due !== undefined && args.due !== "") {
      const normalized = normalizeDueDate(args.due as string)
      if (!normalized) {
        const emsg = `Invalid --due date "${args.due}" — use YYYY-MM-DD (e.g. 2026-07-22)`
        if (args.json) console.log(JSON.stringify({ success: false, error: emsg }))
        else { prompts.log.error(emsg); prompts.outro("Done") }
        process.exitCode = 2
        return
      }
      dueDate = normalized
    }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

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
          if (args.json) console.log(JSON.stringify({ success: false, error: err.message }))
          else { prompts.log.error(err.message); prompts.outro("Done") }
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(content)) { prompts.outro("Cancelled"); return }
    }

    let title = args.title
    if (title === undefined) {
      if (isNonInteractive() || args.json) {
        title = ""
      } else {
        title = (await prompts.text({
          message: "Title (optional)",
          placeholder: "e.g. Meeting notes 2026-04-01",
        })) as string
        if (prompts.isCancel(title)) title = ""
      }
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Adding item…")

    try {
      const payload: Record<string, unknown> = { content }
      if (title) payload.title = title
      if (dueDate) payload.due_date = dueDate

      // ROUTE: the list id goes in the BODY, not the path.
      //
      // This used to POST to /user/{u}/bloqs/{b}/lists/{l}/items, which resolved to a route
      // defined as a CLOSURE. Closure routes are serialized into the route cache and signed with
      // APP_KEY, so once that signature stopped verifying every call returned a bare 500 —
      // "SerializableClosure: might have been modified or unsafe to unserialize" in fl-api's log,
      // with nothing in the response to say so. The path is also gone from routes/api.php now and
      // survived only in a stale cache, so it was one `route:cache` away from becoming a 404.
      //
      // BloqItemController@storeForBloq is a real controller method and takes list_id in the
      // body. `type` is required by its validator; 'default' is the ordinary note.
      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/${args["bloq-id"]}/items`,
        {
          method: "POST",
          body: JSON.stringify({ ...payload, list_id: args["list-id"], type: "default" }),
        },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Add item")
        prompts.outro("Done")
        return
      }

      const addBody = (await res.json().catch(() => null)) as { data?: any; id?: any } | null
      // Bug #178531: the create endpoint historically double-nested its envelope
      // ({ data: { data: { id } } }) while every sibling create returns { data: { id } },
      // so add-item reported `id: null`. fl-api now single-nests; keep the deep path as a
      // fallback so the CLI still reports the id against an un-deployed API.
      const newItemId = addBody?.data?.id ?? addBody?.data?.data?.id ?? addBody?.id
      if (args.json) { console.log(JSON.stringify({ success: true, id: newItemId ?? null, bloq_id: args["bloq-id"], list_id: args["list-id"] })); return }
      spinner?.stop(`${success("✓")} Item added${newItemId ? ` (#${newItemId})` : ""}`)
      const hint = newItemId
        ? `iris bloqs get ${args["bloq-id"]}  |  iris bloqs share ${newItemId}  (publish + get a shareable link)`
        : `iris bloqs get ${args["bloq-id"]}`
      prompts.outro(dim(hint))
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsDeleteItemCommand = cmd({
  command: "delete-item <item-id>",
  aliases: ["rm-item", "remove-item"],
  describe: "delete an item from a bloq list (soft delete — restore with: iris bloqs restore-item <id>)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to delete", type: "number", demandOption: true })
      .option("force", { describe: "skip confirmation (required in a non-interactive shell)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    // Bug #162343: a destructive command must NOT proceed silently when there is
    // no TTY to confirm at. Mirror add-item's non-interactive guard: refuse unless
    // --force is explicitly passed.
    if (!args.force && isNonInteractive()) {
      const msg = "Refusing to delete without --force in a non-interactive shell. Re-run with --force."
      if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 2
      return
    }

    if (!args.json) { UI.empty(); prompts.intro(`◈  Delete Item #${args["item-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    if (!args.force && !isNonInteractive()) {
      const confirmed = await prompts.confirm({ message: "Delete this item? (soft delete — recoverable)" })
      if (prompts.isCancel(confirmed) || !confirmed) { prompts.outro("Cancelled"); return }
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Deleting item…")

    try {
      const res = await irisFetch(
        `/api/v1/user/bloqs/list/item/${args["item-id"]}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Delete item")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: args["item-id"], deleted: true })); return }
      spinner?.stop(`${success("✓")} Item deleted`)
      prompts.outro(dim(`iris bloqs restore-item ${args["item-id"]}  (undo)`))
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// Restore a soft-deleted item — the recovery path promised by delete-item (#162346).
const BloqsRestoreItemCommand = cmd({
  command: "restore-item <item-id>",
  aliases: ["undelete-item"],
  describe: "restore a soft-deleted bloq item",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to restore", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Restore Item #${args["item-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Restoring item…")

    try {
      const res = await irisFetch(
        `/api/v1/user/bloqs/list/item/${args["item-id"]}/restore`,
        { method: "POST", body: "{}" },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Restore item")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: args["item-id"], restored: true })); return }
      spinner?.stop(`${success("✓")} Item #${args["item-id"]} restored`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// Delete a whole bloq/board (#162347). Soft delete — data preserved server-side.
const BloqsDeleteCommand = cmd({
  command: "delete <bloq-id>",
  aliases: ["rm", "delete-bloq"],
  describe: "delete a bloq/board (soft delete — data preserved server-side)",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID to delete", type: "number", demandOption: true })
      .option("force", { describe: "skip confirmation (required in a non-interactive shell)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    // Bug #162343/#162347: same non-interactive safety guard as delete-item.
    if (!args.force && isNonInteractive()) {
      const msg = "Refusing to delete a bloq without --force in a non-interactive shell. Re-run with --force."
      if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 2
      return
    }

    if (!args.json) { UI.empty(); prompts.intro(`◈  Delete Bloq #${args["bloq-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    if (!args.force && !isNonInteractive()) {
      const confirmed = await prompts.confirm({ message: `Delete bloq #${args["bloq-id"]} and all its lists/items? (soft delete)` })
      if (prompts.isCancel(confirmed) || !confirmed) { prompts.outro("Cancelled"); return }
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Deleting bloq…")

    try {
      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/${args["bloq-id"]}`,
        { method: "DELETE" },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Delete bloq")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: args["bloq-id"], deleted: true })); return }
      spinner?.stop(`${success("✓")} Bloq #${args["bloq-id"]} deleted`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsPublishCommand = cmd({
  command: "publish <file>",
  aliases: ["publish-md"],
  describe: "publish a markdown file or HTML artifact as a public bloq item (returns a shareable URL; re-run to sync)",
  builder: (yargs) =>
    yargs
      .positional("file", { describe: "path to a markdown (.md) file", type: "string", demandOption: true })
      .option("bloq", { describe: "target bloq ID (default: prompt, or auto 'Published Docs')", type: "number" })
      .option("list", { describe: "target list (ID or name; created if missing)", type: "string" })
      .option("title", { describe: "override the item title", type: "string" })
      .option("private", { describe: "create/update without making it public", type: "boolean", default: false })
      .option("force", { describe: "overwrite even if the item was edited in the UI after the last publish", type: "boolean", default: false })
      .option("format", { describe: "content format: html or markdown (default: from the file extension)", type: "string", choices: ["html", "markdown"] })
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

    // Enforce the documented password minimum client-side (#162350) so a weak
    // share-link password fails fast with a clear message, matching the server's
    // min:6 — validate before auth/network since it's purely input validation.
    if (args.password !== undefined && String(args.password).length < 6) {
      if (args.json) { console.log(JSON.stringify({ success: false, error: "Password must be at least 6 characters" })); return }
      prompts.log.error("Password must be at least 6 characters")
      prompts.outro("Done")
      return
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
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Create List on Bloq #${args["bloq-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Creating list…")

    try {
      const res = await irisFetch(
        `/api/v1/user/bloqs/${args["bloq-id"]}/lists`,
        {
          method: "POST",
          body: JSON.stringify({ name: args.name }),
        },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Create list")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { data?: any }
      const list = data?.data ?? data
      if (args.json) { console.log(JSON.stringify({ success: true, id: list.id, name: args.name, bloq_id: args["bloq-id"] })); return }
      spinner?.stop(`${success("✓")} List created: ${bold(args.name)} (ID: ${list.id})`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

/**
 * Rename a list (#180584).
 *
 * There was create-list and nothing else, so a typo or a duplicate was permanent from the CLI —
 * while ITEMS had delete-item and restore-item. The endpoints existed the whole time; only the
 * surface was missing.
 */
const BloqsRenameListCommand = cmd({
  command: "rename-list <list-id> <name>",
  aliases: ["update-list"],
  describe: "rename a list on a bloq",
  builder: (yargs) =>
    yargs
      .positional("list-id", { describe: "list ID", type: "number", demandOption: true })
      .positional("name", { describe: "new list name", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Rename List #${args["list-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Renaming…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/list/${args["list-id"]}`, {
        method: "PATCH",
        body: JSON.stringify({ name: args.name, title: args.name }),
      })
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Rename list")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: args["list-id"], name: args.name })); return }
      spinner?.stop(`${success("✓")} Renamed to ${bold(args.name)}`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

/**
 * Delete a list (#180584).
 *
 * Deliberately more careful than create-list, because the two are not mirror images: creating a
 * list costs nothing, and deleting one takes ITS ITEMS WITH IT. So this refuses a non-empty list
 * unless --force, and says how many items it would take — a count is the one thing that turns
 * "delete list 1964" from a guess into a decision.
 */
const BloqsDeleteListCommand = cmd({
  command: "delete-list <list-id>",
  aliases: ["rm-list", "remove-list"],
  describe: "delete a list from a bloq (refuses a non-empty list without --force)",
  builder: (yargs) =>
    yargs
      .positional("list-id", { describe: "list ID", type: "number", demandOption: true })
      .option("bloq-id", { describe: "bloq ID — enables the item-count safety check", type: "number" })
      .option("force", { describe: "delete even if the list has items", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Delete List #${args["list-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    // Count first, when we can. Without a bloq id there is no cheap way to enumerate the list,
    // so say that rather than implying the check passed — a silent skip of a safety check reads
    // exactly like the check succeeding.
    let itemCount: number | null = null
    if (args["bloq-id"]) {
      try {
        const listsRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["bloq-id"]}/lists`)
        if (listsRes.ok) {
          const body = (await listsRes.json()) as any
          const lists = body?.data?.data ?? body?.data ?? body ?? []
          const match = (Array.isArray(lists) ? lists : []).find(
            (l: any) => Number(l.id) === Number(args["list-id"]),
          )
          if (match) itemCount = (match.items?.length ?? match.items_count ?? 0) as number
        }
      } catch {
        // Leave itemCount null — reported as unknown below, never as zero.
      }
    }

    if (itemCount !== null && itemCount > 0 && !args.force) {
      const msg = `List #${args["list-id"]} has ${itemCount} item(s). Re-run with --force to delete it and them.`
      if (args.json) { console.log(JSON.stringify({ success: false, error: msg, items: itemCount })); return }
      prompts.log.error(msg)
      prompts.outro("Done")
      return
    }

    if (!args.json && itemCount === null) {
      prompts.log.warn(
        args["bloq-id"]
          ? "Could not read the item count — deleting without that check."
          : "No --bloq-id given, so the item count was NOT checked. Items in this list go with it.",
      )
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Deleting…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/${args["list-id"]}`, { method: "DELETE" })
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Delete list")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: args["list-id"], items_removed: itemCount })); return }
      spinner?.stop(`${success("✓")} List #${args["list-id"]} deleted`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
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
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Move Item #${args["item-id"]} → List #${args["target-list-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Moving item…")

    try {
      const res = await irisFetch(
        `/api/v1/user/bloqs/list/item/${args["item-id"]}`,
        { method: "PUT", body: JSON.stringify({ bloq_list_id: args["target-list-id"] }) },
      )
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Move item")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: args["item-id"], list_id: args["target-list-id"] })); return }
      spinner?.stop(`${success("✓")} Item moved to list #${args["target-list-id"]}`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsReorderItemCommand = cmd({
  command: "reorder-item <item-id>",
  aliases: ["pin-item"],
  describe: "reorder an item within its list (0 = top). Use --top to pin it first.",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID to reorder", type: "number", demandOption: true })
      .option("position", { alias: "p", describe: "new 0-based position within the list", type: "number" })
      .option("top", { alias: "pin", describe: "pin the item to the top of its list (position 0)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    // Resolve the target position: --top wins, else --position (must be >= 0).
    const position = args.top ? 0 : args.position
    if (position === undefined || position === null) {
      if (!args.json) {
        prompts.log.error("Specify a target: --position <n> (0 = top) or --top")
      } else {
        await writeJson({ error: "Specify --position <n> or --top" })
      }
      process.exitCode = 2
      return
    }
    if (position < 0) {
      if (!args.json) prompts.log.error("--position must be 0 or greater")
      else await writeJson({ error: "--position must be 0 or greater" })
      process.exitCode = 2
      return
    }

    if (!args.json) { UI.empty(); prompts.intro(`◈  Reorder Item #${args["item-id"]} → position ${position}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Reordering item…")

    try {
      // The position endpoint requires the item's list_id in the body, so first
      // resolve the item's current list. This also keeps the item in its own list
      // (a pure reorder, never a cross-list move).
      const itemRes = await irisFetch(`/api/v1/user/bloqs/list/item/${args["item-id"]}`)
      if (!itemRes.ok) {
        if (spinner) spinner.stop("Failed", 1)
        await handleApiError(itemRes, "Reorder item")
        if (!args.json) prompts.outro("Done")
        return
      }
      const itemData = (await itemRes.json()) as { data?: any }
      const item = itemData?.data ?? itemData
      const listId = item?.bloq_list_id ?? item?.list_id
      if (!listId) {
        if (spinner) spinner.stop("Failed", 1)
        if (!args.json) prompts.log.error("Could not determine the item's list")
        else await writeJson({ error: "Could not determine the item's list" })
        if (!args.json) prompts.outro("Done")
        process.exitCode = 1
        return
      }

      const res = await irisFetch(
        `/api/v1/user/${userId}/bloqs/list/item/${args["item-id"]}/position`,
        { method: "PATCH", body: JSON.stringify({ list_id: listId, position }) },
      )
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        await handleApiError(res, "Reorder item")
        if (!args.json) prompts.outro("Done")
        return
      }

      if (args.json) {
        await writeJson({ id: args["item-id"], list_id: listId, position })
        return
      }
      spinner!.stop(`${success("✓")} Item #${args["item-id"]} ${args.top ? "pinned to top" : `moved to position ${position}`} of list #${listId}`)
      prompts.outro("Done")
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (!args.json) prompts.log.error(err instanceof Error ? err.message : String(err))
      else await writeJson({ error: err instanceof Error ? err.message : String(err) })
      if (!args.json) prompts.outro("Done")
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

/**
 * Search boards AND the writing inside them.
 *
 * This used to search board NAMES only — it forwarded to `bloqs list --search`. That is
 * almost never the question being asked: you type `iris bloqs search "denial risk"` because
 * you want the note, not the board it happens to live on. Cross-board content search already
 * existed server-side (`GET user/{id}/bloqs/content-items?search=` matches title + content
 * across every board you own) but it was named for the Review Studio feed that shipped first,
 * so nothing pointed at it and nobody could find it.
 *
 * Both halves are reported, always, even at zero — an empty section is information ("that
 * phrase is nowhere in your items"), whereas a silently-omitted section reads as "no such
 * capability". Same rule federated-search.ts states for skipped sources.
 */
export const BloqsSearchCommand = cmd({
  command: "search <query>",
  aliases: ["find", "q"],
  describe: "search across every board — item titles, item content, and board names",
  builder: (yargs) =>
    yargs
      .positional("query", { describe: "search term", type: "string", demandOption: true })
      .option("limit", { describe: "max results per section", type: "number", default: 20 })
      .option("boards-only", { describe: "only match board names/descriptions (the old behaviour)", type: "boolean", default: false })
      .option("items-only", { describe: "only match item titles/content", type: "boolean", default: false })
      .option("bloq", { describe: "restrict item matches to one board ID", type: "number" })
      // #180715: the multi-source fan-out was only reachable from `bloqs items <bloq-id>
      // --include-all`, which needs an ID you do not have when you are searching FOR something.
      // It is the same engine; it just had no front door at the top level.
      //
      // DEFAULT TRUE, which is the half of #180715 that opt-in did not deliver. This verb's
      // stated contract is "search everything you have written", and a default that quietly
      // omits Obsidian and Drive contradicts it in the direction nobody checks: you get
      // results, so you believe you searched. An empty-handed user does not think to add a
      // flag they have never heard of — that is precisely how the old `bloqs items
      // --include-all` stayed invisible.
      //
      // The cost is latency on every search, and it is bounded: Obsidian is a local bridge,
      // Drive is one API call, both run concurrently with the bloq query rather than after it,
      // and a source that is down is REPORTED in source_outcomes rather than silently dropping
      // to zero results. `--local-only` opts out for a fast bloqs-only lookup.
      //
      // The opt-out is a NAMED FLAG rather than yargs' automatic `--no-include-all`, because
      // this CLI runs yargs in strict mode and strict rejects the negated form outright
      // ("Unknown arguments: no-include-all"). Documenting a flag that errors would be its own
      // small version of the bug this ticket is about.
      .option("include-all", { describe: "also search Obsidian and Drive (on by default)", type: "boolean", default: true })
      .option("local-only", { describe: "skip Obsidian and Drive — search bloqs only (faster)", type: "boolean", default: false })
      .option("source", { describe: "sources to search: bloq, obsidian, drive (comma-separated)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const query = String(args.query)
    const limit = Number(args.limit) || 20
    const wantItems = !args["boards-only"]
    const wantBoards = !args["items-only"]

    if (!args.json) { UI.empty(); prompts.intro(`◈  Search — "${query}"`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Searching…")

    // ── boards (name + description) ──
    // The index endpoint ACCEPTS ?search= and ignores it, returning every board — so the
    // filter has to happen here or every board would report as a match. Same tokenized
    // AND-match `bloqs list --search` uses, so the two agree.
    let boards: any[] = []
    if (wantBoards) {
      try {
        const res = await irisFetch(`/api/v1/user/${userId}/bloqs`)
        if (res.ok) {
          const data = (await res.json()) as any
          const rows: any[] = data?.data ?? []
          boards = (Array.isArray(rows) ? rows : [])
            .filter((b) => matchesSearchQuery(`${b.name ?? ""} ${b.description ?? ""}`, query))
            .slice(0, limit)
        }
      } catch { /* reported as 0 below — never silently narrowed */ }
    }

    // ── items (title + content, every board) ──
    let items: any[] = []
    if (wantItems) {
      try {
        const params = new URLSearchParams({ search: query, per_page: String(limit) })
        // A board-scoped item search has its own endpoint; reuse it so --bloq is exact.
        const url = args.bloq
          ? `/api/v1/user/${userId}/bloqs/${args.bloq}/items?${params}`
          : `/api/v1/user/${userId}/bloqs/content-items?${params}`
        const res = await irisFetch(url)
        if (res.ok) {
          const data = (await res.json()) as any
          const rows = data?.data?.items ?? data?.items ?? data?.data ?? []
          items = Array.isArray(rows) ? rows.slice(0, limit) : []
        }
      } catch { /* same */ }
    }

    // ── external sources (Obsidian, Drive) ──
    // Only when asked. `bloq` is excluded from the fan-out here because the cross-board item
    // search above already covers it WITHOUT a board id — that requirement was the whole
    // reason this engine was unreachable from the top level.
    let external: any[] = []
    let outcomes: any[] = []
    // --local-only wins over everything: it is the explicit "just the boards, quickly" request,
    // and an explicit narrowing should never be overridden by a default that is merely on.
    const fanOut = !args["local-only"] && Boolean(args["include-all"] || args.source)
    if (fanOut) {
      const sources = resolveSources({ source: args.source as string, includeAll: Boolean(args["include-all"]) })
        .filter((s) => s !== "bloq")
      if (sources.length) {
        const r = await federatedSearch(query, { sources, userId, limit })
        external = r.results
        outcomes = r.outcomes
      }
    }

    spinner?.stop(
      `${boards.length} board(s), ${items.length} item(s)` + (fanOut ? `, ${external.length} external` : ""),
    )

    if (args.json) {
      await writeJson({
        query,
        boards,
        items,
        external,
        // Report every source's outcome, including failures — a source that errored must not
        // be indistinguishable from a source that found nothing.
        source_outcomes: outcomes,
        counts: { boards: boards.length, items: items.length, external: external.length },
      })
      return
    }

    if (wantItems) {
      printDivider()
      console.log(`  ${bold("Items")} ${dim(`(${items.length})`)}`)
      if (!items.length) console.log(`  ${dim(`No item matches for "${query}"`)}`)
      for (const i of items) {
        const where = [i.bloq_name, i.list_name].filter(Boolean).join(" › ")
        console.log(`  ${dim(`#${i.id}`)} ${bold(itemTitle(i))}`)
        if (where) console.log(`      ${dim(where)}${i.bloq_id ? dim(`  ·  bloq #${i.bloq_id}`) : ""}`)
        const preview = itemContentPreview(i)
        if (preview) console.log(`      ${dim(preview.replace(/\s+/g, " ").slice(0, 110))}`)
      }
    }

    if (wantBoards) {
      printDivider()
      console.log(`  ${bold("Boards")} ${dim(`(${boards.length})`)}`)
      if (!boards.length) console.log(`  ${dim(`No board-name matches for "${query}"`)}`)
      for (const b of boards) {
        console.log(`  ${dim(`#${b.id}`)} ${bold(b.name ?? "(untitled)")}`)
        if (b.description) console.log(`      ${dim(String(b.description).slice(0, 110))}`)
      }
    }

    if (fanOut) {
      printDivider()
      console.log(`  ${bold("Obsidian & Drive")} ${dim(`(${external.length})`)}`)
      if (!external.length) console.log(`  ${dim(`No external matches for "${query}"`)}`)
      for (const r of external.slice(0, limit)) {
        console.log(`  ${dim(`[${r.source}]`)} ${bold(String(r.title ?? "(untitled)"))}`)
        if (r.snippet) console.log(`      ${dim(String(r.snippet).replace(/\s+/g, " ").slice(0, 110))}`)
      }
      // Per-source health, always — a skipped or failed source is information.
      if (outcomes.length) console.log(`  ${dim(formatOutcomes(outcomes))}`)
    }

    printDivider()
    console.log(`  ${dim("Open an item:")}  iris bloqs get <bloq-id>`)
    if (!fanOut) {
      // #180715: point at THIS command, not at a different one that needs an id. The old hint
      // sent people to `bloqs items <bloq-id> --include-all` — which is unusable at exactly the
      // moment it was offered, because you are searching in order to find the id.
      //
      // Only reachable via --local-only now that the fan-out is the default, so it is a
      // genuine "you narrowed this yourself" reminder rather than a nudge toward a flag the
      // product should have been using all along.
      console.log(`  ${dim("Widen the net:")} iris search "${query}"  ${dim("(drop --local-only for Obsidian + Drive)")}`)
    }
    prompts.outro("Done")
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
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Rename ${args.type} #${args.id}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

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
          if (args.json) console.log(JSON.stringify({ success: false, error: err.message }))
          else { prompts.log.error(err.message); prompts.outro("Done") }
          process.exitCode = 2
          return
        }
        throw err
      }
      if (prompts.isCancel(name)) { prompts.outro("Cancelled"); return }
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start(`Renaming ${args.type}…`)

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
          spinner?.stop("Invalid type", 1)
          if (args.json) console.log(JSON.stringify({ success: false, error: "Invalid type" }))
          else prompts.outro("Done")
          return
      }

      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, `Rename ${args.type}`)
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, type: args.type, id: args.id, name })); return }
      spinner?.stop(`${success("✓")} Renamed to: ${bold(name!)}`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
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
// Attach / Detach playbooks
// ============================================================================

const BloqsAttachPlaybookCommand = cmd({
  command: "attach-playbook <bloq-id> <playbook-name>",
  aliases: ["add-playbook", "link-playbook"],
  describe: "link a playbook to this bloq project",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("playbook-name", { describe: "playbook name (see `iris playbook list`)", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const name = String(args["playbook-name"])
    if (!args.json) { UI.empty(); prompts.intro(`◈  Attach Playbook "${name}" → Bloq #${args["bloq-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Attaching…")

    try {
      const res = await irisFetch(`/api/v1/bloqs/${args["bloq-id"]}/attach-playbook`, {
        method: "POST",
        body: JSON.stringify({ playbook_name: name }),
      })
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Attach playbook")
        prompts.outro("Done")
        return
      }

      const data = await res.json().catch(() => ({})) as Record<string, unknown>
      if (args.json) { console.log(JSON.stringify({ success: true, bloq_id: args["bloq-id"], playbook_name: name, ...data })); return }

      if (spinner) spinner.stop(`${success("✓")} Playbook "${name}" attached to Bloq #${args["bloq-id"]}`)
      prompts.outro(dim(`iris bloqs playbooks ${args["bloq-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsDetachPlaybookCommand = cmd({
  command: "detach-playbook <bloq-id> <playbook-name>",
  aliases: ["remove-playbook", "unlink-playbook"],
  describe: "unlink a playbook from this bloq project",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .positional("playbook-name", { describe: "playbook name", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const name = String(args["playbook-name"])
    if (!args.json) { UI.empty(); prompts.intro(`◈  Detach Playbook "${name}" from Bloq #${args["bloq-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Detaching…")

    try {
      const res = await irisFetch(`/api/v1/bloqs/${args["bloq-id"]}/detach-playbook`, {
        method: "POST",
        body: JSON.stringify({ playbook_name: name }),
      })
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Detach playbook")
        prompts.outro("Done")
        return
      }

      const data = await res.json().catch(() => ({})) as Record<string, unknown>
      if (args.json) { console.log(JSON.stringify({ success: true, bloq_id: args["bloq-id"], playbook_name: name, ...data })); return }

      if (spinner) spinner.stop(`${success("✓")} Playbook "${name}" detached from Bloq #${args["bloq-id"]}`)
      prompts.outro(dim(`iris bloqs playbooks ${args["bloq-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Bloq relations (bug #158309) — parent/sibling/affiliated/partner/feeds_into/mirrors
// ============================================================================

const BloqsRelateCommand = cmd({
  command: "relate <from-id> <to-id>",
  describe: "link two bloqs with a typed relation",
  builder: (yargs) =>
    yargs
      .positional("from-id", { describe: "bloq ID this relation is created from (needs write access)", type: "number", demandOption: true })
      .positional("to-id", { describe: "the related bloq ID", type: "number", demandOption: true })
      .option("type", { describe: `relation type (${RELATION_TYPES.join("|")})`, type: "string", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const type = String(args.type)
    if (!isValidRelationType(type)) {
      const msg = `Invalid --type "${type}". Must be one of: ${RELATION_TYPES.join(", ")}`
      if (args.json) { console.log(JSON.stringify({ success: false, error: msg })); return }
      prompts.log.error(msg)
      return
    }

    if (!args.json) { UI.empty(); prompts.intro(`◈  Relate Bloq #${args["from-id"]} → #${args["to-id"]} (${type})`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Relating…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["from-id"]}/relate`, {
        method: "POST",
        body: JSON.stringify({ to_bloq_id: args["to-id"], type }),
      })
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Relate bloqs")
        prompts.outro("Done")
        return
      }

      const data = await res.json().catch(() => ({})) as Record<string, unknown>
      if (args.json) { console.log(JSON.stringify({ success: true, from_bloq_id: args["from-id"], to_bloq_id: args["to-id"], type, ...data })); return }

      if (spinner) spinner.stop(`${success("✓")} Bloq #${args["from-id"]} related to #${args["to-id"]} (${type})`)
      prompts.outro(dim(`iris bloqs relations ${args["from-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsUnrelateCommand = cmd({
  command: "unrelate <from-id> <to-id>",
  describe: "remove a typed relation between two bloqs",
  builder: (yargs) =>
    yargs
      .positional("from-id", { describe: "bloq ID the relation was created from", type: "number", demandOption: true })
      .positional("to-id", { describe: "the related bloq ID", type: "number", demandOption: true })
      .option("type", { describe: `relation type (${RELATION_TYPES.join("|")})`, type: "string", demandOption: true })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const type = String(args.type)
    if (!isValidRelationType(type)) {
      const msg = `Invalid --type "${type}". Must be one of: ${RELATION_TYPES.join(", ")}`
      if (args.json) { console.log(JSON.stringify({ success: false, error: msg })); return }
      prompts.log.error(msg)
      return
    }

    if (!args.json) { UI.empty(); prompts.intro(`◈  Unrelate Bloq #${args["from-id"]} → #${args["to-id"]} (${type})`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Removing…")

    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["from-id"]}/unrelate`, {
        method: "POST",
        body: JSON.stringify({ to_bloq_id: args["to-id"], type }),
      })
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Unrelate bloqs")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, from_bloq_id: args["from-id"], to_bloq_id: args["to-id"], type })); return }

      if (spinner) spinner.stop(`${success("✓")} Relation removed (Bloq #${args["from-id"]} → #${args["to-id"]}, ${type})`)
      prompts.outro(dim(`iris bloqs relations ${args["from-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsRelationsCommand = cmd({
  command: "relations <id>",
  describe: "list a bloq's relations to other bloqs",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("type", { describe: `filter by relation type (${RELATION_TYPES.join("|")})`, type: "string" })
      .option("direction", { describe: "from|to|both", type: "string", default: "both", choices: ["from", "to", "both"] as const })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await requireUserId(args["user-id"])
    if (!userId) return

    try {
      const params = new URLSearchParams()
      if (args.type) params.set("type", String(args.type))
      if (args.direction) params.set("direction", String(args.direction))
      const qs = params.toString()
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args.id}/relations${qs ? `?${qs}` : ""}`)
      if (!res.ok) {
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "List bloq relations")
        return
      }

      const body = (await res.json().catch(() => ({}))) as { data?: RelationRow[] }
      const relations = body.data ?? []
      if (args.json) { console.log(JSON.stringify({ success: true, bloq_id: args.id, relations })); return }

      if (relations.length === 0) {
        console.log(dim(`No relations for Bloq #${args.id}.`))
        console.log(dim(`Link one: iris bloqs relate ${args.id} <to-id> --type=<type>`))
        return
      }

      console.log(bold(`Relations for Bloq #${args.id}:`))
      console.log(formatRelationsGrouped(relations))
    } catch (err) {
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

const BloqsPlaybooksCommand = cmd({
  command: "playbooks <bloq-id>",
  aliases: ["list-playbooks"],
  describe: "list playbooks linked to this bloq project",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    try {
      const res = await irisFetch(`/api/v1/bloqs/${args["bloq-id"]}/playbooks`, { method: "GET" })
      if (!res.ok) {
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "List bloq playbooks")
        return
      }

      const body = await res.json().catch(() => ({})) as { data?: Array<{ name?: string; attached_at?: string }> }
      const playbooks = body.data ?? []
      if (args.json) { console.log(JSON.stringify({ success: true, bloq_id: args["bloq-id"], playbooks })); return }

      if (playbooks.length === 0) {
        console.log(dim(`No playbooks linked to Bloq #${args["bloq-id"]}.`))
        console.log(dim(`Attach one: iris bloqs attach-playbook ${args["bloq-id"]} <playbook-name>`))
        return
      }

      console.log(bold(`Playbooks linked to Bloq #${args["bloq-id"]}:`))
      for (const p of playbooks) {
        const when = p.attached_at ? dim(` (${p.attached_at})`) : ""
        console.log(`  ${success("•")} ${p.name ?? "unknown"}${when}`)
      }
    } catch (err) {
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
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

      if (args.json) { await writeJson(leads); return }

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

/**
 * Page through a bloq's items collecting only those in one list (#180303).
 *
 * The items endpoint is scoped to the whole bloq and paginated, with no
 * server-side list filter — so a client-side filter applied to a single page
 * answers "nothing here" for any list whose items sit further in. That is a wrong
 * answer wearing the costume of a definitive one: bloq #503 has 558 items, and
 * `-l 1449` reported "No items found" for a list with six.
 *
 * Walks pages until `limit` matches are collected or the bloq runs out, capped at
 * `maxPages` so a pathological board cannot spin forever. `exhausted` reports
 * whether the whole bloq was actually seen — the caller must not present an
 * incomplete scan as a complete one.
 */
export async function collectListFiltered(
  fetchPage: (page: number, perPage: number) => Promise<{ items: any[]; pagination: any }>,
  listId: number,
  limit: number,
  maxPages = 25,
): Promise<{ items: any[]; total: number; exhausted: boolean; pagesScanned: number }> {
  const inList = (i: any) => i?.bloq_list_id === listId || i?.list_id === listId
  const perPage = 200 // scan wide; `limit` governs what we return, not what we read
  const collected: any[] = []
  let page = 1
  let total = 0
  let lastPage = 1
  let pagesScanned = 0

  while (page <= lastPage && pagesScanned < maxPages) {
    const { items, pagination } = await fetchPage(page, perPage)
    pagesScanned++
    total = pagination?.total ?? total
    lastPage = pagination?.last_page ?? 1

    for (const item of items) {
      if (inList(item)) collected.push(item)
    }
    if (collected.length >= limit) {
      return { items: collected.slice(0, limit), total, exhausted: true, pagesScanned }
    }
    if (!items.length) break
    page++
  }

  return {
    items: collected.slice(0, limit),
    total,
    // The whole bloq was seen only if we ran off the end rather than hit the cap.
    exhausted: page > lastPage || pagesScanned < maxPages,
    pagesScanned,
  }
}

const BloqsItemsCommand = cmd({
  command: "items <bloq-id>",
  // There is no `get-item`/`show-item` — every other item verb mutates. This is the only
  // way to READ one, so say so here rather than leaving people to guess a verb that does
  // not exist. `--search <term> --fields id,title,content` is the "show me this one item".
  describe: "list AND read items in a bloq — this is the read path; there is no separate get-item",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("list", { alias: "l", describe: "filter by list ID (scans across pages; warns if it stops early)", type: "number" })
      .option("search", { alias: "s", describe: "search items by keyword — pair with --fields content to read one item's body", type: "string" })
      .option("source", { describe: "also search these sources: obsidian, drive (repeatable)", type: "string", array: true })
      .option("include-all", { describe: "search every available source", type: "boolean", default: false })
      .option("status", { describe: "filter by status", type: "string" })
      .option("limit", { describe: "items per page (max 200)", type: "number", default: 50 })
      .option("page", { describe: "page number (1-based)", type: "number", default: 1 })
      .option("fields", { describe: "comma-separated fields for --json (default: id,title,status,list_name)", type: "string" })
      .option("compact", { describe: "drop null/empty fields in --json output", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Bloq #${args["bloq-id"]} Items`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    // FEDERATED SEARCH (#178646). Only when --source/--include-all is given, so the
    // meaning of an existing `--search` never changes underneath anyone. Content is not
    // copied into bloq items — each source stays the owner of its own data and is queried
    // live, because a second copy is a second truth that drifts.
    const federationRequested = Boolean(args["include-all"] || (args.source && (args.source as string[]).length))
    if (args.search && federationRequested) {
      // On `bloqs items` the bloq is the context, so --source ADDS sources rather than
      // replacing them. Anything else would make `--source obsidian` silently stop
      // searching the board you explicitly named.
      const sources = [...new Set(["bloq" as const, ...resolveSources({ source: args.source as string[], includeAll: args["include-all"] as boolean })])]
      const fedSpinner = args.json ? null : prompts.spinner()
      if (fedSpinner) fedSpinner.start(`Searching ${sources.join(", ")}…`)

      const { results, outcomes } = await federatedSearch(String(args.search), {
        sources,
        bloqId: Number(args["bloq-id"]),
        userId,
        limit: Number(args.limit) || 25,
      })

      if (fedSpinner) fedSpinner.stop(`${results.length} result(s)`)

      if (args.json) {
        // outcomes ride along in --json too: a machine caller must be able to tell a
        // genuinely empty result from a source that never ran.
        await writeJson({ query: args.search, sources, results, outcomes })
        return
      }

      printDivider()
      if (!results.length) console.log(`  ${dim(`No results for "${args.search}"`)}`)
      for (const r of results) {
        const where = r.location ? dim(`  ${r.location}`) : ""
        console.log(`  ${dim(`[${r.source}]`)} ${bold(r.title)}${where}`)
        if (r.snippet) console.log(`      ${dim(r.snippet.slice(0, 110))}`)
      }
      printDivider()
      // Always print outcomes. A source that was skipped or errored MUST be named —
      // silently returning fewer results is how a dead dependency passes for "no matches".
      console.log(`  ${dim(formatOutcomes(outcomes))}`)
      const degraded = outcomes.filter((o) => o.state !== "ok")
      prompts.outro(
        degraded.length
          ? `${results.length} result(s) — ${degraded.length} source(s) unavailable`
          : `${success("✓")} ${results.length} result(s)`,
      )
      return
    }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    // Lean default projection (#164357) — the fields an agent actually needs to
    // scan a board. --fields overrides; --compact drops empties.
    const DEFAULT_FIELDS = ["id", "title", "status", "list_name"]
    const selectedFields = args.fields
      ? String(args.fields).split(",").map((f) => f.trim()).filter(Boolean)
      : DEFAULT_FIELDS
    const project = (item: Record<string, any>) => {
      const out: Record<string, any> = {}
      for (const f of selectedFields) out[f] = item[f] ?? null
      if (args.compact) {
        for (const k of Object.keys(out)) {
          if (out[k] === null || out[k] === undefined || out[k] === "") delete out[k]
        }
      }
      return out
    }

    try {
      // Use the lean, server-paginated items endpoint (#164357/#164358). It returns
      // a curated per-row projection + a pagination envelope (total/last_page), so we
      // no longer dump the whole bloq's fat item models and slice client-side at 50.
      const perPage = Math.min(Math.max(Number(args.limit) || 50, 1), 200)
      const page = Math.max(Number(args.page) || 1, 1)
      const params = new URLSearchParams()
      params.set("per_page", String(perPage))
      params.set("page", String(page))
      if (args.search) params.set("search", String(args.search))
      if (args.status) params.set("status", String(args.status))

      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["bloq-id"]}/items?${params}`)
      if (!res.ok) {
        if (spinner) spinner.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "List items")
        prompts.outro("Done")
        return
      }

      const body = (await res.json()) as { data?: any }
      const data = body?.data ?? body
      let items: any[] = Array.isArray(data?.items) ? data.items : []
      const pg = data?.pagination ?? {}
      let listScanIncomplete = false

      // --list used to be a client-side post-filter on whichever single page came
      // back (#180303). The endpoint paginates over the WHOLE bloq, so on bloq #503
      // — 558 items — filtering page 1 of 50 reported "No items found" for a list
      // that has six. Now we keep pulling pages until the limit is satisfied, and
      // if we stop early we say so instead of presenting a short list as the whole
      // truth.
      if (args.list !== undefined) {
        const collected = await collectListFiltered(
          async (p, per) => {
            const pageParams = new URLSearchParams(params)
            pageParams.set("page", String(p))
            pageParams.set("per_page", String(per))
            const r = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["bloq-id"]}/items?${pageParams}`)
            if (!r.ok) throw new Error(`HTTP ${r.status}`)
            const b = (await r.json()) as { data?: any }
            const d = b?.data ?? b
            return { items: Array.isArray(d?.items) ? d.items : [], pagination: d?.pagination ?? {} }
          },
          Number(args.list),
          perPage,
        )
        items = collected.items
        listScanIncomplete = !collected.exhausted
        if (collected.total) pg.total = collected.total
      }

      const total = pg.total ?? items.length
      const lastPage = pg.last_page ?? 1
      const currentPage = pg.current_page ?? page
      const hasMore = currentPage < lastPage

      if (args.json) {
        await writeJson({
          items: items.map(project),
          pagination: {
            total,
            returned: items.length,
            per_page: pg.per_page ?? perPage,
            page: currentPage,
            last_page: lastPage,
            has_more: hasMore,
            // A machine caller must be able to tell "this list has 2 items" from
            // "we stopped looking after 25 pages" (#180303).
            ...(args.list !== undefined ? { list_scan_complete: !listScanIncomplete } : {}),
          },
        })
        return
      }

      if (spinner) spinner.stop(`${items.length} of ${total} item(s)`)

      if (items.length === 0) {
        // "Nothing here" and "I stopped looking" are different answers (#180303).
        if (listScanIncomplete) {
          prompts.log.warn(
            `No items found in list ${args.list} within the first pages scanned — the bloq is large and the scan was capped, so this is NOT proof the list is empty.`,
          )
        } else {
          prompts.log.warn(args.search ? `No items matching "${args.search}"` : "No items found")
        }
        prompts.outro("Done")
        return
      }
      if (listScanIncomplete) {
        prompts.log.warn(`Scan capped before the end of the bloq — there may be more items in list ${args.list}.`)
      }

      console.log()
      for (const item of items) {
        const title = (item.title ?? item.content ?? "").toString().slice(0, 80)
        const statusLabel = item.status && item.status !== "active" ? `  ${dim(`[${item.status}]`)}` : ""
        const listLabel = item.list_name ? dim(` (${item.list_name})`) : ""
        console.log(`  ${dim(`#${item.id}`)}  ${title}${statusLabel}${listLabel}`)
        if (item.is_public && (item.public_url || item.public_uuid)) {
          console.log(`      ${dim("public:")} ${item.public_url ?? item.public_uuid}`)
        }
      }
      console.log()
      const pageInfo = `Showing ${items.length} of ${total} (page ${currentPage}/${lastPage})`
      const moreHint = hasMore ? dim(`  —  --page ${currentPage + 1} for more`) : ""
      console.log(`  ${dim(pageInfo)}${moreHint}`)
      console.log()
      prompts.outro(dim("iris bloqs share <id>  (publish + shareable link)  |  iris bloqs update-item <id> --status <status>"))
      return
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

// Canonical bloq item statuses (mirrors BloqItemController::VALID_ITEM_STATUSES).
// The board/UI shows hyphenated "in-progress"; the API persists "in_progress".
// Bug #162344 — reject anything outside this set instead of writing garbage.
const BLOQ_ITEM_STATUS_CHOICES = ["active", "pending", "approved", "rejected", "todo", "in-progress", "done"] as const
function normalizeItemStatus(s: string): string {
  return s === "in-progress" ? "in_progress" : s
}

const BloqsUpdateItemCommand = cmd({
  command: "update-item <item-id>",
  aliases: ["edit-item"],
  describe: "update a bloq item (status, title, or content)",
  builder: (yargs) =>
    yargs
      .positional("item-id", { describe: "item ID", type: "number", demandOption: true })
      .option("status", { describe: "set item status", type: "string", choices: BLOQ_ITEM_STATUS_CHOICES })
      .option("title", { describe: "new title", type: "string" })
      // `add-item` names this field --text, so muscle memory brings --text here too and
      // strict mode rejects it ("Unknown argument: text") without naming the right flag.
      // Same field, one name. #180234
      .option("content", { describe: "replace content wholesale", type: "string", alias: "text" })
      .option("merge", {
        describe: "merge key=value into content, preserving other fields (repeatable; dotted keys nest; e.g. --merge rate_cents=7900)",
        type: "array",
      })
      .option("due", { describe: "due date (ISO, e.g. 2026-07-22; 'none' to clear)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Update Item #${args["item-id"]}`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }

    const payload: Record<string, unknown> = {}
    // Bug #162344: map the display value "in-progress" to the persisted "in_progress".
    if (args.status) payload.status = normalizeItemStatus(args.status)
    if (args.title) payload.title = args.title
    if (args.content) payload.content = args.content
    if (args.due !== undefined && args.due !== "") {
      // Allow clearing the due date explicitly.
      if (String(args.due).toLowerCase() === "none" || String(args.due).toLowerCase() === "null") {
        payload.due_date = null
      } else {
        const normalized = normalizeDueDate(args.due as string)
        if (!normalized) {
          const emsg = `Invalid --due date "${args.due}" — use YYYY-MM-DD (e.g. 2026-07-22) or 'none' to clear`
          if (args.json) console.log(JSON.stringify({ success: false, error: emsg }))
          else { prompts.log.error(emsg); prompts.outro("Done") }
          process.exitCode = 2
          return
        }
        payload.due_date = normalized
      }
    }

    // #169753: --merge sends a partial content object the backend deep-merges onto the
    // stored content (BloqItemController::update -> content_merge), so one field can
    // change without resending — and clobbering — the rest. Mutually exclusive with
    // --content (full replace); the backend also 422s if both arrive.
    if (args.content !== undefined && args.merge) {
      const emsg = "Use either --content (full replace) or --merge (partial), not both"
      if (args.json) console.log(JSON.stringify({ success: false, error: emsg }))
      else { prompts.log.error(emsg); prompts.outro("Done") }
      process.exitCode = 2
      return
    }
    if (args.merge) {
      try {
        payload.content_merge = parseMergePairs((args.merge as unknown[]).map(String))
      } catch (e) {
        const emsg = e instanceof Error ? e.message : String(e)
        if (args.json) console.log(JSON.stringify({ success: false, error: emsg }))
        else { prompts.log.error(emsg); prompts.outro("Done") }
        process.exitCode = 2
        return
      }
    }

    if (Object.keys(payload).length === 0) {
      const emsg = "Provide at least one of: --status, --title, --content, --merge, --due"
      if (args.json) console.log(JSON.stringify({ success: false, error: emsg }))
      else { prompts.log.error(emsg); prompts.outro("Done") }
      process.exitCode = 2
      return
    }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Updating…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/list/item/${args["item-id"]}`, {
        method: "PUT",
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Update item")
        prompts.outro("Done")
        return
      }

      if (args.json) { console.log(JSON.stringify({ success: true, id: args["item-id"], ...payload })); return }

      const parts: string[] = []
      if (args.status) parts.push(`status → ${payload.status}`)
      if (args.title) parts.push(`title updated`)
      if (args.content) parts.push(`content replaced`)
      if (args.merge) parts.push(`content merged (${Object.keys(payload.content_merge as object).length} field(s))`)
      if (payload.due_date !== undefined) parts.push(payload.due_date === null ? `due cleared` : `due → ${payload.due_date}`)

      spinner?.stop(`${success("✓")} Item #${args["item-id"]} updated (${parts.join(", ")})`)
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Helpers
// ============================================================================

// #169753: parse repeatable `--merge key=value` pairs into a partial content object
// for the backend's content_merge deep-merge. Values are JSON-parsed when possible
// (7900 → number, true → bool, {"seats":7} → object) and otherwise kept as a raw
// string, so `rate_cents=7900` sets a number while `make=Toyota` sets a string. A
// dotted key nests (`features.seats=7` → {features:{seats:7}}) to match the backend's
// recursive merge. The value is split on the FIRST `=` so values may contain `=`.
function parseMergePairs(pairs: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const raw of pairs) {
    const eq = raw.indexOf("=")
    if (eq < 0) throw new Error(`--merge expects key=value, got "${raw}"`)
    const key = raw.slice(0, eq).trim()
    if (!key) throw new Error(`--merge has an empty key in "${raw}"`)
    const valStr = raw.slice(eq + 1)
    let value: unknown
    try { value = JSON.parse(valStr) } catch { value = valStr }
    const path = key.split(".")
    let node = out
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i]
      const next = node[seg]
      if (typeof next !== "object" || next === null || Array.isArray(next)) node[seg] = {}
      node = node[seg] as Record<string, unknown>
    }
    node[path[path.length - 1]] = value
  }
  return out
}

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

// ============================================================================
// Board MEMBERSHIP (#180537-era gap, found the hard way on 2026-08-19)
//
// `bloqs invite` mints a tokenized LINK. `attach-lead` attaches a CRM contact. Neither one
// adds a MEMBER — a row in fl-api's `user_bloq_users` with a permission, which is what
// `is_owner` in `bloqs list` reads back and what actually grants a real account access to a
// board. That verb simply did not exist, so granting five people-facing boards to one address
// meant reading the endpoint out of the Laravel controller and curling it with a credential
// pulled from ~/.iris/sdk/.env. These three close it.
//
// The endpoint takes a user_id, never an email, so the email→id resolution lives here rather
// than in the caller's head.
// ============================================================================

/** Resolve --email to a user id, or pass --user-id straight through. */
async function resolveMemberId(
  args: { email?: unknown; "user-id"?: unknown },
): Promise<{ id: number; email?: string } | { error: string }> {
  const explicit = args["user-id"]
  if (explicit) return { id: Number(explicit) }

  const email = String(args.email ?? "").trim()
  if (!email) return { error: "Pass --email <address> or --user-id <id>." }

  const res = await irisFetch(`/api/v1/users/search?${new URLSearchParams({ q: email })}`, {}, FL_API)
  if (!res.ok) return { error: `User lookup failed (HTTP ${res.status}).` }

  const body = (await res.json().catch(() => null)) as any
  const rows: any[] = Array.isArray(body) ? body : (body?.data ?? [])

  // Exact address only. A substring match here would grant board access to the wrong person,
  // which is not the kind of thing to be approximately right about.
  const hit = rows.find((r) => String(r?.email ?? "").toLowerCase() === email.toLowerCase())
  if (!hit) {
    return {
      error: rows.length
        ? `No account with the exact address ${email} (search returned ${rows.length} near match(es)).`
        : `No account found for ${email}.`,
    }
  }
  return { id: Number(hit.id), email: String(hit.email) }
}

const BloqsMembersCommand = cmd({
  command: "members <bloq-id>",
  aliases: ["shared-users", "who"],
  describe: "list the accounts a bloq board is shared with (membership, not invite links)",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    if (!args.json) { UI.empty(); prompts.intro(`◈  Members of Bloq #${args["bloq-id"]}`) }

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/${args["bloq-id"]}/shared-users`)
      if (!(await handleApiError(res, "List members"))) { if (!args.json) prompts.outro("Done"); return }

      const body = (await res.json().catch(() => ({}))) as any
      const members: any[] = body?.data?.shared_users ?? body?.shared_users ?? []

      if (args.json) { await writeJson(members); return }

      if (!members.length) {
        prompts.log.info("Not shared with anyone. Add someone with: iris bloqs add-member <id> --email <address>")
      } else {
        printDivider()
        for (const m of members) {
          console.log(`  ${bold(String(m.email ?? m.name ?? m.id))}  ${dim(`#${m.id}`)}  [${String(m.permission ?? "?")}]`)
        }
        printDivider()
      }
      prompts.outro(dim(`iris bloqs add-member ${args["bloq-id"]} --email <address>`))
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

const BloqsAddMemberCommand = cmd({
  command: "add-member <bloq-id>",
  aliases: ["grant", "share-with"],
  describe: "give an account access to a bloq board (by email or user id)",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("email", { describe: "the account's email address (resolved to a user id)", type: "string" })
      .option("user-id", { describe: "the account's user id, if you already know it", type: "number" })
      .option("permission", {
        describe: "access level",
        type: "string",
        default: "editor",
        choices: ["viewer", "editor", "owner"],
      })
      // fl-api's send_notification_email defaults to TRUE — sharing a board emails the person
      // unless you say otherwise. Inverted here so the CLI never sends mail you did not ask for.
      // It is also ONE-SHOT upstream: the mail fires only on a NEW share, so re-running later to
      // "notify after the fact" silently does nothing but update the permission.
      .option("notify", { describe: "email the person that they were added (default: no email)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const who = await resolveMemberId(args as any)
    if ("error" in who) {
      if (args.json) { console.log(JSON.stringify({ success: false, error: who.error })) }
      else { UI.empty(); prompts.log.error(who.error) }
      process.exitCode = 2
      return
    }

    const label = who.email ?? `user #${who.id}`
    if (!args.json) { UI.empty(); prompts.intro(`◈  Add ${label} → Bloq #${args["bloq-id"]}`) }
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Granting…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/${args["bloq-id"]}/share`, {
        method: "POST",
        body: JSON.stringify({
          user_id: who.id,
          permission: args.permission,
          send_notification_email: Boolean(args.notify),
        }),
      })
      if (!(await handleApiError(res, "Add member"))) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const body = (await res.json().catch(() => ({}))) as any
      // fl-api distinguishes a first grant from a permission change; pass that through rather
      // than reporting both as "shared", because only the first one can have sent mail.
      const message = String(body?.data?.message ?? body?.message ?? "Shared")

      if (args.json) {
        await writeJson({ success: true, bloq_id: Number(args["bloq-id"]), user_id: who.id, email: who.email, permission: args.permission, notified: Boolean(args.notify), message })
        return
      }

      if (spinner) spinner.stop(`${success("✓")} ${message}`)
      printDivider()
      printKV("Board", `#${args["bloq-id"]}`)
      printKV("Account", `${label}  (#${who.id})`)
      printKV("Permission", String(args.permission))
      printKV("Emailed", args.notify ? "yes" : "no")
      printDivider()
      prompts.outro(dim(`iris bloqs members ${args["bloq-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const BloqsRemoveMemberCommand = cmd({
  command: "remove-member <bloq-id>",
  aliases: ["revoke-member", "ungrant"],
  describe: "remove an account's access to a bloq board",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID", type: "number", demandOption: true })
      .option("email", { describe: "the account's email address", type: "string" })
      .option("user-id", { describe: "the account's user id", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const who = await resolveMemberId(args as any)
    if ("error" in who) {
      if (args.json) { console.log(JSON.stringify({ success: false, error: who.error })) }
      else { UI.empty(); prompts.log.error(who.error) }
      process.exitCode = 2
      return
    }

    const label = who.email ?? `user #${who.id}`
    if (!args.json) { UI.empty(); prompts.intro(`◈  Remove ${label} from Bloq #${args["bloq-id"]}`) }
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Revoking…")

    try {
      const res = await irisFetch(`/api/v1/user/bloqs/${args["bloq-id"]}/share/${who.id}`, { method: "DELETE" })
      if (!(await handleApiError(res, "Remove member"))) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      if (args.json) { await writeJson({ success: true, bloq_id: Number(args["bloq-id"]), user_id: who.id, email: who.email, removed: true }); return }

      if (spinner) spinner.stop(`${success("✓")} ${label} removed from Bloq #${args["bloq-id"]}`)
      prompts.outro(dim(`iris bloqs members ${args["bloq-id"]}`))
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
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
      // #179082 — address the link to a person, and narrow what it grants.
      // Naming the invitee does NOT email them; it records who the link is for.
      // Use `iris bloq-members invite --send-email` to actually notify someone.
      .option("email", { describe: "address the invite to this person (does not send mail)", type: "string" })
      .option("scope-list", { describe: "grant access to ONE list only", type: "number" })
      .option("scope-item", { describe: "grant access to ONE item only", type: "number" })
      .option("scope-own", { describe: "grant access only to rows this person authored", type: "boolean", default: false })
      .option("open", { describe: "also open the link in a browser", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return

    let link: { token: string; permission: string; expires_at: string | null; max_uses: number | null }
    // Hoisted out of the try: the post-mint summary and the board-wide warning
    // both need to know what was actually granted.
    const scopeType =
      args["scope-list"] != null ? "list" : args["scope-item"] != null ? "item" : args["scope-own"] ? "own" : null
    const scopeId = args["scope-list"] ?? args["scope-item"] ?? null
    try {
      const picked = [args["scope-list"] != null, args["scope-item"] != null, args["scope-own"]].filter(Boolean)
      if (picked.length > 1) {
        prompts.log.error("Pick at most one of --scope-list, --scope-item, --scope-own")
        return
      }

      link = await mintShareLink(args.id, userId, {
        permission: args.permission,
        expiresAt: args.expires ?? null,
        maxUses: args["max-uses"] ?? null,
        email: args.email ?? null,
        scopeType,
        scopeId,
      })
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      return
    }

    const url = inviteWebUrl(link.token)

    if (args.json) {
      await writeJson({ ...link, url, board_url: bloqWebUrl(args.id) })
      return
    }

    console.log(url)
    const meta: string[] = [`${link.permission} access`, describeScope(scopeType, scopeId)]
    if (link.expires_at) meta.push(`expires ${link.expires_at}`)
    if (link.max_uses) meta.push(`max ${link.max_uses} uses`)
    console.log(dim(`  ${meta.join("  ·  ")}`))

    // #179337 — the widest possible grant was the one you got by typing the
    // obvious command, with nothing said about it. Say it. Printed AFTER the
    // URL so the happy path still starts with the thing you came for.
    //
    // Only unscoped links warn: since #179373 a scoped member reaches neither
    // the rest of the board nor its attached CRM leads, so there is nothing
    // left to caution them about. Warning on every mint would train people to
    // ignore it, which is how the next real warning gets missed.
    if (!scopeType) {
      prompts.log.warn(
        `This link grants EVERY list and item on bloq ${args.id}, and the CRM notes on any lead attached to it.\n` +
          `  Narrow it with --scope-list <listId> / --scope-item <itemId> / --scope-own.`,
      )
    }

    if (args.open) {
      const opened = openBrowser(url)
      if (!opened) prompts.log.warn("Could not launch a browser — open the URL above manually.")
    }
  },
})

/**
 * Render a link's scope for humans (#179342).
 *
 * A NULL scope_type is a pre-#179082 row and has always meant the whole board,
 * so it reads the same as an explicit `bloq` — the distinction is a storage
 * detail, and showing "unknown" would imply doubt that does not exist.
 */
function describeScope(scopeType?: string | null, scopeId?: number | null): string {
  switch (scopeType) {
    case "list":
      return `list #${scopeId}`
    case "item":
      return `item #${scopeId}`
    case "own":
      return "own rows only"
    default:
      return "WHOLE BOARD"
  }
}

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
      await writeJson(links.map((l) => ({ ...l, url: inviteWebUrl(l.token) })))
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
      // #179342 — scope is the ONLY field that says whether this link hands over
      // one list or the entire board. Omitting it made this listing look
      // complete while being unable to show the risk it exists to surface.
      meta.push(describeScope(l.scope_type, l.scope_id))
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

// Publish a bloq's items as individual Genesis pages — the reusable "doc library
// → pages" capability. An SOP bloq becomes one clean login-gated page per SOP,
// each with its own /p/<slug> the index can link to. Auth-gated by default
// (requires_auth) so internal docs never land on anyone-with-link public URLs;
// pass --public to opt out. Reuses createPageFromJson (create + publish + purge).
const BloqsPublishPagesCommand = cmd({
  command: "publish-pages <bloq-id>",
  aliases: ["items-to-pages"],
  describe: "publish a bloq's items as individual auth-gated pages (doc library → pages)",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "bloq ID whose items become pages", type: "number", demandOption: true })
      .option("list", { alias: "l", describe: "only publish items in this list ID", type: "number" })
      .option("prefix", { describe: "slug prefix for created pages (default: bloq-<id>)", type: "string" })
      .option("public", { describe: "make pages public (no login gate); default is auth-gated", type: "boolean", default: false })
      .option("owner-id", { describe: "owner bloq ID for the pages (default: the source bloq)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro(`◈  Publish Bloq #${args["bloq-id"]} items → pages`) }

    const token = await requireAuth()
    if (!token) { if (!args.json) prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"])
    if (!userId) { if (!args.json) prompts.outro("Done"); return }

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Loading items…")
    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${args["bloq-id"]}`)
      if (!res.ok) {
        spinner?.stop("Failed", 1)
        if (args.json) { console.log(JSON.stringify({ success: false, error: `HTTP ${res.status}` })); return }
        await handleApiError(res, "Load bloq"); prompts.outro("Done"); return
      }
      const bloq = (await res.json()) as Record<string, any>
      const lists = bloq?.data?.lists ?? bloq?.lists ?? []
      let items: any[] = []
      for (const list of lists) for (const it of (list.items ?? [])) items.push({ ...it, list_id: list.id })
      if (args.list) items = items.filter((i) => i.list_id === args.list || i.bloq_list_id === args.list)
      items = items.filter((i) => String(i.content ?? "").trim().length > 0) // skip empty/stub items

      if (items.length === 0) {
        spinner?.stop("No items", 1)
        if (args.json) { console.log(JSON.stringify({ success: true, pages: [] })); return }
        prompts.log.warn("No non-empty items to publish"); prompts.outro("Done"); return
      }

      const prefix = (args.prefix as string) || `bloq-${args["bloq-id"]}`
      const ownerId = (args["owner-id"] as number) ?? Number(args["bloq-id"])
      const used = new Set<string>()
      const slugify = (s: string): string => {
        let base = s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "item"
        let slug = `${prefix}-${base}`
        let n = 2
        while (used.has(slug)) slug = `${prefix}-${base}-${n++}`
        used.add(slug)
        return slug
      }

      const created: Array<{ item_id: number; title: string; slug: string; url: string }> = []
      let i = 0
      for (const item of items) {
        i++
        const title = String(item.title ?? `Item ${item.id}`)
        spinner?.message(`Publishing ${i}/${items.length}: ${title.slice(0, 40)}…`)
        const slug = slugify(title)
        const json_content = {
          version: "2.0",
          type: "page",
          components: [
            { type: "WidgetWorkspaceBanner", id: "doc-banner", props: { title, subtitle: "Standard Operating Procedure", showDate: false, themeMode: "light" } },
            { type: "TextBlock", id: "doc-body", props: { content: String(item.content ?? ""), maxWidth: "48rem", themeMode: "light" } },
          ],
        }
        const page = await createPageFromJson({ slug, title, json_content, owner_type: "bloq", owner_id: ownerId, publish: true, requires_auth: !args.public })
        if (page?.id) created.push({ item_id: Number(item.id), title, slug, url: `https://freelabel.net/p/${slug}` })
      }

      if (args.json) { console.log(JSON.stringify({ success: true, gated: !args.public, pages: created })); return }
      spinner?.stop(`${success("✓")} Published ${created.length} page(s) ${args.public ? "(public)" : "(auth-gated)"}`)
      console.log()
      for (const p of created) console.log(`  ${dim(`#${p.item_id}`)}  ${p.title.slice(0, 48)}  ${dim("→")}  ${p.url}`)
      console.log()
      prompts.outro("Done")
    } catch (err) {
      spinner?.stop("Error", 1)
      if (args.json) { console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) })); return }
      prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done")
    }
  },
})

/**
 * Top-level `iris search <query>` — the same command as `iris bloqs search`, promoted.
 *
 * Discoverability was the whole point of the request. A search buried three tokens deep
 * under a noun you have to already know ("bloqs") is a search nobody runs. `iris search`
 * is the form people actually try first, so it is the form that has to work.
 */
export const PlatformSearchCommand = cmd({
  ...BloqsSearchCommand,
  command: "search <query>",
  aliases: ["find"],
  describe: "search everything you have written — item titles, item content, and board names",
})

export const PlatformBloqsCommand = cmd({
  command: "bloqs",
  aliases: ["kb", "knowledge", "memory", "projects", "atlas"],
  describe: "manage knowledge bases (bloqs) — start with: iris search <query>",
  builder: (yargs) =>
    yargs
      .command(BloqsListCommand)
      .command(BloqsGetCommand)
      .command(BloqsExportCommand)
      .command(BloqsOpenCommand)
      .command(BloqsShareCommand)
      .command(BloqsMembersCommand)
      .command(BloqsAddMemberCommand)
      .command(BloqsRemoveMemberCommand)
      .command(BloqsLinksCommand)
      .command(BloqsRevokeLinkCommand)
      .command(BloqsCreateCommand)
      .command(BloqsUpdateCommand)
      .command(BloqsIngestCommand)
      .command(BloqsAddItemCommand)
      .command(BloqsDeleteItemCommand)
      .command(BloqsRestoreItemCommand)
      .command(BloqsDeleteCommand)
      .command(BloqsPublishCommand)
      .command(BloqsMakePublicCommand)
      .command(BloqsMakePrivateCommand)
      .command(BloqsCreateListCommand)
      .command(BloqsRenameListCommand)
      .command(BloqsDeleteListCommand)
      .command(BloqsMoveItemCommand)
      .command(BloqsReorderItemCommand)
      .command(BloqsComposeCommand)
      .command(BloqsRenameCommand)
      .command(BloqsSearchCommand)
      .command(BloqsAttachLeadCommand)
      .command(BloqsDetachLeadCommand)
      .command(BloqsAttachPlaybookCommand)
      .command(BloqsDetachPlaybookCommand)
      .command(BloqsPlaybooksCommand)
      .command(BloqsUpdateItemCommand)
      .command(BloqsContributorsCommand)
      .command(BloqsItemsCommand)
      .command(BloqsPublishPagesCommand)
      .command(BloqsRelateCommand)
      .command(BloqsUnrelateCommand)
      .command(BloqsRelationsCommand)
      .command(AtlasUseCommand)
      .demandCommand(),
  async handler() {},
})
