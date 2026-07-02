import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"

// ============================================================================
// iris bloq-sync — operate the Bloq ↔ cloud-storage sync feature from the CLI
//
// Parity with the UI (Elon CloudSyncPanel / Board.vue) over BloqSyncController:
//   GET    /api/v1/bloqs/{id}/sync/config              → getConfig      (config)
//   POST   /api/v1/bloqs/{id}/sync/config              → linkFolder     (link)
//   DELETE /api/v1/bloqs/{id}/sync/config/{provider}   → unlinkFolder   (unlink)
//   GET    /api/v1/bloqs/{id}/sync/browse/{provider}   → browseFolders  (browse) *
//   POST   /api/v1/bloqs/{id}/sync/export-item         → exportItem     (export-item)
//   GET    /api/v1/bloqs/{id}/sync/providers           → getProviders   (providers) *
//   GET    /api/v1/bloqs/{id}/sync/status              → getSyncStatus  (status)
//   POST   /api/v1/bloqs/{id}/sync/trigger             → triggerSync    (trigger)
//   POST   /api/v1/bloqs/{id}/sync/run-now             → runSyncNow     (run-now)
//   GET    /api/v1/bloqs/{id}/sync/debug               → debugSync      (debug) *
//   POST   /api/v1/bloqs/{id}/sync/import              → importFile     (import)
//
// (*) browse / providers / debug have NO UI caller today — the Elon panel hits
//     iris-api's /cloud-sync/* directly and never touches sync/debug. So the
//     CLI is the only complete surface over BloqSyncController.
//
// All endpoints are owner-scoped server-side via $request->user(); the CLI
// authenticates with the stored token (requireAuth) — no user-id flag needed.
// ============================================================================

// ----------------------------------------------------------------------------
// Pure helpers (unit-tested in platform-bloq-sync.test.ts)
// ----------------------------------------------------------------------------

/** Canonical provider ids the BloqSyncController accepts. */
export const CANONICAL_PROVIDERS = ["google-drive", "dropbox"] as const
export type CanonicalProvider = (typeof CANONICAL_PROVIDERS)[number]

/**
 * Normalize a user-typed provider into the canonical id the API validates on.
 * The UI/API use the hyphenated `google-drive`; humans (and the data-sources
 * `sync` verb) type `gdrive` / `drive` / `google_drive`. Returns null for an
 * unknown provider so callers can fail loudly instead of POSTing a 422.
 *
 * `allowAll` permits the special "all" value used by `trigger`.
 */
export function normalizeProvider(
  raw: string | undefined,
  allowAll = false,
): CanonicalProvider | "all" | null {
  const v = (raw ?? "").trim().toLowerCase().replace(/_/g, "-")
  if (!v) return null
  if (allowAll && v === "all") return "all"
  if (["google-drive", "googledrive", "gdrive", "drive", "google"].includes(v)) return "google-drive"
  if (["dropbox", "db", "drop"].includes(v)) return "dropbox"
  return null
}

/** Pretty one-line summary of a single provider's linked-folder config. */
export function formatProviderConfig(provider: string, cfg: any): string {
  const folder = cfg?.folder_name || cfg?.folder_path || cfg?.folder_id || dim("(no folder)")
  const auto = cfg?.auto_sync ? success("auto-sync on") : dim("auto-sync off")
  const last = cfg?.last_exported_at ? `last: ${cfg.last_exported_at}` : dim("never synced")
  return `${bold(provider)}  →  ${folder}  ${dim("•")}  ${auto}  ${dim("•")}  ${dim(last)}`
}

// ----------------------------------------------------------------------------
// Shared request/error plumbing
// ----------------------------------------------------------------------------

/** Run an authed request, honour --json, and surface API errors consistently. */
async function call(
  args: any,
  action: string,
  path: string,
  init: RequestInit = {},
): Promise<any | null> {
  const token = await requireAuth()
  if (!token) {
    prompts.outro("Done")
    return null
  }
  const res = await irisFetch(path, init)
  const ok = await handleApiError(res, action)
  if (!ok) {
    prompts.outro("Done")
    return null
  }
  return (await res.json()) as any
}

/** Reject an unknown provider before we hit the API (avoids a 422). */
function resolveProviderOrBail(raw: string | undefined, allowAll = false): CanonicalProvider | "all" | null {
  const p = normalizeProvider(raw, allowAll)
  if (!p) {
    console.log(
      `  ${dim("✗ unknown provider")} ${bold(String(raw))}${dim(
        ` — use one of: ${[...CANONICAL_PROVIDERS, ...(allowAll ? ["all"] : [])].join(", ")}`,
      )}`,
    )
  }
  return p
}

// ----------------------------------------------------------------------------
// bloq-sync providers <bloqId>   — list connected cloud accounts
// ----------------------------------------------------------------------------

const ProvidersCommand = cmd({
  command: "providers <bloqId>",
  aliases: ["accounts"],
  describe: "list cloud-storage providers the user has connected",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true, describe: "bloq id (route scope)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Providers")
    const data = await call(args, "List providers", `/api/v1/bloqs/${args.bloqId}/sync/providers`)
    if (!data) return
    const providers: any[] = data?.data?.providers ?? data?.providers ?? []
    if (args.json) {
      console.log(JSON.stringify(providers, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    if (providers.length === 0) {
      console.log(`  ${dim("(no connected providers — connect Google Drive / Dropbox first)")}`)
    } else {
      for (const p of providers) {
        const id = p.id ?? p.provider ?? p.type ?? p
        const label = p.name ?? p.label ?? ""
        console.log(`  ${bold(String(id))}  ${dim(String(label))}`)
      }
    }
    printDivider()
    console.log(`  ${dim("link a folder:")} ${highlight(`iris bloq-sync link ${args.bloqId} <provider>`)}`)
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync config <bloqId>   — show linked folders for a bloq
// ----------------------------------------------------------------------------

const ConfigCommand = cmd({
  command: "config <bloqId>",
  aliases: ["show"],
  describe: "show the cloud-sync config (linked folders) for a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Config")
    const data = await call(args, "Get sync config", `/api/v1/bloqs/${args.bloqId}/sync/config`)
    if (!data) return
    const cloudSync = data?.data?.cloud_sync ?? data?.cloud_sync ?? {}
    if (args.json) {
      console.log(JSON.stringify(cloudSync, null, 2))
      prompts.outro("Done")
      return
    }
    const providers = Object.keys(cloudSync || {})
    printDivider()
    if (providers.length === 0) {
      console.log(`  ${dim("(no folders linked)")}`)
      console.log(`  ${dim("link one:")} ${highlight(`iris bloq-sync link ${args.bloqId} dropbox`)}`)
    } else {
      for (const prov of providers) {
        console.log(`  ${formatProviderConfig(prov, cloudSync[prov])}`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync status <bloqId> [--provider]   — sync stats / recent log
// ----------------------------------------------------------------------------

const StatusCommand = cmd({
  command: "status <bloqId>",
  describe: "show sync status/stats for a bloq (optionally one provider)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("provider", { alias: "p", type: "string", describe: "filter to one provider" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Status")
    let path = `/api/v1/bloqs/${args.bloqId}/sync/status`
    if (args.provider) {
      const p = resolveProviderOrBail(args.provider as string)
      if (!p) {
        prompts.outro("Done")
        return
      }
      path += `?provider=${encodeURIComponent(p)}`
    }
    const data = await call(args, "Get sync status", path)
    if (!data) return
    const status = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(status, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    // The status payload shape varies; print the common scalar fields, then any per-provider blocks.
    for (const [k, v] of Object.entries(status || {})) {
      if (v === null || typeof v === "object") continue
      printKV(k, v)
    }
    for (const [k, v] of Object.entries(status || {})) {
      if (v && typeof v === "object" && !Array.isArray(v)) {
        console.log(`  ${bold(k)}`)
        for (const [k2, v2] of Object.entries(v as any)) {
          if (v2 !== null && typeof v2 !== "object") printKV(`  ${k2}`, v2)
        }
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync link <bloqId> <provider> [--folder-id ... | auto]
// ----------------------------------------------------------------------------

const LinkCommand = cmd({
  command: "link <bloqId> <provider>",
  describe: "link (or auto-create) a cloud folder for a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("provider", { type: "string", demandOption: true, describe: "google-drive | dropbox" })
      .option("folder-id", { type: "string", describe: "existing folder id (omit/`auto` → auto-create a bloq folder)" })
      .option("folder-name", { type: "string" })
      .option("folder-path", { type: "string" })
      .option("auto-sync", { type: "boolean", describe: "enable scheduled auto-sync for this provider" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Link")
    const provider = resolveProviderOrBail(args.provider as string)
    if (!provider) {
      prompts.outro("Done")
      return
    }
    const body: Record<string, unknown> = { provider }
    if (args["folder-id"] !== undefined) body.folder_id = args["folder-id"]
    if (args["folder-name"] !== undefined) body.folder_name = args["folder-name"]
    if (args["folder-path"] !== undefined) body.folder_path = args["folder-path"]
    if (args["auto-sync"] !== undefined) body.auto_sync = args["auto-sync"]

    const data = await call(args, "Link folder", `/api/v1/bloqs/${args.bloqId}/sync/config`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!data) return
    const cloudSync = data?.data?.cloud_sync ?? data?.cloud_sync ?? {}
    if (args.json) {
      console.log(JSON.stringify(cloudSync, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ linked")}  ${formatProviderConfig(provider, cloudSync[provider])}`)
    printDivider()
    console.log(`  ${dim("now sync it:")} ${highlight(`iris bloq-sync trigger ${args.bloqId} -p ${provider}`)}`)
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync unlink <bloqId> <provider>
// ----------------------------------------------------------------------------

const UnlinkCommand = cmd({
  command: "unlink <bloqId> <provider>",
  describe: "unlink a cloud provider from a bloq",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("provider", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Unlink")
    const provider = resolveProviderOrBail(args.provider as string)
    if (!provider) {
      prompts.outro("Done")
      return
    }
    const data = await call(
      args,
      "Unlink folder",
      `/api/v1/bloqs/${args.bloqId}/sync/config/${provider}`,
      { method: "DELETE" },
    )
    if (!data) return
    if (args.json) {
      console.log(JSON.stringify(data?.data ?? data, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ unlinked")} ${bold(provider)} ${dim("from bloq")} #${args.bloqId}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync browse <bloqId> <provider> [--folder-id]
// ----------------------------------------------------------------------------

const BrowseCommand = cmd({
  command: "browse <bloqId> <provider>",
  describe: "browse folders/files in a connected provider (to pick a folder id)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("provider", { type: "string", demandOption: true })
      .option("folder-id", { type: "string", describe: "folder id to list inside (omit → root)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Browse")
    const provider = resolveProviderOrBail(args.provider as string)
    if (!provider) {
      prompts.outro("Done")
      return
    }
    let path = `/api/v1/bloqs/${args.bloqId}/sync/browse/${provider}`
    if (args["folder-id"]) path += `?folder_id=${encodeURIComponent(String(args["folder-id"]))}`
    const data = await call(args, "Browse folders", path)
    if (!data) return
    const payload = data?.data ?? data
    const folders: any[] = payload?.folders ?? []
    const files: any[] = payload?.files ?? []
    if (args.json) {
      console.log(JSON.stringify({ folders, files }, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    if (!folders.length && !files.length) {
      console.log(`  ${dim("(empty)")}`)
    }
    for (const f of folders) {
      console.log(`  ${bold("📁 " + (f.name ?? f.title ?? "?"))}  ${dim(f.id ?? f.folder_id ?? "")}`)
    }
    for (const f of files) {
      console.log(`  ${dim("📄")} ${f.name ?? f.title ?? "?"}  ${dim(f.id ?? f.file_id ?? "")}`)
    }
    printDivider()
    console.log(`  ${dim("link a folder:")} ${highlight(`iris bloq-sync link ${args.bloqId} ${provider} --folder-id <id>`)}`)
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync trigger <bloqId> [--provider] [--force]   — queued (recommended)
// ----------------------------------------------------------------------------

const TriggerCommand = cmd({
  command: "trigger <bloqId>",
  aliases: ["sync"],
  describe: "queue a sync job (defaults to all linked providers)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("provider", { alias: "p", type: "string", describe: "google-drive | dropbox | all (default: all)" })
      .option("force", { alias: "f", type: "boolean", default: false, describe: "re-export every item (ignore hashes)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Trigger")
    const body: Record<string, unknown> = { force: !!args.force }
    if (args.provider) {
      const p = resolveProviderOrBail(args.provider as string, true)
      if (!p) {
        prompts.outro("Done")
        return
      }
      body.provider = p
    }
    const data = await call(args, "Trigger sync", `/api/v1/bloqs/${args.bloqId}/sync/trigger`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!data) return
    const payload = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    const provs = (payload?.providers ?? []).join(", ") || dim("(none)")
    console.log(`  ${success("✓ queued")}  providers: ${bold(provs)}  ${dim(payload?.force ? "(forced)" : "")}`)
    console.log(`  ${dim("files appear in the cloud folder shortly — check:")} ${highlight(`iris bloq-sync status ${args.bloqId}`)}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync run-now <bloqId> [--provider] [--force] [--list-id]  — synchronous
// ----------------------------------------------------------------------------

const RunNowCommand = cmd({
  command: "run-now <bloqId>",
  describe: "run sync synchronously (waits for the result; bypasses the queue)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("provider", { alias: "p", type: "string", default: "dropbox", describe: "google-drive | dropbox" })
      .option("force", { alias: "f", type: "boolean", default: true })
      .option("list-id", { type: "number", describe: "sync only one list's items" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Run-now")
    const provider = resolveProviderOrBail(args.provider as string)
    if (!provider) {
      prompts.outro("Done")
      return
    }
    const body: Record<string, unknown> = { provider, force: !!args.force }
    if (args["list-id"] !== undefined) body.list_id = args["list-id"]
    const data = await call(args, "Run sync now", `/api/v1/bloqs/${args.bloqId}/sync/run-now`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!data) return
    const payload = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    printKV("synced", payload?.synced)
    printKV("failed", payload?.failed)
    printKV("total", payload?.total)
    const failedItems = (payload?.items ?? []).filter((i: any) => i && i.success === false)
    if (failedItems.length) {
      console.log(`  ${dim("failures:")}`)
      for (const i of failedItems.slice(0, 20)) {
        console.log(`    ${dim("✗")} #${i.item_id} ${i.title ?? ""} ${dim(i.error ?? "")}`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync export-item <bloqId> <itemId> <provider>
// ----------------------------------------------------------------------------

const ExportItemCommand = cmd({
  command: "export-item <bloqId> <itemId> <provider>",
  aliases: ["export"],
  describe: "export a single bloq item/card to the linked cloud folder",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("itemId", { type: "number", demandOption: true })
      .positional("provider", { type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Export item")
    const provider = resolveProviderOrBail(args.provider as string)
    if (!provider) {
      prompts.outro("Done")
      return
    }
    const data = await call(args, "Export item", `/api/v1/bloqs/${args.bloqId}/sync/export-item`, {
      method: "POST",
      body: JSON.stringify({ provider, item_id: args.itemId }),
    })
    if (!data) return
    const payload = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ exported")}  ${bold(payload?.filename ?? `item #${args.itemId}`)}`)
    printKV("link", payload?.web_link ?? payload?.remote_web_link)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync import <bloqId> <provider> <fileId> [--file-name]
// ----------------------------------------------------------------------------

const ImportCommand = cmd({
  command: "import <bloqId> <provider> <fileId>",
  describe: "import a cloud file into the bloq as a new item (pull)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("provider", { type: "string", demandOption: true })
      .positional("fileId", { type: "string", demandOption: true })
      .option("file-name", { type: "string", describe: "override the imported file name" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Import")
    const provider = resolveProviderOrBail(args.provider as string)
    if (!provider) {
      prompts.outro("Done")
      return
    }
    const body: Record<string, unknown> = { provider, file_id: args.fileId }
    if (args["file-name"]) body.file_name = args["file-name"]
    const data = await call(args, "Import file", `/api/v1/bloqs/${args.bloqId}/sync/import`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!data) return
    const payload = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ imported")}  ${bold(payload?.item?.title ?? payload?.title ?? args.fileId)}`)
    printKV("item id", payload?.item?.id ?? payload?.item_id)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// bloq-sync debug <bloqId>   — what the sync query finds (no jobs dispatched)
// ----------------------------------------------------------------------------

const DebugCommand = cmd({
  command: "debug <bloqId>",
  describe: "diagnostic: show lists/items the sync would process (dispatches nothing)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cloud Sync · Debug")
    const data = await call(args, "Debug sync", `/api/v1/bloqs/${args.bloqId}/sync/debug`)
    if (!data) return
    const payload = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    printKV("bloq id", payload?.bloq_id)
    printKV("total items", payload?.total_items)
    console.log(`  ${bold("lists")}`)
    for (const l of payload?.lists ?? []) {
      console.log(`    ${dim("•")} ${l.name} ${dim(`(id=${l.id}, items=${l.items_count})`)}`)
    }
    const noText = (payload?.file_generation ?? []).filter((f: any) => f && !f.has_text)
    if (noText.length) {
      console.log(`  ${dim(`${noText.length} item(s) have no exportable text and will be skipped`)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// Parent command
// ----------------------------------------------------------------------------

export const PlatformBloqSyncCommand = cmd({
  command: "bloq-sync",
  aliases: ["cloud-sync", "bsync"],
  describe: "sync bloq projects ↔ Google Drive / Dropbox (link, browse, trigger, status, import)",
  builder: (yargs) =>
    yargs
      .command(ProvidersCommand)
      .command(ConfigCommand)
      .command(StatusCommand)
      .command(BrowseCommand)
      .command(LinkCommand)
      .command(UnlinkCommand)
      .command(TriggerCommand)
      .command(RunNowCommand)
      .command(ExportItemCommand)
      .command(ImportCommand)
      .command(DebugCommand)
      .demandCommand(),
  async handler() {},
})
