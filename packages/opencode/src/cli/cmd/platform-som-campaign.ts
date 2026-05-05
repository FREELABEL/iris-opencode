import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, bold, dim } from "./iris-api"

// ─── iris som campaign — DB-backed registry CRUD ─────────────────────────────
//
// Phase 1B: replaces the hardcoded CAMPAIGNS map in platform-som.ts and the
// tests/e2e/som-config.js inline registry with API-backed records.

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

interface Campaign {
  id: number
  name: string
  label: string | null
  bloq_id: string
  strategy_template_id: number | null
  strategy_name: string | null
  ig_account: string | null
  tw_account: string | null
  active: boolean
  starts_at: string | null
  ends_at: string | null
  geo_tag: string | null
  parent_campaign_id: number | null
  color: string | null
  metadata: Record<string, unknown> | null
  is_live: boolean
}

function fmtRow(c: Campaign): string {
  const live = c.is_live ? "\x1b[32m●\x1b[0m" : c.active ? "\x1b[33m○\x1b[0m" : "\x1b[90m○\x1b[0m"
  const ends = c.ends_at ? `, ends ${c.ends_at.slice(0, 10)}` : ""
  const geo = c.geo_tag ? ` [${c.geo_tag}]` : ""
  const ig = c.ig_account ? `@${c.ig_account}` : "(no IG)"
  return `  ${live} ${c.name.padEnd(16)} #${c.id.toString().padEnd(3)} board=${(c.bloq_id ?? "?").toString().padEnd(4)} ${ig.padEnd(24)} ${(c.strategy_name ?? "(no strategy)").padEnd(40)}${geo}${ends}`
}

// ── list ──────────────────────────────────────────────────────────────────────
const ListCmd = cmd({
  command: "list",
  describe: "list SOM campaigns from the registry",
  builder: (y) =>
    y.option("active", { describe: "only active=true campaigns", type: "boolean" })
     .option("live", { describe: "only campaigns within their time window", type: "boolean" })
     .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const params = new URLSearchParams()
    if (args.active) params.set("active", "1")
    if (args.live) params.set("live", "1")
    const qs = params.toString() ? `?${params.toString()}` : ""

    const res = await irisFetch(`/api/v1/som/campaigns${qs}`, {}, RAICHU)
    if (!res.ok) { prompts.log.error(`API ${res.status}`); return }
    const body = await res.json() as { data?: { campaigns?: Campaign[] } }
    const list = body.data?.campaigns ?? []

    if (args.json) { console.log(JSON.stringify(list, null, 2)); return }

    console.log("")
    console.log(bold(`SOM Campaigns ${dim("(" + list.length + ")")}`))
    console.log(dim("  ●=live ○=active-but-out-of-window ○=inactive"))
    console.log("")
    for (const c of list) console.log(fmtRow(c))
    console.log("")
  },
})

// ── show ──────────────────────────────────────────────────────────────────────
const ShowCmd = cmd({
  command: "show <id-or-name>",
  describe: "show a single campaign",
  builder: (y) => y.positional("id-or-name", { type: "string", demandOption: true }),
  async handler(args) {
    await requireAuth()
    const ref = args["id-or-name"] as string
    const res = await irisFetch(`/api/v1/som/campaigns/${encodeURIComponent(ref)}`, {}, RAICHU)
    if (res.status === 404) { prompts.log.error(`Not found: ${ref}`); return }
    if (!res.ok) { prompts.log.error(`API ${res.status}`); return }
    const body = await res.json() as { data?: { campaign?: Campaign } }
    const c = body.data?.campaign
    if (!c) { prompts.log.error("Empty response"); return }

    console.log("")
    console.log(bold(`#${c.id} ${c.name}`) + (c.label ? dim(` — ${c.label}`) : ""))
    console.log(`  status:    ${c.is_live ? "\x1b[32mlive\x1b[0m" : c.active ? "\x1b[33mactive (out of window)\x1b[0m" : "\x1b[90minactive\x1b[0m"}`)
    console.log(`  bloq:      ${c.bloq_id}`)
    console.log(`  strategy:  ${c.strategy_name ?? "(none)"} ${c.strategy_template_id ? dim(`[#${c.strategy_template_id}]`) : dim("[unresolved]")}`)
    console.log(`  ig:        ${c.ig_account ?? "(none)"}`)
    console.log(`  tw:        ${c.tw_account ?? "(none)"}`)
    if (c.starts_at) console.log(`  starts:    ${c.starts_at}`)
    if (c.ends_at)   console.log(`  ends:      ${c.ends_at}`)
    if (c.geo_tag)   console.log(`  geo:       ${c.geo_tag}`)
    if (c.parent_campaign_id) console.log(`  parent:    #${c.parent_campaign_id}`)
    console.log("")
  },
})

// ── create ────────────────────────────────────────────────────────────────────
const CreateCmd = cmd({
  command: "create",
  describe: "create a new campaign",
  builder: (y) =>
    y.option("name", { describe: "unique handle (e.g. ffat, freelabelnet)", type: "string", demandOption: true })
     .option("bloq", { alias: "board", describe: "bloq id (lead pool)", type: "number", demandOption: true })
     .option("strategy", { describe: "strategy template name (e.g. \"Artist Outreach | FFAT V1\")", type: "string" })
     .option("strategy-id", { describe: "strategy template id (alternative to --strategy)", type: "number" })
     .option("ig", { describe: "IG account", type: "string" })
     .option("tw", { describe: "Twitter/X account", type: "string" })
     .option("label", { describe: "human label", type: "string" })
     .option("active", { describe: "active flag", type: "boolean", default: false })
     .option("starts", { describe: "starts_at (ISO date)", type: "string" })
     .option("ends", { describe: "ends_at (ISO date) — auto-disables after", type: "string" })
     .option("geo", { describe: "geo tag (e.g. austin)", type: "string" })
     .option("color", { describe: "terminal color code", type: "string" })
     .option("parent", { describe: "parent campaign id (for overlays)", type: "number" }),
  async handler(args) {
    await requireAuth()
    const body: Record<string, unknown> = {
      name: args.name,
      bloq_id: args.bloq,
      ig_account: args.ig ?? null,
      tw_account: args.tw ?? null,
      label: args.label ?? null,
      active: args.active,
      starts_at: args.starts ?? null,
      ends_at: args.ends ?? null,
      geo_tag: args.geo ?? null,
      color: args.color ?? null,
      parent_campaign_id: args.parent ?? null,
    }
    if (args["strategy-id"]) body.strategy_template_id = args["strategy-id"]
    if (args.strategy) body.strategy_name = args.strategy

    const res = await irisFetch(`/api/v1/som/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, RAICHU)

    if (!res.ok) { prompts.log.error(`API ${res.status}: ${await res.text()}`); return }
    const data = await res.json() as { data?: { campaign?: Campaign } }
    const c = data.data?.campaign
    if (!c) { prompts.log.error("Empty response"); return }
    prompts.log.success(`Created #${c.id} ${c.name}`)
    if (!c.strategy_template_id && c.strategy_name) {
      prompts.log.warn(`Strategy "${c.strategy_name}" not yet resolved on bloq ${c.bloq_id} — create the template, then update this campaign.`)
    }
  },
})

// ── update ────────────────────────────────────────────────────────────────────
const UpdateCmd = cmd({
  command: "update <id-or-name>",
  describe: "update a campaign (toggle active, change dates, swap strategy, etc)",
  builder: (y) =>
    y.positional("id-or-name", { type: "string", demandOption: true })
     .option("active", { type: "boolean" })
     .option("strategy", { type: "string", describe: "swap strategy by name" })
     .option("strategy-id", { type: "number" })
     .option("ig", { type: "string" })
     .option("label", { type: "string" })
     .option("starts", { type: "string" })
     .option("ends", { type: "string" })
     .option("geo", { type: "string" }),
  async handler(args) {
    await requireAuth()
    const ref = args["id-or-name"] as string
    const body: Record<string, unknown> = {}
    if (args.active !== undefined) body.active = args.active
    if (args.strategy !== undefined) body.strategy_name = args.strategy
    if (args["strategy-id"] !== undefined) body.strategy_template_id = args["strategy-id"]
    if (args.ig !== undefined) body.ig_account = args.ig
    if (args.label !== undefined) body.label = args.label
    if (args.starts !== undefined) body.starts_at = args.starts
    if (args.ends !== undefined) body.ends_at = args.ends
    if (args.geo !== undefined) body.geo_tag = args.geo

    if (Object.keys(body).length === 0) { prompts.log.warn("Nothing to update — provide at least one flag"); return }

    const res = await irisFetch(`/api/v1/som/campaigns/${encodeURIComponent(ref)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }, RAICHU)
    if (!res.ok) { prompts.log.error(`API ${res.status}: ${await res.text()}`); return }
    const data = await res.json() as { data?: { campaign?: Campaign } }
    const c = data.data?.campaign
    prompts.log.success(`Updated ${c?.name} (live=${c?.is_live})`)
  },
})

// ── expire ────────────────────────────────────────────────────────────────────
const ExpireCmd = cmd({
  command: "expire <id-or-name>",
  describe: "set ends_at = now (immediately removes from live set)",
  builder: (y) => y.positional("id-or-name", { type: "string", demandOption: true }),
  async handler(args) {
    await requireAuth()
    const ref = args["id-or-name"] as string
    const res = await irisFetch(`/api/v1/som/campaigns/${encodeURIComponent(ref)}/expire`, { method: "POST" }, RAICHU)
    if (!res.ok) { prompts.log.error(`API ${res.status}`); return }
    const data = await res.json() as { data?: { campaign?: Campaign } }
    prompts.log.success(`Expired ${data.data?.campaign?.name}`)
  },
})

// ── delete ────────────────────────────────────────────────────────────────────
const DeleteCmd = cmd({
  command: "delete <id-or-name>",
  aliases: ["rm"],
  describe: "delete a campaign permanently",
  builder: (y) => y.positional("id-or-name", { type: "string", demandOption: true }).option("yes", { type: "boolean", describe: "skip confirmation" }),
  async handler(args) {
    await requireAuth()
    const ref = args["id-or-name"] as string
    if (!args.yes) {
      const ok = await prompts.confirm({ message: `Delete campaign ${ref}? This cannot be undone.` })
      if (!ok || prompts.isCancel(ok)) { prompts.log.info("Cancelled"); return }
    }
    const res = await irisFetch(`/api/v1/som/campaigns/${encodeURIComponent(ref)}`, { method: "DELETE" }, RAICHU)
    if (!res.ok) { prompts.log.error(`API ${res.status}`); return }
    prompts.log.success(`Deleted ${ref}`)
  },
})

// ── parent: iris som campaign ─────────────────────────────────────────────────
export const SomCampaignCommand = cmd({
  command: "campaign",
  describe: "manage SOM campaigns (DB-backed registry)",
  builder: (y) =>
    y.command(ListCmd)
     .command(ShowCmd)
     .command(CreateCmd)
     .command(UpdateCmd)
     .command(ExpireCmd)
     .command(DeleteCmd)
     .demandCommand(1),
  handler: () => {},
})
