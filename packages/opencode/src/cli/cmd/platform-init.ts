import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  highlight,
  resolveUserId,
  FL_API,
} from "./iris-api"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

// ── Progress file ───────────────────────────────────────────────────────────

interface StepProgress {
  completed: boolean
  [key: string]: any
}

interface InitProgress {
  version: number
  user_id: number
  started_at: string
  steps: Record<string, StepProgress>
}

function progressPath(): string {
  return join(homedir(), ".iris", "init-progress.json")
}

function loadProgress(): InitProgress | null {
  const p = progressPath()
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function saveProgress(progress: InitProgress): void {
  const dir = join(homedir(), ".iris")
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(progressPath(), JSON.stringify(progress, null, 2))
}

function ensureProgress(userId: number): InitProgress {
  const existing = loadProgress()
  if (existing && existing.user_id === userId) return existing
  const fresh: InitProgress = {
    version: 1,
    user_id: userId,
    started_at: new Date().toISOString(),
    steps: {},
  }
  saveProgress(fresh)
  return fresh
}

// ── Step definitions ────────────────────────────────────────────────────────

interface StepDef {
  key: string
  label: string
  check: (progress: InitProgress, apiData: any) => { completed: boolean; summary: string }
  run: (progress: InitProgress, userId: number) => Promise<boolean>
}

const STEPS: StepDef[] = [
  {
    key: "brand",
    label: "Brand Setup",
    check: (p, api) => {
      const brand = api?.brand ?? p.steps.brand
      if (brand?.completed && brand?.brand_slug) return { completed: true, summary: `"${brand.brand_name || brand.brand_slug}" (${brand.brand_slug})` }
      return { completed: false, summary: "not configured" }
    },
    run: async (progress, userId) => {
      const name = await prompts.text({ message: "Brand name:", placeholder: "Acme Corp" })
      if (prompts.isCancel(name)) return false

      const slug = await prompts.text({
        message: "Brand slug (URL-safe):",
        placeholder: String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, ""),
        initialValue: String(name).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/-+$/, ""),
      })
      if (prompts.isCancel(slug)) return false

      const entityType = await prompts.select({
        message: "Entity type:",
        options: [
          { value: "business", label: "Business" },
          { value: "creator", label: "Creator / Artist" },
          { value: "nonprofit", label: "Nonprofit" },
          { value: "personal", label: "Personal" },
        ],
      })
      if (prompts.isCancel(entityType)) return false

      const sp = prompts.spinner()
      sp.start("Creating brand...")

      const res = await irisFetch("/api/v1/brands", {
        method: "POST",
        body: JSON.stringify({ name, slug, entity_type: entityType }),
      })
      if (!res.ok) {
        const err = await res.text().catch(() => "Unknown error")
        sp.stop(`Failed: ${err}`, 1)
        return false
      }
      const data = await res.json()
      const brand = data?.data ?? data
      sp.stop(success(`Brand "${name}" created (#${brand.id})`))

      progress.steps.brand = { completed: true, brand_id: brand.id, brand_slug: String(slug), brand_name: String(name) }
      saveProgress(progress)
      return true
    },
  },
  {
    key: "design_tokens",
    label: "Design Tokens",
    check: (p, api) => {
      if (p.steps.design_tokens?.completed) return { completed: true, summary: "configured" }
      return { completed: false, summary: "not configured" }
    },
    run: async (progress, userId) => {
      const brandSlug = progress.steps.brand?.brand_slug
      if (!brandSlug) {
        prompts.log.warn("Complete Brand Setup first (step 1)")
        return false
      }

      const primary = await prompts.text({ message: "Primary color (hex):", placeholder: "#3B82F6" })
      if (prompts.isCancel(primary)) return false

      const secondary = await prompts.text({ message: "Secondary color (hex):", placeholder: "#10B981" })
      if (prompts.isCancel(secondary)) return false

      const font = await prompts.text({ message: "Font family:", placeholder: "Inter", initialValue: "Inter" })
      if (prompts.isCancel(font)) return false

      const sp = prompts.spinner()
      sp.start("Saving design tokens...")

      const brandId = progress.steps.brand?.brand_id
      const res = await irisFetch(`/api/v1/brands/${brandId}/design-tokens`, {
        method: "PATCH",
        body: JSON.stringify({
          colors: { primary: String(primary), secondary: String(secondary) },
          typography: { font_family: String(font) },
        }),
      })
      if (!res.ok) {
        sp.stop("Failed to save tokens", 1)
        return false
      }
      sp.stop(success("Design tokens saved"))

      progress.steps.design_tokens = { completed: true }
      saveProgress(progress)
      return true
    },
  },
  {
    key: "knowledge_base",
    label: "Knowledge Base",
    check: (p, api) => {
      const kb = api?.knowledge_base ?? p.steps.knowledge_base
      if (kb?.completed && kb?.bloq_id) return { completed: true, summary: `bloq #${kb.bloq_id}` }
      if (api?.bloq_count > 0) return { completed: true, summary: `${api.bloq_count} bloq(s)` }
      return { completed: false, summary: "no knowledge base" }
    },
    run: async (progress, userId) => {
      const name = await prompts.text({ message: "Knowledge base name:", placeholder: "My Workspace" })
      if (prompts.isCancel(name)) return false

      const description = await prompts.text({
        message: "Description (optional):",
        placeholder: "Central knowledge base for my business",
      })
      if (prompts.isCancel(description)) return false

      const sp = prompts.spinner()
      sp.start("Creating knowledge base...")

      const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
        method: "POST",
        body: JSON.stringify({ name: String(name), description: String(description) || `Knowledge base for ${name}` }),
      })
      if (!res.ok) {
        sp.stop("Failed to create bloq", 1)
        return false
      }
      const data = await res.json()
      const bloq = data?.data?.bloq ?? data?.data ?? data
      sp.stop(success(`Bloq #${bloq.id} created`))

      progress.steps.knowledge_base = { completed: true, bloq_id: bloq.id }
      saveProgress(progress)
      return true
    },
  },
  {
    key: "agent",
    label: "AI Agent",
    check: (p, api) => {
      const agent = api?.agent ?? p.steps.agent
      if (agent?.completed && agent?.agent_id) return { completed: true, summary: `"${agent.agent_name}" (#${agent.agent_id})` }
      if (api?.agent_count > 0) return { completed: true, summary: `${api.agent_count} agent(s)` }
      return { completed: false, summary: "no agents" }
    },
    run: async (progress, userId) => {
      const name = await prompts.text({ message: "Agent name:", placeholder: "My Assistant" })
      if (prompts.isCancel(name)) return false

      const model = await prompts.select({
        message: "AI model:",
        options: [
          { value: "gpt-4o-mini", label: "GPT-4o Mini (fast, affordable)" },
          { value: "gpt-4.1-nano", label: "GPT-4.1 Nano (balanced)" },
          { value: "gpt-5-nano", label: "GPT-5 Nano (latest)" },
        ],
      })
      if (prompts.isCancel(model)) return false

      const bloqId = progress.steps.knowledge_base?.bloq_id
      const sp = prompts.spinner()
      sp.start("Creating agent...")

      const payload: any = {
        name: String(name),
        type: "assistant",
        description: `AI assistant: ${name}`,
        config: { model: String(model), provider: "openai", temperature: 0.3 },
      }
      if (bloqId) payload.bloq_id = bloqId

      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      if (!res.ok) {
        const err = await res.text().catch(() => "Unknown error")
        sp.stop(`Failed: ${err}`, 1)
        return false
      }
      const data = await res.json()
      const agent = data?.data ?? data
      sp.stop(success(`Agent "${name}" created (#${agent.id})`))

      progress.steps.agent = { completed: true, agent_id: agent.id, agent_name: String(name) }
      saveProgress(progress)
      return true
    },
  },
  {
    key: "landing_page",
    label: "Landing Page",
    check: (p, api) => {
      if (p.steps.landing_page?.completed) return { completed: true, summary: `page created` }
      if (api?.page_count > 0) return { completed: true, summary: `${api.page_count} page(s)` }
      return { completed: false, summary: "no pages yet" }
    },
    run: async (progress, userId) => {
      const template = await prompts.select({
        message: "Page template:",
        options: [
          { value: "blank", label: "Blank — start from scratch" },
          { value: "business", label: "Business — hero + services + contact" },
          { value: "creator", label: "Creator — portfolio + bio + links" },
          { value: "portfolio", label: "Portfolio — grid gallery + about" },
        ],
      })
      if (prompts.isCancel(template)) return false

      const headline = await prompts.text({ message: "Page headline:", placeholder: "Welcome to my site" })
      if (prompts.isCancel(headline)) return false

      const slug = progress.steps.brand?.brand_slug || "my-page"
      const sp = prompts.spinner()
      sp.start("Creating page...")

      const components: any[] = [
        { type: "Hero", props: { headline: String(headline), subtitle: "Built with IRIS" } },
      ]
      if (template === "business") {
        components.push({ type: "Features", props: { title: "Our Services" } })
        components.push({ type: "CTA", props: { title: "Get in Touch" } })
      } else if (template === "creator") {
        components.push({ type: "Bio", props: { title: "About Me" } })
        components.push({ type: "Links", props: { title: "Links" } })
      } else if (template === "portfolio") {
        components.push({ type: "Gallery", props: { title: "Portfolio" } })
        components.push({ type: "Bio", props: { title: "About" } })
      }

      const res = await irisFetch("/api/v6/pages", {
        method: "POST",
        body: JSON.stringify({
          title: String(headline),
          slug: `${slug}-home`,
          status: "draft",
          components,
        }),
      })
      if (!res.ok) {
        sp.stop("Failed to create page", 1)
        return false
      }
      const data = await res.json()
      const page = data?.data ?? data
      sp.stop(success(`Page created — edit: iris pages view ${slug}-home`))

      progress.steps.landing_page = { completed: true, page_id: page.id }
      saveProgress(progress)
      return true
    },
  },
  {
    key: "outreach",
    label: "Outreach Config",
    check: (p) => {
      if (p.steps.outreach?.completed) return { completed: true, summary: "configured" }
      return { completed: false, summary: "not configured" }
    },
    run: async (progress) => {
      prompts.log.info(bold("Outreach Setup Guide"))
      console.log()
      console.log(`  Outreach lets you find and contact leads automatically.`)
      console.log(`  Set it up with these commands:`)
      console.log()
      console.log(`  ${highlight("iris som overview")}       — view your outreach pipeline`)
      console.log(`  ${highlight("iris som leads")}          — manage lead lists`)
      console.log(`  ${highlight("iris outreach create")}    — create a campaign`)
      console.log()

      const done = await prompts.confirm({ message: "Mark outreach as reviewed?" })
      if (prompts.isCancel(done) || !done) return false

      progress.steps.outreach = { completed: true }
      saveProgress(progress)
      return true
    },
  },
  {
    key: "content",
    label: "Content Strategy",
    check: (p, api) => {
      if (p.steps.content?.completed) return { completed: true, summary: "schedule set" }
      if (api?.schedule_count > 0) return { completed: true, summary: `${api.schedule_count} schedule(s)` }
      return { completed: false, summary: "no schedule" }
    },
    run: async (progress, userId) => {
      const frequency = await prompts.select({
        message: "Content frequency:",
        options: [
          { value: "daily", label: "Daily" },
          { value: "weekly", label: "Weekly" },
          { value: "biweekly", label: "Every 2 weeks" },
        ],
      })
      if (prompts.isCancel(frequency)) return false

      const topics = await prompts.text({
        message: "Content topics (comma-separated):",
        placeholder: "industry news, tips, case studies",
      })
      if (prompts.isCancel(topics)) return false

      prompts.log.info(`Content strategy saved locally: ${frequency}, topics: ${topics}`)
      console.log()
      console.log(`  Next: Create a content agent with scheduled heartbeat:`)
      console.log(`  ${highlight("iris agents create")}     — create content agent`)
      console.log(`  ${highlight("iris schedules create")}  — schedule recurring content`)

      progress.steps.content = { completed: true, frequency: String(frequency), topics: String(topics) }
      saveProgress(progress)
      return true
    },
  },
  {
    key: "billing",
    label: "Billing",
    check: (p, api) => {
      if (api?.subscription) return { completed: true, summary: `${api.subscription.plan ?? "active"} tier` }
      if (p.steps.billing?.completed) return { completed: true, summary: "reviewed" }
      return { completed: false, summary: "check your plan" }
    },
    run: async (progress, userId) => {
      const sp = prompts.spinner()
      sp.start("Fetching billing info...")

      const res = await irisFetch(`/api/v1/users/${userId}/subscription`)
      if (res.ok) {
        const data = await res.json().catch(() => ({}))
        const sub = data?.data ?? data
        sp.stop(success("Billing loaded"))
        printKV("Plan", sub?.plan ?? sub?.name ?? "Free")
        printKV("Status", sub?.status ?? "active")
        if (sub?.daily_cap) printKV("Daily budget", `$${sub.daily_cap}`)
      } else {
        sp.stop("No active subscription")
        console.log(`  ${dim("Start a subscription at")} ${highlight("https://heyiris.io/pricing")}`)
      }

      const done = await prompts.confirm({ message: "Mark billing as reviewed?" })
      if (prompts.isCancel(done) || !done) return false

      progress.steps.billing = { completed: true }
      saveProgress(progress)
      return true
    },
  },
]

// ── Signal-to-step bridge ───────────────────────────────────────────────────
// Maps heartbeat signal data to the flat keys that step.check() expects.
// This bridges the heartbeat API response format into iris init's existing check pattern.

const SIGNAL_STEP_MAP: Record<string, string> = {
  config: "brand",           // config signal → brand + design_tokens steps
  knowledge_completeness: "knowledge_base",
  liveness: "agent",
  deliverable_completeness: "landing_page",
  scripts: "outreach",
  content_output: "content",
  deal_health: "billing",
}

function enrichApiDataFromSignals(apiData: any): any {
  const signals = apiData?.signals ?? {}
  const enriched = { ...apiData }

  for (const [signalName, stepKey] of Object.entries(SIGNAL_STEP_MAP)) {
    const sig = signals[signalName]
    if (!sig || typeof sig !== "object") continue

    // If the signal reports completed via onboarding threshold, mark the step
    if (sig.completed && !enriched[stepKey]?.completed) {
      enriched[stepKey] = { ...(enriched[stepKey] ?? {}), completed: true, from_signal: true }
    }
  }

  // Bridge onboarding object for dashboard display
  if (apiData?.onboarding) {
    enriched._onboarding = apiData.onboarding
  }

  return enriched
}

// ── Fetch live readiness signals for dashboard state ────────────────────────

async function fetchApiState(userId: number): Promise<any> {
  try {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    // Use heartbeat endpoint — includes onboarding progress, completion flags, and remediation hints
    const res = await irisFetch(`/api/v1/users/${userId}/heartbeat?include=copy`, { signal: controller.signal }, FL_API)
    clearTimeout(timer)
    if (!res.ok) return {}
    const body = await res.json().catch(() => ({}))
    return body?.data ?? body ?? {}
  } catch {
    return {}
  }
}

// ── Main command ────────────────────────────────────────────────────────────

export const PlatformInitCommand = cmd({
  command: "init",
  aliases: ["setup"],
  describe: "self-serve setup wizard — resumable, pick-your-step onboarding",
  builder: (yargs) =>
    yargs
      .option("reset", { describe: "reset progress and start fresh", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await resolveUserId()
    if (!userId) {
      prompts.log.error("Could not resolve user ID. Run `iris auth login` first.")
      return
    }

    UI.empty()
    prompts.intro("  IRIS Setup")

    if (args.reset) {
      const confirm = await prompts.confirm({ message: "Reset all init progress?" })
      if (prompts.isCancel(confirm) || !confirm) {
        prompts.outro("Cancelled")
        return
      }
      const fresh: InitProgress = {
        version: 1,
        user_id: userId,
        started_at: new Date().toISOString(),
        steps: {},
      }
      saveProgress(fresh)
      prompts.log.success("Progress reset")
    }

    const progress = ensureProgress(userId)

    // Fetch live API data for state enrichment
    const sp = prompts.spinner()
    sp.start("Checking account status...")
    const rawApiData = await fetchApiState(userId)
    const apiData = enrichApiDataFromSignals(rawApiData)
    sp.stop(dim("ready"))

    // Build dashboard
    const stepStates = STEPS.map((step) => {
      const state = step.check(progress, apiData)
      return { ...step, ...state }
    })

    const completedCount = stepStates.filter((s) => s.completed).length

    if (args.json) {
      console.log(JSON.stringify({
        completed: completedCount,
        total: STEPS.length,
        steps: stepStates.map((s) => ({ key: s.key, label: s.label, completed: s.completed, summary: s.summary })),
      }, null, 2))
      return
    }

    // Render dashboard
    function renderDashboard() {
      const states = STEPS.map((step) => step.check(progress, apiData))
      const done = states.filter((s) => s.completed).length
      console.log()
      console.log(`  ${bold("IRIS Setup")}                             ${dim(`[${done}/${STEPS.length} complete]`)}`)
      console.log(dim("  ─────────────────────────────────────────────"))
      for (let i = 0; i < STEPS.length; i++) {
        const step = STEPS[i]
        const state = states[i]
        const icon = state.completed ? success("✓") : dim("○")
        const label = state.completed ? dim(step.label) : step.label
        const summary = state.completed ? dim(state.summary) : highlight(state.summary)
        console.log(`  ${icon} ${String(i + 1).padStart(2)}. ${label.padEnd(22)} ${summary}`)
      }
      console.log()
    }

    renderDashboard()

    if (completedCount === STEPS.length) {
      prompts.log.success("All steps complete! Your IRIS account is fully set up.")
      console.log(`  ${dim("Run")} ${highlight("iris pulse")} ${dim("to see your account health")}`)
      prompts.outro(success("Setup complete"))
      return
    }

    // Interactive step selection loop
    while (true) {
      const incomplete = STEPS.map((step, i) => {
        const state = step.check(progress, apiData)
        return { value: i, label: `${state.completed ? "✓" : "○"} ${step.label} — ${state.summary}`, hint: state.completed ? "done" : undefined }
      })

      const choice = await prompts.select({
        message: "Select a step to configure (or quit):",
        options: [
          ...incomplete,
          { value: -1, label: "Quit", hint: "exit setup" },
        ],
      })

      if (prompts.isCancel(choice) || choice === -1) break

      const step = STEPS[choice as number]
      console.log()
      prompts.log.info(bold(`Step ${(choice as number) + 1}: ${step.label}`))
      printDivider()

      await step.run(progress, userId)
      console.log()
      renderDashboard()
    }

    const finalStates = STEPS.map((step) => step.check(progress, apiData))
    const finalDone = finalStates.filter((s) => s.completed).length

    if (finalDone < STEPS.length) {
      console.log(`  ${dim("Resume anytime:")} ${highlight("iris init")}`)
    }
    prompts.outro(dim(`${finalDone}/${STEPS.length} steps complete`))
  },
})
