import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// Endpoints (from SopCommand.php):
//   GET    /api/v1/services/requests/simplified
//   GET    /api/v1/services/requests/{requestId}/sops
//   POST   /api/v1/services/requests/{requestId}/sops
//   PUT    /api/v1/services/requests/{requestId}/sops/{sopId}
//   DELETE /api/v1/services/requests/{requestId}/sops/{sopId}
//   POST   /api/v1/services/requests/{requestId}/sops/sync

const SopRequestsCommand = cmd({
  command: "requests",
  describe: "list service requests",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Service Requests")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/services/requests/simplified`)
    const ok = await handleApiError(res, "List requests")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const items: any[] = data?.data ?? data?.requests ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(items, null, 2)); prompts.outro("Done"); return }
    printDivider()
    for (const r of items) console.log(`  ${bold(String(r.title ?? r.name ?? "Untitled"))}  ${dim(`#${r.id}`)}`)
    printDivider()
    prompts.outro("Done")
  },
})

const SopListCommand = cmd({
  command: "list <requestId>",
  aliases: ["ls"],
  describe: "list SOPs for a service request",
  builder: (yargs) =>
    yargs
      .positional("requestId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  SOPs — Request #${args.requestId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/services/requests/${args.requestId}/sops`)
    const ok = await handleApiError(res, "List SOPs")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const sops: any[] = data?.data ?? data?.sops ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(sops, null, 2)); prompts.outro("Done"); return }
    printDivider()
    if (sops.length === 0) console.log(`  ${dim("(no SOPs)")}`)
    else for (const s of sops) {
      console.log(`  ${bold(String(s.title ?? "Untitled"))}  ${dim(`#${s.id}`)}`)
      if (s.description) console.log(`    ${dim(String(s.description).slice(0, 80))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const SopCreateCommand = cmd({
  command: "create <requestId>",
  describe: "create a new SOP",
  builder: (yargs) =>
    yargs
      .positional("requestId", { type: "number", demandOption: true })
      .option("title", { type: "string", demandOption: true })
      .option("description", { type: "string" })
      .option("content", { type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create SOP")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = { title: args.title }
    if (args.description) payload.description = args.description
    if (args.content) payload.content = args.content
    const res = await irisFetch(`/api/v1/services/requests/${args.requestId}/sops`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Create SOP")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? {}
    prompts.outro(`${success("✓")} Created SOP #${data.id ?? ""}`)
  },
})

const SopUpdateCommand = cmd({
  command: "update <requestId> <sopId>",
  describe: "update an SOP",
  builder: (yargs) =>
    yargs
      .positional("requestId", { type: "number", demandOption: true })
      .positional("sopId", { type: "number", demandOption: true })
      .option("title", { type: "string" })
      .option("description", { type: "string" })
      .option("content", { type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Update SOP #${args.sopId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const payload: any = {}
    if (args.title) payload.title = args.title
    if (args.description) payload.description = args.description
    if (args.content) payload.content = args.content
    const res = await irisFetch(`/api/v1/services/requests/${args.requestId}/sops/${args.sopId}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    })
    const ok = await handleApiError(res, "Update SOP")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Updated`)
  },
})

const SopDeleteCommand = cmd({
  command: "delete <requestId> <sopId>",
  aliases: ["rm"],
  describe: "delete an SOP",
  builder: (yargs) =>
    yargs
      .positional("requestId", { type: "number", demandOption: true })
      .positional("sopId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete SOP #${args.sopId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/services/requests/${args.requestId}/sops/${args.sopId}`, { method: "DELETE" })
    const ok = await handleApiError(res, "Delete SOP")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Deleted`)
  },
})

const SopSyncCommand = cmd({
  command: "sync <requestId>",
  describe: "sync SOPs for a service request",
  builder: (yargs) => yargs.positional("requestId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Sync SOPs — Request #${args.requestId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/services/requests/${args.requestId}/sops/sync`, { method: "POST", body: "{}" })
    const ok = await handleApiError(res, "Sync SOPs")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Synced`)
  },
})

export const PlatformSopCommand = cmd({
  command: "sop",
  describe: "manage Standard Operating Procedures (SOPs)",
  builder: (yargs) =>
    yargs
      .command(SopRequestsCommand)
      .command(SopListCommand)
      .command(SopCreateCommand)
      .command(SopUpdateCommand)
      .command(SopDeleteCommand)
      .command(SopSyncCommand)
      .demandCommand(),
  async handler() {},
})
