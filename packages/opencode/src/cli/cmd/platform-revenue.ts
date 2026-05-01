import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

function fmtMoney(n: unknown): string {
  return `$${Number(n ?? 0).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function pctBar(pct: number, width: number = 30): string {
  const clamped = Math.min(100, Math.max(0, pct))
  const filled = Math.round((clamped / 100) * width)
  const bar = "█".repeat(filled) + "░".repeat(width - filled)
  return pct >= 100 ? `\x1b[32m${bar}\x1b[0m` : pct >= 50 ? `\x1b[33m${bar}\x1b[0m` : `\x1b[31m${bar}\x1b[0m`
}

// ── dashboard ──

const RevenueDashboardCommand = cmd({
  command: "dashboard",
  aliases: ["show", "status"],
  describe: "goal vs reality vs pipeline",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    const res = await irisFetch("/api/v1/revenue/dashboard")
    if (!(await handleApiError(res, "Revenue dashboard"))) return

    const data = await res.json().catch(() => ({}))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }

    const g = data.goals ?? {}
    const r = data.reality ?? {}
    const p = data.pipeline ?? {}
    const s = data.summary ?? {}
    const rec = data.recommendations ?? {}

    console.log("")
    console.log(bold("  Revenue Dashboard"))
    console.log(`  ${pctBar(s.pct_of_goal ?? 0)}  ${s.pct_of_goal ?? 0}% of goal`)
    printDivider()

    // Goal vs Reality
    printKV("  Target", `${fmtMoney(g.target_mrr)}/mo  (${fmtMoney(g.target_arr)}/yr)`)
    printKV("  Stripe (confirmed)", `${success(fmtMoney(r.stripe_mrr) + "/mo")}  ${dim(`${r.stripe_active_subscriptions ?? 0} subscriptions`)}`)
    printKV("  Stripe total paid", fmtMoney(r.stripe_total_paid))
    console.log("")

    // Pipeline
    console.log(bold("  Pipeline"))
    if (p.won?.count > 0) console.log(`    ${highlight(fmtMoney(p.won.total) + "/mo")}  ${p.won.count} Won clients  ${dim("(not yet on Stripe)")}`)
    if (p.negotiation?.count > 0) console.log(`    ${dim(fmtMoney(p.negotiation.total) + "/mo")}  ${p.negotiation.count} In Negotiation`)
    printKV("  Pipeline total", fmtMoney(p.total))
    printKV("  If all converts", `${fmtMoney(s.total_if_converts)}/mo  (${fmtMoney((s.total_if_converts ?? 0) * 12)}/yr)`)
    console.log("")

    // Gap + Recommendations
    const pricing = data.pricing ?? {}
    console.log(bold("  Gap Analysis"))
    if (s.gap > 0) {
      printKV("    Gap to goal", highlight(fmtMoney(s.gap) + "/mo"))
      if (pricing.starter) printKV(`    Need at Starter (${fmtMoney(pricing.starter)})`, `${rec.clients_needed_at_starter} more clients`)
      if (pricing.growth) printKV(`    Need at Growth (${fmtMoney(pricing.growth)})`, `${rec.clients_needed_at_growth} more clients`)
      if (pricing.platform) printKV(`    Need at Platform (${fmtMoney(pricing.platform)})`, `${rec.clients_needed_at_platform} more clients`)
      if (rec.avg_deal_size > 0) {
        printKV(`    Need at avg deal (${fmtMoney(rec.avg_deal_size)})`, `${rec.clients_needed_at_avg} more clients`)
      }
      if (rec.leads_needed_at_current_rate) {
        console.log("")
        printKV("    Conversion rate", `${rec.conversion_rate}% (${rec.won_leads}/${rec.total_leads})`)
        printKV("    Leads needed at this rate", `~${rec.leads_needed_at_current_rate.toLocaleString()} prospected leads`)
      }
    } else {
      console.log(`    ${success("Goal met! Pipeline covers the target.")}`)
    }

    // Top pipeline clients
    const clients = p.clients ?? []
    if (clients.length > 0) {
      console.log("")
      console.log(bold("  Top Pipeline Clients"))
      for (const c of clients.slice(0, 10)) {
        const st = (c.status ?? "").toLowerCase().includes("won") ? success(c.status) : dim(c.status)
        console.log(`    ${dim(`#${c.id}`)}  ${c.name}${c.company ? `  ${dim(c.company)}` : ""}  ${fmtMoney(c.price_bid)}  ${st}`)
      }
      if (clients.length > 10) console.log(`    ${dim(`…and ${clients.length - 10} more`)}`)
    }

    printDivider()
    console.log(dim("  Set goal: iris revenue goal --mrr=10000"))
  },
})

// ── goal ──

const RevenueGoalCommand = cmd({
  command: "goal",
  aliases: ["set", "target"],
  describe: "set or view your MRR/ARR target",
  builder: (yargs) =>
    yargs
      .option("mrr", { describe: "target monthly recurring revenue", type: "number" })
      .option("arr", { describe: "target annual recurring revenue", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return

    if (!args.mrr && !args.arr) {
      const res = await irisFetch("/api/v1/revenue/goals")
      if (!(await handleApiError(res, "Get goals"))) return
      const data = await res.json().catch(() => ({}))
      const g = data.goals ?? {}
      if (args.json) { console.log(JSON.stringify(g, null, 2)); return }
      console.log("")
      console.log(bold("  Revenue Goal"))
      printDivider()
      printKV("  Target MRR", fmtMoney(g.target_mrr))
      printKV("  Target ARR", fmtMoney(g.target_arr))
      if (g.updated_at) printKV("  Last Updated", g.updated_at.split("T")[0])
      printDivider()
      console.log(dim("  Update: iris revenue goal --mrr=10000"))
      return
    }

    const payload: Record<string, unknown> = {}
    if (args.mrr) payload.target_mrr = args.mrr
    if (args.arr) payload.target_arr = args.arr

    const res = await irisFetch("/api/v1/revenue/goals", { method: "POST", body: JSON.stringify(payload) })
    if (!(await handleApiError(res, "Set goals"))) return
    const data = await res.json().catch(() => ({}))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); return }
    if (data.success) {
      prompts.log.success("Revenue goal updated")
      printKV("  Target MRR", fmtMoney(data.goals?.target_mrr))
      printKV("  Target ARR", fmtMoney(data.goals?.target_arr))
      console.log(dim("  View: iris revenue"))
    }
  },
})

// ── export ──

export const PlatformRevenueCommand = cmd({
  command: "revenue",
  aliases: ["rev", "mrr"],
  describe: "revenue dashboard — goal vs Stripe vs pipeline",
  builder: (yargs) =>
    yargs
      .command(RevenueDashboardCommand)
      .command(RevenueGoalCommand)
      .demandCommand(0),
  async handler(args) {
    await RevenueDashboardCommand.handler(args as any)
  },
})
