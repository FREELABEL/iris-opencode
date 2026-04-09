import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold } from "./iris-api"

// ============================================================================
// Atlas Staff CLI (Track 7)
// Routes: /api/v1/atlas/staff + /api/v1/atlas/staff/sign/{token} (public)
// ============================================================================

function fmtCents(c?: number | null): string {
  if (c == null) return dim("—")
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list staff members",
  builder: (y) =>
    y
      .option("bloq", { type: "number" })
      .option("event", { type: "number" })
      .option("department", { type: "string" })
      .option("type", { type: "string", describe: "employee|contractor|vendor|volunteer" })
      .option("search", { type: "string" })
      .option("limit", { type: "number", default: 50 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Staff")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const p = new URLSearchParams({ per_page: String(args.limit) })
    if (args.bloq != null) p.set("bloq_id", String(args.bloq))
    if (args.event != null) p.set("event_id", String(args.event))
    if (args.department) p.set("department", args.department)
    if (args.type) p.set("staff_type", args.type)
    if (args.search) p.set("search", args.search)

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await irisFetch(`/api/v1/atlas/staff?${p}`)
      const ok = await handleApiError(res, "List staff"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const rows: any[] = body?.data?.data ?? body?.data ?? []
      spinner.stop(`${rows.length} staff`)

      if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }
      if (rows.length === 0) { prompts.log.warn("No staff"); prompts.outro("Done"); return }

      for (const s of rows) {
        const rate = s.hourly_rate_cents ? dim(`${fmtCents(s.hourly_rate_cents)}/h`) : ""
        const contract = s.contract_status ? dim(` [${s.contract_status}]`) : ""
        console.log(`  ${bold(s.name)}  ${dim(`#${s.id}`)}  ${s.role ?? ""}  ${s.staff_type ?? ""}  ${rate}${contract}`)
        if (s.email) console.log(`    ${dim(s.email)}`)
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ShowCommand = cmd({
  command: "show <id>",
  describe: "show staff details",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth(); if (!token) return
    const res = await irisFetch(`/api/v1/atlas/staff/${args.id}`)
    const ok = await handleApiError(res, "Show"); if (!ok) return
    const data = ((await res.json()) as any)?.data
    if (args.json) { console.log(JSON.stringify(data, null, 2)) } else {
      for (const [k, v] of Object.entries(data ?? {})) {
        if (v != null && typeof v !== "object") console.log(`  ${dim(k + ":")} ${v}`)
      }
    }
  },
})

const AddCommand = cmd({
  command: "add",
  aliases: ["create"],
  describe: "add a staff member",
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true })
      .option("role", { type: "string" })
      .option("email", { type: "string" })
      .option("phone", { type: "string" })
      .option("department", { type: "string" })
      .option("type", { type: "string", default: "employee", describe: "employee|contractor|vendor|volunteer" })
      .option("rate", { type: "number", describe: "hourly rate in dollars" })
      .option("bloq", { type: "number" })
      .option("event", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add Staff")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const body: Record<string, any> = { name: args.name, staff_type: args.type }
    if (args.role) body.role = args.role
    if (args.email) body.email = args.email
    if (args.phone) body.phone = args.phone
    if (args.department) body.department = args.department
    if (args.rate != null) body.hourly_rate_cents = Math.round(Number(args.rate) * 100)
    if (args.bloq != null) body.bloq_id = args.bloq
    if (args.event != null) body.event_id = args.event

    const res = await irisFetch(`/api/v1/atlas/staff`, { method: "POST", body: JSON.stringify(body) })
    const ok = await handleApiError(res, "Create"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    prompts.outro(`${bold(data?.name)} ${dim("#" + data?.id)}`)
  },
})

const UpdateCommand = cmd({
  command: "update <id>",
  describe: "update a staff member",
  builder: (y) =>
    y
      .positional("id", { type: "number", demandOption: true })
      .option("name", { type: "string" })
      .option("role", { type: "string" })
      .option("email", { type: "string" })
      .option("phone", { type: "string" })
      .option("department", { type: "string" })
      .option("type", { type: "string" })
      .option("rate", { type: "number" }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth(); if (!token) return
    const body: Record<string, any> = {}
    if (args.name) body.name = args.name
    if (args.role) body.role = args.role
    if (args.email) body.email = args.email
    if (args.phone) body.phone = args.phone
    if (args.department) body.department = args.department
    if (args.type) body.staff_type = args.type
    if (args.rate != null) body.hourly_rate_cents = Math.round(Number(args.rate) * 100)
    if (Object.keys(body).length === 0) { console.log("Nothing to update"); return }

    const res = await irisFetch(`/api/v1/atlas/staff/${args.id}`, { method: "PATCH", body: JSON.stringify(body) })
    await handleApiError(res, "Update")
    console.log("Updated")
  },
})

const RemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["rm"],
  describe: "delete a staff member",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    const token = await requireAuth(); if (!token) return
    const res = await irisFetch(`/api/v1/atlas/staff/${args.id}`, { method: "DELETE" })
    await handleApiError(res, "Delete")
    console.log("Deleted")
  },
})

const SendContractCommand = cmd({
  command: "send-contract <id>",
  describe: "generate a signing token and contract URL",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Send Contract for staff #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/atlas/staff/${args.id}/send-contract`, { method: "POST", body: "{}" })
    const ok = await handleApiError(res, "Send contract"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    console.log(`  ${dim("signing_token:")} ${data?.signing_token}`)
    console.log(`  ${bold("sign_url:")}      ${data?.sign_url}`)
    prompts.outro("Send this URL to the recipient")
  },
})

const ByEventCommand = cmd({
  command: "by-event <eventId>",
  describe: "list staff for a specific event",
  builder: (y) => y.positional("eventId", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Staff for event #${args.eventId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/atlas/staff/by-event/${args.eventId}`)
    const ok = await handleApiError(res, "By event"); if (!ok) { prompts.outro("Done"); return }
    const rows: any[] = ((await res.json()) as any)?.data ?? []
    if (args.json) { console.log(JSON.stringify(rows, null, 2)) } else {
      for (const s of rows) console.log(`  ${bold(s.name)}  ${dim(`#${s.id}`)}  ${s.role ?? ""}`)
    }
    prompts.outro("Done")
  },
})

export const PlatformAtlasStaffCommand = cmd({
  command: "atlas:staff",
  aliases: ["atlas-staff"],
  describe: "Atlas staff management + contract signing",
  builder: (y) =>
    y
      .command(ListCommand)
      .command(ShowCommand)
      .command(AddCommand)
      .command(UpdateCommand)
      .command(RemoveCommand)
      .command(SendContractCommand)
      .command(ByEventCommand)
      .demandCommand(),
  async handler() {},
})
