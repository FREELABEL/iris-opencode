import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, resolveUserId, requireUserId } from "./iris-api"

// ============================================================================
// Affiliates — manage affiliate links, signups, commissions, and payouts
// Endpoints: /api/v1/user/affiliate/*, /api/v1/atlas/rev-share/*,
//            /api/v1/earnings/*, /api/v1/short-url/*
// ============================================================================

async function getJson(res: Response): Promise<any> { try { return await res.json() } catch { return {} } }

function fmtMoney(cents: unknown): string {
  const v = Number(cents ?? 0)
  return `$${(v / 100).toFixed(2)}`
}

function fmtDollars(n: unknown): string {
  const v = Number(n ?? 0)
  return `$${v.toFixed(2)}`
}

// Recurring commission tiers (mirrors fl-api StripeWebhookController + User model)
const TIERS = [
  { name: "Bronze",   minReferrals: 0,   percent: 15 },
  { name: "Silver",   minReferrals: 10,  percent: 20 },
  { name: "Gold",     minReferrals: 50,  percent: 25 },
  { name: "Platinum", minReferrals: 100, percent: 30 },
]

function getTier(referrals: number): typeof TIERS[0] {
  for (let i = TIERS.length - 1; i >= 0; i--) {
    if (referrals >= TIERS[i].minReferrals) return TIERS[i]
  }
  return TIERS[0]
}

function nextTier(referrals: number): typeof TIERS[0] | null {
  for (const t of TIERS) {
    if (referrals < t.minReferrals) return t
  }
  return null
}

// Helper: resolve user ID from flag, env, or /api/v1/me
async function uid(flagValue?: number): Promise<number | null> {
  return await requireUserId(flagValue)
}

// -- status (default command when no subcommand given) --

const StatusCmd = cmd({
  command: "status",
  aliases: ["dashboard", "show"],
  describe: "full affiliate overview — link, earnings, tier, stripe status",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected if omitted)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    const [linkRes, summaryRes, connectRes] = await Promise.all([
      irisFetch(`/api/v1/user/affiliate/referral-link?user_id=${userId}`),
      irisFetch(`/api/v1/atlas/rev-share/summary`),
      irisFetch(`/api/v1/earnings/connect-status?user_id=${userId}`),
    ])

    const linkBody = linkRes.ok ? await getJson(linkRes) : {}
    const summaryBody = summaryRes.ok ? await getJson(summaryRes) : {}
    const connectBody = connectRes.ok ? await getJson(connectRes) : {}

    const link = linkBody.data ?? linkBody
    const summary = summaryBody.data ?? summaryBody
    const connect = connectBody

    if (args.json) { console.log(JSON.stringify({ link, summary, connect }, null, 2)); return }

    const signups = Number(link.signups ?? link.total_signups ?? 0)
    const tier = getTier(signups)
    const next = nextTier(signups)
    const stripeOk = connect.connected === true

    console.log("")
    console.log(bold("Affiliate Dashboard"))
    printDivider()

    // Link
    const url = link.url ?? link.referral_url ?? link.short_url ?? ""
    printKV("Referral Link", url ? highlight(url) : dim("none — run: iris affiliate link"))
    printKV("Clicks", String(link.clicks ?? link.total_clicks ?? link.stats?.total_clicks ?? 0))
    printKV("Signups", String(signups))
    printDivider()

    // Tier
    printKV("Current Tier", success(`${tier.name} (${tier.percent}% recurring commission)`))
    if (next) {
      const remaining = next.minReferrals - signups
      printKV("Next Tier", dim(`${next.name} (${next.percent}%) — ${remaining} more referrals`))
    }
    printDivider()

    // Earnings
    const totalOwed = Number(summary.total_owed_cents ?? 0)
    const totalPaid = Number(summary.total_paid_cents ?? 0)
    const balance = Number(summary.balance_cents ?? 0)
    const pendingCount = Number(summary.pending_count ?? 0)

    printKV("Total Earned", fmtMoney(totalOwed))
    printKV("Total Paid", fmtMoney(totalPaid))
    printKV("Pending Balance", balance > 0 ? highlight(fmtMoney(balance)) : fmtMoney(balance))
    printKV("Pending Events", String(pendingCount))
    printDivider()

    // Stripe Connect
    if (stripeOk) {
      const payouts = connect.payouts_enabled ? success("enabled") : dim("pending verification")
      printKV("Stripe Connect", success("connected"))
      printKV("Payouts", payouts)
      if (connect.login_url) printKV("Stripe Dashboard", dim(connect.login_url))
    } else {
      printKV("Stripe Connect", dim("not connected"))
      prompts.log.info(`Setup: ${highlight("iris affiliate connect-stripe")}`)
    }
    printDivider()

    // Quick reference
    console.log("")
    console.log(dim("  Earning examples at your tier:"))
    console.log(dim(`    Starter ($99/mo) referral  → $${(99 * tier.percent / 100).toFixed(2)}/mo recurring`))
    console.log(dim(`    Growth ($295/mo) referral  → $${(295 * tier.percent / 100).toFixed(2)}/mo recurring`))
    console.log(dim(`    Pro ($1,500/mo) referral   → $${(1500 * tier.percent / 100).toFixed(2)}/mo recurring`))
    console.log("")
  },
})

// -- link --

const LinkCmd = cmd({
  command: "link",
  aliases: ["url"],
  describe: "show your referral link with stats",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("copy", { describe: "copy link to clipboard", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    const res = await irisFetch(`/api/v1/user/affiliate/referral-link?user_id=${userId}`)
    if (!(await handleApiError(res, "Referral link"))) return
    const body = await getJson(res)
    const link = body.data ?? body

    if (args.json) { console.log(JSON.stringify(link, null, 2)); return }

    const url = link.url ?? link.referral_url ?? link.short_url ?? ""

    console.log("")
    console.log(bold("Your Affiliate Link"))
    printDivider()
    printKV("URL", url ? highlight(url) : dim("none"))
    printKV("Clicks", String(link.clicks ?? link.total_clicks ?? link.stats?.total_clicks ?? 0))
    printKV("Signups", String(link.signups ?? link.total_signups ?? 0))
    printKV("Earnings", fmtDollars(link.earnings ?? link.total_earnings ?? link.stats?.total_calculated_earnings ?? 0))
    printDivider()

    if (args.copy && url) {
      try {
        const { execSync } = await import("child_process")
        execSync(`printf '%s' ${JSON.stringify(url)} | pbcopy`)
        prompts.log.success(`${success("✓")} Copied to clipboard`)
      } catch {
        prompts.log.warn("Could not copy to clipboard")
      }
    } else if (url) {
      prompts.log.info(dim(`Copy: iris affiliate link --copy`))
    }
  },
})

// -- create --

const CreateCmd = cmd({
  command: "create",
  aliases: ["new"],
  describe: "create a new affiliate tracking link",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("slug", { describe: "vanity slug (e.g. dj-mayo)", type: "string" })
      .option("name", { describe: "label (e.g. Instagram Bio)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    const payload: Record<string, unknown> = {
      url: `https://web.freelabel.net/login/register/?affiliate_id=${userId}&simple_signup=true`,
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
    prompts.log.info(dim(`View all: iris affiliate links`))
  },
})

// -- links --

const LinksCmd = cmd({
  command: "links",
  aliases: ["urls"],
  describe: "list all your tracking links",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    const res = await irisFetch(`/api/v1/short-url/user/${userId}`)
    if (!(await handleApiError(res, "List short URLs"))) return
    const body = await getJson(res)
    const raw = body.data ?? body.urls ?? body
    const urls: any[] = Array.isArray(raw) ? raw : []

    if (args.json) { console.log(JSON.stringify(urls, null, 2)); return }
    if (urls.length === 0) { prompts.log.info("No tracking links yet. Create one: iris affiliate create"); return }

    console.log("")
    console.log(bold(`Your Tracking Links (${urls.length})`))
    printDivider()
    for (const u of urls) {
      const shortUrl = u.short_url ?? u.default_short_url ?? u.url_key ?? ""
      const isAffiliate = (u.destination_url ?? u.long_url ?? "").includes("affiliate_id")
      const tag = isAffiliate ? success(" [affiliate]") : ""
      const clicks = u.clicks ?? u.total_clicks ?? 0
      console.log(`  ${dim(`#${u.id}`)}  ${bold(shortUrl)}${tag}  ${dim(`clicks: ${clicks}`)}  ${dim(u.created_at ?? "")}`)
    }
    printDivider()
  },
})

// -- referrals --

const ReferralsCmd = cmd({
  command: "referrals",
  aliases: ["signups", "tree"],
  describe: "list people who signed up through your link",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    const res = await irisFetch(`/api/v1/user/affiliate/market/get-signups?user_id=${userId}`)
    if (!(await handleApiError(res, "Get referrals"))) return
    const body = await getJson(res)
    const raw = body.data ?? body.signups ?? body
    const users: any[] = Array.isArray(raw) ? raw : []

    if (args.json) { console.log(JSON.stringify(users, null, 2)); return }
    if (users.length === 0) { prompts.log.info("No referrals yet. Share your link: iris affiliate link --copy"); return }

    console.log("")
    console.log(bold(`Your Referrals (${users.length})`))
    printDivider()
    for (const u of users) {
      const name = u.full_name ?? u.user_name ?? u.name ?? dim("unnamed")
      const email = u.email ?? ""
      console.log(`  ${dim(`#${u.id}`)}  ${bold(name)}  ${dim(email)}  ${dim(u.created_at ?? "")}`)
    }
    printDivider()

    const tier = getTier(users.length)
    prompts.log.info(`Your tier: ${success(tier.name)} (${tier.percent}% recurring)`)
  },
})

// -- tiers --

const TiersCmd = cmd({
  command: "tiers",
  aliases: ["splits", "commission"],
  describe: "show commission tier rates and your progress",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    // Get signup count to determine current tier
    const res = await irisFetch(`/api/v1/user/affiliate/market/get-signups?user_id=${userId}`)
    const body = res.ok ? await getJson(res) : {}
    const raw = body.data ?? body.signups ?? body
    const signups = Array.isArray(raw) ? raw.length : Number(raw ?? 0)
    const current = getTier(signups)

    if (args.json) { console.log(JSON.stringify({ current: current.name, referrals: signups, tiers: TIERS }, null, 2)); return }

    console.log("")
    console.log(bold("Commission Tiers"))
    printDivider()
    printKV("Your Referrals", String(signups))
    printKV("Current Tier", success(`${current.name} — ${current.percent}% recurring`))
    printDivider()
    console.log("")
    console.log(bold("  Tier        Min Referrals   Commission   On $99/mo    On $295/mo   On $1,500/mo"))
    printDivider()
    for (const t of TIERS) {
      const marker = t.name === current.name ? success(" ← you") : ""
      const s99 = `$${(99 * t.percent / 100).toFixed(2)}`
      const s295 = `$${(295 * t.percent / 100).toFixed(2)}`
      const s1500 = `$${(1500 * t.percent / 100).toFixed(2)}`
      console.log(`  ${bold(t.name.padEnd(12))}  ${String(t.minReferrals).padStart(4)}            ${String(t.percent).padStart(3)}%         ${s99.padStart(7)}      ${s295.padStart(8)}     ${s1500.padStart(9)}${marker}`)
    }
    printDivider()
  },
})

// -- earnings --

const EarningsCmd = cmd({
  command: "earnings",
  aliases: ["events", "sales"],
  describe: "list your commission events",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" })
      .option("status", { describe: "filter: pending or paid", type: "string", choices: ["pending", "paid"] }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    const params = new URLSearchParams({ per_page: "50" })
    if (args.status) params.set("status", args.status)

    const res = await irisFetch(`/api/v1/atlas/rev-share?${params}`)
    if (!(await handleApiError(res, "Commission events"))) return
    const body = await getJson(res)
    const rawData = body.data ?? body
    const events: any[] = Array.isArray(rawData) ? rawData : rawData?.data ?? []

    if (args.json) { console.log(JSON.stringify(events, null, 2)); return }
    if (events.length === 0) { prompts.log.info("No commission events yet. Earnings are created automatically when your referrals pay."); return }

    console.log("")
    console.log(bold(`Commission Events (${events.length})`))
    printDivider()
    for (const e of events) {
      const status = e.status === "paid" ? success("PAID") : dim(e.status ?? "pending")
      const pct = e.rev_share_percent ?? e.percent ?? 0
      const gross = fmtMoney(e.gross_amount_cents ?? 0)
      const share = fmtMoney(e.share_amount_cents ?? 0)
      console.log(`  ${dim(`#${e.id}`)}  ${dim(e.event_date ?? e.created_at ?? "")}  gross: ${gross}  ${pct}%  share: ${bold(share)}  ${status}`)
    }
    printDivider()
  },
})

// -- payout --

const PayoutCmd = cmd({
  command: "payout",
  aliases: ["balance", "summary"],
  describe: "show your payout balance",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    const res = await irisFetch(`/api/v1/atlas/rev-share/summary`)
    if (!(await handleApiError(res, "Payout summary"))) return
    const body = await getJson(res)
    const summary = body.data ?? body

    if (args.json) { console.log(JSON.stringify(summary, null, 2)); return }

    const balance = Number(summary.balance_cents ?? 0)

    console.log("")
    console.log(bold("Payout Balance"))
    printDivider()
    printKV("Total Earned", fmtMoney(summary.total_owed_cents))
    printKV("Total Paid Out", fmtMoney(summary.total_paid_cents))
    printKV("Pending Balance", balance > 0 ? highlight(fmtMoney(balance)) : fmtMoney(balance))
    printKV("Pending Events", String(summary.pending_count ?? 0))
    printKV("Paid Events", String(summary.paid_count ?? 0))
    printDivider()

    if (balance >= 2500) {
      prompts.log.info(`Ready to cash out! Run: ${highlight("iris affiliate cashout")}`)
    } else if (balance > 0) {
      prompts.log.info(dim(`Minimum $25.00 to cash out (you have ${fmtMoney(balance)})`))
    }
  },
})

// -- cashout --

const CashoutCmd = cmd({
  command: "cashout",
  aliases: ["withdraw"],
  describe: "request a payout to your Stripe account",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("amount", { describe: "amount in dollars (default: full balance)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    // Check balance first
    const summaryRes = await irisFetch(`/api/v1/atlas/rev-share/summary`)
    if (summaryRes.ok) {
      const sb = await getJson(summaryRes)
      const s = sb.data ?? sb
      const balance = Number(s.balance_cents ?? 0)
      if (balance < 2500) {
        prompts.log.warn(`Balance is ${fmtMoney(balance)}. Minimum $25.00 required for cashout.`)
        return
      }
      prompts.log.info(`Available balance: ${highlight(fmtMoney(balance))}`)
    }

    const confirmed = await prompts.confirm({
      message: args.amount
        ? `Cash out $${args.amount.toFixed(2)} to your Stripe account?`
        : "Cash out full balance to your Stripe account?",
    })
    if (!confirmed || (typeof confirmed === "symbol")) return

    const payload: Record<string, unknown> = { user_id: userId }
    if (args.amount) payload.amount = args.amount

    const res = await irisFetch(`/api/v1/earnings/cashout`, {
      method: "POST",
      body: JSON.stringify(payload),
    })

    const body = await getJson(res)

    if (args.json) { console.log(JSON.stringify(body, null, 2)); return }

    if (body.success) {
      prompts.log.success(`${success("✓")} Cashout initiated!`)
      if (body.transfer_id) printKV("Transfer ID", body.transfer_id)
      if (body.amount) printKV("Amount", fmtDollars(body.amount))
    } else {
      prompts.log.error(body.message ?? "Cashout failed. Make sure Stripe Connect is set up.")
      prompts.log.info(dim(`Setup: iris affiliate connect-stripe`))
    }
  },
})

// -- connect-stripe --

const ConnectStripeCmd = cmd({
  command: "connect-stripe",
  aliases: ["stripe", "connect"],
  describe: "set up Stripe Connect to receive payouts",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID (auto-detected)", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await uid(args.userId)
    if (!userId) return

    // Check current status first
    const statusRes = await irisFetch(`/api/v1/earnings/connect-status?user_id=${userId}`)
    if (statusRes.ok) {
      const status = await getJson(statusRes)
      if (status.connected) {
        if (args.json) { console.log(JSON.stringify(status, null, 2)); return }
        console.log("")
        console.log(bold("Stripe Connect Status"))
        printDivider()
        printKV("Status", success("Connected"))
        printKV("Payouts", status.payouts_enabled ? success("Enabled") : dim("Pending verification"))
        if (status.login_url) printKV("Dashboard", highlight(status.login_url))
        printDivider()
        return
      }
    }

    // Not connected — initiate onboarding
    prompts.log.info("Setting up Stripe Connect — this will open your browser for onboarding.")

    const res = await irisFetch(`/api/v1/earnings/setup-connect`, {
      method: "POST",
      body: JSON.stringify({ user_id: userId }),
    })
    const body = await getJson(res)

    if (args.json) { console.log(JSON.stringify(body, null, 2)); return }

    if (body.success && body.onboarding_url) {
      prompts.log.success(`${success("✓")} Stripe Connect onboarding ready`)
      printKV("Onboarding URL", highlight(body.onboarding_url))
      // Try to open in browser
      try {
        const { execSync } = await import("child_process")
        execSync(`open ${JSON.stringify(body.onboarding_url)}`)
        prompts.log.info("Opened in your browser. Complete the onboarding to receive payouts.")
      } catch {
        prompts.log.info("Open the URL above in your browser to complete setup.")
      }
    } else {
      prompts.log.error(body.error ?? body.message ?? "Failed to generate onboarding URL")
    }
  },
})

export const PlatformAffiliatesCommand = cmd({
  command: "affiliates",
  aliases: ["affiliate"],
  describe: "manage your affiliate link, referrals, commissions, and payouts",
  builder: (yargs) =>
    yargs
      .command(StatusCmd)
      .command(LinkCmd)
      .command(CreateCmd)
      .command(LinksCmd)
      .command(ReferralsCmd)
      .command(TiersCmd)
      .command(EarningsCmd)
      .command(PayoutCmd)
      .command(CashoutCmd)
      .command(ConnectStripeCmd)
      .demandCommand(),
  async handler() {},
})
