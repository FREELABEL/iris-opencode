import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// iris onboard-flows — manage schema-driven onboarding flows
// ============================================================================

async function fetchFlows(bloqId?: number): Promise<any[]> {
  const qs = bloqId ? `?bloq_id=${bloqId}` : ""
  const res = await irisFetch(`/api/v1/onboarding/flows${qs}`)
  if (!res.ok) return []
  const data = await res.json() as any
  return data?.flows ?? []
}

async function fetchFlowConfig(slug: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/onboarding/flows/${slug}`)
  if (!res.ok) return null
  return await res.json()
}

async function fetchAnalytics(slug: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/onboarding/flows/${slug}/analytics`)
  if (!res.ok) return null
  return await res.json()
}

export const PlatformOnboardFlowsCommand = cmd({
  command: "onboard-flows [action] [slug]",
  aliases: ["flows"],
  describe: "manage schema-driven onboarding flows (list, view, analytics, test, embed)",
  builder: (y) =>
    y
      .positional("action", {
        describe: "action: list | view | analytics | test | embed | create",
        type: "string",
        default: "list",
      })
      .positional("slug", { describe: "flow slug", type: "string" })
      .option("bloq-id", { describe: "filter by bloq ID", type: "number" }),
  async handler(args) {
    UI.empty()
    const action = (args.action as string) || "list"
    const slug = args.slug as string | undefined

    prompts.intro(`◈  Onboarding Flows — ${action}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()

    // ── LIST ──────────────────────────────────────────────
    if (action === "list") {
      sp.start("Fetching flows…")
      const flows = await fetchFlows(args["bloq-id"] as number | undefined)
      sp.stop(success(`${flows.length} flow(s)`))

      if (flows.length === 0) {
        prompts.log.info(dim("No onboarding flows found. Create one with: iris onboard-flows create"))
        prompts.outro("Done")
        return
      }

      for (const f of flows) {
        printDivider()
        printKV("Slug", f.slug)
        printKV("Name", f.name)
        printKV("Status", f.status ?? "draft")
        printKV("Steps", f.steps_count ?? 0)
        if (f.analytics?.started_count) {
          printKV("Started", f.analytics.started_count)
          printKV("Completed", f.analytics.completed_count ?? 0)
        }
      }
      printDivider()
      prompts.outro(dim("View details: iris onboard-flows view <slug>"))
      return
    }

    // ── VIEW ──────────────────────────────────────────────
    if (action === "view") {
      if (!slug) { prompts.log.error("Usage: iris onboard-flows view <slug>"); prompts.outro("Done"); return }

      sp.start("Fetching flow config…")
      const config = await fetchFlowConfig(slug)
      if (!config) { sp.stop("Not found", 1); prompts.outro("Done"); return }
      sp.stop(success(config.name))

      printDivider()
      printKV("Slug", config.slug)
      printKV("Name", config.name)
      printKV("Total Steps", config.total_steps)

      if (config.branding?.accent_color) {
        printKV("Accent", config.branding.accent_color)
      }
      if (config.branding?.logo_url) {
        printKV("Logo", config.branding.logo_url)
      }

      prompts.log.info("")
      prompts.log.info(bold("Steps:"))
      for (let i = 0; i < (config.steps ?? []).length; i++) {
        const step = config.steps[i]
        const fieldCount = step.fields?.length ?? 0
        const extra = step.type === "schema"
          ? ` (${fieldCount} fields${step.repeatable ? ", repeatable" : ""})`
          : ""
        prompts.log.info(`  ${i + 1}. [${step.type}] ${step.title}${extra}`)
      }

      if (config.conditional_logic?.length) {
        prompts.log.info("")
        prompts.log.info(bold("Conditional Logic:"))
        for (const rule of config.conditional_logic) {
          prompts.log.info(`  if ${rule.if.field} = "${rule.if.equals}"`)
          if (rule.show_steps?.length) prompts.log.info(`    show: ${rule.show_steps.join(", ")}`)
          if (rule.hide_steps?.length) prompts.log.info(`    hide: ${rule.hide_steps.join(", ")}`)
        }
      }

      printDivider()
      prompts.outro(dim(`Test: iris onboard-flows test ${slug}`))
      return
    }

    // ── ANALYTICS ────────────────────────────────────────
    if (action === "analytics") {
      if (!slug) { prompts.log.error("Usage: iris onboard-flows analytics <slug>"); prompts.outro("Done"); return }

      sp.start("Fetching analytics…")
      const analytics = await fetchAnalytics(slug)
      if (!analytics || analytics.error) { sp.stop("Not found", 1); prompts.outro("Done"); return }
      sp.stop(success(slug))

      printDivider()
      printKV("Flow", analytics.slug)
      printKV("Started", analytics.started)
      printKV("Completed", analytics.completed)
      printKV("Conversion", `${analytics.conversion_rate}%`)
      printKV("In Progress", analytics.in_progress)
      printKV("Abandoned", analytics.abandoned)
      printDivider()

      prompts.outro("Done")
      return
    }

    // ── TEST ─────────────────────────────────────────────
    if (action === "test") {
      if (!slug) { prompts.log.error("Usage: iris onboard-flows test <slug>"); prompts.outro("Done"); return }

      const env = process.env.IRIS_ENV ?? "production"
      const baseUrl = env === "local"
        ? "http://local.iris.freelabel.net:9300"
        : "https://freelabel.net"

      // The flow can be embedded on any Genesis page; for testing, show the API URL
      prompts.log.info(`Flow API: ${baseUrl}/api/v1/onboarding/flows/${slug}`)
      prompts.log.info(dim("Embed on a Genesis page with: OnboardingFlow component, flowSlug=\"" + slug + "\""))
      prompts.outro("Done")
      return
    }

    // ── EMBED ────────────────────────────────────────────
    if (action === "embed") {
      if (!slug) { prompts.log.error("Usage: iris onboard-flows embed <slug>"); prompts.outro("Done"); return }

      prompts.log.info(bold("Genesis Page JSON component:"))
      prompts.log.info("")
      const snippet = JSON.stringify({
        type: "OnboardingFlow",
        id: `onboarding-${slug}`,
        props: { flowSlug: slug, themeMode: "dark" },
      }, null, 2)
      prompts.log.info(snippet)
      prompts.log.info("")
      prompts.log.info(dim("Add this to your page's components[] array"))
      prompts.outro("Done")
      return
    }

    // ── CREATE (interactive) ─────────────────────────────
    if (action === "create") {
      prompts.log.info(dim("Creating onboarding flows uses Atlas schemas."))
      prompts.log.info(dim("1. Create child schemas: iris atlas schemas create"))
      prompts.log.info(dim("2. Create the flow schema with settings.flow_type = 'onboarding'"))
      prompts.log.info(dim("   and settings.steps[] referencing child schema slugs"))
      prompts.log.info("")
      prompts.log.info(dim("Example:"))
      prompts.log.info(dim('  iris atlas schemas create --slug my-onboarding --name "My Onboarding"'))
      prompts.log.info(dim('  Then PATCH settings to add flow_type, steps, branding, completion config'))
      prompts.outro("Done")
      return
    }

    prompts.log.error(`Unknown action: ${action}. Available: list, view, analytics, test, embed, create`)
    prompts.outro("Done")
  },
})
