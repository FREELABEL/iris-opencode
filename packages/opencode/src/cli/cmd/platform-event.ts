import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { irisFetch, requireAuth, requireUserId, bold, dim } from "./iris-api"

// ============================================================================
// iris event — single command that codifies the FFAT recipe (BET 2)
//
// Composes 3 existing primitives into one operation:
//   1. Create a bloq        (POST /api/v1/users/{userId}/bloqs)
//   2. Create a strategy    (POST /api/v1/bloqs/{bloqId}/outreach-strategy-templates)
//   3. Create a campaign    (POST /api/v1/som/campaigns)  — auto-expires at event_date+1d
//
// Eliminates the 90-min manual recipe documented in the FFAT SWOT analysis.
// ============================================================================

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

// ─── Strategy archetypes ─────────────────────────────────────────────────────
//
// Pre-baked 4-step IG DM strategies for common event roles. Tokens like
// {event_name}, {event_date}, {venue}, {city} get replaced at create time.
// Add new archetypes here — the create command auto-picks them up.

interface ArchetypeStep {
  title: string
  type: "instagram" | "email" | "sms" | "phone" | "linkedin"
  delay_hours: number
  instructions: string
  ai_prompt?: string
}

interface Archetype {
  label: string
  audience: string
  steps: ArchetypeStep[]
}

const ARCHETYPES: Record<string, Archetype> = {
  artist: {
    label: "Artist Outreach",
    audience: "Artists, performers, dancers, visual artists",
    steps: [
      {
        title: "Slot Invite",
        type: "instagram",
        delay_hours: 0,
        instructions: "Hey {first_name}, we're putting together {event_name} at {venue} on {event_date} — live music, dancers, visual artists, free to the public. We've still got performance windows open. Your stuff would fit. Would you be down to perform?",
        ai_prompt: "Personalize a DM to a {city}-based artist, performer, dancer, or visual artist about performing at {event_name} ({venue}) on {event_date}. Reference one specific thing from their profile (medium, recent post, style). Keep under 4 sentences. No URLs. No income claims. End with a soft question like \"Would you be down to perform?\"",
      },
      {
        title: "Quick Follow-up",
        type: "instagram",
        delay_hours: 48,
        instructions: "Just circling back on {event_name} on {event_date} at {venue}. We're locking the lineup this week — want me to send the run-of-show so you can see where you'd fit?",
      },
      {
        title: "Lineup Reveal",
        type: "instagram",
        delay_hours: 96,
        instructions: "Lineup's coming together for {event_name} — live music, performance acts, free admission. Expecting good turnout. Want a slot?",
      },
      {
        title: "Lock It In",
        type: "instagram",
        delay_hours: 168,
        instructions: "Last call before we close the lineup for {event_name} on {event_date}. If you want in, just reply yes.",
      },
    ],
  },
  vendor: {
    label: "Vendor Outreach",
    audience: "Food trucks, makers, retail, small businesses",
    steps: [
      {
        title: "Vendor Slot Invite",
        type: "instagram",
        delay_hours: 0,
        instructions: "{first_name} — we're running {event_name} at {venue} on {event_date} (free public event). Live music + performance art, expecting solid foot traffic. Looking for vendors and your spot would be a great fit. Would you want a table?",
        ai_prompt: "Personalize a vendor pitch DM to a {city} food truck, maker, retail brand, or small business. Reference their product/specialty in one line. Mention foot traffic and free admission. Soft CTA. Under 4 sentences. No URLs in step 1. No pricing in step 1.",
      },
      {
        title: "The Numbers",
        type: "instagram",
        delay_hours: 48,
        instructions: "Here's the deal — vendor slot for {event_name}, you keep 100% of your sales. Free public event, we handle the promo and crowd. Want me to hold one for you?",
      },
      {
        title: "Lock Your Spot",
        type: "instagram",
        delay_hours: 120,
        instructions: "Vendor list for {event_name} is filling up. If you want in, reply and I'll lock your slot.",
      },
      {
        title: "Final Call",
        type: "instagram",
        delay_hours: 168,
        instructions: "Closing the vendor list for {event_name} this week. LMK if you want the spot or I'll release it to the waitlist.",
      },
    ],
  },
  dj: {
    label: "DJ Outreach",
    audience: "DJs, producers, beatmakers",
    steps: [
      {
        title: "DJ Slot Invite",
        type: "instagram",
        delay_hours: 0,
        instructions: "Yo {first_name} — running {event_name} at {venue} on {event_date}. Looking for a DJ to play through the night between live music sets. Sound system on-site is solid. Would you be open?",
        ai_prompt: "Personalize a DM to a {city}-based DJ about playing at {event_name} ({venue}) on {event_date}. Reference their style/genre if visible on profile. Mention the sound system. Under 4 sentences. Casual tone. No URLs.",
      },
      {
        title: "The Setup",
        type: "instagram",
        delay_hours: 48,
        instructions: "The setup — you'd be the through-line between live band sets and performance windows at {event_name}. Free event, expecting good crowd. Pay or trade depending on your usual. Want to chat?",
      },
      {
        title: "Lock It",
        type: "instagram",
        delay_hours: 120,
        instructions: "Locking the DJ for {event_name} ({event_date}) this week — want the slot?",
      },
    ],
  },
  sponsor: {
    label: "Sponsor Outreach",
    audience: "Brands, businesses, partners with marketing budget",
    steps: [
      {
        title: "Sponsor Pitch",
        type: "instagram",
        delay_hours: 0,
        instructions: "Hey {first_name} — we're hosting {event_name} at {venue} on {event_date}. Free public event, expecting solid turnout. Looking for a couple sponsors who'd be a natural fit. Open to a quick chat about visibility options?",
        ai_prompt: "Personalize a sponsorship pitch DM to a {city}-area brand or business. Reference one specific thing about what they do. Mention {event_name} on {event_date}, free event, attendance expectation. Soft CTA. Under 4 sentences. No URLs.",
      },
      {
        title: "The Package",
        type: "instagram",
        delay_hours: 72,
        instructions: "Following up — sponsor packages for {event_name} include logo placement, on-site activation space, and social mentions. Free 15-min call this week to walk through?",
      },
      {
        title: "Final Window",
        type: "instagram",
        delay_hours: 168,
        instructions: "Closing sponsorships for {event_name} ({event_date}) this week. If you want in, reply and we'll set up the call.",
      },
    ],
  },
}

function fillTokens(text: string, tokens: Record<string, string>): string {
  return text.replace(/\{(\w+)\}/g, (_, key) => tokens[key] ?? `{${key}}`)
}

function slugify(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60)
}

function addOneDay(date: string): string {
  const d = new Date(date)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString()
}

// ─── create ──────────────────────────────────────────────────────────────────

const CreateCmd = cmd({
  command: "create",
  describe: "spin up a complete event outreach pipeline (bloq + strategy + campaign) in one shot",
  builder: (y) =>
    y.option("name", { describe: "short event name (used as campaign handle, e.g. ffat)", type: "string", demandOption: true })
     .option("label", { describe: "full event title (e.g. \"First Friday Art Trail\")", type: "string", demandOption: true })
     .option("date", { describe: "event date (ISO, e.g. 2026-06-05)", type: "string", demandOption: true })
     .option("venue", { describe: "venue name + address", type: "string", demandOption: true })
     .option("city", { describe: "city name (drives geo_tag and AI personalization)", type: "string", demandOption: true })
     .option("role", { describe: `outreach role — ${Object.keys(ARCHETYPES).join(" | ")}`, type: "string", demandOption: true, choices: Object.keys(ARCHETYPES) })
     .option("ig", { describe: "IG account that will send DMs", type: "string", demandOption: true })
     .option("user-id", { describe: "owner user id", type: "number" })
     .option("active", { describe: "activate the campaign immediately", type: "boolean", default: true }),
  async handler(args) {
    await requireAuth()
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) return

    const name = slugify(args.name as string)
    const role = args.role as string
    const archetype = ARCHETYPES[role]
    const tokens = {
      event_name: args.label as string,
      event_date: args.date as string,
      venue: args.venue as string,
      city: args.city as string,
    }

    prompts.intro(bold(`◈  Event: ${tokens.event_name} — ${role}`))

    // ── 1. Create bloq ────────────────────────────────────────────────────
    const bloqDescription = `${tokens.event_name} at ${tokens.venue} on ${tokens.event_date}. ${archetype.audience} outreach pipeline.`
    const bloqResp = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: `${tokens.event_name} — ${archetype.label}`, description: bloqDescription }),
    }, RAICHU)
    if (!bloqResp.ok) {
      prompts.log.error(`Bloq create failed: HTTP ${bloqResp.status} — ${await bloqResp.text()}`)
      return
    }
    const bloqBody = await bloqResp.json() as { data?: { id?: number; bloq?: { id: number } } }
    const bloqId = bloqBody.data?.bloq?.id ?? bloqBody.data?.id
    if (!bloqId) { prompts.log.error("Bloq create returned no id"); return }
    prompts.log.success(`bloq #${bloqId} created`)

    // ── 2. Create strategy template ───────────────────────────────────────
    const strategyName = `${archetype.label} | ${name.toUpperCase()} V1`
    const filledSteps = archetype.steps.map((s, i) => ({
      title: s.title,
      type: s.type,
      order: i,
      delay_hours: s.delay_hours,
      instructions: fillTokens(s.instructions, tokens),
      ...(s.ai_prompt ? { ai_prompt: fillTokens(s.ai_prompt, tokens) } : {}),
    }))
    const stratResp = await irisFetch(`/api/v1/bloqs/${bloqId}/outreach-strategy-templates`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: strategyName,
        description: `Auto-generated by \`iris event create\` for ${tokens.event_name}.`,
        category: "cold_outreach",
        steps: filledSteps,
      }),
    }, RAICHU)
    if (!stratResp.ok) {
      prompts.log.error(`Strategy create failed: HTTP ${stratResp.status} — ${await stratResp.text()}`)
      return
    }
    const stratBody = await stratResp.json() as { data?: { id?: number; template?: { id: number } } }
    const strategyId = stratBody.data?.id ?? stratBody.data?.template?.id
    if (!strategyId) { prompts.log.error("Strategy create returned no id"); return }
    prompts.log.success(`strategy "${strategyName}" #${strategyId} created (${filledSteps.length} steps)`)

    // ── 3. Create campaign ────────────────────────────────────────────────
    const campResp = await irisFetch(`/api/v1/som/campaigns`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        label: `${tokens.event_name} (${archetype.label})`,
        bloq_id: bloqId,
        strategy_template_id: strategyId,
        strategy_name: strategyName,
        ig_account: args.ig as string,
        active: args.active as boolean,
        ends_at: addOneDay(tokens.event_date),
        geo_tag: slugify(tokens.city),
        metadata: {
          event: {
            label: tokens.event_name,
            date: tokens.event_date,
            venue: tokens.venue,
            city: tokens.city,
            role,
          },
        },
      }),
    }, RAICHU)
    if (!campResp.ok) {
      prompts.log.error(`Campaign create failed: HTTP ${campResp.status} — ${await campResp.text()}`)
      return
    }
    const campBody = await campResp.json() as { data?: { campaign?: { id: number } } }
    const campaignId = campBody.data?.campaign?.id
    prompts.log.success(`campaign "${name}" #${campaignId} created (auto-expires ${addOneDay(tokens.event_date).slice(0, 10)})`)

    // ── Summary ───────────────────────────────────────────────────────────
    console.log("")
    console.log(bold("✓ Event pipeline ready"))
    console.log(`  ${dim("bloq:")}     #${bloqId}`)
    console.log(`  ${dim("strategy:")} #${strategyId} — ${strategyName}`)
    console.log(`  ${dim("campaign:")} #${campaignId} — ${name} ${args.active ? "(active)" : "(inactive)"}`)
    console.log("")
    console.log(bold("Next steps:"))
    console.log(`  ${dim("# Seed leads (scrape IG post commenters):")}`)
    console.log(`  npm run leadgen:freelabelnet -- mode=comments post=<URL> board=${bloqId} limit=100 enrich=1`)
    console.log("")
    console.log(`  ${dim("# Refresh local cache so consumers pick up the new campaign:")}`)
    console.log(`  npm run som:sync`)
    console.log("")
    console.log(`  ${dim("# Inspect:")}`)
    console.log(`  iris event show ${name}`)
    console.log("")
    prompts.outro("Done")
  },
})

// ─── list ────────────────────────────────────────────────────────────────────

const ListCmd = cmd({
  command: "list",
  describe: "list event campaigns (campaigns with non-null ends_at)",
  builder: (y) => y.option("json", { type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const res = await irisFetch(`/api/v1/som/campaigns`, {}, RAICHU)
    if (!res.ok) { prompts.log.error(`API ${res.status}`); return }
    const body = await res.json() as { data?: { campaigns?: any[] } }
    const events = (body.data?.campaigns ?? []).filter((c) => c.ends_at)

    if (args.json) { console.log(JSON.stringify(events, null, 2)); return }

    if (events.length === 0) { prompts.log.info("No event campaigns yet — try `iris event create`"); return }

    console.log("")
    console.log(bold(`Event Campaigns ${dim("(" + events.length + ")")}`))
    console.log("")
    for (const c of events) {
      const live = c.is_live ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m"
      const ev = c.metadata?.event
      const date = c.ends_at?.slice(0, 10) ?? "?"
      const evLabel = ev?.label ?? c.label ?? c.name
      console.log(`  ${live} ${c.name.padEnd(16)} #${String(c.id).padEnd(3)} ${evLabel.padEnd(36)} ${dim("expires " + date)}  ${ev?.role ? dim(`[${ev.role}]`) : ""}`)
    }
    console.log("")
  },
})

// ─── show ────────────────────────────────────────────────────────────────────

const ShowCmd = cmd({
  command: "show <name>",
  describe: "inspect an event pipeline (bloq + strategy + campaign + lead count)",
  builder: (y) => y.positional("name", { type: "string", demandOption: true }),
  async handler(args) {
    await requireAuth()
    const name = args.name as string
    const res = await irisFetch(`/api/v1/som/campaigns/${encodeURIComponent(name)}`, {}, RAICHU)
    if (res.status === 404) { prompts.log.error(`Not found: ${name}`); return }
    if (!res.ok) { prompts.log.error(`API ${res.status}`); return }
    const body = await res.json() as { data?: { campaign?: any } }
    const c = body.data?.campaign
    if (!c) return

    // Lead count
    let leadCount: number | string = "?"
    try {
      const lc = await irisFetch(`/api/v1/leads?bloq_id=${c.bloq_id}&per_page=1`, {}, RAICHU)
      const lb = await lc.json() as { total?: number; data?: { total?: number } }
      leadCount = lb.total ?? lb.data?.total ?? "?"
    } catch {}

    const ev = c.metadata?.event
    console.log("")
    console.log(bold(`${ev?.label ?? c.label ?? c.name}`))
    console.log(`  ${dim("status:")}    ${c.is_live ? "\x1b[32mlive\x1b[0m" : "\x1b[90mexpired\x1b[0m"}`)
    if (ev) {
      console.log(`  ${dim("date:")}      ${ev.date}`)
      console.log(`  ${dim("venue:")}     ${ev.venue}`)
      console.log(`  ${dim("city:")}      ${ev.city}`)
      console.log(`  ${dim("role:")}      ${ev.role}`)
    }
    console.log(`  ${dim("bloq:")}      #${c.bloq_id} (${leadCount} leads)`)
    console.log(`  ${dim("strategy:")}  ${c.strategy_name ?? "(none)"} ${c.strategy_template_id ? dim(`[#${c.strategy_template_id}]`) : ""}`)
    console.log(`  ${dim("ig:")}        @${c.ig_account ?? "(none)"}`)
    console.log(`  ${dim("ends:")}      ${c.ends_at ?? "(open-ended)"}`)
    console.log("")
  },
})

// ─── archetypes ──────────────────────────────────────────────────────────────

const ArchetypesCmd = cmd({
  command: "archetypes",
  describe: "list available outreach archetypes (artist | vendor | dj | sponsor)",
  builder: (y) => y,
  async handler() {
    console.log("")
    console.log(bold("Event archetypes"))
    console.log("")
    for (const [k, v] of Object.entries(ARCHETYPES)) {
      console.log(`  ${bold(k.padEnd(10))} ${v.label} — ${dim(v.audience)}`)
      console.log(`             ${dim(`${v.steps.length} steps`)}`)
    }
    console.log("")
    console.log(dim("  Tokens: {first_name} {event_name} {event_date} {venue} {city}"))
    console.log("")
  },
})

// ─── parent ──────────────────────────────────────────────────────────────────

export const PlatformEventCommand = cmd({
  command: "event",
  describe: "spin up a full event outreach pipeline in one command (bloq + strategy + campaign)",
  builder: (y) =>
    y.command(CreateCmd)
     .command(ListCmd)
     .command(ShowCmd)
     .command(ArchetypesCmd)
     .demandCommand(1),
  handler: () => {},
})
