import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold } from "./iris-api"

// ============================================================================
// Good Deals CLI — Andrew "Esher" Usher's Chief-of-Staff financial engine
//
// All actions dispatch through fl-api /api/v1/users/{userId}/integrations/execute
// with {integration: 'good-deals', action, parameters}. fl-api routes to
// GoodDealsIntegrationService which reads from business_context + atlas_*
// tables and writes artifacts back to business_context.good_deals.{kind}.
//
// 5 commands:
//   iris good-deals lean-canvas <bloqId>
//   iris good-deals three-statement <bloqId> [--months=12]
//   iris good-deals operational-hq <bloqId>
//   iris good-deals list <bloqId>
//   iris good-deals get <bloqId> <kind>
// ============================================================================

async function callGoodDeals(action: string, params: Record<string, unknown>, userId: number): Promise<any> {
  const res = await irisFetch(`/api/v1/users/${userId}/integrations/execute`, {
    method: "POST",
    body: JSON.stringify({
      integration: "good-deals",
      action,
      parameters: params,
    }),
  })
  const ok = await handleApiError(res, action)
  if (!ok) return null
  return await res.json()
}

function fmtCents(cents?: number | null): string {
  if (cents == null) return dim("—")
  return "$" + (cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function printDivider() {
  console.log(dim("  " + "─".repeat(76)))
}

// ----------------------------------------------------------------------------
// Pretty-printers
// ----------------------------------------------------------------------------

function printLeanCanvas(canvas: any) {
  printDivider()
  console.log("  " + bold("LEAN CANVAS") + dim(`  ${canvas.id ?? ""}`))
  printDivider()
  const blocks = canvas.blocks ?? {}
  const labels: Array<[string, string]> = [
    ["problem", "Problem"],
    ["customer_segments", "Customer Segments"],
    ["unique_value_proposition", "Unique Value Proposition"],
    ["solution", "Solution"],
    ["channels", "Channels"],
    ["revenue_streams", "Revenue Streams"],
    ["cost_structure", "Cost Structure"],
    ["key_metrics", "Key Metrics"],
    ["unfair_advantage", "Unfair Advantage"],
  ]
  for (const [key, label] of labels) {
    const v = blocks[key]
    console.log("  " + bold(label) + dim(":"))
    if (v == null || (Array.isArray(v) && v.length === 0)) {
      console.log("    " + dim("(empty)"))
    } else if (Array.isArray(v)) {
      for (const item of v) {
        if (typeof item === "string") {
          console.log("    • " + item)
        } else if (item && typeof item === "object") {
          if ("source" in item && "value_cents" in item) {
            console.log(`    • ${item.source}  ${dim(fmtCents(item.value_cents as number))}`)
          } else if ("name" in item) {
            const target = item.target != null ? `target=${item.target}` : ""
            const current = item.current != null ? `current=${item.current}` : ""
            console.log(`    • ${item.name}  ${dim([target, current].filter(Boolean).join(" "))}`)
          } else {
            console.log("    • " + JSON.stringify(item))
          }
        }
      }
    } else {
      console.log("    " + String(v))
    }
    console.log()
  }
  const derived = canvas.derived_from ?? {}
  printDivider()
  console.log(
    "  " +
      dim(
        `derived from: goals=${derived.goals_count ?? 0}  strategies=${derived.strategies_count ?? 0}  deals=${derived.deals_count ?? 0}  kpis=${derived.kpis_count ?? 0}`,
      ),
  )
}

function printThreeStatement(ts: any) {
  printDivider()
  console.log("  " + bold("3-STATEMENT") + dim(`  ${ts.id ?? ""}  (${ts.months ?? 12} months)`))
  printDivider()

  const inputs = ts.inputs ?? {}
  console.log("  " + bold("Inputs"))
  console.log("    " + dim("won_value:") + " " + fmtCents(inputs.won_value_cents))
  console.log("    " + dim("pipeline:") + "  " + fmtCents(inputs.pipeline_value_cents))
  console.log("    " + dim("deals:") + "     " + (inputs.deals_total ?? 0))
  if (inputs.actual_revenue_cents != null) {
    console.log()
    console.log("  " + bold("Actuals (atlas_transactions)"))
    console.log("    " + dim("revenue:") + "  " + fmtCents(inputs.actual_revenue_cents))
    console.log("    " + dim("expense:") + "  " + fmtCents(inputs.actual_expense_cents))
    console.log("    " + dim("net:") + "      " + fmtCents(inputs.actual_net_cents))
    console.log("    " + dim("count:") + "    " + (inputs.actual_transaction_count ?? 0))
  }

  const pnl = ts.pnl ?? []
  if (pnl.length > 0) {
    console.log()
    console.log("  " + bold("P&L Projection"))
    console.log("    " + dim("Month  Revenue        Expense        Net            Cum Net"))
    for (const row of pnl) {
      console.log(
        "    " +
          String(row.month).padStart(5) +
          "  " +
          fmtCents(row.revenue_cents).padEnd(13) +
          "  " +
          fmtCents(row.expense_cents).padEnd(13) +
          "  " +
          fmtCents(row.net_cents).padEnd(13) +
          "  " +
          fmtCents(row.cum_net_cents),
      )
    }
  }

  const bs = ts.balance_sheet
  if (bs) {
    console.log()
    console.log("  " + bold("Balance Sheet") + dim(`  (source: ${bs.source ?? "stub"})`))
    if (bs.assets?.total_cents != null) {
      console.log("    " + dim("assets:") + "      " + fmtCents(bs.assets.total_cents))
      console.log("    " + dim("liabilities:") + " " + fmtCents(bs.liabilities?.total_cents))
      console.log("    " + dim("equity:") + "      " + fmtCents(bs.equity?.total_cents))
      if (bs.balanced != null) {
        console.log("    " + dim("balanced:") + "    " + (bs.balanced ? "yes ✓" : "no ✗"))
      }
    } else if (bs.assets?.cash_cents != null) {
      console.log("    " + dim("cash:") + "        " + fmtCents(bs.assets.cash_cents) + dim("  (projected)"))
    }
    if (bs.note) console.log("    " + dim(bs.note))
  }

  const cf = ts.cash_flow
  if (cf) {
    console.log()
    console.log("  " + bold("Cash Flow"))
    console.log("    " + dim("operating:") + "    " + fmtCents(cf.operating_cents))
    console.log("    " + dim("investing:") + "    " + fmtCents(cf.investing_cents))
    console.log("    " + dim("financing:") + "    " + fmtCents(cf.financing_cents))
    console.log("    " + dim("net change:") + "   " + fmtCents(cf.net_change_cents))
  }

  if (Array.isArray(ts.warnings) && ts.warnings.length > 0) {
    console.log()
    console.log("  " + bold("⚠ Warnings"))
    for (const w of ts.warnings) console.log("    • " + dim(w))
  }
}

function printOperationalHq(hq: any) {
  printDivider()
  console.log("  " + bold("OPERATIONAL HQ") + dim(`  ${hq.id ?? ""}`))
  printDivider()

  const people = hq.people ?? {}
  console.log("  " + bold("People"))
  console.log("    " + dim("staff_count:") + "  " + (people.staff_count ?? 0))
  if (Array.isArray(people.roles_needed) && people.roles_needed.length > 0) {
    console.log("    " + dim("roles_needed:"))
    for (const r of people.roles_needed) console.log("      • " + r)
  }

  const process = hq.process ?? {}
  console.log()
  console.log("  " + bold("Process"))
  if (Array.isArray(process.strategies) && process.strategies.length > 0) {
    console.log("    " + dim("strategies:"))
    for (const s of process.strategies) {
      console.log(`      • ${s.title ?? s.id}  ${dim(`[${s.status ?? "active"}]`)}`)
    }
  }
  if (Array.isArray(process.active_goals) && process.active_goals.length > 0) {
    console.log("    " + dim("active goals:"))
    for (const g of process.active_goals) {
      console.log(`      • ${g.title ?? g.id}  ${dim(`[${g.status ?? "?"}]`)}`)
    }
  }

  const systems = hq.systems ?? {}
  console.log()
  console.log("  " + bold("Systems"))
  console.log("    " + dim("integrations_active:") + "  " + (systems.integrations_active ?? 0))

  const metrics = hq.metrics ?? {}
  console.log()
  console.log("  " + bold("Metrics") + dim(`  health: ${metrics.kpi_health ?? "unknown"}`))
  if (Array.isArray(metrics.kpis) && metrics.kpis.length > 0) {
    for (const k of metrics.kpis) {
      const target = k.target ?? "?"
      const current = k.current ?? "?"
      const unit = k.unit ?? ""
      console.log(`    • ${bold(k.name)}  ${dim(`${current} / ${target} ${unit}`)}`)
    }
  }

  if (Array.isArray(hq.risk_flags) && hq.risk_flags.length > 0) {
    console.log()
    console.log("  " + bold("⚠ Risk Flags"))
    for (const r of hq.risk_flags) console.log("    • " + dim(r))
  }
}

// ----------------------------------------------------------------------------
// Commands
// ----------------------------------------------------------------------------

async function runArtifactCommand(
  args: any,
  action: string,
  label: string,
  printer: (data: any) => void,
  extraParams: Record<string, unknown> = {},
) {
  UI.empty()
  prompts.intro(`◈  good-deals ${action}`)
  const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"]); if (!userId) { prompts.outro("Done"); return }

  const spinner = prompts.spinner()
  spinner.start(label)
  try {
    const result = await callGoodDeals(action, { bloq_id: args.bloqId, ...extraParams }, userId)
    if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
    spinner.stop("Done")

    const payload = result?.data ?? result
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
    } else {
      printer(payload)
    }
    prompts.outro(dim(`stored at business_context.good_deals.${payload?.kind ?? "?"}`))
  } catch (err) {
    spinner.stop("Error", 1)
    prompts.log.error(err instanceof Error ? err.message : String(err))
    prompts.outro("Done")
  }
}

const LeanCanvasCommand = cmd({
  command: "lean-canvas <bloqId>",
  describe: "build a Lean Canvas from a bloq's business_context",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .option("user-id", { type: "number", describe: "user ID (or IRIS_USER_ID env)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await runArtifactCommand(args, "generate_lean_canvas", "Generating Lean Canvas…", printLeanCanvas)
  },
})

const ThreeStatementCommand = cmd({
  command: "three-statement <bloqId>",
  aliases: ["3s", "pnl"],
  describe: "generate N-month 3-statement projection (P&L + balance sheet + cash flow)",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .option("months", { type: "number", default: 12 })
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await runArtifactCommand(args, "generate_three_statement", "Building projection…", printThreeStatement, {
      months: args.months,
    })
  },
})

const OperationalHqCommand = cmd({
  command: "operational-hq <bloqId>",
  aliases: ["op-hq", "hq"],
  describe: "snapshot of people / process / systems / metrics",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    await runArtifactCommand(args, "generate_operational_hq", "Building snapshot…", printOperationalHq)
  },
})

const ListCommand = cmd({
  command: "list <bloqId>",
  aliases: ["ls"],
  describe: "list all Good Deals artifacts on a bloq",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  good-deals artifacts for bloq #${args.bloqId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"]); if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const result = await callGoodDeals("list_artifacts", { bloq_id: args.bloqId }, userId)
      if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const items: any[] = result?.data ?? []
      spinner.stop(`${items.length} artifact(s)`)

      if (args.json) {
        console.log(JSON.stringify(items, null, 2))
      } else if (items.length === 0) {
        prompts.log.warn("No artifacts yet — generate one:")
        console.log("  " + dim("iris good-deals lean-canvas " + args.bloqId))
        console.log("  " + dim("iris good-deals three-statement " + args.bloqId))
        console.log("  " + dim("iris good-deals operational-hq " + args.bloqId))
      } else {
        printDivider()
        for (const item of items) {
          console.log(`  ${bold(item.kind)}  ${dim("#" + (item.id ?? "?"))}  ${dim(item.generated_at ?? "")}`)
        }
        printDivider()
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCommand = cmd({
  command: "get <bloqId> <kind>",
  describe: "fetch a specific artifact by kind (lean_canvas|three_statement|operational_hq)",
  builder: (y) =>
    y
      .positional("bloqId", { type: "number", demandOption: true })
      .positional("kind", { type: "string", demandOption: true })
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  good-deals get ${args.kind}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"]); if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const result = await callGoodDeals("get_artifact", { bloq_id: args.bloqId, kind: args.kind }, userId)
      if (result == null) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const payload = result?.data ?? result
      spinner.stop("Done")

      if (args.json) {
        console.log(JSON.stringify(payload, null, 2))
      } else if (args.kind === "lean_canvas") {
        printLeanCanvas(payload)
      } else if (args.kind === "three_statement") {
        printThreeStatement(payload)
      } else if (args.kind === "operational_hq") {
        printOperationalHq(payload)
      } else {
        console.log(JSON.stringify(payload, null, 2))
      }
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformGoodDealsCommand = cmd({
  command: "good-deals",
  aliases: ["gd"],
  describe: "Good Deals: Lean Canvas, 3-statement, Operational HQ",
  builder: (yargs) =>
    yargs
      .command(LeanCanvasCommand)
      .command(ThreeStatementCommand)
      .command(OperationalHqCommand)
      .command(ListCommand)
      .command(GetCommand)
      .demandCommand(),
  async handler() {},
})
