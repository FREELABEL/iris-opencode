import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// Customer onboarding pipeline — one command to create bloq + agent + heartbeat + page

async function fetchLead(leadId: string): Promise<any> {
  const res = await irisFetch(`/api/v1/leads/${leadId}`)
  if (!res.ok) return null
  const data = (await res.json()) as any
  return data?.data ?? data?.lead ?? data
}

async function fetchLeads(status: string): Promise<any[]> {
  const res = await irisFetch(`/api/v1/leads?status=${status}&limit=100`)
  if (!res.ok) return []
  const data = (await res.json()) as any
  return data?.data ?? data?.leads ?? []
}

async function addLeadNote(leadId: string | number, content: string): Promise<void> {
  await irisFetch(`/api/v1/leads/${leadId}/notes`, {
    method: "POST",
    body: JSON.stringify({ content }),
  })
}

// ── SETUP ─────────────────────────────────────────────────────
const CustomerSetupCommand = cmd({
  command: "setup <lead-id>",
  describe: "onboard a customer — create bloq, agent, heartbeat, and page",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { type: "string", demandOption: true, describe: "lead ID to onboard" })
      .option("agent-name", { type: "string", describe: "custom agent name" })
      .option("briefing-time", { type: "string", default: "08:00", describe: "daily digest time (HH:MM)" })
      .option("model", { type: "string", default: "gpt-4.1-nano", describe: "AI model for agent" })
      .option("skip-page", { type: "boolean", default: false, describe: "skip Genesis page creation" })
      .option("skip-heartbeat", { type: "boolean", default: false, describe: "skip daily digest setup" })
      .option("dry-run", { type: "boolean", default: false, describe: "preview without creating anything" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return
    UI.empty()

    const leadId = (args.leadId ?? args["lead-id"]) as string
    prompts.intro(`◈  Customer Setup — Lead #${leadId}`)

    // 1. Fetch lead
    const spinner = prompts.spinner()
    spinner.start("Fetching lead...")
    const lead = await fetchLead(leadId)
    if (!lead) {
      spinner.stop("Lead not found", 1)
      prompts.outro("Done")
      return
    }
    const company = lead.company || lead.name || `Lead #${leadId}`
    spinner.stop(`${success("✓")} ${bold(company)} — ${lead.email || "no email"}`)

    if (lead.phone) printKV("Phone", lead.phone)
    if (lead.status) printKV("Status", lead.status)
    if (lead.price) printKV("MRR", `$${lead.price}`)
    console.log()

    const dryRun = args.dryRun || args["dry-run"]

    // 2. Create or find bloq
    let bloqId = lead.bloq_id
    if (bloqId) {
      printKV("Bloq", `#${bloqId} (existing)`)
    } else {
      const bloqName = `${company} Workspace`
      if (dryRun) {
        printKV("Bloq", `${dim("[DRY RUN]")} Would create: ${bloqName}`)
      } else {
        spinner.start(`Creating bloq "${bloqName}"...`)
        const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
          method: "POST",
          body: JSON.stringify({ name: bloqName, description: `Workspace for ${company}` }),
        })
        if (!res.ok) {
          spinner.stop("Failed to create bloq", 1)
          prompts.outro("Done")
          return
        }
        const bloqData = (await res.json()) as any
        bloqId = bloqData?.data?.bloq?.id ?? bloqData?.data?.id ?? bloqData?.id
        spinner.stop(`${success("✓")} Bloq #${bloqId} created`)
      }
    }

    // 3. Create agent
    const agentName = args.agentName ?? args["agent-name"] ?? `${company} Assistant`
    const model = args.model as string
    let agentId: number | null = null

    if (dryRun) {
      printKV("Agent", `${dim("[DRY RUN]")} Would create: ${agentName} (${model})`)
    } else {
      spinner.start(`Creating agent "${agentName}"...`)
      const systemPrompt = `You are a digital employee for ${company}. You monitor their business daily and provide actionable insights. You have access to their knowledge base, leads, and integrations. Always be concise, professional, and action-oriented.`
      const initialPrompt = `Review the knowledge base for ${company}. Check for any new leads, pending tasks, or items that need attention. Provide a brief daily digest with:\n1. Key updates since yesterday\n2. Action items for today\n3. Deadlines approaching this week\n4. Any items that need the owner's attention`

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents`, {
        method: "POST",
        body: JSON.stringify({
          name: agentName,
          type: "assistant",
          description: `Digital assistant for ${company}`,
          prompt: systemPrompt,
          initial_prompt: initialPrompt,
          config: { model, provider: "openai", temperature: 0.1 },
          bloq_id: bloqId,
          heartbeat_mode: "autonomous",
          settings: {
            system_prompt: systemPrompt,
            heartbeat_tools: ["manageLeads", "agent_memory", "searchKnowledgeBase", "sendEmail"],
            nurture_mode: true,
          },
        }),
      })
      if (!res.ok) {
        const err = await res.text().catch(() => "")
        spinner.stop(`Failed to create agent: ${err}`, 1)
      } else {
        const agentData = (await res.json()) as any
        const a = agentData?.data ?? agentData
        agentId = a?.id
        spinner.stop(`${success("✓")} Agent #${agentId} — ${bold(agentName)}`)
      }
    }

    // 3b. Enable nurture on the lead
    if (!dryRun && lead.email) {
      await irisFetch(`/api/v1/leads/${leadId}`, {
        method: "PUT",
        body: JSON.stringify({
          contact_info: {
            ...(lead.contact_info || {}),
            nurture_heartbeat_enabled: true,
            nurture_email: lead.email,
          },
        }),
      })
      printKV("Nurture", `${success("✓")} enabled → ${lead.email}`)
    }

    // 4. Enable heartbeat (daily briefing)
    const skipHeartbeat = args.skipHeartbeat || args["skip-heartbeat"]
    const briefingTime = (args.briefingTime ?? args["briefing-time"] ?? "08:00") as string

    if (skipHeartbeat) {
      printKV("Heartbeat", dim("skipped"))
    } else if (dryRun) {
      printKV("Heartbeat", `${dim("[DRY RUN]")} Would create: daily at ${briefingTime}`)
    } else if (agentId) {
      spinner.start("Enabling daily heartbeat...")
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs`, {
        method: "POST",
        body: JSON.stringify({
          agent_id: agentId,
          task_name: `${company} Daily Digest`,
          prompt: `Run daily briefing for ${company}. Check knowledge base, recent leads, pending tasks. Produce a concise digest.`,
          time: briefingTime,
          frequency: "daily",
          timezone: "America/Chicago",
          data: {
            type: "heartbeat",
            agent_id: agentId,
            bloq_id: bloqId,
          },
        }),
      })
      if (!res.ok) {
        spinner.stop("Failed to create heartbeat schedule", 1)
      } else {
        const jobData = (await res.json()) as any
        const job = jobData?.data ?? jobData
        spinner.stop(`${success("✓")} Heartbeat #${job?.id ?? "?"} — daily at ${briefingTime}`)
      }
    } else {
      printKV("Heartbeat", dim("skipped (no agent created)"))
    }

    // 5. Log note on lead
    if (!dryRun) {
      const note = `## Customer Onboarding (${new Date().toISOString().split("T")[0]})
- Bloq: #${bloqId ?? "existing"}
- Agent: #${agentId ?? "skipped"} (${agentName})
- Model: ${model}
- Heartbeat: ${skipHeartbeat ? "skipped" : `daily at ${briefingTime}`}
- Setup by: iris customer setup ${leadId}`
      await addLeadNote(leadId, note)
      printKV("Note", dim("logged on lead"))
    }

    // 6. Summary + next steps
    console.log()
    printDivider()
    console.log(`  ${bold("Next steps for " + company)}:`)
    console.log(`  ${dim("1.")} Send OAuth links to ${lead.email || "customer"} for Gmail, Calendar, Drive`)
    console.log(`  ${dim("2.")} Customer connects integrations at ${highlight("app.heyiris.io")}`)
    console.log(`  ${dim("3.")} Heartbeat will auto-run daily and produce digest`)
    console.log(`  ${dim("4.")} Enable email delivery so customer gets digest in inbox`)
    if (!args.skipPage && !args["skip-page"]) {
      console.log(`  ${dim("5.")} Create Genesis page: ${dim(`iris pages compose --bloq=${bloqId}`)}`)
    }
    console.log()

    if (args.json) {
      console.log(JSON.stringify({ lead_id: leadId, bloq_id: bloqId, agent_id: agentId, model, briefing_time: briefingTime }, null, 2))
    }

    prompts.outro(`${success("✓")} ${company} onboarded`)
  },
})

// ── STATUS ────────────────────────────────────────────────────
const CustomerStatusCommand = cmd({
  command: "status [lead-id]",
  describe: "show onboarding checklist for a customer (or --all for everyone)",
  builder: (yargs) =>
    yargs
      .positional("lead-id", { type: "string", describe: "specific lead ID" })
      .option("all", { type: "boolean", default: false, describe: "show all active/won leads" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()

    const leadId = args.leadId ?? args["lead-id"]
    const showAll = args.all

    if (!leadId && !showAll) {
      prompts.intro("◈  Customer Status")
      prompts.log.error("Provide a lead ID or use --all")
      prompts.outro(`${dim("iris customer status 110")}  or  ${dim("iris customer status --all")}`)
      return
    }

    if (showAll) {
      prompts.intro("◈  Customer Onboarding — All Active Leads")

      // Fetch active + won leads
      const [active, won] = await Promise.all([fetchLeads("Active"), fetchLeads("Won")])
      const leads = [...active, ...won].filter((l) => l.price && parseFloat(l.price) > 0)

      if (leads.length === 0) {
        prompts.log.info("No active/won leads with MRR found")
        prompts.outro("Done")
        return
      }

      if (args.json) {
        console.log(JSON.stringify(leads, null, 2))
        prompts.outro("Done")
        return
      }

      // Sort by price descending
      leads.sort((a, b) => (parseFloat(b.price) || 0) - (parseFloat(a.price) || 0))

      let totalMRR = 0
      let totalSteps = 0

      printDivider()
      for (const lead of leads) {
        const checks = getChecklist(lead)
        const done = checks.filter((c) => c.ok).length
        const bar = checks.map((c) => (c.ok ? success("✓") : dim("✗"))).join("")
        const mrr = parseFloat(lead.price) || 0
        totalMRR += mrr
        totalSteps += done
        const name = (lead.company || lead.name || `#${lead.id}`).padEnd(20).slice(0, 20)
        console.log(`  ${bar}  ${bold(name)} $${mrr}/mo  ${done}/8`)
      }
      printDivider()

      const avg = leads.length > 0 ? (totalSteps / leads.length).toFixed(1) : "0"
      const delivering = leads.filter((l) => getChecklist(l).filter((c) => c.ok).length >= 6).length
      console.log(`  ${dim(`Total MRR at risk: $${totalMRR.toFixed(0)}`)}`)
      console.log(`  ${dim(`Average onboarding: ${avg}/8 steps`)}`)
      console.log(`  ${delivering > 0 ? success(`${delivering}`) : dim("0")} of ${leads.length} customers receiving daily value`)
      prompts.outro("Done")
      return
    }

    // Single lead status
    prompts.intro(`◈  Customer Status — Lead #${leadId}`)

    const lead = await fetchLead(leadId as string)
    if (!lead) {
      prompts.log.error("Lead not found")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify({ lead, checklist: getChecklist(lead) }, null, 2))
      prompts.outro("Done")
      return
    }

    const company = lead.company || lead.name || `Lead #${leadId}`
    printKV("Customer", bold(company))
    if (lead.email) printKV("Email", lead.email)
    if (lead.price) printKV("MRR", `$${lead.price}`)
    printDivider()

    const checks = getChecklist(lead)
    for (const c of checks) {
      const icon = c.ok ? success("✓") : "✗"
      const detail = c.detail ? `  ${dim(c.detail)}` : ""
      console.log(`  ${icon} ${c.label}${detail}`)
    }

    const done = checks.filter((c) => c.ok).length
    printDivider()
    console.log(`  Onboarding: ${done}/8 complete`)

    if (done < 8) {
      console.log()
      console.log(`  ${bold("Next steps:")}`)
      const missing = checks.filter((c) => !c.ok)
      missing.forEach((c, i) => {
        console.log(`  ${dim(`${i + 1}.`)} ${c.fix}`)
      })
    }

    prompts.outro("Done")
  },
})

interface CheckItem {
  label: string
  ok: boolean
  detail?: string
  fix: string
}

function getChecklist(lead: any): CheckItem[] {
  const hasBloq = !!lead.bloq_id
  const hasAgent = !!(lead.outreach_agent || lead.agent_id || lead.agent_assignments?.length)
  // These require deeper API calls — approximate from lead data
  const hasHeartbeat = !!(lead.heartbeat_mode || lead.has_heartbeat)
  const hasPage = !!(lead.page_url || lead.pages?.length)
  const hasGmail = !!(lead.integrations?.gmail || lead.gmail_connected)
  const hasCalendar = !!(lead.integrations?.calendar || lead.calendar_connected)
  const hasDrive = !!(lead.integrations?.drive || lead.drive_connected)
  const hasEmailDelivery = !!(lead.email_delivery_enabled)

  return [
    { label: "Bloq workspace", ok: hasBloq, detail: hasBloq ? `#${lead.bloq_id}` : undefined, fix: `iris customer setup ${lead.id}` },
    { label: "AI agent", ok: hasAgent, detail: hasAgent ? `assigned` : undefined, fix: `iris customer setup ${lead.id}` },
    { label: "Heartbeat enabled", ok: hasHeartbeat, fix: `iris schedules create --type heartbeat --agent <id> --frequency daily` },
    { label: "Genesis page", ok: hasPage, fix: `iris pages compose --bloq=${lead.bloq_id || "<id>"}` },
    { label: "Gmail connected", ok: hasGmail, fix: `Send OAuth link to ${lead.email || "customer"}` },
    { label: "Calendar connected", ok: hasCalendar, fix: `Send OAuth link to ${lead.email || "customer"}` },
    { label: "Drive connected", ok: hasDrive, fix: `Send OAuth link to ${lead.email || "customer"}` },
    { label: "Daily email delivery", ok: hasEmailDelivery, fix: "Enable email delivery in HeartbeatExecutorService" },
  ]
}

// ── ROOT ──────────────────────────────────────────────────────
export const PlatformCustomerCommand = cmd({
  command: "customer",
  aliases: ["onboard"],
  describe: "customer onboarding — setup, status, and delivery tracking",
  builder: (yargs) =>
    yargs
      .command(CustomerSetupCommand)
      .command(CustomerStatusCommand)
      .demandCommand(),
  async handler() {},
})
