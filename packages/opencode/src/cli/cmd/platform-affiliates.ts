import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// Affiliates — manage affiliate trees, links, clicks, signups, commissions
// Endpoints: /api/v1/user/affiliate/*, /api/v1/atlas/rev-share/*, /api/v1/short-url/*
// ============================================================================

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

function fmtMoney(n: unknown): string {
  const v = Number(n ?? 0)
  return `$${v.toFixed(2)}`
}

// Tier thresholds (mirrors User model)
const TIERS = [
  { name: "Bronze",   minSignups: 0,   perClick: 0.01, perSignup: 1.00, perUpgrade: 5.00 },
  { name: "Silver",   minSignups: 10,  perClick: 0.02, perSignup: 2.00, perUpgrade: 10.00 },
  { name: "Gold",     minSignups: 50,  perClick: 0.03, perSignup: 3.00, perUpgrade: 15.00 },
  { name: "Platinum", minSignups: 100, perClick: 0.05, perSignup: 5.00, perUpgrade: 25.00 },
]

function getTier(signups: number): typeof TIERS[0] {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (signups >= TIERS[i].minSignups) return TIERS[i]
  }
  return TIERS[0]
}

// -- dashboard --

const DashboardCmd = cmd({
  command: "dashboard <user-id>",
  aliases: ["show"],
  describe: "combined affiliate overview for a user",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const uid = args.userId
    const [linkRes, summaryRes] = await Promise.all([
      irisFetch(`/api/v1/user/affiliate/referral-link?user_id=${uid}`),
      irisFetch(`/api/v1/atlas/rev-share/summary?partner_lead_id=${uid}`),
    ])
    if (!(await handleApiError(linkRes, "Referral link"))) return
    if (!(await handleApiError(summaryRes, "Rev-share summary"))) return

    const linkBody = await getJson(linkRes)
    const summaryBody = await getJson(summaryRes)
    const link = linkBody.data ?? linkBody
    const summary = summaryBody.data ?? summaryBody

    if (args.json) { console.log(JSON.stringify({ link, summary }, null, 2)); return }

    const signups = Number(link.signups ?? link.total_signups ?? 0)
    const tier = getTier(signups)

    console.log("")
    console.log(bold(`Affiliate Dashboard — User #${uid}`))
    printDivider()
    printKV("Link", link.url ?? link.referral_url ?? link.short_url ?? dim("none"))
    printKV("Clicks", String(link.clicks ?? link.total_clicks ?? 0))
    printKV("Unique Clicks", String(link.unique_clicks ?? 0))
    printKV("Signups", String(signups))
    printKV("Tier", tier.name)
    printDivider()
    printKV("Total Earned", fmtMoney(summary.total_earned ?? summary.total_share))
    printKV("Total Paid", fmtMoney(summary.total_paid))
    printKV("Balance Due", fmtMoney(summary.balance_due ?? summary.balance))
    printKV("Events", String(summary.total_events ?? summary.event_count ?? 0))
    printDivider()
  },
})

// -- link --

const LinkCmd = cmd({
  command: "link <user-id>",
  aliases: ["url"],
  describe: "show primary referral link with stats",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("copy", { describe: "copy link to clipboard", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/user/affiliate/referral-link?user_id=${args.userId}`)
    if (!(await handleApiError(res, "Referral link"))) return
    const body = await getJson(res)
    const link = body.data ?? body

    if (args.json) { console.log(JSON.stringify(link, null, 2)); return }

    const url = link.url ?? link.referral_url ?? link.short_url ?? ""

    console.log("")
    console.log(bold(`Affiliate Link — User #${args.userId}`))
    printDivider()
    printKV("URL", url ? highlight(url) : dim("none"))
    printKV("Destination", link.destination ?? link.long_url ?? dim("—"))
    printKV("Clicks", String(link.clicks ?? link.total_clicks ?? 0))
    printKV("Unique Clicks", String(link.unique_clicks ?? 0))
    printKV("Signups", String(link.signups ?? link.total_signups ?? 0))
    printKV("Earnings", fmtMoney(link.earnings ?? link.total_earnings ?? 0))
    if (link.top_browsers) printKV("Top Browsers", String(link.top_browsers))
    if (link.top_countries) printKV("Top Countries", String(link.top_countries))
    if (link.top_referrers) printKV("Top Referrers", String(link.top_referrers))
    printDivider()

    if (args.copy && url) {
      try {
        const { execSync } = await import("child_process")
        execSync(`printf '%s' ${JSON.stringify(url)} | pbcopy`)
        prompts.log.success(`${success("✓")} Copied to clipboard`)
      } catch {
        prompts.log.warn("Could not copy to clipboard")
      }
    }
  },
})

// -- links --

const LinksCmd = cmd({
  command: "links <user-id>",
  aliases: ["urls"],
  describe: "list all short URLs for a user",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/short-url/user/${args.userId}`)
    if (!(await handleApiError(res, "List short URLs"))) return
    const body = await getJson(res)
    const raw = body.data ?? body.urls ?? body
    const urls: any[] = Array.isArray(raw) ? raw : []

    if (args.json) { console.log(JSON.stringify(urls, null, 2)); return }
    if (urls.length === 0) { prompts.log.info(`No short URLs for user #${args.userId}`); return }

    console.log("")
    console.log(bold(`Short URLs — User #${args.userId} (${urls.length})`))
    printDivider()
    for (const u of urls) {
      const shortUrl = u.short_url ?? u.default_short_url ?? u.url_key ?? ""
      const dest = u.destination_url ?? u.long_url ?? ""
      const isAffiliate = dest.includes("affiliate_id")
      const tag = isAffiliate ? success(" [affiliate]") : ""
      const clicks = u.clicks ?? u.total_clicks ?? 0
      console.log(`  ${dim(`#${u.id}`)}  ${bold(shortUrl)}${tag}  ${dim(`clicks: ${clicks}`)}  ${dim(u.created_at ?? "")}`)
      if (u.title) console.log(`       ${dim(u.title)}`)
    }
    printDivider()
  },
})

// -- create --

const CreateCmd = cmd({
  command: "create <user-id>",
  aliases: ["new"],
  describe: "create a new affiliate tracking link",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("slug", { describe: "vanity slug (e.g. dj-mayo)", type: "string" })
      .option("name", { describe: "label for the link (e.g. Instagram Bio)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const payload: Record<string, unknown> = {
      url: `https://web.heyiris.io/login/register/?affiliate_id=${args.userId}&simple_signup=true`,
    }
    if (args.slug) payload.url_key = args.slug
    if (args.name) payload.title = args.name

    const res = await irisFetch(`/api/v1/short-url/create`, {
      method: "POST",
      body: JSON.stringify(payload),
    })
    if (!(await handleApiError(res, "Create affiliate link"))) return
    const body = await getJson(res)
    const link = body.data ?? body

    if (args.json) { console.log(JSON.stringify(link, null, 2)); return }

    prompts.log.success(`${success("✓")} Affiliate link created`)
    printKV("URL", highlight(link.short_url ?? link.default_short_url ?? link.url_key ?? ""))
    if (link.title) printKV("Label", link.title)
    if (link.qr_code ?? link.qr_code_url) printKV("QR Code", link.qr_code ?? link.qr_code_url)
    prompts.log.info(dim(`Next: iris affiliates links ${args.userId}`))
  },
})

// -- signups --

const SignupsCmd = cmd({
  command: "signups <user-id>",
  aliases: ["referrals", "tree"],
  describe: "list referred users (signup tree)",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/user/affiliate/market/get-signups?user_id=${args.userId}`)
    if (!(await handleApiError(res, "Get signups"))) return
    const body = await getJson(res)
    const raw = body.data ?? body.signups ?? body
    const users: any[] = Array.isArray(raw) ? raw : []

    if (args.json) { console.log(JSON.stringify(users, null, 2)); return }
    if (users.length === 0) { prompts.log.info(`No signups for user #${args.userId}`); return }

    console.log("")
    console.log(bold(`Referred Users — User #${args.userId} (${users.length})`))
    printDivider()
    for (const u of users) {
      const name = u.full_name ?? u.user_name ?? u.name ?? ""
      const email = u.email ?? ""
      console.log(`  ${dim(`#${u.id}`)}  ${bold(name)}  ${dim(email)}  ${dim(u.created_at ?? "")}`)
    }
    printDivider()
  },
})

// -- splits --

const SplitsCmd = cmd({
  command: "splits <user-id>",
  aliases: ["tiers", "commission"],
  describe: "show commission tier and rate schedule",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/user/affiliate/referral-link?user_id=${args.userId}`)
    if (!(await handleApiError(res, "Referral link"))) return
    const body = await getJson(res)
    const link = body.data ?? body
    const signups = Number(link.signups ?? link.total_signups ?? 0)
    const current = getTier(signups)

    if (args.json) { console.log(JSON.stringify({ current: current.name, signups, tiers: TIERS }, null, 2)); return }

    console.log("")
    console.log(bold(`Commission Splits — User #${args.userId}`))
    printDivider()
    printKV("Signups", String(signups))
    printKV("Current Tier", success(current.name))
    printKV("Per Click", fmtMoney(current.perClick))
    printKV("Per Signup", fmtMoney(current.perSignup))
    printKV("Per Upgrade", fmtMoney(current.perUpgrade))
    printDivider()
    console.log("")
    console.log(bold("Tier Reference"))
    printDivider()
    for (const t of TIERS) {
      const marker = t.name === current.name ? success(" <--") : ""
      console.log(`  ${bold(t.name.padEnd(10))}  ${dim("min:")} ${String(t.minSignups).padStart(3)}  ${dim("click:")} ${fmtMoney(t.perClick)}  ${dim("signup:")} ${fmtMoney(t.perSignup)}  ${dim("upgrade:")} ${fmtMoney(t.perUpgrade)}${marker}`)
    }
    printDivider()
  },
})

// -- earnings --

const EarningsCmd = cmd({
  command: "earnings <user-id>",
  aliases: ["events", "sales"],
  describe: "list rev-share events (commissions)",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("status", { describe: "filter by status", type: "string", choices: ["pending", "paid"] })
      .option("from", { describe: "start date (YYYY-MM-DD)", type: "string" })
      .option("to", { describe: "end date (YYYY-MM-DD)", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const params = new URLSearchParams({ partner_lead_id: String(args.userId), per_page: "50" })
    if (args.status) params.set("status", args.status)
    if (args.from) params.set("from", args.from)
    if (args.to) params.set("to", args.to)

    const res = await irisFetch(`/api/v1/atlas/rev-share?${params}`)
    if (!(await handleApiError(res, "Rev-share events"))) return
    const body = await getJson(res)
    const raw = body.data ?? body.events ?? body
    const events: any[] = Array.isArray(raw) ? raw : []

    if (args.json) { console.log(JSON.stringify(events, null, 2)); return }
    if (events.length === 0) { prompts.log.info(`No rev-share events for user #${args.userId}`); return }

    console.log("")
    console.log(bold(`Earnings — User #${args.userId} (${events.length})`))
    printDivider()
    for (const e of events) {
      const status = e.status === "paid" ? success("PAID") : dim(e.status ?? "pending")
      const pct = e.percent ?? e.rev_share_percent ?? 0
      console.log(`  ${dim(`#${e.id}`)}  ${dim(e.created_at ?? "")}  gross: ${fmtMoney(e.gross ?? e.gross_amount)}  ${pct}%  share: ${bold(fmtMoney(e.share ?? e.partner_share))}  ${status}`)
      if (e.description) console.log(`       ${dim(e.description)}`)
    }
    printDivider()
  },
})

// -- payout --

const PayoutCmd = cmd({
  command: "payout <user-id>",
  aliases: ["balance", "summary"],
  describe: "show payout balance summary",
  builder: (yargs) =>
    yargs
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/atlas/rev-share/summary?partner_lead_id=${args.userId}`)
    if (!(await handleApiError(res, "Rev-share summary"))) return
    const body = await getJson(res)
    const summary = body.data ?? body

    if (args.json) { console.log(JSON.stringify(summary, null, 2)); return }

    console.log("")
    console.log(bold(`Payout Summary — User #${args.userId}`))
    printDivider()
    printKV("Total Earned", fmtMoney(summary.total_earned ?? summary.total_share))
    printKV("Total Paid", fmtMoney(summary.total_paid))
    printKV("Balance Due", highlight(fmtMoney(summary.balance_due ?? summary.balance)))
    printKV("Total Events", String(summary.total_events ?? summary.event_count ?? 0))
    printDivider()
  },
})

export const PlatformAffiliatesCommand = cmd({
  command: "affiliates",
  aliases: ["affiliate"],
  describe: "manage affiliate links, signups, commissions, and payouts",
  builder: (yargs) =>
    yargs
      .command(DashboardCmd)
      .command(LinkCmd)
      .command(LinksCmd)
      .command(CreateCmd)
      .command(SignupsCmd)
      .command(SplitsCmd)
      .command(EarningsCmd)
      .command(PayoutCmd)
      .demandCommand(),
  async handler() {},
})
