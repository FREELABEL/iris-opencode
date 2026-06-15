import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Display helpers
// ============================================================================

function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "-"
  return `$${(cents / 100).toFixed(2)}`
}

function formatRate(ratePerMille: number | null): string {
  if (!ratePerMille) return "-"
  return `$${(ratePerMille / 100).toFixed(2)}/1K views`
}

function printBounty(b: Record<string, unknown>): void {
  const title = bold(String(b.title ?? `Bounty #${b.id}`))
  const id = dim(`#${b.id}`)
  const type = b.bounty_type ? `  [${String(b.bounty_type)}]` : ""
  console.log(`  ${title}  ${id}${type}`)
  console.log(`    Rate: ${formatRate(b.rate_per_mille_cents as number)}  |  Budget: ${formatCents(b.budget_pool_cents as number)}  |  Spent: ${formatCents(b.budget_spent_cents as number)}`)
  if (b.budget_remaining_cents !== null && b.budget_remaining_cents !== undefined) {
    console.log(`    Remaining: ${formatCents(b.budget_remaining_cents as number)}`)
  }
}

function printSubmission(s: Record<string, unknown>): void {
  const title = s.title ? bold(String(s.title)) : dim("(untitled)")
  const id = dim(`#${s.id}`)
  const status = String(s.status ?? "unknown")
  const statusIcon = status === "approved" ? "✓" : status === "rejected" ? "✗" : status === "pending_review" ? "◌" : "…"
  console.log(`  ${statusIcon} ${title}  ${id}  [${status}]`)
  console.log(`    ${dim(String(s.platform ?? ""))} | Views: ${s.eligible_views ?? 0} | Earned: ${formatCents(s.earned_cents as number)} | Paid: ${formatCents(s.paid_cents as number)}`)
  if (s.content_url) console.log(`    ${dim(String(s.content_url))}`)
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list active bounty campaigns",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("type", { describe: "filter by bounty_type (ugc_views, ugc_flat)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    if (!args.json) prompts.intro("◈  Content Bounties")
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading bounties…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args.type) params.set("bounty_type", String(args.type))
      const res = await irisFetch(`/api/v1/marketplace/bounties?${params}`)
      const ok = await handleApiError(res, "List bounties")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as { data?: { data?: unknown[] } }
      const items = json.data?.data ?? (json.data as unknown as unknown[]) ?? []

      if (spinner) spinner.stop(`${(items as unknown[]).length} bounties found`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
        return
      }

      if ((items as unknown[]).length === 0) {
        prompts.log.info("No active bounties found.")
      } else {
        for (const item of items as Record<string, unknown>[]) {
          printBounty(item)
          console.log()
        }
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

const MySubmissionsCommand = cmd({
  command: "my-submissions",
  aliases: ["mine"],
  describe: "view your content submissions across all bounties",
  builder: (yargs) =>
    yargs
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    if (!args.json) prompts.intro("◈  My Bounty Submissions")
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading submissions…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/marketplace/my-submissions?${params}`)
      const ok = await handleApiError(res, "My submissions")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as { data?: { data?: unknown[] } }
      const items = json.data?.data ?? (json.data as unknown as unknown[]) ?? []

      if (spinner) spinner.stop(`${(items as unknown[]).length} submissions`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
        return
      }

      if ((items as unknown[]).length === 0) {
        prompts.log.info("No submissions yet. Apply to a bounty and submit content!")
      } else {
        for (const item of items as Record<string, unknown>[]) {
          printSubmission(item)
          console.log()
        }
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

const SubmitCommand = cmd({
  command: "submit <opportunity-id>",
  describe: "submit content URL to a bounty",
  builder: (yargs) =>
    yargs
      .positional("opportunity-id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("url", { describe: "content URL (YouTube, TikTok, etc.)", type: "string", demandOption: true })
      .option("title", { describe: "optional title", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const oppId = args["opportunity-id"]
    if (!args.json) prompts.intro(`◈  Submit Content to Bounty #${oppId}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Submitting…")

    try {
      const body: Record<string, unknown> = { content_url: args.url }
      if (args.title) body.title = args.title

      const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/submissions`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      const ok = await handleApiError(res, "Submit content")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = await res.json()

      if (spinner) spinner.stop(success("Submitted!"))

      if (args.json) {
        console.log(JSON.stringify(json, null, 2))
      } else {
        prompts.log.success("Content submitted for review.")
        const data = (json as any).data ?? json
        if (data.id) prompts.log.info(`Submission ID: #${data.id}`)
        if (data.platform) prompts.log.info(`Platform detected: ${data.platform}`)
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

const StatsCommand = cmd({
  command: "stats <opportunity-id>",
  describe: "view bounty campaign stats (owner only)",
  builder: (yargs) =>
    yargs
      .positional("opportunity-id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const oppId = args["opportunity-id"]
    if (!args.json) prompts.intro(`◈  Bounty Stats #${oppId}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading stats…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/bounty-stats`)
      const ok = await handleApiError(res, "Bounty stats")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as { data?: Record<string, unknown> }
      const stats = (json.data ?? json) as any

      if (spinner) spinner.stop("Loaded")

      if (args.json) {
        console.log(JSON.stringify(stats, null, 2))
        return
      }

      printDivider()
      printKV("Rate", formatRate(stats.rate_per_mille_cents as number))
      printKV("Budget Pool", formatCents(stats.budget_pool_cents as number))
      printKV("Budget Spent", formatCents(stats.budget_spent_cents as number))
      printKV("Budget Remaining", formatCents(stats.budget_remaining_cents as number))
      printDivider()
      printKV("Total Submissions", String(stats.total_submissions ?? 0))
      printKV("Approved", String(stats.approved_submissions ?? 0))
      printKV("Pending", String(stats.pending_submissions ?? 0))
      printDivider()
      printKV("Total Eligible Views", String(stats.total_eligible_views ?? 0))
      printKV("Total Earned", formatCents(stats.total_earned_cents as number))
      printKV("Total Paid", formatCents(stats.total_paid_cents as number))
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

const ApproveCommand = cmd({
  command: "approve <submission-id>",
  describe: "approve a pending content submission",
  builder: (yargs) =>
    yargs
      .positional("submission-id", { describe: "submission ID", type: "number", demandOption: true })
      .option("tier", {
        describe: "quality tier for clip-cutting bounties (sets the payout amount)",
        type: "string",
        choices: ["high", "medium", "low"] as const,
      })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const id = args["submission-id"]
    if (!args.json) prompts.intro(`◈  Approve Submission #${id}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Approving…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/submissions/${id}/approve`, {
        method: "PATCH",
        body: args.tier ? JSON.stringify({ tier: args.tier }) : undefined,
      })
      const ok = await handleApiError(res, "Approve submission")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = await res.json()
      if (spinner) spinner.stop(success("Approved!"))

      if (args.json) {
        console.log(JSON.stringify(json, null, 2))
      } else {
        const data = (json as any).data ?? json
        prompts.log.success(`Submission approved. Initial views captured: ${data.initial_view_count ?? 0}`)
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

const RejectCommand = cmd({
  command: "reject <submission-id>",
  describe: "reject a pending content submission",
  builder: (yargs) =>
    yargs
      .positional("submission-id", { describe: "submission ID", type: "number", demandOption: true })
      .option("reason", { describe: "rejection reason", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const id = args["submission-id"]
    if (!args.json) prompts.intro(`◈  Reject Submission #${id}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Rejecting…")

    try {
      const body: Record<string, unknown> = {}
      if (args.reason) body.reason = args.reason

      const res = await irisFetch(`/api/v1/marketplace/submissions/${id}/reject`, {
        method: "PATCH",
        body: JSON.stringify(body),
      })
      const ok = await handleApiError(res, "Reject submission")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      if (spinner) spinner.stop(success("Rejected"))
      if (!args.json) prompts.log.info("Submission rejected.")
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

const PayoutCommand = cmd({
  command: "payout <opportunity-id>",
  describe: "process payouts for a bounty campaign",
  builder: (yargs) =>
    yargs
      .positional("opportunity-id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const oppId = args["opportunity-id"]
    if (!args.json) prompts.intro(`◈  Process Payouts for Bounty #${oppId}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Processing payouts…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/process-payouts`, {
        method: "POST",
      })
      const ok = await handleApiError(res, "Process payouts")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as { data?: Record<string, unknown> }
      const result = (json.data ?? json) as any

      if (spinner) spinner.stop(success("Payouts processed"))

      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      printKV("Payouts Made", String(result.payouts_count ?? 0))
      printKV("Total Paid", formatCents(result.total_paid_cents as number))
      printKV("Budget Remaining", formatCents(result.budget_remaining_cents as number))
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

const SubmissionsCommand = cmd({
  command: "submissions <opportunity-id>",
  aliases: ["subs"],
  describe: "list submissions for a bounty (owner view)",
  builder: (yargs) =>
    yargs
      .positional("opportunity-id", { describe: "opportunity ID", type: "number", demandOption: true })
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const oppId = args["opportunity-id"]
    if (!args.json) prompts.intro(`◈  Submissions for Bounty #${oppId}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Loading…")

    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/submissions?${params}`)
      const ok = await handleApiError(res, "List submissions")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as { data?: { data?: unknown[] } }
      const items = json.data?.data ?? (json.data as unknown as unknown[]) ?? []

      if (spinner) spinner.stop(`${(items as unknown[]).length} submissions`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
        return
      }

      if ((items as unknown[]).length === 0) {
        prompts.log.info("No submissions yet.")
      } else {
        for (const item of items as Record<string, unknown>[]) {
          printSubmission(item)
          console.log()
        }
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
    }

    if (!args.json) prompts.outro("Done")
  },
})

// ============================================================================
// Main command export
// ============================================================================

export const PlatformBountiesCommand = cmd({
  command: "bounty",
  aliases: ["bounties"],
  describe: "UGC content bounty campaigns — create, submit, approve, payout",
  builder: (yargs) =>
    yargs
      .command(ListCommand)
      .command(SubmitCommand)
      .command(MySubmissionsCommand)
      .command(SubmissionsCommand)
      .command(StatsCommand)
      .command(ApproveCommand)
      .command(RejectCommand)
      .command(PayoutCommand)
      .demandCommand(1, "Specify a subcommand"),
  async handler() {},
})
