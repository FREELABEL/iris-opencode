import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// iris bookings — the operator capture surface for the Charge engine (#168496)
//
// HOLD bookings authorize a card now and capture later. A Stripe authorization voids in
// ~7 days, so someone must capture (deliver) or release (can't fulfil) before then. This
// is that someone's fastest surface. `charge:sweep-holds` on the server warns; this acts.
// ============================================================================

function formatCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined) return "-"
  return `$${(cents / 100).toFixed(2)}`
}

function expiryLabel(iso: string | null | undefined): string {
  if (!iso) return dim("no expiry")
  const ms = new Date(iso).getTime() - Date.now()
  if (Number.isNaN(ms)) return dim(String(iso))
  const hours = ms / 36e5
  if (hours <= 0) return highlight("EXPIRED")
  if (hours < 24) return highlight(`${hours.toFixed(1)}h left`)
  return dim(`${Math.floor(hours / 24)}d left`)
}

function printHold(b: Record<string, unknown>): void {
  const id = bold(`#${b.id}`)
  const amount = formatCents(b.charged_cents as number)
  const label = String(b.resource_label ?? b.service_name ?? "booking")
  const who = b.customer_name ? dim(` — ${b.customer_name}`) : ""
  console.log(`  ${id}  ${amount}  ${label}${who}  ${expiryLabel(b.authorization_expires_at as string)}`)
}

// ── list (the capture queue) ───────────────────────────────────────────────

const ListCommand = cmd({
  command: "list <bloq-id>",
  aliases: ["ls", "holds"],
  describe: "list HOLD authorizations awaiting capture or release, soonest-to-expire first",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "booking bloq ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) return

    const bloqId = args["bloq-id"]
    if (!args.json) prompts.intro("◈  Capture Queue")
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading holds…")

    try {
      const res = await irisFetch(`/api/v1/bloqs/${bloqId}/bookings/holds`)
      const ok = await handleApiError(res, "List holds")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as { data?: unknown[] }
      const items = json.data ?? []
      if (spinner) spinner.stop(`${items.length} authorization(s) awaiting action`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
      } else if (items.length === 0) {
        prompts.log.info("No HOLD authorizations awaiting capture. Nothing at risk of expiring.")
      } else {
        UI.empty()
        for (const b of items as Record<string, unknown>[]) printHold(b)
        UI.empty()
        prompts.log.info(`Capture:  ${dim(`iris bookings capture ${bloqId} <booking-id>`)}`)
        prompts.log.info(`Release:  ${dim(`iris bookings release ${bloqId} <booking-id>`)}`)
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }
    if (!args.json) prompts.outro("Done")
  },
})

// ── capture ─────────────────────────────────────────────────────────────────

const CaptureCommand = cmd({
  command: "capture <bloq-id> <booking-id>",
  describe: "capture a HOLD authorization (charge the customer) — full amount unless --amount given",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "booking bloq ID", type: "number", demandOption: true })
      .positional("booking-id", { describe: "booking ID", type: "number", demandOption: true })
      .option("amount", { describe: "partial capture in dollars (never more than authorized)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) return

    const bloqId = args["bloq-id"]
    const id = args["booking-id"]
    const amountCents = args.amount !== undefined ? Math.round(args.amount * 100) : undefined

    if (!args.json) prompts.intro(`◈  Capture Booking #${id}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Capturing…")

    try {
      const res = await irisFetch(`/api/v1/bloqs/${bloqId}/bookings/${id}/capture`, {
        method: "PUT",
        body: amountCents !== undefined ? JSON.stringify({ amount_cents: amountCents }) : undefined,
      })
      const ok = await handleApiError(res, "Capture booking")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as any
      const data = json.data ?? json
      if (spinner) spinner.stop(success("Captured"))
      if (args.json) {
        console.log(JSON.stringify(json, null, 2))
      } else {
        prompts.log.success(`Charged ${formatCents(data.charged_cents)} — booking #${id} is now ${bold(String(data.charge_status ?? "captured"))}.`)
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }
    if (!args.json) prompts.outro("Done")
  },
})

// ── release ─────────────────────────────────────────────────────────────────

const ReleaseCommand = cmd({
  command: "release <bloq-id> <booking-id>",
  describe: "release a HOLD authorization (void it — the money never moved)",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "booking bloq ID", type: "number", demandOption: true })
      .positional("booking-id", { describe: "booking ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const token = await requireAuth()
    if (!token) return

    const bloqId = args["bloq-id"]
    const id = args["booking-id"]

    if (!args.json) prompts.intro(`◈  Release Booking #${id}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Releasing…")

    try {
      const res = await irisFetch(`/api/v1/bloqs/${bloqId}/bookings/${id}/release`, { method: "PUT" })
      const ok = await handleApiError(res, "Release booking")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as any
      if (spinner) spinner.stop(success("Released"))
      if (args.json) {
        console.log(JSON.stringify(json, null, 2))
      } else {
        prompts.log.success(`Authorization voided — booking #${id} released. No charge was made.`)
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }
    if (!args.json) prompts.outro("Done")
  },
})

export const PlatformBookingsCommand = cmd({
  command: "bookings",
  aliases: ["booking"],
  describe: "operator surface for bookings — capture or release HOLD authorizations",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(CaptureCommand)
      .command(ReleaseCommand)
      .demandCommand(1, "Specify a subcommand"),
  async handler() {},
})
