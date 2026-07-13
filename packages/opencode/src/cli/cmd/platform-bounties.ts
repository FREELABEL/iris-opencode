import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, isNonInteractive } from "./iris-api"

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
      // Placement bounties show the prize tiers + owner-assigned placements instead of a view rate.
      if (stats.bounty_type === "placement" && stats.reward_tiers) {
        const tiers = stats.reward_tiers as Record<string, number>
        for (const [rank, cents] of Object.entries(tiers)) {
          printKV(`Prize #${rank}`, formatCents(cents as number))
        }
        printKV("Prize Pool Total", formatCents(stats.reward_tiers_total_cents as number))
        const assigned = Array.isArray(stats.assigned_placements) ? stats.assigned_placements : []
        if (assigned.length) {
          for (const a of assigned) {
            console.log(`  ${dim(`rank #${a.placement}`)} → submission ${a.id}${a.title ? `  ${a.title}` : ""}`)
          }
        }
      } else {
        printKV("Rate", formatRate(stats.rate_per_mille_cents as number))
      }
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
      .option("dry-run", { describe: "preview payouts (placement bounties: show resolved ranks + amounts) without paying", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const oppId = args["opportunity-id"]
    if (!args.json) prompts.intro(`◈  ${args["dry-run"] ? "Preview" : "Process"} Payouts for Bounty #${oppId}`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start(args["dry-run"] ? "Computing payouts…" : "Processing payouts…")

    try {
      const path = `/api/v1/marketplace/opportunities/${oppId}/process-payouts${args["dry-run"] ? "?dry_run=1" : ""}`
      const res = await irisFetch(path, { method: "POST" })
      const ok = await handleApiError(res, "Process payouts")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); return }

      const json = (await res.json()) as { data?: Record<string, unknown> }
      const result = (json.data ?? json) as any

      if (spinner) spinner.stop(success(args["dry-run"] ? "Preview ready" : "Payouts processed"))

      if (args.json) {
        console.log(JSON.stringify(result, null, 2))
        return
      }

      printKV("Payouts Made", String(result.payouts_count ?? 0))
      printKV("Total Paid", formatCents(result.total_paid_cents as number))
      printKV("Budget Remaining", formatCents(result.budget_remaining_cents as number))

      // Placement bounties return the resolved rank → submission → amount table.
      const placements = Array.isArray(result.placements) ? result.placements : []
      if (placements.length) {
        printDivider()
        for (const p of placements) {
          const note = p.status && p.status !== "sent" ? `  ${dim(String(p.block_reason || p.status))}` : ""
          console.log(`  #${p.rank}  submission ${p.submission_id}  ${formatCents(p.amount_cents)}${note}`)
        }
      }
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

// #165984: the bounty command's help advertised `create` but it was never
// implemented — users had to know to run `iris opportunities create --bounty`.
// This mirrors that exact path (POST /api/v1/marketplace/opportunities with the
// bounty fields) so `iris bounty create` works directly.
const CreateCommand = cmd({
  command: "create",
  describe: "create a bounty (clip/UGC) campaign",
  builder: (yargs) =>
    yargs
      .option("title", { describe: "campaign title", type: "string" })
      .option("description", { describe: "campaign description", type: "string" })
      .option("type", {
        describe: "bounty type ('placement' = fixed prizes by rank via --reward-tiers)",
        type: "string",
        default: "video_views",
        choices: ["video_views", "audio_streams", "social_impressions", "ugc_views", "placement"],
      })
      .option("rate-per-mille", { describe: "pay rate per 1K views in cents (e.g. 500 = $5)", type: "number" })
      .option("reward-tiers", { describe: "placement prizes in dollars, best-first (e.g. \"250,100,50\" = 1st/2nd/3rd)", type: "string" })
      .option("budget", { describe: "total campaign budget in dollars (e.g. 10000)", type: "number" })
      .option("per-creator-cap", { describe: "max payout per creator in dollars (e.g. 500)", type: "number" })
      .option("deadline", { describe: "deadline (YYYY-MM-DD)", type: "string" })
      .option("profile-id", { describe: "attach to a profile (PK)", type: "number" })
      .option("profile", { describe: "attach to a profile (slug — resolves to PK)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    // Headless-safe: title/description are the only required fields — prompt in a
    // TTY, but fail loud (don't hang) when non-interactive without them.
    let title = args.title as string | undefined
    let description = args.description as string | undefined
    if ((!title || !description) && (args.json || isNonInteractive())) {
      const missing = !title ? "--title" : "--description"
      const msg = `${missing} is required in non-interactive mode.`
      if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 2
      return
    }

    // Placement bounties need a prize table. Parse "250,100,50" (dollars, best-first) into
    // ordered [{rank, amount_cents}] before we prompt/spin so we can fail loud early.
    let rewardTiers: Array<{ rank: number; amount_cents: number }> | undefined
    if (args.type === "placement") {
      const raw = (args["reward-tiers"] as string | undefined)?.trim()
      if (!raw) {
        const msg = "--reward-tiers is required for a placement bounty (e.g. --reward-tiers \"250,100,50\")."
        if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      const amounts = raw.split(",").map((s) => Number(s.trim()))
      if (amounts.some((n) => !Number.isFinite(n) || n <= 0)) {
        const msg = `Invalid --reward-tiers "${raw}": expected positive dollar amounts like "250,100,50".`
        if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      rewardTiers = amounts.map((dollars, i) => ({ rank: i + 1, amount_cents: Math.round(dollars * 100) }))
    }

    if (!args.json) { UI.empty(); prompts.intro("◈  Create Bounty Campaign") }

    if (!title) {
      title = (await prompts.text({ message: "Title", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(title)) { prompts.outro("Cancelled"); return }
    }
    if (!description) {
      description = (await prompts.text({ message: "Description", validate: (x) => (x && x.length > 0 ? undefined : "Required") })) as string
      if (prompts.isCancel(description)) { prompts.outro("Cancelled"); return }
    }

    // Resolve profile slug → PK if --profile provided
    let profilePk: number | undefined = args["profile-id"] as number | undefined
    if (!profilePk && args.profile) {
      const profileRes = await irisFetch(`/api/v1/profile/${args.profile}`)
      if (profileRes.ok) {
        const pd = (await profileRes.json()) as any
        const p = pd?.data ?? pd
        profilePk = p?.pk
      }
      if (!profilePk) {
        const msg = `Profile '${args.profile}' not found`
        if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 1
        return
      }
    }

    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Creating…")

    try {
      const payload: Record<string, unknown> = {
        title,
        description,
        bounty_type: args.type,
        is_public: true,
      }
      if (profilePk) payload.profile_id = profilePk
      if (rewardTiers) payload.reward_tiers = rewardTiers
      if (args["rate-per-mille"]) payload.rate_per_mille_cents = Number(args["rate-per-mille"])
      if (args.budget) payload.budget_pool_cents = Math.round(Number(args.budget) * 100)
      if (args["per-creator-cap"]) payload.per_creator_cap_cents = Math.round(Number(args["per-creator-cap"]) * 100)
      if (args.deadline) payload.application_deadline = args.deadline

      const res = await irisFetch("/api/v1/marketplace/opportunities", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create bounty")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const o = data?.data?.opportunity ?? data?.opportunity ?? data?.data ?? data

      if (spinner) spinner.stop(`${success("✓")} Created: ${bold(String(o.title ?? o.id ?? "bounty"))}`)

      if (args.json) {
        console.log(JSON.stringify(data, null, 2))
      } else {
        printDivider()
        printKV("ID", o.id)
        printKV("Title", o.title)
        printKV("Type", o.bounty_type)
        printDivider()
        prompts.outro(dim(`iris bounty stats ${o.id}`))
      }
    } catch (err) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      if (!args.json) prompts.outro("Done")
    }
  },
})

// #165985: owner assigns a submission's finishing rank for a placement (judged) bounty.
// Pass --clear to unset and let the payout auto-rank it by the leaderboard metric.
const PlaceCommand = cmd({
  command: "place <submission-id>",
  describe: "set a submission's placement/rank for a placement bounty (judged contests)",
  builder: (yargs) =>
    yargs
      .positional("submission-id", { describe: "submission ID", type: "number", demandOption: true })
      .option("rank", { describe: "finishing rank (1 = first place)", type: "number" })
      .option("clear", { describe: "clear the placement (revert to auto-rank by metric)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    if (!args.clear && !args.rank) {
      const msg = "Pass --rank <n> to set a placement, or --clear to remove it."
      if (args.json) console.log(JSON.stringify({ success: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 2
      return
    }

    const subId = args["submission-id"]
    if (!args.json) { UI.empty(); prompts.intro(`◈  Set Placement for Submission #${subId}`) }
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Saving…")

    try {
      const res = await irisFetch(`/api/v1/marketplace/submissions/${subId}/placement`, {
        method: "PATCH",
        body: JSON.stringify({ rank: args.clear ? null : args.rank }),
      })
      const ok = await handleApiError(res, "Set placement")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const json = await res.json()
      if (spinner) spinner.stop(success(args.clear ? "Placement cleared" : `Ranked #${args.rank}`))

      if (args.json) console.log(JSON.stringify((json as any).data ?? json, null, 2))
      else prompts.outro(dim(`iris bounty payout <opportunity-id> --dry-run`))
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
      if (!args.json) prompts.outro("Done")
    }
  },
})

export const PlatformBountiesCommand = cmd({
  command: "bounty",
  aliases: ["bounties"],
  describe: "UGC content bounty campaigns — create, submit, approve, payout",
  builder: (yargs) =>
    yargs
      .command(CreateCommand)
      .command(PlaceCommand)
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
