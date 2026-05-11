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
  resolveUserId,
  FL_API,
} from "./iris-api"

// ============================================================================
// iris dialer start
// ============================================================================

const DialerStartCommand = cmd({
  command: "start",
  describe: "open the Power Dialer in your browser",
  builder: (yargs) =>
    yargs
      .option("bloq-id", { alias: "b", describe: "bloq/project ID to load leads from", type: "number" })
      .option("limit", { alias: "l", describe: "max leads to queue", type: "number", default: 100 }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    // Fetch leads with phone numbers to show queue preview
    const spinner = prompts.spinner()
    spinner.start("Loading leads with phone numbers...")

    try {
      const params = new URLSearchParams({
        per_page: String(args.limit),
        has_phone: "1",
      })
      if (args.bloqId) params.set("bloq_id", String(args.bloqId))

      const res = await irisFetch(`/api/v1/users/${userId}/leads?${params}`, {}, FL_API)
      if (!(await handleApiError(res, "Fetch leads"))) {
        spinner.stop("Failed", 1)
        return
      }

      const result = await res.json().catch(() => ({}))
      const leads = result?.data ?? []

      // Filter to leads that actually have phone numbers
      const dialable = leads.filter((l: any) => {
        const phone = l.phone || l.phone_number || ""
        return phone.replace(/\D/g, "").length >= 10
      })

      spinner.stop(`Found ${highlight(String(dialable.length))} dialable leads`)

      if (dialable.length === 0) {
        prompts.log.warn("No leads with valid phone numbers found")
        prompts.outro(dim("iris leads list --has-phone"))
        return
      }

      // Show preview
      printDivider()
      console.log(`  ${bold("Power Dialer Queue Preview")}`)
      console.log()
      for (const lead of dialable.slice(0, 10)) {
        const name = lead.name || lead.nickname || lead.business_name || "Unknown"
        const phone = lead.phone || lead.phone_number || ""
        const company = lead.company ? ` · ${lead.company}` : ""
        console.log(`  ${highlight(`#${lead.id}`)} ${name} ${dim(phone)}${dim(company)}`)
      }
      if (dialable.length > 10) {
        console.log(`  ${dim(`... and ${dialable.length - 10} more`)}`)
      }
      printDivider()

      // Open the dialer in browser
      const bloqParam = args.bloqId ? `?bloq=${args.bloqId}&dialer=1` : "?dialer=1"
      const frontendUrl = process.env.IRIS_FRONTEND_URL ?? "https://web.heyiris.io"
      const url = `${frontendUrl}/iris${bloqParam}`
      prompts.log.info(`Opening Power Dialer: ${dim(url)}`)

      const { exec } = require("child_process")
      exec(`open "${url}"`)

      prompts.outro(
        `${success("✓")} ${dialable.length} leads queued  ·  ${dim("iris dialer stats")}  ·  ${dim("iris leads disposition <id> meeting_booked")}`,
      )
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// iris dialer stats
// ============================================================================

const DialerStatsCommand = cmd({
  command: "stats",
  describe: "show today's dialer session stats",
  builder: (yargs) =>
    yargs.option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Loading call stats...")

    try {
      // Fetch today's outreach steps of type 'call'
      const today = new Date().toISOString().split("T")[0]
      const res = await irisFetch(
        `/api/v1/users/${userId}/leads/outreach-steps?type=call&since=${today}&source=power_dialer,cli_dialer`,
        {}, FL_API,
      )

      // If endpoint doesn't exist yet, show placeholder stats
      if (!res.ok) {
        spinner.stop("Stats endpoint not available yet")
        printDivider()
        console.log(`  ${bold("Dialer Session Stats")} ${dim(`(${today})`)}`)
        console.log()
        printKV("Tip", "Stats will populate once calls are made via the Power Dialer UI")
        printKV("Open Dialer", dim("iris dialer start"))
        printKV("Disposition", dim('iris leads disposition <id> meeting_booked --note "..."'))
        printDivider()
        prompts.outro(dim("iris leads pulse-all"))
        return
      }

      const result = await res.json().catch(() => ({}))
      const steps = result?.data ?? []

      // Calculate stats
      const dials = steps.length
      const connected = steps.filter((s: any) => s.data?.disposition && s.data.disposition !== "no_contact").length
      const meetings = steps.filter((s: any) => s.data?.disposition === "meeting_booked").length
      const callbacks = steps.filter((s: any) => s.data?.disposition === "call_back_later").length
      const voicemails = steps.filter((s: any) => s.data?.disposition === "voicemail_left").length
      const notInterested = steps.filter((s: any) => s.data?.disposition === "not_interested").length
      const totalDuration = steps.reduce((sum: number, s: any) => sum + (s.data?.call_duration || 0), 0)
      const avgDuration = connected > 0 ? Math.round(totalDuration / connected) : 0

      spinner.stop(success(`${dials} dials today`))

      if (args.json) {
        console.log(JSON.stringify({ dials, connected, meetings, callbacks, voicemails, notInterested, avgDuration, totalDuration }, null, 2))
        return
      }

      printDivider()
      console.log(`  ${bold("Dialer Session Stats")} ${dim(`(${today})`)}`)
      console.log()
      printKV("Dials", String(dials))
      printKV("Connected", highlight(String(connected)))
      printKV("Meetings", `${UI.Style.TEXT_SUCCESS}${meetings}${UI.Style.TEXT_NORMAL}`)
      printKV("Callbacks", String(callbacks))
      printKV("VM Drops", String(voicemails))
      printKV("Not Interested", String(notInterested))
      printKV("Avg Talk Time", avgDuration > 0 ? `${Math.floor(avgDuration / 60)}m ${avgDuration % 60}s` : "—")
      printDivider()
      prompts.outro(dim('iris leads disposition <id> meeting_booked --note "..."'))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// iris dialer queue
// ============================================================================

const DialerQueueCommand = cmd({
  command: "queue",
  aliases: ["ls"],
  describe: "list leads in the dialer queue (leads with phone numbers)",
  builder: (yargs) =>
    yargs
      .option("bloq-id", { alias: "b", describe: "bloq/project ID", type: "number" })
      .option("limit", { alias: "l", describe: "max leads to show", type: "number", default: 50 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) return

    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Loading dialable leads...")

    try {
      const params = new URLSearchParams({
        per_page: String(args.limit),
        has_phone: "1",
      })
      if (args.bloqId) params.set("bloq_id", String(args.bloqId))

      const res = await irisFetch(`/api/v1/users/${userId}/leads?${params}`, {}, FL_API)
      if (!(await handleApiError(res, "Fetch leads"))) {
        spinner.stop("Failed", 1)
        return
      }

      const result = await res.json().catch(() => ({}))
      const leads = result?.data ?? []

      const dialable = leads.filter((l: any) => {
        const phone = l.phone || l.phone_number || ""
        return phone.replace(/\D/g, "").length >= 10
      })

      spinner.stop(`${highlight(String(dialable.length))} dialable leads`)

      if (args.json) {
        console.log(JSON.stringify(dialable.map((l: any) => ({
          id: l.id,
          name: l.name || l.nickname || l.business_name,
          phone: l.phone || l.phone_number,
          company: l.company,
          status: l.status,
        })), null, 2))
        return
      }

      if (dialable.length === 0) {
        prompts.log.warn("No leads with valid phone numbers")
        return
      }

      printDivider()
      console.log(`  ${bold("Dialer Queue")} — ${dialable.length} leads ready`)
      console.log()
      for (const lead of dialable) {
        const name = lead.name || lead.nickname || lead.business_name || "Unknown"
        const phone = lead.phone || lead.phone_number || ""
        const company = lead.company ? dim(` · ${lead.company}`) : ""
        const status = lead.status ? dim(` [${lead.status}]`) : ""
        console.log(`  ${highlight(`#${lead.id}`)} ${name} ${dim(phone)}${company}${status}`)
      }
      printDivider()
      prompts.outro(dim("iris dialer start") + "  ·  " + dim("iris dialer stats"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformDialerCommand = cmd({
  command: "dialer",
  aliases: ["dial", "echo-dialer"],
  describe: "Power Dialer — parallel outbound calling for leads",
  builder: (yargs) =>
    yargs
      .command(DialerStartCommand)
      .command(DialerStatsCommand)
      .command(DialerQueueCommand)
      .demandCommand(),
  async handler() {},
})
