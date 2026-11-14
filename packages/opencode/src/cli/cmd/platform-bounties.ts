import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import { BountyAdminCommand } from "./platform-bounty-admin"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, isNonInteractive, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"

// ============================================================================
// Display helpers
// ============================================================================

function formatCents(cents: number | null): string {
  if (cents === null || cents === undefined) return "-"
  // Grouped thousands (#180537). "$10000.00" and "$100000.00" differ by one glyph in the middle
  // of a run of zeros, which is exactly the misreading the pre-create money preview exists to
  // prevent — an order of magnitude is the error worth catching, and it is the hardest to see.
  return `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
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
        await writeJson(items)
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
        await writeJson(items)
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
        await writeJson(json)
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
        await writeJson(stats)
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
        await writeJson(json)
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
        await writeJson(result)
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
        await writeJson(items)
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
        // gig/fde/task are ENGAGEMENT types priced by FixedAmountCalculator
        // (role.pay_amount -> proposed_budget -> fixed cents), as opposed to the
        // view/impression types metered per 1K. They were reachable over the API
        // but not from the CLI, so `--type gig` failed the choices check.
        choices: ["video_views", "audio_streams", "social_impressions", "ugc_views", "placement", "gig", "fde", "task"],
      })
      .option("rate-per-mille", { describe: "pay rate per 1K views in cents (e.g. 500 = $5)", type: "number" })
      .option("reward-tiers", { describe: "placement prizes in dollars, best-first (e.g. \"250,100,50\" = 1st/2nd/3rd)", type: "string" })
      .option("budget", { describe: "total campaign budget in dollars (e.g. 10000)", type: "number" })
      .option("per-creator-cap", { describe: "max payout per creator in dollars (e.g. 500)", type: "number" })
      // #180539: engagement types (gig/fde/task) are priced by FixedAmountCalculator, which had
      // no CLI-settable source at all — every one of them was created worth nothing and had to
      // be repriced by hand afterwards. Dollars, matching --budget and --reward-tiers.
      .option("amount", { describe: "fixed payout in dollars for gig/fde/task (e.g. 750)", type: "number" })
      .option("deadline", { describe: "deadline (YYYY-MM-DD)", type: "string" })
      .option("profile-id", { describe: "attach to a profile (PK)", type: "number" })
      .option("profile", { describe: "attach to a profile (slug — resolves to PK)", type: "string" })
      // #180537: creating used to BE publishing. Default false so the irreversible half of the
      // act is opt-in; --dry-run is the step before that, printing the money without an API call.
      .option("publish", { describe: "make it live to creators immediately (default: create as draft)", type: "boolean", default: false })
      .option("dry-run", { describe: "print what would be created, in dollars, and exit", type: "boolean", default: false })
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
    // Don't say "Creating…" on a --dry-run; nothing is being created, and the whole value of the
    // flag is that you can trust what it tells you.
    if (spinner) spinner.start(args["dry-run"] ? "Composing…" : "Creating…")

    try {
      const payload: Record<string, unknown> = {
        title,
        description,
        bounty_type: args.type,
        // #180537: DRAFT unless --publish. Creating and going live used to be one act, so a rate
        // you meant to check first was already standing in front of creators — #698 carried
        // $11,998 that way. Publishing is now the thing you have to ask for.
        is_public: Boolean(args.publish),
      }
      if (profilePk) payload.profile_id = profilePk
      if (rewardTiers) payload.reward_tiers = rewardTiers
      if (args["rate-per-mille"]) payload.rate_per_mille_cents = Number(args["rate-per-mille"])
      if (args.budget) payload.budget_pool_cents = Math.round(Number(args.budget) * 100)
      if (args["per-creator-cap"]) payload.per_creator_cap_cents = Math.round(Number(args["per-creator-cap"]) * 100)
      if (args.deadline) payload.application_deadline = args.deadline
      // #180539: FixedAmountCalculator resolves proposal_metadata.amount.fixed_cents (step 3 of
      // its four-source chain) — the only one of the four that exists at creation time. The
      // other three are role/proposal records that this POST has not created yet.
      if (args.amount) {
        payload.proposal_metadata = { amount: { fixed_cents: Math.round(Number(args.amount) * 100) } }
      }

      // #180537: restate the money in DOLLARS before anything is created. The flags MIX UNITS —
      // --rate-per-mille is CENTS while --budget, --amount and --reward-tiers are DOLLARS — so
      // the only reliable check is seeing every amount converted the same way. Printed on a real
      // create too, not just --dry-run: a number you first see after publishing is not a check,
      // it is a receipt.
      const money: string[] = []
      if (payload.rate_per_mille_cents) money.push(`rate            ${formatCents(payload.rate_per_mille_cents as number)} per 1,000 views`)
      if (payload.proposal_metadata) money.push(`fixed amount    ${formatCents(Math.round(Number(args.amount) * 100))}`)
      if (rewardTiers) money.push(`prizes          ${rewardTiers.map((t) => `#${t.rank} ${formatCents(t.amount_cents)}`).join("  ")}`)
      if (payload.budget_pool_cents) money.push(`budget pool     ${formatCents(payload.budget_pool_cents as number)}`)
      if (payload.per_creator_cap_cents) money.push(`per-creator cap ${formatCents(payload.per_creator_cap_cents as number)}`)

      if (args["dry-run"]) {
        if (spinner) spinner.stop("Nothing created")
        if (args.json) {
          await writeJson({ success: true, dry_run: true, would_create: payload })
        } else {
          printDivider()
          printKV("Title", title)
          printKV("Type", String(args.type))
          printKV("Visibility", args.publish ? "PUBLIC — live to creators on create" : "draft")
          if (money.length) { printDivider(); money.forEach((m) => console.log(`  ${m}`)) }
          printDivider()
          prompts.outro(dim(money.length
            ? "Re-run without --dry-run to create it."
            : "No payout terms set — re-run with --rate-per-mille, --amount or --reward-tiers."))
        }
        return
      }

      const res = await irisFetch("/api/v1/marketplace/opportunities", { method: "POST", body: JSON.stringify(payload) })
      const ok = await handleApiError(res, "Create bounty")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const o = data?.data?.opportunity ?? data?.opportunity ?? data?.data ?? data

      if (spinner) spinner.stop(`${success("✓")} Created: ${bold(String(o.title ?? o.id ?? "bounty"))}`)

      if (args.json) {
        await writeJson(data)
      } else {
        printDivider()
        printKV("ID", o.id)
        printKV("Title", o.title)
        printKV("Type", o.bounty_type)
        // Say plainly whether creators can see it. A draft the operator believes is live is a
        // campaign that quietly receives nothing — the mirror image of #180537's original bug.
        printKV("Visibility", args.publish ? "PUBLIC — live to creators now" : "draft — not visible to creators")
        if (money.length) { printDivider(); money.forEach((m) => console.log(`  ${m}`)) }
        printDivider()
        prompts.outro(dim(args.publish
          ? `iris bounty stats ${o.id}`
          : `Draft created. Publish it when the terms are right.   iris bounty stats ${o.id}`))
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

      if (args.json) await writeJson((json as any).data ?? json)
      else prompts.outro(dim(`iris bounty payout <opportunity-id> --dry-run`))
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
      if (!args.json) prompts.outro("Done")
    }
  },
})

// Enroll a CRM lead as a hunter on a bounty opportunity and fire the welcome
// across whatever channels the backend resolves (email / SMS). Owner-auth; the
// backend reports which channels went out (channels_sent) + any warnings
// (e.g. no phone on file → SMS skipped).
const AddHunterCommand = cmd({
  command: "add-hunter",
  describe: "enroll a CRM lead as a bounty hunter and send the welcome",
  builder: (yargs) =>
    yargs
      .option("lead", { describe: "CRM lead ID to enroll", type: "number", demandOption: true })
      .option("opportunity", { describe: "opportunity ID", type: "number", default: 581 })
      .option("phone", { describe: "phone number for SMS welcome (optional)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()

    const token = await requireAuth()
    if (!token) return

    const oppId = args.opportunity
    const leadId = args.lead

    if (!args.json) prompts.intro(`◈  Enroll Lead #${leadId} as Hunter (Bounty #${oppId})`)
    const spinner = args.json ? null : prompts.spinner()
    if (spinner) spinner.start("Enrolling hunter…")

    try {
      const body: Record<string, unknown> = { lead_id: leadId }
      if (args.phone) body.phone = args.phone

      const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/hunters`, {
        method: "POST",
        body: JSON.stringify(body),
      })
      const ok = await handleApiError(res, "Add hunter")
      if (!ok) { if (spinner) spinner.stop("Failed", 1); if (!args.json) prompts.outro("Done"); return }

      const json = await res.json()
      const data = (json as any).data ?? json

      if (spinner) spinner.stop(success("Hunter enrolled!"))

      if (args.json) {
        await writeJson(json)
        return
      }

      const leadName = data.lead_name ?? data.name ?? (data.lead && (data.lead.name ?? data.lead.full_name)) ?? `Lead #${leadId}`
      const channels = Array.isArray(data.channels_sent) ? data.channels_sent : []
      const warnings = Array.isArray(data.warnings) ? data.warnings : []

      printDivider()
      printKV("Lead", leadName)
      printKV("Opportunity", `#${oppId}`)
      printKV("Welcome sent on", channels.length ? channels.join(", ") : dim("(no channels)"))
      printDivider()

      if (warnings.length) {
        for (const w of warnings) prompts.log.warn(String(w))
      }
    } catch (e: any) {
      if (spinner) spinner.stop("Error", 1)
      prompts.log.error(e.message)
      if (!args.json) prompts.outro("Done")
      return
    }

    if (!args.json) prompts.outro("Done")
  },
})


// ── Bug-bounty operator verbs (#178606) ─────────────────────────────────────
// The bug-bounty money path lived entirely in artisan, so checking who is owed
// what meant `railway ssh -s fl-api -- php artisan bounty:hunters`. These wrap
// the endpoints that ALREADY exist, so a hunter can see their own standing and
// an owner can see the board without shell access to production.

const BUG_BOUNTY_OPP = 581

const HuntersCommand = cmd({
  command: "hunters [opportunity-id]",
  aliases: ["leaderboard", "board"],
  describe: "bug-bounty hunters ranked — reported, verified, owed, paid (owner only)",
  builder: (yargs) =>
    yargs
      .positional("opportunity-id", { describe: "one campaign; omit for everything you have across all of them", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const oppId = (args["opportunity-id"] as number) ?? BUG_BOUNTY_OPP

    const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/bug-bounty/leaderboard`)
    if (!(await handleApiError(res, "Bug-bounty leaderboard"))) return
    const body = (await res.json().catch(() => null)) as any
    const data = body?.data ?? body
    const rows: any[] = firstArray(data?.leaderboard)
    const opp = data?.opportunity ?? {}

    if (args.json) { await writeJson({ success: true, ...data }); return }

    UI.empty()
    prompts.intro(`◈  Bug Bounty Hunters — #${oppId}`)
    printDivider()
    if (!rows.length) {
      prompts.log.info("No attributed hunters yet.")
    } else {
      // held_cents is money that is verified and priced but which the payout run will refuse
      // to release — currently an outstanding certification (fl-api #180702).
      //
      // It gets a column of its own rather than being folded back into `owed`, and it is only
      // rendered when somebody actually has some, so the ordinary board stays a four-column
      // read. Before this, the moment the certification gate shipped, two hunters with $39 and
      // $18 held showed as "owed $0.00" here with nothing to indicate the money existed at
      // all — which reads as "nothing pending" or "already paid". Wrong in a quieter and worse
      // direction than the overstatement it replaced.
      const anyHeld = rows.some((h) => Number(h.held_cents ?? 0) > 0)
      for (const [i, h] of rows.entries()) {
        const money = (c: unknown) => `$${(Number(c ?? 0) / 100).toFixed(2)}`
        const held = Number(h.held_cents ?? 0)
        console.log(
          `  ${String(i + 1).padStart(2)}. ${bold(String(h.name ?? h.hunter ?? "unknown").padEnd(22))}` +
            ` reported ${String(h.reported ?? 0).padStart(4)}` +
            `  verified ${String(h.verified ?? 0).padStart(4)}` +
            `  owed ${money(h.owed_cents).padStart(9)}` +
            `  paid ${money(h.paid_cents).padStart(9)}` +
            (anyHeld ? `  held ${(held > 0 ? money(held) : "—").padStart(9)}` : ""),
        )
      }
      if (anyHeld) {
        console.log(
          dim(`      held = verified and priced, not released — an outstanding certification.`),
        )
      }
    }
    printDivider()
    if (opp.budget_pool_cents !== undefined) {
      printKV("Pool", `$${(Number(opp.budget_pool_cents) / 100).toFixed(2)}`)
      printKV("Remaining", `$${(Number(opp.budget_remaining_cents ?? 0) / 100).toFixed(2)}`)
    }
    prompts.outro(dim(`iris bounty me ${oppId}   ·   iris bounty bugs ${oppId}`))
  },
})


const ConnectCommand = cmd({
  command: "connect",
  aliases: ["setup-payouts", "payout-setup"],
  describe: "set up or check your payout account, so money can actually reach you",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Payout account")

    const res = await irisFetch(`/api/v1/earnings/connect-status`)
    if (!(await handleApiError(res, "Payout status"))) return
    const st = ((await res.json().catch(() => null)) as any) ?? {}

    if (args.json) { await writeJson(st); return }

    if (st.connected && st.payouts_enabled) {
      printDivider()
      console.log(`  ${success("Connected")} — payouts are enabled.`)
      if (st.login_url) console.log(`  ${dim(st.login_url)}`)
      printDivider()
      prompts.outro(dim("iris bounty claim   to take what you are owed"))
      return
    }

    // Connected but not payable is its own state, and the most confusing one to be in:
    // Stripe has the account and is still waiting on something. Say which, rather than
    // sending someone round the onboarding loop again for no reason.
    if (st.connected && !st.payouts_enabled) {
      printDivider()
      console.log(`  ${bold("Connected, but payouts are not enabled yet.")}`)
      const due = st.requirements?.currently_due ?? []
      if (due.length) {
        console.log(`  ${dim("Stripe still needs:")}`)
        for (const r of due.slice(0, 8)) console.log(`    ${dim("·")} ${r}`)
      }
      if (st.login_url) console.log(`\n  ${st.login_url}`)
      printDivider()
      prompts.outro("Done")
      return
    }

    const start = await irisFetch(`/api/v1/earnings/setup-connect`, { method: "POST" })
    if (!(await handleApiError(start, "Payout setup"))) return
    const body = ((await start.json().catch(() => null)) as any) ?? {}
    const url = body.onboarding_url ?? body.data?.onboarding_url

    if (!url) {
      prompts.log.error("No onboarding link came back. Nothing has changed.")
      prompts.outro("Failed")
      return
    }

    console.log()
    console.log(`  ${url}`)
    console.log()
    prompts.log.info("Open that to finish setup. Verified bugs already waiting will pay out")
    prompts.log.info("automatically once it completes — you do not have to claim them again.")
    prompts.outro("Done")
  },
})

const ClaimCommand = cmd({
  command: "claim",
  aliases: ["cashout"],
  describe: "claim what you are owed — pays out to your connected account",
  builder: (y) => y.option("yes", { type: "boolean", describe: "skip the confirmation" }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Claim")

    // Show the amount BEFORE asking. "Confirm cashout?" with no number is a prompt people
    // accept without reading, which is the wrong habit to build around money.
    const meRes = await irisFetch(`/api/v1/bounty/me`)
    const me = meRes.ok ? (((await meRes.json().catch(() => null)) as any) ?? {}) : {}
    const owed = me.earnings?.unpaid ?? null

    if (me.earnings && (me.earnings.unpaidCents ?? 0) <= 0) {
      prompts.log.info("Nothing owed right now.")
      prompts.outro("Done")
      return
    }

    // An unsigned agreement will have the gate withhold this anyway. Better to say so here
    // than to let someone claim into a refusal.
    const outstanding = (me.agreements ?? []).filter((a: any) => !a.signed)
    if (outstanding.length) {
      prompts.log.warn(`You still have an unsigned ${outstanding[0].type}.`)
      prompts.log.info(outstanding[0].signingUrl ?? "Run: iris bounty me")
    }

    if (!args.yes && !isNonInteractive()) {
      const ok = await prompts.confirm({ message: `Claim ${owed ?? "your balance"} now?` })
      if (prompts.isCancel(ok) || !ok) { prompts.outro("Cancelled"); return }
    }

    const res = await irisFetch(`/api/v1/earnings/cashout`, { method: "POST" })
    const body = ((await res.json().catch(() => null)) as any) ?? {}

    if (!res.ok || body.success === false) {
      // The API distinguishes "not available" from "failed"; pass its own words through
      // rather than flattening both into a generic error.
      prompts.log.error(body.message ?? "Claim did not go through. Nothing was paid.")
      if (String(body.message ?? "").toLowerCase().includes("connect")) {
        prompts.log.info("Set up your payout account first: iris bounty connect")
      }
      prompts.outro("Failed")
      return
    }

    printDivider()
    console.log(`  ${success("Paid")}  ${body.amount ? `$${body.amount}` : ""}`)
    if (body.transfer_id) console.log(`  ${dim(`transfer ${body.transfer_id}`)}`)
    printDivider()
    prompts.outro("Done")
  },
})

const MyBountyCommand = cmd({
  command: "me [opportunity-id]",
  aliases: ["mine-bugs", "standing"],
  describe: "your own bug-bounty standing — what you reported, what is verified, what you are owed",
  builder: (yargs) =>
    yargs
      .positional("opportunity-id", { describe: "one campaign; omit for everything you have across all of them", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const explicitOpp = args["opportunity-id"] as number | undefined

    // No opportunity given → the WHOLE position (#180387). This used to fall back to a
    // hardcoded opportunity constant and 500, which is the shape of the original problem:
    // every bounty surface is per-opportunity, so a hunter had to already know an id to see
    // anything, and in practice that meant asking a colleague for it.
    if (!explicitOpp) {
      const meRes = await irisFetch(`/api/v1/bounty/me`)
      if (!(await handleApiError(meRes, "Bounty standing"))) return
      const me = (await meRes.json().catch(() => null)) as any
      if (!me) return

      if (args.json) { await writeJson(me); return }

      printDivider()
      printKV("Owed", `${me.earnings?.unpaid ?? "$0.00"}`)
      printKV("Paid to date", `${me.earnings?.paid ?? "$0.00"}`)
      printKV("Bugs", String((me.bugs ?? []).length))

      const outstanding = (me.agreements ?? []).filter((a: any) => !a.signed)
      if (outstanding.length) {
        printKV("Unsigned", outstanding.map((a: any) => a.type).join(", "))
      }

      // The one thing to do next, in the terms the API already decided. Repeating that
      // ordering here would eventually disagree with it.
      if (me.nextStep) {
        printDivider()
        console.log(`  ${bold(me.nextStep.label)}`)
        console.log(`  ${dim(me.nextStep.detail)}`)
        if (me.nextStep.href) console.log(`  ${me.nextStep.href}`)
      } else {
        printDivider()
        console.log(`  ${dim("Nothing outstanding.")}`)
      }
      printDivider()
      prompts.outro(dim("iris bounty me <opportunity-id>   for one campaign"))
      return
    }

    const oppId = explicitOpp
    const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/bug-bounty/hunter`)
    if (!(await handleApiError(res, "Bug-bounty standing"))) return
    const body = (await res.json().catch(() => null)) as any
    const d = body?.data ?? body

    if (args.json) { await writeJson({ success: true, ...d }); return }

    const money = (c: unknown) => `$${(Number(c ?? 0) / 100).toFixed(2)}`
    UI.empty()
    prompts.intro(`◈  Your Bug Bounty — #${oppId}`)
    printDivider()
    // The API nests these under `totals`; reading them off the root rendered a hunter
    // who is owed money as "Owed $0.00" with 0 reported, while `bounty hunters` showed
    // the real figures at the same instant (#178839). This is the ONLY self-serve way a
    // hunter checks their own balance, and a zero reads as a settled account — so a wrong
    // field path here looks exactly like "the programme owes you nothing".
    // Fall back to the root so an older/flatter response shape still renders.
    const t = d?.totals ?? d ?? {}
    printKV("Reported", t.reported ?? d?.bugs?.length ?? 0)
    printKV("Verified", t.verified ?? 0)
    printKV("Pending", t.pending ?? 0)
    printKV("Owed", money(t.owed_cents))
    printKV("Paid", money(t.paid_cents))
    printDivider()
    // Verification is the gate between reporting and money, so say so here.
    prompts.outro(dim("verified = fixed, live in production, and closed — that is when it pays"))
  },
})

const BugsCommand = cmd({
  command: "bugs [opportunity-id]",
  describe: "bugs attributed to this bounty, with their verification status",
  builder: (yargs) =>
    yargs
      .positional("opportunity-id", { describe: "one campaign; omit for everything you have across all of them", type: "number" })
      .option("limit", { describe: "max rows", type: "number", default: 30 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const oppId = (args["opportunity-id"] as number) ?? BUG_BOUNTY_OPP

    const res = await irisFetch(`/api/v1/marketplace/opportunities/${oppId}/bug-bounty/bugs`)
    if (!(await handleApiError(res, "Bug-bounty bugs"))) return
    const body = (await res.json().catch(() => null)) as any
    const d = body?.data ?? body
    const rows: any[] = firstArray(d, d?.bugs)

    if (args.json) { await writeJson({ success: true, count: rows.length, bugs: rows }); return }

    UI.empty()
    prompts.intro(`◈  Bug Bounty Bugs — #${oppId}`)
    printDivider()
    for (const b of rows.slice(0, args.limit)) {
      const sev = String(b.severity ?? "?").toUpperCase().padEnd(8)
      const st = String(b.status ?? "?").padEnd(12)
      console.log(`  #${String(b.id ?? b.bug_item_id ?? "?").padEnd(8)} ${sev} ${st} ${String(b.title ?? "").slice(0, 60)}`)
    }
    printDivider()
    printKV("Total", rows.length)
    prompts.outro(dim(`iris bounty hunters ${oppId}`))
  },
})

export const PlatformBountiesCommand = productCommand({
  name: "bounty",
  aliases: ["bounties"],
  purpose:
    "Bounty OS — campaigns, submissions, hunters, payouts and ledger checks",
  keywords: ["bounty", "hunter", "submission", "payout", "campaign", "reward", "ledger", "gig"],
  howtos: ["bounty-os-hunter-journey", "bug-bounty"],
  playbooks: ["freelabel-bounty-ads"],
  builder: (yargs) =>
    yargs
      .command(CreateCommand)
      .command(AddHunterCommand)
      .command(PlaceCommand)
      .command(ListCommand)
      .command(SubmitCommand)
      .command(MySubmissionsCommand)
      .command(SubmissionsCommand)
      .command(StatsCommand)
      .command(ApproveCommand)
      .command(RejectCommand)
      .command(PayoutCommand)
      .command(HuntersCommand)
      .command(MyBountyCommand)
      .command(ConnectCommand)
      .command(ClaimCommand)
      .command(BugsCommand)
      .command(BountyAdminCommand)
      // Hunters do not have the CLI. Everything they need — proving their email, seeing what
      // they are owed, applying (account created in the flow), signing, connecting Stripe —
      // is one page, and nothing here said so. An operator reaching for `iris bounty` is
      // usually one question away from "where do I send them".
      .epilogue(
        "Hunters use https://heyiris.io/p/bounty-dashboard — sign in by email, see earnings, apply, sign, get paid.\n" +
          "How it fits together: iris how-to view bounty-os-hunter-journey",
      )
      .demandCommand(1, "Specify a subcommand"),
})
