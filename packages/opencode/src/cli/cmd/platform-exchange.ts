import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, dim, bold, success, highlight, FL_API } from "./iris-api"
import { hiveFetch, fetchNodes } from "./platform-hive-nodes"
import { homedir } from "os"
import { join } from "path"
import { readFileSync, existsSync } from "fs"

// ============================================================================
// IRIS Exchange — distributed task marketplace
// ============================================================================

const IRIS_API = (() => {
  try {
    const configPath = join(homedir(), ".iris", "config.json")
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"))
      return config.api_url || "https://freelabel.net"
    }
  } catch {}
  return process.env.IRIS_API_URL || "https://freelabel.net"
})()

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

function dollars(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`
}

function tierBadge(tier: string): string {
  const badges: Record<string, string> = {
    bronze: "bronze",
    silver: "* silver",
    gold: "** gold",
    diamond: "*** diamond",
  }
  return badges[tier] || tier
}

function statusColor(status: string): string {
  if (status === "open") return success(status)
  if (status === "completed") return success(status)
  if (status === "claimed" || status === "submitted") return highlight(status)
  if (status === "expired" || status === "cancelled" || status === "disputed") return dim(status)
  return status
}

// ============================================================================
// iris exchange list — browse open listings
// ============================================================================

const ExchangeListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "browse open exchange listings",
  builder: (yargs) =>
    yargs
      .option("category", { alias: "c", describe: "filter by category", type: "string" })
      .option("skill", { describe: "filter by skill", type: "string" })
      .option("status", { describe: "filter by status", type: "string", default: "open" })
      .option("min-bounty", { describe: "minimum bounty in dollars", type: "number" })
      .option("limit", { describe: "max results", type: "number", default: 20 })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  IRIS Exchange") }

    const token = await requireAuth()
    if (!token) return

    const sp = argv.json ? null : prompts.spinner()
    sp?.start("Loading listings…")

    const params = new URLSearchParams()
    if (argv.category) params.set("category", String(argv.category))
    if (argv.skill) params.set("skill", String(argv.skill))
    if (argv.status) params.set("status", String(argv.status))
    if (argv["min-bounty"]) params.set("min_bounty", String(argv["min-bounty"]))
    params.set("limit", String(argv.limit))

    const res = await hiveFetch(`/api/v6/exchange/listings?${params}`)
    if (!res.ok) {
      sp?.stop("Failed")
      console.error(`  HTTP ${res.status}`)
      return
    }

    const data = (await res.json()) as { listings: any[]; total: number }
    sp?.stop(`${data.total} listing(s)`)

    if (argv.json) {
      console.log(JSON.stringify(data.listings, null, 2))
      return
    }

    if (data.listings.length === 0) {
      console.log(dim("  No listings found."))
      prompts.outro("Done")
      return
    }

    console.log()
    console.log(bold("  Bounty   Status     Category    Title"))
    console.log(dim("  " + "─".repeat(75)))

    for (const l of data.listings) {
      const bounty = highlight(dollars(l.bounty_cents).padEnd(8))
      const status = statusColor((l.status || "").padEnd(10))
      const cat = dim((l.category || "other").padEnd(11))
      const title = l.title?.substring(0, 40) || "Untitled"
      const id = dim(`#${(l.id || "").substring(0, 8)}`)
      console.log(`  ${bounty} ${status} ${cat} ${title}  ${id}`)
      if (l.skills_required?.length) {
        console.log(`  ${dim("         skills: " + l.skills_required.join(", "))}`)
      }
    }

    console.log()
    prompts.outro("Done")
  },
})

// ============================================================================
// iris exchange post — create a new listing
// ============================================================================

const ExchangePostCommand = cmd({
  command: "post",
  describe: "post a new exchange listing",
  builder: (yargs) =>
    yargs
      .option("title", { alias: "t", describe: "listing title", type: "string" })
      .option("description", { alias: "d", describe: "full description", type: "string" })
      .option("bounty", { alias: "b", describe: "bounty in dollars", type: "number" })
      .option("category", { alias: "c", describe: "category", type: "string", default: "other" })
      .option("skills", { describe: "comma-separated skills", type: "string" })
      .option("repo", { describe: "git repo URL", type: "string" })
      .option("tests", { describe: "acceptance test command", type: "string" })
      .option("max-hours", { describe: "max hours to complete", type: "number", default: 48 })
      .option("expires-days", { describe: "days until listing expires", type: "number", default: 14 })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Post Exchange Listing") }

    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) return

    // Interactive prompts for missing fields
    let title = argv.title as string | undefined
    if (!title) {
      const r = await prompts.text({ message: "Title", placeholder: "Fix pagination bug in LeadController" })
      if (prompts.isCancel(r)) { prompts.outro("Cancelled"); return }
      title = r as string
    }

    let description = argv.description as string | undefined
    if (!description) {
      const r = await prompts.text({
        message: "Description (acceptance criteria, context)",
        placeholder: "The leads list endpoint returns all records instead of paginating...",
      })
      if (prompts.isCancel(r)) { prompts.outro("Cancelled"); return }
      description = r as string
    }

    let bounty = argv.bounty as number | undefined
    if (!bounty) {
      const r = await prompts.text({ message: "Bounty (USD)", placeholder: "50" })
      if (prompts.isCancel(r)) { prompts.outro("Cancelled"); return }
      bounty = parseFloat(r as string)
    }

    const bountyCents = Math.round(bounty * 100)
    const category = String(argv.category || "other")
    const skills = argv.skills ? String(argv.skills).split(",").map((s) => s.trim()) : null

    const sp = argv.json ? null : prompts.spinner()
    sp?.start("Creating listing…")

    const body: Record<string, unknown> = {
      user_id: userId,
      title,
      description,
      bounty_cents: bountyCents,
      category,
      skills_required: skills,
      repo_url: argv.repo || null,
      acceptance_tests: argv.tests || null,
      max_claim_hours: argv["max-hours"],
      expires_days: argv["expires-days"],
    }

    const res = await hiveFetch(`/api/v6/exchange/listings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      sp?.stop("Failed")
      const err = await res.text().catch(() => `HTTP ${res.status}`)
      console.error(`  ${err.substring(0, 300)}`)
      return
    }

    const data = (await res.json()) as { listing: any }
    const l = data.listing
    sp?.stop(success(`Listed: ${dollars(l.bounty_cents)} bounty`))

    if (argv.json) {
      console.log(JSON.stringify(l, null, 2))
      return
    }

    console.log()
    console.log(`  ${bold("ID:")}       ${l.id}`)
    console.log(`  ${bold("Title:")}    ${l.title}`)
    console.log(`  ${bold("Bounty:")}   ${highlight(dollars(l.bounty_cents))}  (fee: ${dollars(l.platform_fee_cents)})`)
    console.log(`  ${bold("Category:")} ${l.category}`)
    if (l.repo_url) console.log(`  ${bold("Repo:")}     ${l.repo_url}`)
    if (skills?.length) console.log(`  ${bold("Skills:")}   ${skills.join(", ")}`)
    console.log()
    prompts.outro(dim("Share: iris exchange show " + l.id.substring(0, 8)))
  },
})

// ============================================================================
// iris exchange show <id> — view listing detail
// ============================================================================

const ExchangeShowCommand = cmd({
  command: "show <id>",
  describe: "view listing detail",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "listing ID (or prefix)", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const token = await requireAuth()
    if (!token) return

    const res = await hiveFetch(`/api/v6/exchange/listings/${argv.id}`)
    if (!res.ok) {
      console.error(`  Listing not found: HTTP ${res.status}`)
      return
    }

    const data = (await res.json()) as { listing: any }
    const l = data.listing

    if (argv.json) {
      console.log(JSON.stringify(l, null, 2))
      return
    }

    console.log()
    console.log(`  ${bold(l.title)}  ${dim("#" + l.id.substring(0, 8))}`)
    console.log(dim("  " + "─".repeat(60)))
    console.log(`  ${bold("Status:")}   ${statusColor(l.status)}`)
    console.log(`  ${bold("Bounty:")}   ${highlight(dollars(l.bounty_cents))}  (payout: ${dollars(l.bounty_cents - l.platform_fee_cents)})`)
    console.log(`  ${bold("Category:")} ${l.category}`)
    if (l.skills_required?.length) console.log(`  ${bold("Skills:")}   ${l.skills_required.join(", ")}`)
    if (l.repo_url) console.log(`  ${bold("Repo:")}     ${l.repo_url}`)
    if (l.branch_name) console.log(`  ${bold("Branch:")}   ${l.branch_name}`)
    if (l.pr_url) console.log(`  ${bold("PR:")}       ${l.pr_url}`)
    if (l.acceptance_tests) console.log(`  ${bold("Tests:")}    ${l.acceptance_tests}`)
    console.log(`  ${bold("Posted:")}   ${timeAgo(l.created_at)}`)
    if (l.expires_at) console.log(`  ${bold("Expires:")}  ${timeAgo(l.expires_at)}`)
    if (l.claimed_by_user_id) {
      console.log(`  ${bold("Claimed:")}  user #${l.claimed_by_user_id}  ${timeAgo(l.claimed_at)}`)
    }
    if (l.submitted_at) console.log(`  ${bold("Submitted:")} ${timeAgo(l.submitted_at)}`)
    if (l.verification_rating) console.log(`  ${bold("Rating:")}   ${"★".repeat(l.verification_rating)}${"☆".repeat(5 - l.verification_rating)}`)

    console.log()
    console.log(dim("  Description:"))
    console.log(`  ${l.description?.substring(0, 500) || "(none)"}`)
    if (l.result_summary) {
      console.log()
      console.log(dim("  Result:"))
      console.log(`  ${l.result_summary.substring(0, 500)}`)
    }
    console.log()
  },
})

// ============================================================================
// iris exchange claim <id> — claim a listing
// ============================================================================

const ExchangeClaimCommand = cmd({
  command: "claim <id>",
  describe: "claim an open listing — dispatches task to your node",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "listing ID", type: "string", demandOption: true })
      .option("node", { describe: "node name or ID", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Claim Exchange Listing") }

    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) return

    // Resolve node
    const nodes = await fetchNodes(userId)
    const online = nodes.filter((n) => n.connection_status === "online")

    if (online.length === 0) {
      if (!argv.json) prompts.log.error("No online nodes. Start your daemon: iris bridge start")
      process.exit(1)
    }

    let nodeId: string
    if (argv.node) {
      const match = online.find((n) => n.name === argv.node || n.id === argv.node || n.id.startsWith(String(argv.node)))
      if (!match) {
        if (!argv.json) prompts.log.error(`Node "${argv.node}" not found or offline`)
        process.exit(1)
      }
      nodeId = match.id
    } else if (online.length === 1) {
      nodeId = online[0].id
      if (!argv.json) prompts.log.info(`Using node: ${online[0].name}`)
    } else {
      const r = await prompts.select({
        message: "Which node should execute this task?",
        options: online.map((n) => ({ value: n.id, label: `${n.name} (${n.active_tasks ?? 0} active)` })),
      })
      if (prompts.isCancel(r)) { prompts.outro("Cancelled"); return }
      nodeId = r as string
    }

    const sp = argv.json ? null : prompts.spinner()
    sp?.start("Claiming…")

    const res = await hiveFetch(`/api/v6/exchange/listings/${argv.id}/claim`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, node_id: nodeId }),
    })

    if (!res.ok) {
      sp?.stop("Failed")
      const err = await res.text().catch(() => `HTTP ${res.status}`)
      console.error(`  ${err.substring(0, 300)}`)
      return
    }

    const data = (await res.json()) as { listing: any; message: string }
    sp?.stop(success(data.message || "Claimed"))

    if (argv.json) {
      console.log(JSON.stringify(data.listing, null, 2))
      return
    }

    console.log()
    console.log(`  ${bold("Task ID:")} ${data.listing.node_task_id}`)
    console.log(`  ${bold("Node:")}    ${online.find((n) => n.id === nodeId)?.name || nodeId}`)
    console.log(`  ${dim("Monitor: iris hive tasks")}`)
    console.log(`  ${dim("Submit:  iris exchange submit " + String(argv.id).substring(0, 8))}`)
    console.log()
    prompts.outro("Done")
  },
})

// ============================================================================
// iris exchange submit <id> — submit completed work
// ============================================================================

const ExchangeSubmitCommand = cmd({
  command: "submit <id>",
  describe: "submit completed work on a claimed listing",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "listing ID", type: "string", demandOption: true })
      .option("summary", { alias: "m", describe: "result summary", type: "string" })
      .option("pr", { describe: "PR URL", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Submit Exchange Work") }

    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) return

    let summary = argv.summary as string | undefined
    if (!summary) {
      const r = await prompts.text({ message: "Summary of work completed", placeholder: "Fixed the pagination bug, added tests" })
      if (prompts.isCancel(r)) { prompts.outro("Cancelled"); return }
      summary = r as string
    }

    const sp = argv.json ? null : prompts.spinner()
    sp?.start("Submitting…")

    const res = await hiveFetch(`/api/v6/exchange/listings/${argv.id}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId, result_summary: summary, pr_url: argv.pr || null }),
    })

    if (!res.ok) {
      sp?.stop("Failed")
      const err = await res.text().catch(() => `HTTP ${res.status}`)
      console.error(`  ${err.substring(0, 300)}`)
      return
    }

    const data = (await res.json()) as { listing: any; message: string }
    sp?.stop(success(data.message || "Submitted"))

    if (argv.json) { console.log(JSON.stringify(data.listing, null, 2)); return }
    console.log(dim("  Poster will be notified to verify."))
    prompts.outro("Done")
  },
})

// ============================================================================
// iris exchange verify <id> — poster accepts or rejects work
// ============================================================================

const ExchangeVerifyCommand = cmd({
  command: "verify <id>",
  describe: "verify submitted work (poster only) — accept or reject",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "listing ID", type: "string", demandOption: true })
      .option("accept", { describe: "accept the work", type: "boolean" })
      .option("reject", { describe: "reject the work", type: "boolean" })
      .option("rating", { describe: "quality rating (1-5)", type: "number" })
      .option("notes", { describe: "verification notes", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Verify Exchange Work") }

    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) return

    let accepted: boolean
    if (argv.accept) {
      accepted = true
    } else if (argv.reject) {
      accepted = false
    } else {
      const r = await prompts.confirm({ message: "Accept this work?" })
      if (prompts.isCancel(r)) { prompts.outro("Cancelled"); return }
      accepted = r as boolean
    }

    let rating = argv.rating as number | undefined
    if (accepted && !rating) {
      const r = await prompts.text({ message: "Quality rating (1-5)", placeholder: "5" })
      if (prompts.isCancel(r)) { prompts.outro("Cancelled"); return }
      rating = parseInt(r as string, 10)
    }

    const sp = argv.json ? null : prompts.spinner()
    sp?.start(accepted ? "Accepting…" : "Rejecting…")

    const res = await hiveFetch(`/api/v6/exchange/listings/${argv.id}/verify`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        accepted,
        rating: rating || 5,
        notes: argv.notes || null,
      }),
    })

    if (!res.ok) {
      sp?.stop("Failed")
      const err = await res.text().catch(() => `HTTP ${res.status}`)
      console.error(`  ${err.substring(0, 300)}`)
      return
    }

    const data = (await res.json()) as { listing: any; message: string }
    sp?.stop(success(data.message || (accepted ? "Accepted" : "Disputed")))

    if (argv.json) { console.log(JSON.stringify(data.listing, null, 2)); return }
    if (accepted) {
      console.log(`  ${success("★".repeat(rating || 5))} Work accepted`)
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// iris exchange cancel <id>
// ============================================================================

const ExchangeCancelCommand = cmd({
  command: "cancel <id>",
  describe: "cancel your open listing",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "listing ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) return

    const res = await hiveFetch(`/api/v6/exchange/listings/${argv.id}/cancel`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: userId }),
    })

    if (!res.ok) {
      const err = await res.text().catch(() => `HTTP ${res.status}`)
      console.error(`  ${err.substring(0, 300)}`)
      return
    }

    if (argv.json) { const data = await res.json(); console.log(JSON.stringify(data, null, 2)); return }
    console.log(success("  Listing cancelled."))
  },
})

// ============================================================================
// iris exchange mine — my posts + claims
// ============================================================================

const ExchangeMineCommand = cmd({
  command: "mine",
  aliases: ["my"],
  describe: "your posted and claimed listings",
  builder: (yargs) =>
    yargs
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  My Exchange Activity") }

    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) return

    const [postsRes, claimsRes] = await Promise.all([
      hiveFetch(`/api/v6/exchange/my-posts?user_id=${userId}`),
      hiveFetch(`/api/v6/exchange/my-claims?user_id=${userId}`),
    ])

    const posts = postsRes.ok ? ((await postsRes.json()) as any).listings || [] : []
    const claims = claimsRes.ok ? ((await claimsRes.json()) as any).listings || [] : []

    if (argv.json) {
      console.log(JSON.stringify({ posts, claims }, null, 2))
      return
    }

    if (posts.length > 0) {
      console.log()
      console.log(bold("  Posted by you"))
      console.log(dim("  " + "─".repeat(70)))
      for (const l of posts) {
        console.log(`  ${highlight(dollars(l.bounty_cents).padEnd(8))} ${statusColor((l.status || "").padEnd(10))} ${l.title?.substring(0, 40)}  ${dim(timeAgo(l.created_at))}`)
      }
    }

    if (claims.length > 0) {
      console.log()
      console.log(bold("  Claimed by you"))
      console.log(dim("  " + "─".repeat(70)))
      for (const l of claims) {
        console.log(`  ${highlight(dollars(l.bounty_cents).padEnd(8))} ${statusColor((l.status || "").padEnd(10))} ${l.title?.substring(0, 40)}  ${dim(timeAgo(l.claimed_at))}`)
      }
    }

    if (posts.length === 0 && claims.length === 0) {
      console.log(dim("  No exchange activity yet."))
    }

    console.log()
    prompts.outro("Done")
  },
})

// ============================================================================
// iris exchange reputation — view node reputation
// ============================================================================

const ExchangeReputationCommand = cmd({
  command: "reputation",
  aliases: ["rep"],
  describe: "view your node's exchange reputation",
  builder: (yargs) =>
    yargs
      .option("node", { describe: "node name or ID", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Exchange Reputation") }

    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) return

    const nodes = await fetchNodes(userId)
    let node: any

    if (argv.node) {
      node = nodes.find((n) => n.name === argv.node || n.id === argv.node)
    } else {
      node = nodes.find((n) => n.connection_status === "online") || nodes[0]
    }

    if (!node) {
      if (!argv.json) prompts.log.error("No nodes found")
      return
    }

    const res = await hiveFetch(`/api/v6/exchange/reputation/${node.id}?user_id=${userId}`)
    if (!res.ok) {
      console.error(`  HTTP ${res.status}`)
      return
    }

    const data = (await res.json()) as { node_id: string; node_name: string; reputation: any }
    const rep = data.reputation

    if (argv.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }

    console.log()
    console.log(`  ${bold("Node:")}       ${data.node_name}`)
    console.log(`  ${bold("Tier:")}       ${tierBadge(rep.tier)}`)
    console.log(`  ${bold("Completed:")}  ${rep.exchange_tasks_completed}`)
    console.log(`  ${bold("Claimed:")}    ${rep.exchange_tasks_claimed}`)
    console.log(`  ${bold("Failed:")}     ${rep.exchange_tasks_failed}`)
    if (rep.completion_rate !== null) {
      console.log(`  ${bold("Completion:")} ${Math.round(rep.completion_rate * 100)}%`)
    }
    if (rep.average_quality_score !== null) {
      const stars = Math.round(rep.average_quality_score)
      console.log(`  ${bold("Quality:")}    ${"★".repeat(stars)}${"☆".repeat(5 - stars)} (${rep.average_quality_score}/5)`)
    }
    if (rep.total_earned_cents > 0) {
      console.log(`  ${bold("Earned:")}     ${highlight(dollars(rep.total_earned_cents))}`)
    }
    console.log()
    prompts.outro("Done")
  },
})

// ============================================================================
// iris exchange (root command)
// ============================================================================

export const ExchangeCommand = cmd({
  command: "exchange",
  aliases: ["ice"],
  describe: "IRIS Exchange — distributed task marketplace",
  builder: (yargs) =>
    yargs
      .command(ExchangeListCommand)
      .command(ExchangePostCommand)
      .command(ExchangeShowCommand)
      .command(ExchangeClaimCommand)
      .command(ExchangeSubmitCommand)
      .command(ExchangeVerifyCommand)
      .command(ExchangeCancelCommand)
      .command(ExchangeMineCommand)
      .command(ExchangeReputationCommand)
      .demandCommand(1, "Specify: list, post, show, claim, submit, verify, cancel, mine, reputation"),
  async handler() {},
})
