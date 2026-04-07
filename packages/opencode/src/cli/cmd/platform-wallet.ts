import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// Endpoints (PaymentsResource — A2P agent wallets):
//   POST /api/v1/a2p/wallets                              — create wallet
//   GET  /api/v1/a2p/wallets/{agentId}                    — get wallet
//   GET  /api/v1/a2p/wallets/{agentId}/balance            — balance
//   POST /api/v1/a2p/wallets/{agentId}/fund               — fund
//   POST /api/v1/a2p/wallets/{agentId}/withdraw           — withdraw
//   GET  /api/v1/a2p/wallets/{agentId}/transactions       — txns
//   POST /api/v1/a2p/wallets/{agentId}/freeze             — freeze
//   POST /api/v1/a2p/wallets/{agentId}/unfreeze           — unfreeze

const WalletGetCommand = cmd({
  command: "get <agentId>",
  describe: "show wallet for an agent",
  builder: (yargs) => yargs.positional("agentId", { type: "number", demandOption: true }).option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Wallet — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/a2p/wallets/${args.agentId}`)
    const ok = await handleApiError(res, "Get wallet")
    if (!ok) { prompts.outro("Done"); return }
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    if (args.json) { console.log(JSON.stringify(data, null, 2)); prompts.outro("Done"); return }
    printDivider()
    printKV("Wallet ID", data.id)
    printKV("Agent", data.agent_id)
    printKV("Balance", data.balance !== undefined ? `$${(data.balance / 100).toFixed(2)}` : undefined)
    printKV("Currency", data.currency)
    printKV("Status", data.status)
    printKV("Frozen", data.is_frozen)
    printDivider()
    prompts.outro("Done")
  },
})

const WalletBalanceCommand = cmd({
  command: "balance <agentId>",
  describe: "get wallet balance",
  builder: (yargs) => yargs.positional("agentId", { type: "number", demandOption: true }),
  async handler(args) {
    const token = await requireAuth(); if (!token) return
    const res = await irisFetch(`/api/v1/a2p/wallets/${args.agentId}/balance`)
    const ok = await handleApiError(res, "Get balance")
    if (!ok) return
    const data = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
    const bal = data.balance !== undefined ? `$${(data.balance / 100).toFixed(2)}` : "?"
    console.log(`Balance: ${bal} (${data.currency ?? "USD"})`)
  },
})

const WalletCreateCommand = cmd({
  command: "create <agentId>",
  describe: "create a new wallet for an agent",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("currency", { type: "string", default: "USD" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Create wallet — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/a2p/wallets`, {
      method: "POST",
      body: JSON.stringify({ agent_id: args.agentId, currency: args.currency }),
    })
    const ok = await handleApiError(res, "Create wallet")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Created`)
  },
})

const WalletFundCommand = cmd({
  command: "fund <agentId> <amount>",
  describe: "fund a wallet (amount in dollars)",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .positional("amount", { type: "number", demandOption: true })
      .option("source", { type: "string", default: "stripe" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Fund wallet`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const cents = Math.round(args.amount * 100)
    const res = await irisFetch(`/api/v1/a2p/wallets/${args.agentId}/fund`, {
      method: "POST",
      body: JSON.stringify({ amount: cents, source: args.source }),
    })
    const ok = await handleApiError(res, "Fund wallet")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Funded $${args.amount.toFixed(2)}`)
  },
})

const WalletTransactionsCommand = cmd({
  command: "transactions <agentId>",
  aliases: ["txns"],
  describe: "list wallet transactions",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("limit", { type: "number", default: 20 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Transactions — Agent #${args.agentId}`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const params = new URLSearchParams({ limit: String(args.limit) })
    const res = await irisFetch(`/api/v1/a2p/wallets/${args.agentId}/transactions?${params}`)
    const ok = await handleApiError(res, "List txns")
    if (!ok) { prompts.outro("Done"); return }
    const data = (await res.json()) as any
    const txns: any[] = data?.data ?? data?.transactions ?? (Array.isArray(data) ? data : [])
    if (args.json) { console.log(JSON.stringify(txns, null, 2)); prompts.outro("Done"); return }
    printDivider()
    if (txns.length === 0) console.log(`  ${dim("(no transactions)")}`)
    else for (const t of txns) {
      const amt = t.amount !== undefined ? `$${(t.amount / 100).toFixed(2)}` : "?"
      console.log(`  ${bold(amt)}  ${dim(String(t.type ?? ""))}  ${dim(String(t.description ?? ""))}`)
      if (t.created_at) console.log(`    ${dim(String(t.created_at))}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const WalletFreezeCommand = cmd({
  command: "freeze <agentId>",
  describe: "freeze a wallet",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("reason", { type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Freeze wallet`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/a2p/wallets/${args.agentId}/freeze`, {
      method: "POST",
      body: JSON.stringify({ reason: args.reason ?? "manual freeze" }),
    })
    const ok = await handleApiError(res, "Freeze")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Frozen`)
  },
})

const WalletUnfreezeCommand = cmd({
  command: "unfreeze <agentId>",
  describe: "unfreeze a wallet",
  builder: (yargs) => yargs.positional("agentId", { type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Unfreeze wallet`)
    const token = await requireAuth(); if (!token) { prompts.outro("Done"); return }
    const res = await irisFetch(`/api/v1/a2p/wallets/${args.agentId}/unfreeze`, { method: "POST", body: "{}" })
    const ok = await handleApiError(res, "Unfreeze")
    if (!ok) { prompts.outro("Done"); return }
    prompts.outro(`${success("✓")} Unfrozen`)
  },
})

export const PlatformWalletCommand = cmd({
  command: "wallet",
  aliases: ["payments"],
  describe: "manage agent A2P wallets (balance, fund, transactions)",
  builder: (yargs) =>
    yargs
      .command(WalletGetCommand)
      .command(WalletBalanceCommand)
      .command(WalletCreateCommand)
      .command(WalletFundCommand)
      .command(WalletTransactionsCommand)
      .command(WalletFreezeCommand)
      .command(WalletUnfreezeCommand)
      .demandCommand(),
  async handler() {},
})
