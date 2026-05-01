import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Revenue — goal tracking, MRR dashboard, gap analysis
// ============================================================================

function fmtMoney(n: unknown): string {
  const v = Number(n ?? 0)
  return `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pctBar(pct: number, width: number = 30): string {
  const filled = Math.min(width, Math.round((pct / 100) * width))
  const empty = width - filled
  const bar = "█".repeat(filled) + "░".repeat(empty)
  return pct >= 100 ? `\x1b[32m${bar}\x1b[0m` : pct >= 50 ? `\x1b[33m${bar}\x1b[0m` : `\x1b[31m${bar}\x1b[0m`
}

// ── dashboard (default) ──

const RevenueDashboardCommand = cmd({
  command: "dashboard",
  aliases: ["show", "status", "$"],
  describe: "show revenue dashboard with goals, pipeline, and gap analysis",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch("/api/v1/revenue/dashboard")
    if (!(await handleApiError(res, "Revenue dashboard"))) return

    const data = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    const g = data.goals ?? {}
    const c = data.current ?? {}
    const t = data.tiers ?? {}
    const gap = data.gap_analysis ?? {}
    const stats = data.lead_stats ?? {}

    console.log("")
    console.log(bold("  Revenue Dashboard"))
    console.log(`  ${pctBar(gap.pct_of_goal ?? 0)}  ${gap.pct_of_goal ?? 0}% of goal`)
    printDivider()

    // Goals
    printKV("  Target MRR", `${fmtMoney(g.target_mrr)}/mo  (${fmtMoney((g.target_mrr ?? 0) * 12)}/yr)`)
    printKV("  Confirmed MRR", `${fmtMoney(c.confirmed_mrr)}  (${fmtMoney(c.confirmed_arr)}/yr)`)
    printKV("  If pipeline converts", `${fmtMoney(c.total_if_converts)}  (${fmtMoney(c.total_arr_if_converts)}/yr)`)
    console.log("")

    // Tiers
    console.log(bold("  Revenue Tiers"))
    const tiers = [
      { label: "Autopay (Stripe)", data: t.autopay, color: success },
      { label: "Untracked (Mercury)", data: t.untracked, color: highlight },
      { label: "Won — needs Stripe", data: t.needs_stripe, color: dim },
      { label: "In Negotiation", data: t.in_negotiation, color: dim },
      { label: "Performance-based", data: t.performance, color: dim },
    ]
    for (const tier of tiers) {
      const d = tier.data ?? { total: 0, count: 0 }
      if (d.count > 0) {
        console.log(`    ${tier.color(`${fmtMoney(d.total)}/mo`)}  ${d.count} clients  ${dim(tier.label)}`)
      }
    }
    console.log("")

    // Gap Analysis
    console.log(bold("  Gap Analysis"))
    if (gap.gap_with_pipeline > 0) {
      printKV("    Gap (even if pipeline converts)", highlight(fmtMoney(gap.gap_with_pipeline) + "/mo"))
      printKV("    Need at $250/client", `${gap.clients_needed_at_250} more clients`)
      printKV("    Need at $500/client", `${gap.clients_needed_at_500} more clients`)
      if (gap.avg_deal_size > 0 && gap.avg_deal_size !== 250) {
        printKV(`    Need at avg (${fmtMoney(gap.avg_deal_size)})`, `${gap.clients_needed_at_avg} more clients`)
      }
    } else if (gap.gap_mrr > 0) {
      printKV("    Gap (confirmed only)", highlight(fmtMoney(gap.gap_mrr) + "/mo"))
      console.log(`    ${success("Pipeline covers the gap if it converts")}`)
    } else {
      console.log(`    ${success("Goal met!")}`)
    }
    console.log("")

    // Lead Stats
    console.log(bold("  Lead Stats"))
    printKV("    Total leads", String(stats.total_leads?.toLocaleString() ?? 0))
    printKV("    Won leads", String(stats.won_leads ?? 0))
    printKV("    Conversion rate", `${stats.conversion_rate ?? 0}%`)
    printKV("    Active clients", String(stats.total_clients ?? 0))
    printDivider()
    console.log(dim("  Set goal: iris revenue goal --mrr=10000"))
    console.log(dim("  Full data: iris revenue dashboard --json"))
  },
})

// ── goal ──

const RevenueGoalCommand = cmd({
  command: "goal",
  aliases: ["set", "target"],
  describe: "set your MRR/ARR revenue target",
  builder: (yargs) =>
    yargs
      .option("mrr", { describe: "target monthly recurring revenue", type: "number" })
      .option("arr", { describe: "target annual recurring revenue (calculates MRR)", type: "number" })
      .option("clients", { describe: "target number of clients", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    if (!args.mrr && !args.arr && !args.clients) {
      // Show current goals
      const res = await irisFetch("/api/v1/revenue/goals")
      if (!(await handleApiError(res, "Get goals"))) return
      const data = await res.json().catch(() => ({}))
      const g = data.goals ?? {}

      if (args.json) { console.log(JSON.stringify(g, null, 2)); return }

      console.log("")
      console.log(bold("  Current Revenue Goals"))
      printDivider()
      printKV("  Target MRR", fmtMoney(g.target_mrr))
      printKV("  Target ARR", fmtMoney(g.target_arr))
      if (g.target_clients) printKV("  Target Clients", String(g.target_clients))
      if (g.updated_at) printKV("  Last Updated", g.updated_at.split("T")[0])
      printDivider()
      console.log(dim("  Update: iris revenue goal --mrr=10000"))
      return
    }

    const payload: Record<string, unknown> = {}
    if (args.mrr) payload.target_mrr = args.mrr
    if (args.arr) payload.target_arr = args.arr
    if (args.clients) payload.target_clients = args.clients

    const res = await irisFetch("/api/v1/revenue/goals", {
      method: "POST",
      body: JSON.stringify(payload),
    })
    if (!(await handleApiError(res, "Set goals"))) return

    const data = await res.json().catch(() => ({}))

    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    if (data.success) {
      prompts.log.success("Revenue goal updated")
      const g = data.goals ?? {}
      printKV("  Target MRR", fmtMoney(g.target_mrr))
      printKV("  Target ARR", fmtMoney(g.target_arr))
      console.log(dim("  View dashboard: iris revenue"))
    } else {
      prompts.log.error(data.error ?? data.message ?? "Failed")
    }
  },
})

// ── main export ──

export const PlatformRevenueCommand = cmd({
  command: "revenue",
  aliases: ["rev", "mrr"],
  describe: "revenue dashboard — goals, MRR tracking, pipeline gap analysis",
  builder: (yargs) =>
    yargs
      .command(RevenueDashboardCommand)
      .command(RevenueGoalCommand)
      .demandCommand(0), // default to dashboard if no subcommand
  async handler(args) {
    // Default: show dashboard
    await RevenueDashboardCommand.handler(args as any)
  },
})
