import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"
import { executeIntegrationCall } from "./platform-run"

const COMPOSIO_KEY = "ak_c2m5Q0Av7lOHYK9NPTCn"

interface Asset {
  id: string | null
  name: string
  type: string
  thumbnail: string | null
  url?: string | null
  source: string
}

// ============================================================================
// Composio helpers
// ============================================================================

async function findComposioAccount(appName: string): Promise<string | null> {
  try {
    const userId = (await requireUserId()) ?? 193
    const res = await fetch(
      `https://backend.composio.dev/api/v1/connectedAccounts?entityId=user-${userId}`,
      { headers: { "x-api-key": COMPOSIO_KEY } },
    )
    if (!res.ok) return null
    const data = (await res.json()) as any
    for (const item of data.items ?? []) {
      if (item.appName === appName && item.status === "ACTIVE") return item.id
    }
  } catch {}
  return null
}

async function composioExecute(action: string, accountId: string, params: Record<string, unknown>): Promise<any> {
  try {
    const res = await fetch(
      `https://backend.composio.dev/api/v2/actions/${action}/execute`,
      {
        method: "POST",
        headers: { "x-api-key": COMPOSIO_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({ connectedAccountId: accountId, input: params }),
      },
    )
    return await res.json()
  } catch (e) {
    return { successful: false, error: e instanceof Error ? e.message : String(e) }
  }
}

// ============================================================================
// Asset listing per source
// ============================================================================

async function listCanvaAssets(query = ""): Promise<Asset[]> {
  const accountId = await findComposioAccount("canva")
  if (!accountId) return []
  const params: Record<string, unknown> = { ownership: "owned" }
  if (query) params.query = query
  const result = await composioExecute("CANVA_LIST_USER_DESIGNS", accountId, params)
  if (!(result?.successful || result?.successfull)) return []
  const data = result.data?.response_data ?? result.data ?? {}
  const items: any[] = data.items ?? data.designs ?? []
  return items.map((i) => ({
    id: i.id ?? null,
    name: i.title ?? i.name ?? "Untitled",
    type: "design",
    thumbnail: i.thumbnail?.url ?? i.urls?.thumbnail_url ?? null,
    url: i.urls?.edit_url ?? i.urls?.view_url ?? null,
    source: "canva",
  }))
}

async function listDriveAssets(query = ""): Promise<Asset[]> {
  try {
    const result = await executeIntegrationCall("google-drive", "search_files", {
      query: query || "logo OR brand OR icon",
    })
    const files: any[] = result?.files ?? result?.data ?? []
    return files.map((f) => ({
      id: f.id ?? null,
      name: f.name ?? f.title ?? "Untitled",
      type: f.mimeType ?? "unknown",
      thumbnail: f.thumbnailLink ?? null,
      url: f.webViewLink ?? f.alternateLink ?? null,
      source: "google-drive",
    }))
  } catch {
    return []
  }
}

async function listAssetsForSource(source: string, query: string): Promise<Asset[]> {
  if (source === "canva") return listCanvaAssets(query)
  if (source === "google-drive") return listDriveAssets(query)
  return []
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["scan"],
  describe: "scan for brand assets",
  builder: (y) =>
    y
      .option("from", { alias: "f", type: "string", default: "canva", choices: ["canva", "google-drive"] })
      .option("query", { type: "string", default: "" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Atlas — Brand Kit Scanner (${args.from})`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Scanning…")
    const assets = await listAssetsForSource(String(args.from), String(args.query ?? ""))
    spinner.stop(`${assets.length} asset(s)`)

    if (args.json) { console.log(JSON.stringify({ source: args.from, assets, count: assets.length }, null, 2)); prompts.outro("Done"); return }

    if (assets.length === 0) {
      prompts.log.warn(`No assets found on ${args.from}.`)
      prompts.log.info(`Make sure ${args.from} is connected: iris integrations connect ${args.from}`)
      prompts.outro("Done")
      return
    }

    printDivider()
    for (const a of assets) {
      console.log(`  ${highlight(String(a.id ?? "—").slice(0, 20))}  ${bold(a.name.slice(0, 45))}  ${dim(a.type)}`)
    }
    printDivider()
    prompts.outro(dim(`iris atlas:brand-kit pull --from=${args.from} --lead=<id>`))
  },
})

const PullCommand = cmd({
  command: "pull",
  aliases: ["collect"],
  describe: "pull brand assets to a lead/bloq",
  builder: (y) =>
    y
      .option("from", { alias: "f", type: "string", default: "canva" })
      .option("lead", { alias: "l", type: "number" })
      .option("bloq", { alias: "b", type: "number" })
      .option("query", { type: "string", default: "logo brand" })
      .option("dry-run", { type: "boolean" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Atlas — Brand Kit Pull (${args.from})`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const leadId = args.lead as number | undefined
    const bloqId = args.bloq as number | undefined
    if (!leadId && !bloqId) {
      prompts.log.error("Specify --lead=<id> or --bloq=<id>")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Scanning for brand assets…")
    const assets = await listAssetsForSource(String(args.from), String(args.query))
    spinner.stop(`${assets.length} asset(s) found`)

    if (assets.length === 0) {
      prompts.log.warn("No brand assets found.")
      prompts.outro("Done")
      return
    }

    const brandKit = { logos: [] as Asset[], images: [] as Asset[], templates: [] as Asset[], other: [] as Asset[] }
    for (const a of assets) {
      const n = a.name.toLowerCase()
      if (n.includes("logo") || n.includes("icon") || n.includes("mark")) brandKit.logos.push(a)
      else if (n.includes("template") || n.includes("brand")) brandKit.templates.push(a)
      else if (["image", "photo", "jpg", "png", "svg"].includes(a.type)) brandKit.images.push(a)
      else brandKit.other.push(a)
    }

    if (args["dry-run"]) {
      if (args.json) {
        console.log(JSON.stringify({ dry_run: true, source: args.from, brand_kit: brandKit, counts: {
          logos: brandKit.logos.length, images: brandKit.images.length, templates: brandKit.templates.length, other: brandKit.other.length,
        } }, null, 2))
      } else {
        prompts.log.warn("DRY RUN — nothing saved")
        console.log(`  ${dim("Logos:")} ${brandKit.logos.length}  ${dim("Images:")} ${brandKit.images.length}  ${dim("Templates:")} ${brandKit.templates.length}  ${dim("Other:")} ${brandKit.other.length}`)
      }
      prompts.outro("Done")
      return
    }

    let noteContent = `## Brand Kit (Atlas OS — Auto-Collected from ${args.from})\n\n`
    noteContent += `**Logos** (${brandKit.logos.length}):\n`
    for (const l of brandKit.logos) noteContent += `- ${l.name}${l.thumbnail ? " — " + l.thumbnail : ""}\n`
    noteContent += `\n**Images** (${brandKit.images.length}):\n`
    for (const i of brandKit.images.slice(0, 10)) noteContent += `- ${i.name}\n`
    noteContent += `\n**Templates** (${brandKit.templates.length}):\n`
    for (const t of brandKit.templates) noteContent += `- ${t.name}\n`

    try {
      if (leadId) {
        const res = await irisFetch(`/api/v1/leads/${leadId}/notes`, {
          method: "POST",
          body: JSON.stringify({ message: noteContent }),
        })
        const ok = await handleApiError(res, "Create note")
        if (!ok) { prompts.outro("Done"); return }
        const data = (await res.json()) as any
        const noteId = data?.data?.id ?? data?.id
        console.log(`  ${success("✓")} Brand kit saved to lead #${leadId}${noteId ? " (note #" + noteId + ")" : ""}`)
      } else if (bloqId) {
        const res = await irisFetch(`/api/v1/bloqs/${bloqId}/items`, {
          method: "POST",
          body: JSON.stringify({
            title: `Brand Kit — ${args.from} — ${new Date().toLocaleDateString()}`,
            content: noteContent,
            type: "note",
          }),
        })
        const ok = await handleApiError(res, "Create bloq item")
        if (!ok) { prompts.outro("Done"); return }
        console.log(`  ${success("✓")} Brand kit saved to bloq #${bloqId}`)
      }
      console.log(`  ${dim("Logos:")} ${brandKit.logos.length}  ${dim("Images:")} ${brandKit.images.length}  ${dim("Templates:")} ${brandKit.templates.length}`)
      prompts.outro("Done")
    } catch (e) {
      prompts.log.error(e instanceof Error ? e.message : String(e))
      prompts.outro("Done")
    }
  },
})

const ExportCommand = cmd({
  command: "export <asset_id>",
  describe: "export a specific design (Canva)",
  builder: (y) =>
    y
      .positional("asset_id", { type: "string", demandOption: true })
      .option("from", { alias: "f", type: "string", default: "canva" })
      .option("format", { type: "string", default: "png", choices: ["png", "jpg", "svg", "pdf"] }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas — Export Design")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    if (args.from !== "canva") {
      prompts.log.error("Export only supported for Canva designs.")
      prompts.outro("Done")
      return
    }
    const accountId = await findComposioAccount("canva")
    if (!accountId) {
      prompts.log.error("Canva not connected. Run: iris integrations connect canva")
      prompts.outro("Done")
      return
    }
    const spinner = prompts.spinner()
    spinner.start(`Exporting ${args.asset_id} as ${args.format}…`)
    const result = await composioExecute("CANVA_POST_EXPORTS", accountId, {
      design_id: args.asset_id,
      format_type: args.format,
    })
    if (result?.successful || result?.successfull) {
      spinner.stop(success("Export job started"))
      console.log(JSON.stringify(result.data?.response_data ?? result.data ?? {}, null, 2))
    } else {
      spinner.stop("Failed", 1)
      prompts.log.error(`Export failed: ${result?.error ?? "unknown"}`)
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformAtlasBrandKitCommand = cmd({
  command: "atlas:brand-kit",
  aliases: ["brand-kit"],
  describe: "[Atlas OS] Pull brand assets from Canva, Google Drive, or Dropbox",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(PullCommand)
      .command(ExportCommand)
      .demandCommand(),
  async handler() {},
})
