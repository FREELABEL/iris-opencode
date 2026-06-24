import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, printKV, dim, bold, success, IRIS_API } from "./iris-api"

async function callPathways(userId: number, func: string, params: Record<string, unknown> = {}): Promise<any> {
  const res = await irisFetch(`/api/v1/users/${userId}/integrations/execute-direct`, {
    method: "POST",
    body: JSON.stringify({ integration: "pathways", action: func, params }),
  }, IRIS_API)
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error((err as any).message || `Pathways ${func} failed (${res.status})`)
  }
  return res.json()
}

const PathwaysAuditCommand = cmd({
  command: "audit",
  describe: "run financial audit on all cases — shows flagged cases needing attention",
  builder: (yargs) =>
    yargs
      .option("stage", { type: "string", describe: "only audit cases in this stage" })
      .option("email", { type: "boolean", describe: "generate and display audit email" })
      .option("to", { type: "string", describe: "email recipient (default: rbaker@vanguardhcs.com)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("Pathways Audit") }
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return
    const spinner = prompts.spinner()
    try {
      const func = args.email ? "generate_audit_email" : "audit_all_cases"
      const params: Record<string, unknown> = {}
      if (args.stage) params.stage_filter = args.stage
      spinner.start("Auditing cases...")
      const data = await callPathways(userId, func, params)
      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }
      if (args.email) {
        if (!data.send) {
          spinner.stop(success(data.message || "All cases clean"))
        } else {
          spinner.stop(success(`${data.flagged_count} case(s) flagged`))
          console.log()
          console.log(bold(`  Subject: ${data.subject}`))
          console.log(dim(`  To: ${args.to || "rbaker@vanguardhcs.com"}`))
          console.log()
          console.log(data.text_body)
        }
      } else {
        spinner.stop(success(`${data.total_cases} cases audited`))
        console.log()
        printKV("Clean", `${data.clean_count} cases`)
        printKV("Flagged", `${data.flagged_count} cases`)
        if (data.flag_breakdown && Object.keys(data.flag_breakdown).length > 0) {
          console.log()
          console.log(bold("  Flag breakdown:"))
          for (const [type, count] of Object.entries(data.flag_breakdown)) {
            console.log(`  ${dim("+")} ${type.replace(/_/g, " ")}: ${count}`)
          }
        }
        if (data.flagged_cases?.length > 0) {
          console.log()
          console.log(bold("  Cases needing attention:"))
          for (const fc of data.flagged_cases) {
            const name = fc.patient_name || fc.case_id || "?"
            const flags = (fc.flags || []).map((f: any) => f.message).join(", ")
            console.log(`  ${dim("+")} ${name}: ${flags}`)
          }
        }
      }
      console.log()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PathwaysSettleCommand = cmd({
  command: "settle [case-id]",
  describe: "calculate settlement distribution — single case or batch",
  builder: (yargs) =>
    yargs
      .positional("case-id", { type: "string", describe: "case ID (omit for --batch mode)" })
      .option("check", { type: "number", describe: "check amount in dollars" })
      .option("batch", { type: "boolean", describe: "process all cases in target stage" })
      .option("stage", { type: "string", default: "Awaiting Payment", describe: "stage filter for batch mode" })
      .option("export", { type: "boolean", describe: "save combined IIF export file" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("Pathways Settlement") }
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return
    const spinner = prompts.spinner()
    try {
      if (args.batch) {
        spinner.start(`Processing cases in "${args.stage}"...`)
        const data = await callPathways(userId, "batch_settle", { stage_filter: args.stage })
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return }
        spinner.stop(success(`${data.processed_count} cases settled (${data.skipped_count} skipped)`))
        for (const r of (data.results || [])) {
          console.log()
          console.log(bold(`  ${r.patient_name || r.case_id}`))
          console.log(`  Check: $${r.check_amount?.toLocaleString()} | Billed: $${r.total_billed?.toLocaleString()} | Reduction: ${r.reduction_percentage}%`)
          for (const p of (r.providers || [])) {
            console.log(`    ${dim("+")} ${p.name}: $${p.settlement?.toLocaleString()} (${p.percentage}%)`)
          }
        }
        if (args.export && data.combined_iif) {
          const outPath = `pathways-batch-settle-${Date.now()}.iif`
          require("fs").writeFileSync(outPath, data.combined_iif)
          console.log()
          console.log(success(`  IIF export saved: ${outPath}`))
        }
      } else {
        if (!args["case-id"]) { prompts.log.error("Provide a case ID or use --batch"); prompts.outro("Done"); return }
        if (!args.check) { prompts.log.error("--check <amount> is required"); prompts.outro("Done"); return }
        spinner.start(`Calculating settlement for ${args["case-id"]}...`)
        const data = await callPathways(userId, "calculate_settlement", { case_id: args["case-id"], check_amount: args.check })
        if (args.json) { console.log(JSON.stringify(data, null, 2)); return }
        spinner.stop(success(`Settlement: ${data.reduction_percentage}% reduction`))
        console.log()
        printKV("Patient", data.patient_name || data.case_id)
        printKV("Check", `$${data.check_amount?.toLocaleString()}`)
        printKV("Total Billed", `$${data.total_billed?.toLocaleString()}`)
        printKV("Reduction", `${data.reduction_percentage}%`)
        console.log()
        for (const p of (data.providers || [])) {
          console.log(`  ${dim("+")} ${p.name}: $${p.settlement?.toLocaleString()} (billed $${p.billed?.toLocaleString()}, ${p.percentage}%)`)
        }
      }
      console.log()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PathwaysPipelineCommand = cmd({
  command: "pipeline",
  describe: "show case pipeline summary grouped by stage",
  builder: (yargs) =>
    yargs
      .option("stage", { type: "string", describe: "filter to specific stage" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("Pathways Pipeline") }
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return
    const spinner = prompts.spinner()
    try {
      const params: Record<string, unknown> = {}
      if (args.stage) params.stage_filter = args.stage
      spinner.start("Fetching pipeline...")
      const data = await callPathways(userId, "get_pipeline_summary", params)
      if (args.json) { console.log(JSON.stringify(data, null, 2)); return }
      spinner.stop(success(`${data.total_cases || 0} cases | $${(data.total_value || 0).toLocaleString()}`))
      console.log()
      for (const stage of (data.stages || [])) {
        console.log(`  ${bold(stage.name)}: ${stage.count} cases — $${(stage.value || 0).toLocaleString()}`)
      }
      console.log()
      prompts.outro("Done")
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PathwaysStatusCommand = cmd({
  command: "status",
  describe: "show Pathways integration health and available functions",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("Pathways Status") }
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return
    try {
      const data = await callPathways(userId, "get_pipeline_summary", {})
      if (args.json) { console.log(JSON.stringify({ connected: true, ...data }, null, 2)); return }
      console.log(success("  Connected"))
      printKV("Cases", `${data.total_cases || 0}`)
      printKV("Pipeline Value", `$${(data.total_value || 0).toLocaleString()}`)
      printKV("Functions", "17 available")
      console.log()
      console.log(dim("  iris integrations pathways audit"))
      console.log(dim("  iris integrations pathways settle <case-id> --check <amount>"))
      console.log(dim("  iris integrations pathways settle --batch"))
      console.log(dim("  iris integrations pathways pipeline"))
      console.log()
      prompts.outro("Done")
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// The Pathways agent tool surface (prefixed integration names) that a new tenant's agent
// must allowlist to reach the records + accounting tools. Keep in sync with pathways.yml.
const PATHWAYS_AGENT_TOOLS = [
  "Pathways_get_firm_directory",
  "Pathways_get_records_cadence",
  "Pathways_get_records_validation",
  "Pathways_get_ron_approval_queue",
  "Pathways_get_records_delivery",
  "Pathways_get_provider_balance_ledger",
  "Pathways_get_reduction_evidence",
  "Pathways_get_settlement_allocation",
  "Pathways_get_provider_payouts",
  "Pathways_get_smartpay_deposits",
  "Pathways_get_reconciliation_audit",
]

const PathwaysOnboardCommand = cmd({
  command: "onboard <client>",
  describe: "Plan onboarding a NEW Pathways tenant — emits the executable runbook (clone spokes · wire agent+integration · vertical-template mapping · storage)",
  builder: (y) =>
    y
      .positional("client", { describe: "new client slug prefix, e.g. 'acme-legal'", type: "string", demandOption: true })
      .option("brand", { describe: "brand slug whose identity to apply to the cloned spokes", type: "string", demandOption: true })
      .option("template", { describe: "template tenant to inherit panels/tools from", type: "string", default: "pathways-dashboard" })
      .option("agent", { describe: "the client's agent id to enable the Pathways integration on", type: "number" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pathways onboard — ${bold(String(args.client))}  ${dim(`(template: ${args.template}, brand: ${args.brand})`)}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const client = String(args.client).replace(/-dashboard$/, "")
    const dash = `${client}-dashboard`
    const records = `${client}-records`
    const acct = `${client}-accounting`
    const template = String(args.template)
    const recordsTpl = template.replace(/-dashboard$/, "-records")
    const acctTpl = template.replace(/-dashboard$/, "-accounting")
    const brand = String(args.brand)
    const agent = args.agent ? `${args.agent}` : "<AGENT_ID>"

    prompts.log.info("This emits the runbook to instantiate a new tenant from the Pathways vertical.")
    prompts.log.info("Each step reuses an already-verified primitive. Run them in order.\n")

    const steps = [
      ["1. Bloq — create the client's data owner bloq (note the new id → use as owner)",
        `iris bloqs create "${client} — Case Management"`],
      ["2. Spokes — clone the 3 Genesis spokes with the client's brand (PII-gated rebrand)",
        `iris pages rebrand ${template}  --as ${dash}    --brand ${brand} --publish\n` +
        `       iris pages rebrand ${recordsTpl} --as ${records} --brand ${brand} --publish\n` +
        `       iris pages rebrand ${acctTpl}    --as ${acct}    --brand ${brand} --publish`],
      ["3. Mapping — inherit all Pathways panels via ONE config line, then deploy fl-iris-api",
        `# config/tenant-settings.php → 'vertical_templates' => [ '${dash}' => '${template}' ]\n` +
        `       git commit + push fl-iris-api (config:cache rebuilds on deploy)`],
      ["4. Agent — enable the Pathways integration + allowlist the 11 tools on the client's agent",
        `iris agents update ${agent} --enable-integration pathways \\\n` +
        `         --add-tools ${PATHWAYS_AGENT_TOOLS.join(",")}`],
      ["5. Storage — bind a PRIVATE per-tenant bucket for PHI packages (capability #150146)",
        `# set PATHWAYS_RECORDS_DISK + a per-tenant R2_PRIVATE_BUCKET on fl-iris-api\n` +
        `       railway ssh -s fl-iris-api -- php artisan pathways:records-storage-check`],
      ["6. Data — connect the client's Servis/FA source + seed their Atlas cases (scoped to their bloq)",
        `# wire the client's data source; the builders read the 'cases' schema scoped to the owner bloq`],
    ]

    for (const [title, cmds] of steps) {
      console.log(`  ${bold(title)}`)
      console.log(`       ${dim(cmds)}\n`)
    }

    prompts.log.success(`Verify: load /p/${dash} under a staff OTP session → all panels populate from the client's data; ` +
      `send their agent "which records packages are going quiet?" → answers from the tools.`)
    prompts.log.warn("Steps 1/5/6 create prod resources / touch infra — run deliberately. Steps 2/4 are reversible " +
      "(unpublish / --remove-tools). This planner does not auto-execute; full auto-provisioning is the next increment.")
    printKV("New slugs", `${dash} · ${records} · ${acct}`)
    prompts.outro(dim(`Capability: #503 (vertical templates) · #150146 (per-tenant storage)`))
  },
})

export const PathwaysCommand = cmd({
  command: "pathways",
  aliases: ["pw"],
  describe: "Pathways AI — settlement calc, audit, pipeline, batch processing, tenant onboarding",
  builder: (yargs) =>
    yargs
      .command(PathwaysAuditCommand)
      .command(PathwaysSettleCommand)
      .command(PathwaysPipelineCommand)
      .command(PathwaysStatusCommand)
      .command(PathwaysOnboardCommand)
      .demandCommand(),
  async handler() {},
})
