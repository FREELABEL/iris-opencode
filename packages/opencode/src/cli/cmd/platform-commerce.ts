import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, success, writeJson } from "./iris-api"

// ============================================================================
// IRIS Commerce — sell from an Atlas dataset, hold the money, pay the seller.
//
// Buyers pay the platform; every step of a sale is an entry in an append-only ledger:
//   pending → paid → held → released → payout_pending → paid_out   (+ refunded / disputed)
// Routes live in fl-api (/api/v1/commerce/*), which is irisFetch's default base.
// Epic #186079 · payouts #186157
// ============================================================================

const BASE = "/api/v1/commerce"
const CHECKOUT = "https://raichu.heyiris.io/api/v1/commerce/buy"

export function money(cents: number | null | undefined): string {
  const n = Number(cents ?? 0) / 100
  return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

/** The public checkout link for one catalogue row. Price, seller and fee are read on the server. */
export function buyLink(workspace: number | string, dataset: string, item: string, returnUrl?: string): string {
  const url = `${CHECKOUT}/${encodeURIComponent(String(workspace))}/${encodeURIComponent(dataset)}/${encodeURIComponent(item)}`
  return returnUrl ? `${url}?return=${encodeURIComponent(returnUrl)}` : url
}

const STATE_HINT: Record<string, string> = {
  pending: "checkout opened, not paid",
  paid: "paid, being placed on hold",
  held: "paid and held — waiting for a release",
  released: "released — ready to pay out",
  payout_pending: "payout started — waiting on Stripe",
  paid_out: "paid to the seller",
  refunded: "refunded",
  disputed: "disputed — money frozen",
  expired: "checkout expired",
  settled_direct: "paid directly to the seller",
}

async function getJson(path: string, init?: RequestInit): Promise<{ ok: boolean; status: number; body: any }> {
  const res = await irisFetch(path, init)
  const body = await res.json().catch(() => ({}))
  return { ok: res.ok, status: res.status, body }
}

function explain(status: number, body: any, action: string): string {
  if (status === 401) return `${action}: not signed in — run iris login`
  if (status === 403) return `${action}: not allowed — operators release and pay out; sellers can read their own sales`
  return `${action}: ${body?.message ?? `HTTP ${status}`}`
}

// ============================================================================
// Subcommands
// ============================================================================

const SettlementsCmd = cmd({
  command: "settlements",
  aliases: ["ls", "list", "sales"],
  describe: "list sales, their state, and what the seller is owed",
  builder: (y) =>
    y
      .option("seller", { describe: "only this seller workspace (bloq id); also prints what they are owed", type: "number" })
      .option("state", { describe: "only sales in this state, e.g. held, released, paid_out", type: "string" })
      .option("limit", { describe: "most recent sales to show", type: "number", default: 50 })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example("iris commerce settlements --seller 691", "a seller's sales and what they are owed")
      .example("iris commerce settlements --state released", "everything ready to pay out"),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Commerce — sales")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const q = new URLSearchParams()
    if (args.seller) q.set("seller", String(args.seller))
    if (args.state) q.set("state", String(args.state))
    q.set("limit", String(args.limit))
    const r = await getJson(`${BASE}/settlements?${q}`)
    if (!r.ok) { prompts.log.error(explain(r.status, r.body, "List sales")); prompts.outro("Done"); return }
    const rows: any[] = Array.isArray(r.body?.data) ? r.body.data : []
    if (args.json) { await writeJson(r.body); prompts.outro("Done"); return }
    if (rows.length === 0) { prompts.outro("No sales yet"); return }
    printDivider()
    for (const s of rows) {
      console.log(`  ${s.sale}  ${String(s.state).padEnd(15)} ${money(s.gross_cents).padStart(11)}  fee ${money(s.fee_cents)}  net ${money(s.net_cents)}`)
      console.log(`    ${dim(`${s.item} · seller ${s.seller_bloq_id} · ${s.as_of} · ${STATE_HINT[s.state] ?? ""}`)}`)
    }
    printDivider()
    if (r.body?.meta?.owed_cents !== undefined) printKV("Owed to seller", money(r.body.meta.owed_cents) + dim("  (held + released, not yet paid out)"))
    prompts.outro(dim("iris commerce show <sale>"))
  },
})

const ShowCmd = cmd({
  command: "show <sale>",
  describe: "one sale with every step it has been through",
  builder: (y) =>
    y
      .positional("sale", { describe: "sale id, stl_…", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Commerce — ${args.sale}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const r = await getJson(`${BASE}/settlements/${encodeURIComponent(String(args.sale))}`)
    if (!r.ok) { prompts.log.error(explain(r.status, r.body, "Show sale")); prompts.outro("Done"); return }
    const s = r.body?.data ?? {}
    if (args.json) { await writeJson(s); prompts.outro("Done"); return }
    printDivider()
    printKV("State", `${s.state}  ${dim(STATE_HINT[s.state] ?? "")}`)
    printKV("Item", s.item)
    printKV("Seller", String(s.seller_bloq_id))
    printKV("Gross", money(s.gross_cents))
    printKV("Platform fee", money(s.fee_cents))
    printKV("Net to seller", money(s.net_cents))
    printDivider()
    for (const e of s.entries ?? []) {
      console.log(`  ${String(e.seq).padStart(5)}  ${String(e.state).padEnd(15)} ${dim(e.at ?? "")}  ${e.actor ? `by ${e.actor}` : ""}`)
      if (e.note) console.log(`         ${dim(e.note)}`)
      if (e.stripe_ref) console.log(`         ${dim(e.stripe_ref)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

const ReleaseCmd = cmd({
  command: "release <sale>",
  describe: "release held money to the seller (operators) — records who and why; moves no money",
  builder: (y) =>
    y
      .positional("sale", { describe: "sale id, stl_…", type: "string", demandOption: true })
      .option("reason", { describe: "why it is being released, e.g. 'kickoff delivered'", type: "string", demandOption: true })
      .example("iris commerce release stl_… --reason 'kickoff delivered'", "then: iris commerce payout stl_…"),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Commerce — release")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const r = await getJson(`${BASE}/settlements/${encodeURIComponent(String(args.sale))}/release`, {
      method: "POST",
      body: JSON.stringify({ reason: args.reason }),
    })
    if (!r.ok) { prompts.log.error(explain(r.status, r.body, "Release")); prompts.outro("Done"); return }
    console.log(success(`  ${args.sale} released — ${money(r.body?.data?.net_cents)} is ready to pay out`))
    prompts.outro(dim(`iris commerce payout ${args.sale}`))
  },
})

const PayoutCmd = cmd({
  command: "payout [sale]",
  describe: "pay the seller from released sales (operators) — a dry run unless --apply",
  builder: (y) =>
    y
      .positional("sale", { describe: "one sale id, stl_… (or use --seller)", type: "string" })
      .option("seller", { describe: "every released sale for this seller workspace (bloq id)", type: "number" })
      .option("apply", { describe: "actually transfer the money (otherwise shows what would happen)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .example("iris commerce payout stl_…", "dry run: net amount, destination, anything blocking it")
      .example("iris commerce payout stl_… --apply", "transfer the net to the seller's Stripe account")
      .example("iris commerce payout --seller 691 --apply", "pay every released sale for one seller")
      .epilogue(
        "Rules: the seller's Stripe account must have payouts enabled; the NET is sent (the platform fee was kept\n" +
          "when the buyer paid); the payout is recorded before any money moves, and a retry can never pay twice.",
      ),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Commerce — payout${args.apply ? "" : " (dry run)"}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    if (!args.sale && !args.seller) { prompts.log.error("Name a sale, or --seller <bloq id>."); prompts.outro("Done"); return }
    const path = args.sale
      ? `${BASE}/settlements/${encodeURIComponent(String(args.sale))}/payout`
      : `${BASE}/sellers/${encodeURIComponent(String(args.seller))}/payouts`
    const r = await getJson(path, { method: "POST", body: JSON.stringify({ apply: !!args.apply }) })
    if (args.json) { await writeJson(r.body); prompts.outro("Done"); return }
    if (!r.ok && r.status !== 409) { prompts.log.error(explain(r.status, r.body, "Payout")); prompts.outro("Done"); return }
    const data = r.body?.data
    const rows: any[] = Array.isArray(data) ? data : data ? [data] : []
    if (rows.length === 0) { prompts.outro("Nothing released to pay out"); return }
    printDivider()
    for (const p of rows) {
      const id = p.sale ?? p.settlementId
      const net = money(p.net_cents ?? p.netCents)
      if (!args.apply) {
        console.log(`  ${id}  ${net.padStart(11)}  → ${p.destination ?? "—"}  ${p.blocker ? dim(`blocked: ${p.blocker}`) : "ready"}`)
      } else {
        console.log(`  ${id}  ${String(p.status).padEnd(12)} ${net.padStart(11)}  ${p.transferId ?? p.reason ?? ""}`)
      }
    }
    printDivider()
    prompts.outro(args.apply ? "Done" : dim("Nothing moved. Add --apply to transfer."))
  },
})

const VerifyCmd = cmd({
  command: "verify",
  describe: "check the sales ledger is intact — every entry chained to the one before it (operators)",
  builder: (y) => y.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Commerce — verify ledger")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const r = await getJson(`${BASE}/settlements/verify`)
    if (!r.ok) { prompts.log.error(explain(r.status, r.body, "Verify")); prompts.outro("Done"); return }
    const d = r.body?.data ?? {}
    if (args.json) { await writeJson(d); prompts.outro("Done"); return }
    if (d.intact) console.log(success(`  Intact — ${d.entries} entries, every hash and link checks out`))
    else for (const p of d.problems ?? []) prompts.log.error(p)
    prompts.outro("Done")
  },
})

const BuyLinkCmd = cmd({
  command: "buy-link <workspace> <dataset> <item>",
  describe: "print the checkout link for one catalogue item — paste it in an email, a DM or a bio",
  builder: (y) =>
    y
      .positional("workspace", { describe: "seller workspace (bloq id)", type: "string", demandOption: true })
      .positional("dataset", { describe: "Atlas dataset slug (must be sellable)", type: "string", demandOption: true })
      .positional("item", { describe: "the row's external_id", type: "string", demandOption: true })
      .option("return", { describe: "where the buyer lands after paying (https heyiris.io / freelabel.net)", type: "string" })
      .example("iris commerce buy-link 691 mino-packages stageshift-playbook", "a link anyone can pay through"),
  async handler(args) {
    console.log(buyLink(String(args.workspace), String(args.dataset), String(args.item), args.return as string | undefined))
  },
})

export const PlatformCommerceCommand = productCommand({
  name: "commerce",
  purpose: "sell from Atlas, hold the money, pay the seller — sales, release, payout, buy links",
  keywords: ["commerce", "sell", "sales", "checkout", "payout", "settlement", "stripe", "buy link", "storefront", "refund"],
  // Shipped without either of these (#186319): the guide existed, but nobody reading
  // `iris commerce --help` was ever told where it was.
  howtos: ["genesis-atlas-commerce"],
  playbooks: ["genesis-atlas-commerce"],
  builder: (y) =>
    y
      .command(SettlementsCmd)
      .command(ShowCmd)
      .command(ReleaseCmd)
      .command(PayoutCmd)
      .command(VerifyCmd)
      .command(BuyLinkCmd)
      .demandCommand()
      .epilogue(
        "A sale moves: pending → paid → held → released → payout_pending → paid_out.\n" +
          "Buyers pay the platform; money is held until an operator releases it with a reason,\n" +
          "then paid out to the seller's Stripe account. Guide: https://heyiris.io/playbooks/genesis-atlas-commerce",
      ),
  async handler() {},
})
