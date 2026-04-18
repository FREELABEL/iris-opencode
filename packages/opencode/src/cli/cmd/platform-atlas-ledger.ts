import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold } from "./iris-api"

// ============================================================================
// Atlas Ledger CLI — Transactions + Accounts (Track 1)
//
// Routes: /api/v1/atlas/transactions + /api/v1/atlas/accounts
// Auth: user_id resolved from token (hardened — ignores inbound user_id)
// ============================================================================

function fmtCents(c?: number | null): string {
  if (c == null) return dim("—")
  return "$" + (c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function printDivider() { console.log(dim("  " + "─".repeat(72))) }

// ── Transactions ─────────────────────────────────────────────────────────────

const TxListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list transactions",
  builder: (y) =>
    y
      .option("bloq", { type: "number", describe: "filter by bloq" })
      .option("type", { type: "string", describe: "expense|revenue|transfer|journal" })
      .option("category", { type: "string" })
      .option("source", { type: "string", describe: "manual|qb|stripe|invoice|import" })
      .option("from", { type: "string", describe: "YYYY-MM-DD" })
      .option("to", { type: "string", describe: "YYYY-MM-DD" })
      .option("search", { type: "string" })
      .option("limit", { type: "number", default: 25 })
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Transactions")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const p = new URLSearchParams({ per_page: String(args.limit) })
      if (args.bloq != null) p.set("bloq_id", String(args.bloq))
      if (args.type) p.set("type", args.type)
      if (args.category) p.set("category", args.category)
      if (args.source) p.set("source", args.source)
      if (args.from) p.set("from", args.from)
      if (args.to) p.set("to", args.to)
      if (args.search) p.set("search", args.search)

      const res = await irisFetch(`/api/v1/atlas/transactions?${p}`)
      const ok = await handleApiError(res, "List transactions"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as any
      const rows: any[] = body?.data?.data ?? body?.data ?? []
      const total = body?.data?.total ?? rows.length
      spinner.stop(`${rows.length} of ${total}`)

      if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }
      if (rows.length === 0) { prompts.log.warn("No transactions"); prompts.outro("Done"); return }

      printDivider()
      for (const tx of rows) {
        const date = tx.transaction_date ?? ""
        const tag = tx.type === "revenue" ? "+" : tx.type === "expense" ? "-" : " "
        console.log(`  ${dim(date)}  ${tag}${fmtCents(tx.amount_cents).padEnd(13)}  ${bold(tx.description ?? "")}`)
        const meta: string[] = []
        if (tx.category) meta.push(tx.category)
        if (tx.source && tx.source !== "manual") meta.push(`via ${tx.source}`)
        if (tx.qb_id) meta.push(`qb:${tx.qb_id}`)
        if (meta.length) console.log("    " + dim(meta.join("  ·  ")))
      }
      printDivider()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const TxAddCommand = cmd({
  command: "add",
  aliases: ["create"],
  describe: "add a transaction",
  builder: (y) =>
    y
      .option("type", { type: "string", demandOption: true, describe: "expense|revenue|transfer|journal|barter|credit" })
      .option("description", { type: "string", demandOption: true })
      .option("amount", { type: "number", demandOption: true, describe: "amount in dollars (converted to cents)" })
      .option("date", { type: "string", demandOption: true, describe: "YYYY-MM-DD" })
      .option("category", { type: "string" })
      .option("source", { type: "string", default: "manual" })
      .option("lead-id", { type: "number", describe: "link to a lead for deal tracking" })
      .option("counterparty", { type: "string", describe: "counterparty name (for barter/credit)" })
      .option("fair-value", { type: "number", describe: "fair market value in dollars (for barter)" })
      .option("bloq", { type: "number" })
      .option("account-id", { type: "number" })
      .option("user-id", { type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add Transaction")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }

    const body: Record<string, any> = {
      type: args.type,
      description: args.description,
      amount_cents: Math.round(Number(args.amount) * 100),
      transaction_date: args.date,
      source: args.source ?? "manual",
    }
    if (args.category) body.category = args.category
    if (args["lead-id"] != null) body.lead_id = args["lead-id"]
    if (args.counterparty) body.counterparty_name = args.counterparty
    if (args["fair-value"] != null) body.fair_value_cents = Math.round(Number(args["fair-value"]) * 100)
    if (args.bloq != null) body.bloq_id = args.bloq
    if (args["account-id"] != null) body.account_id = args["account-id"]

    const spinner = prompts.spinner()
    spinner.start("Creating…")
    try {
      const res = await irisFetch(`/api/v1/atlas/transactions`, { method: "POST", body: JSON.stringify(body) })
      const ok = await handleApiError(res, "Create transaction"); if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      const data = ((await res.json()) as any)?.data
      spinner.stop(`Created #${data?.id}`)
      prompts.outro(`${fmtCents(data?.amount_cents)} ${data?.type}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const TxShowCommand = cmd({
  command: "show <id>",
  describe: "show transaction details",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Transaction #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/atlas/transactions/${args.id}`)
    const ok = await handleApiError(res, "Show"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    if (args.json) { console.log(JSON.stringify(data, null, 2)) } else {
      for (const [k, v] of Object.entries(data ?? {})) {
        if (v != null && typeof v !== "object") console.log(`  ${dim(k + ":")} ${v}`)
      }
    }
    prompts.outro("Done")
  },
})

const TxDeleteCommand = cmd({
  command: "remove <id>",
  aliases: ["rm", "delete"],
  describe: "delete a transaction",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Delete Transaction #${args.id}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/atlas/transactions/${args.id}`, { method: "DELETE" })
    const ok = await handleApiError(res, "Delete"); if (!ok) { prompts.outro("Done"); return }
    prompts.outro("Deleted")
  },
})

const TxSummaryCommand = cmd({
  command: "summary",
  describe: "totals by category",
  builder: (y) =>
    y.option("bloq", { type: "number" }).option("from", { type: "string" }).option("to", { type: "string" }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Transaction Summary")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const p = new URLSearchParams()
    if (args.bloq != null) p.set("bloq_id", String(args.bloq))
    if (args.from) p.set("from", args.from)
    if (args.to) p.set("to", args.to)

    const res = await irisFetch(`/api/v1/atlas/transactions/summary?${p}`)
    const ok = await handleApiError(res, "Summary"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }

    printDivider()
    console.log(`  ${bold("Revenue:")}  ${fmtCents(data?.total_revenue_cents)}`)
    console.log(`  ${bold("Expense:")}  ${fmtCents(data?.total_expense_cents)}`)
    console.log(`  ${bold("Net:")}      ${fmtCents(data?.net_cents)}`)
    console.log(`  ${dim("count:")}     ${data?.transaction_count ?? 0}`)
    const cats = data?.by_category ?? {}
    if (Object.keys(cats).length > 0) {
      console.log()
      console.log("  " + bold("By Category"))
      for (const [cat, v] of Object.entries(cats) as any) {
        console.log(`    ${cat.padEnd(20)} rev=${fmtCents(v.revenue_cents)}  exp=${fmtCents(v.expense_cents)}  n=${v.count}`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

const TxReconcileCommand = cmd({
  command: "reconcile",
  describe: "check sync status with QuickBooks (stub — deferred to Track 2)",
  builder: (y) => y,
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Reconcile")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/atlas/transactions/reconcile`)
    const ok = await handleApiError(res, "Reconcile"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    console.log(`  ${dim("unsynced_local:")} ${data?.unsynced_local}`)
    console.log(`  ${dim("synced_local:")}   ${data?.synced_local}`)
    if (data?.note) console.log(`  ${dim(data.note)}`)
    prompts.outro("Done")
  },
})

const LedgerGroup = cmd({
  command: "ledger",
  aliases: ["transactions", "tx"],
  describe: "manage atlas transactions",
  builder: (y) =>
    y.command(TxListCommand).command(TxAddCommand).command(TxShowCommand).command(TxDeleteCommand).command(TxSummaryCommand).command(TxReconcileCommand).demandCommand(),
  async handler() {},
})

// ── Accounts (Chart of Accounts) ─────────────────────────────────────────────

const AccListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list accounts",
  builder: (y) =>
    y.option("bloq", { type: "number" }).option("type", { type: "string", describe: "Asset|Liability|Equity|Income|Expense" }).option("active-only", { type: "boolean", default: false }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Atlas Accounts")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const p = new URLSearchParams()
    if (args.bloq != null) p.set("bloq_id", String(args.bloq))
    if (args.type) p.set("account_type", args.type)
    if (args["active-only"]) p.set("active_only", "1")

    const res = await irisFetch(`/api/v1/atlas/accounts?${p}`)
    const ok = await handleApiError(res, "List accounts"); if (!ok) { prompts.outro("Done"); return }
    const rows: any[] = ((await res.json()) as any)?.data ?? []
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }
    if (rows.length === 0) { prompts.log.warn("No accounts"); prompts.outro("Done"); return }

    printDivider()
    for (const a of rows) {
      console.log(`  ${bold(a.name)}  ${dim(`#${a.id}  ${a.account_type}${a.account_sub_type ? "/" + a.account_sub_type : ""}`)}  ${fmtCents(a.balance_cents)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const AccCreateCommand = cmd({
  command: "create",
  aliases: ["add"],
  describe: "create an account",
  builder: (y) =>
    y
      .option("name", { type: "string", demandOption: true })
      .option("type", { type: "string", demandOption: true, describe: "Asset|Liability|Equity|Income|Expense" })
      .option("sub-type", { type: "string" })
      .option("bloq", { type: "number" })
      .option("parent", { type: "number" })
      .option("currency", { type: "string", default: "USD" })
      .option("balance", { type: "number", describe: "initial balance in dollars", default: 0 }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Account")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const body: Record<string, any> = {
      name: args.name,
      account_type: args.type,
      currency: args.currency,
      balance_cents: Math.round(Number(args.balance) * 100),
    }
    if (args["sub-type"]) body.account_sub_type = args["sub-type"]
    if (args.bloq != null) body.bloq_id = args.bloq
    if (args.parent != null) body.parent_id = args.parent

    const res = await irisFetch(`/api/v1/atlas/accounts`, { method: "POST", body: JSON.stringify(body) })
    const ok = await handleApiError(res, "Create account"); if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data
    prompts.outro(`${bold(data?.name)} ${dim("#" + data?.id)} ${data?.account_type}`)
  },
})

const AccTreeCommand = cmd({
  command: "tree",
  describe: "chart of accounts tree (parent → children)",
  builder: (y) => y.option("bloq", { type: "number" }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Chart of Accounts Tree")
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const p = new URLSearchParams()
    if (args.bloq != null) p.set("bloq_id", String(args.bloq))
    const res = await irisFetch(`/api/v1/atlas/accounts/tree?${p}`)
    const ok = await handleApiError(res, "Tree"); if (!ok) { prompts.outro("Done"); return }
    const rows: any[] = ((await res.json()) as any)?.data ?? []
    if (args.json) { console.log(JSON.stringify(rows, null, 2)); prompts.outro("Done"); return }

    function printNode(n: any, depth = 0) {
      const indent = "  ".repeat(depth + 1)
      console.log(`${indent}${bold(n.name)}  ${dim(`#${n.id}  ${n.account_type}`)}  ${fmtCents(n.balance_cents)}`)
      for (const child of n.children ?? []) printNode(child, depth + 1)
    }
    printDivider()
    for (const root of rows) printNode(root)
    printDivider()
    prompts.outro("Done")
  },
})

const AccShowCommand = cmd({
  command: "show <id>",
  describe: "show account details",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const res = await irisFetch(`/api/v1/atlas/accounts/${args.id}`)
    const ok = await handleApiError(res, "Show"); if (!ok) return
    const data = ((await res.json()) as any)?.data
    if (args.json) { console.log(JSON.stringify(data, null, 2)) } else {
      for (const [k, v] of Object.entries(data ?? {})) {
        if (v != null && typeof v !== "object") console.log(`  ${dim(k + ":")} ${v}`)
      }
    }
  },
})

const AccDeleteCommand = cmd({
  command: "remove <id>",
  aliases: ["rm"],
  describe: "delete an account",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    const token = await requireAuth(); if (!token) return
    const res = await irisFetch(`/api/v1/atlas/accounts/${args.id}`, { method: "DELETE" })
    await handleApiError(res, "Delete")
    console.log("Deleted")
  },
})

const AccountsGroup = cmd({
  command: "accounts",
  aliases: ["coa"],
  describe: "chart of accounts",
  builder: (y) =>
    y.command(AccListCommand).command(AccCreateCommand).command(AccTreeCommand).command(AccShowCommand).command(AccDeleteCommand).demandCommand(),
  async handler() {},
})

// ============================================================================
export const PlatformAtlasLedgerCommand = cmd({
  command: "atlas:ledger",
  aliases: ["atlas-ledger"],
  describe: "Atlas transactions + chart of accounts",
  builder: (y) => y.command(LedgerGroup).command(AccountsGroup).demandCommand(),
  async handler() {},
})
