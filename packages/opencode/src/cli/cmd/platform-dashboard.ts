import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, printDivider, printKV, dim, bold, success, IRIS_API } from "./iris-api"

function dashFetch(path: string, options?: RequestInit): Promise<Response> {
  return irisFetch(path, options ?? {}, IRIS_API)
}

function publicUrl(slug: string): string {
  const env = process.env.IRIS_ENV ?? "production"
  return env === "local"
    ? `http://local.iris.freelabel.net:9300/p/${slug}`
    : `https://freelabel.net/p/${slug}`
}

interface DesignTokens {
  colors?: { primary?: string; secondary?: string; background?: string; text?: string }
  fonts?: { heading?: string; body?: string }
}

async function fetchDesignTokens(slug: string): Promise<DesignTokens> {
  try {
    const res = await dashFetch(`/api/v1/public/brands/${slug}/design-tokens`)
    if (res.ok) {
      const data = await res.json() as any
      return data?.data ?? data ?? {}
    }
  } catch {}
  return {}
}

function buildDashboardJson(client: string, title: string, tokens?: DesignTokens) {
  const slug = `${client}-dashboard`
  const primary = tokens?.colors?.primary ?? "#34d399"
  const background = tokens?.colors?.background ?? "#f8fafc"
  return {
    version: "2.0",
    type: "dashboard",
    theme: {
      mode: "light",
      backgroundColor: background,
      branding: { name: title, primaryColor: primary, description: `${title} Operations Dashboard` },
    },
    layout: {
      type: "dashboard",
      pageTitle: "Operations",
      pageIcon: "chart-bar",
      themeMode: "light",
      navItems: [
        { label: "Dashboard", url: "#", icon: "chart-bar", active: true },
        { label: "Signups", url: "#signups", icon: "user-plus" },
        { label: "Site", url: `/p/${client}`, icon: "document-text" },
      ],
    },
    components: [
      {
        type: "WidgetWorkspaceBanner", id: "banner-1",
        props: { title: `${title} Operations`, subtitle: "Site traffic, signups, and analytics.", themeMode: "light" },
      },
      {
        type: "WidgetStatsRow", id: "stats",
        props: {
          columns: 4, themeMode: "light",
          dataSource: `/api/v1/app-data/${slug}/stats`,
          stats: [
            { label: "Total Views", value: "...", icon: "eye" },
            { label: "Signups", value: "...", icon: "users" },
            { label: "Pages", value: "...", icon: "layout" },
            { label: "Today", value: "...", icon: "trending-up" },
          ],
        },
      },
      {
        type: "TextBlock", id: "heading-views",
        props: { content: "## Site Traffic\nReal-time page view analytics.", themeMode: "light" },
      },
      {
        type: "DataTable", id: "views-table",
        props: {
          title: "Page Views",
          dataSource: `/api/v1/app-data/${slug}/views`,
          columns: [
            { key: "page_slug", label: "Page", sortable: true },
            { key: "total_views", label: "Total Views", sortable: true },
            { key: "today_views", label: "Today", sortable: true },
          ],
          searchable: true, sortable: true, paginated: false,
          emptyMessage: "No page views yet.", themeMode: "light",
        },
      },
      {
        type: "TextBlock", id: "heading-signups",
        props: { content: "## Signups\nForm submissions from your pages.", themeMode: "light" },
      },
      {
        type: "DataTable", id: "signups-table",
        props: {
          title: "Signups",
          dataSource: `/api/v1/app-data/${slug}/signups`,
          columns: [
            { key: "email", label: "Email", sortable: true },
            { key: "full_name", label: "Name", sortable: true },
            { key: "source", label: "Source", type: "status" },
            { key: "first_visit", label: "First Visit", type: "date", sortable: true },
          ],
          searchable: true, sortable: true, paginated: true, pageSize: 20,
          emptyMessage: "No signups yet.", themeMode: "light",
        },
      },
    ],
  }
}

// ─── create ──────────────────────────────────────────────────────────────────

const CreateCmd = cmd({
  command: "create",
  describe: "create a client dashboard (app bloq + page + publish)",
  builder: (y) =>
    y
      .option("client", { describe: "client slug prefix (e.g. moody-beauty)", type: "string", demandOption: true })
      .option("title", { describe: "dashboard title (e.g. Moody Beauty)", type: "string" })
      .option("lead", { describe: "lead ID to associate", type: "number" }),
  async handler(args) {
    UI.empty()
    const client = args.client as string
    const title = (args.title as string) || client.split("-").map((w: string) => w.charAt(0).toUpperCase() + w.slice(1)).join(" ")
    const slug = `${client}-dashboard`

    prompts.intro(`◈  Create Dashboard: ${slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId()
    if (!userId) { prompts.outro("Done"); return }

    const sp = prompts.spinner()

    // Step 1: Init app bloq
    sp.start("Initializing dashboard app...")
    try {
      const initRes = await dashFetch(`/api/v1/app-data/${slug}/init`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      })
      if (!initRes.ok) {
        const err = await initRes.json().catch(() => ({})) as Record<string, unknown>
        sp.stop(`Failed: ${(err as any).error || initRes.status}`, 1)
        prompts.outro("Done")
        return
      }
      const initData = (await initRes.json()) as { created?: boolean; app?: { id: number } }
      if (initData.created) {
        sp.stop(success(`App created (bloq #${initData.app?.id})`))
      } else {
        sp.stop(dim(`App already exists (bloq #${initData.app?.id})`))
      }
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }

    // Step 2: Fetch brand design tokens for theming
    sp.start("Loading brand design tokens...")
    const tokens = await fetchDesignTokens(client)
    if (tokens.colors?.primary) {
      sp.stop(success(`Brand colors: ${tokens.colors.primary}`))
    } else {
      sp.stop(dim("No brand tokens found — using defaults"))
    }

    // Step 3: Create dashboard page
    sp.start("Creating dashboard page...")
    try {
      const jsonContent = buildDashboardJson(client, title, tokens)
      const payload = {
        slug,
        title: `${title} Operations Dashboard`,
        seo_title: `${title} Operations Dashboard`,
        seo_description: `Operations dashboard for ${title} — site traffic, signups, and analytics.`,
        owner_type: "bloq",
        owner_id: 38,
        status: "draft",
        json_content: jsonContent,
        auto_publish: true,
      }
      const pageRes = await dashFetch("/api/v1/pages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      })
      if (!pageRes.ok) {
        const errBody = await pageRes.json().catch(() => ({})) as Record<string, unknown>
        const errMsg = (errBody as any).errors?.slug?.[0] || (errBody as any).message || `HTTP ${pageRes.status}`
        if (String(errMsg).includes("already been taken")) {
          sp.stop(dim("Page already exists"))
        } else {
          sp.stop(`Page creation failed: ${errMsg}`, 1)
          prompts.outro("Done")
          return
        }
      } else {
        const pageData = (await pageRes.json()) as { data?: { id: number; slug: string; status: string } }
        const p = pageData?.data ?? pageData
        sp.stop(success(`Page created (#${(p as any).id})`))
      }
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }

    // Step 3: Verify
    sp.start("Verifying endpoints...")
    try {
      const viewsRes = await dashFetch(`/api/v1/app-data/${slug}/views`)
      const viewsData = (await viewsRes.json()) as { meta?: { total_views: number; pages_tracked: number } }
      sp.stop(success("Live"))

      printDivider()
      printKV("Dashboard", slug)
      printKV("Page URL", publicUrl(slug))
      printKV("Views", `${viewsData.meta?.total_views ?? 0} total, ${viewsData.meta?.pages_tracked ?? 0} pages`)
      printKV("Views API", `/api/v1/app-data/${slug}/views`)
      printKV("Signups API", `/api/v1/app-data/${slug}/signups`)
      printDivider()
      prompts.outro(dim(`iris dashboard status ${client}`))
    } catch {
      sp.stop(dim("Verification skipped"))
      printDivider()
      printKV("Dashboard", slug)
      printKV("Page URL", publicUrl(slug))
      printDivider()
      prompts.outro("Done")
    }
  },
})

// ─── status ──────────────────────────────────────────────────────────────────

const StatusCmd = cmd({
  command: "status <client>",
  describe: "check dashboard health for a client",
  builder: (y) => y.positional("client", { describe: "client slug prefix", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    const client = args.client as string
    const slug = `${client}-dashboard`
    prompts.intro(`◈  Dashboard Status: ${slug}`)

    const sp = prompts.spinner()
    sp.start("Checking endpoints...")

    try {
      const [viewsRes, signupsRes] = await Promise.all([
        dashFetch(`/api/v1/app-data/${slug}/views`).then(r => r.json()).catch(() => null),
        dashFetch(`/api/v1/app-data/${slug}/signups`).then(r => r.json()).catch(() => null),
      ]) as [any, any]

      const viewsOk = viewsRes?.success === true
      const signupsOk = signupsRes?.success === true

      if (viewsOk && signupsOk) {
        sp.stop(success("All endpoints healthy"))
      } else {
        sp.stop("Some endpoints failing", 1)
      }

      printDivider()
      printKV("Views", viewsOk
        ? success(`${viewsRes.meta?.total_views ?? 0} total, ${viewsRes.meta?.today_views ?? 0} today, ${viewsRes.meta?.pages_tracked ?? 0} pages`)
        : "FAIL — app bloq may not exist")
      printKV("Signups", signupsOk
        ? success(`${signupsRes.meta?.total_count ?? signupsRes.data?.length ?? 0} records`)
        : "FAIL")
      printKV("Page URL", publicUrl(slug))

      // Check if bloq has members (digest recipients)
      try {
        const pageRes = await dashFetch(`/api/v1/pages/by-slug/${client}`)
        if (pageRes.ok) {
          const pageData = (await pageRes.json()) as any
          const ownerId = pageData?.data?.owner_id
          if (ownerId) {
            const membersRes = await dashFetch(`/api/v1/bloqs/${ownerId}/members`)
            if (membersRes.ok) {
              const membersData = (await membersRes.json()) as any
              const members = membersData?.data ?? []
              if (members.length === 0) {
                prompts.log.warn(`No members on bloq #${ownerId} — only the owner gets the daily digest email.`)
                prompts.log.warn(`Clients won't receive traffic stats. Add members:`)
                prompts.log.warn(dim(`  iris bloq members add ${ownerId} --user <client_user_id>`))
              } else {
                printKV("Digest Recipients", success(`${members.length} member(s) will receive daily stats`))
              }
            }
          }
        }
      } catch {
        // Non-fatal — skip member check
      }

      printDivider()
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ─── add-assistant ─────────────────────────────────────────────────────────

const AddAssistantCmd = cmd({
  command: "add-assistant <slug>",
  describe: "drop an AI chat assistant onto a dashboard page, wired to a bloq agent",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug to add the assistant to", type: "string", demandOption: true })
      .option("agent-id", { describe: "BloqAgent id to chat with (auto-detected from the bloq if omitted)", type: "number" })
      .option("bloq-id", { describe: "bloq the agent is scoped to (defaults to the page owner / agent's bloq)", type: "number" })
      .option("title", { describe: "assistant title (default: '<Page> AI Assistant')", type: "string" })
      .option("subtitle", { describe: "assistant subtitle", type: "string" })
      .option("suggestion", { describe: "starter prompt chip (repeatable)", type: "array" })
      .option("model", { describe: "model override (nano tiers)", type: "string", default: "gpt-4.1-nano" })
      .option("replace", { describe: "make the chat the page's sole content (keeps a banner if present)", type: "boolean", default: false })
      .option("nav", { describe: "point/activate this page's 'AI Assistant' nav item here", type: "boolean", default: false })
      .option("publish", { describe: "publish after saving (use --no-publish for draft)", type: "boolean", default: true }),
  async handler(args) {
    UI.empty()
    const slug = args.slug as string
    prompts.intro(`◈  Add AI Assistant → ${slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const userId = await requireUserId()
    if (!userId) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading page…")

    // 1. Fetch the page with its json_content.
    let page: any
    try {
      const res = await dashFetch(`/api/v1/pages/by-slug/${encodeURIComponent(slug)}?include_json=1&include_drafts=1`)
      if (!res.ok) { sp.stop(`Page "${slug}" not found`, 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any }
      page = data?.data ?? data
    } catch (err) {
      sp.stop("Error loading page", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done"); return
    }

    const jc = page?.json_content
    if (!jc || typeof jc !== "object") { sp.stop("Page has no json_content to edit", 1); prompts.outro("Done"); return }

    // 2. Resolve bloq + agent (explicit flags win; otherwise infer).
    let bloqId = (args.bloqId as number | undefined) ?? (page.owner_type === "bloq" ? Number(page.owner_id) : undefined)
    let agentId = args.agentId as number | undefined
    let agentName = ""

    if (!agentId) {
      if (!bloqId) { sp.stop("No --agent-id and no bloq to detect from — pass --agent-id (and --bloq-id)", 1); prompts.outro("Done"); return }
      sp.message("Finding agent for bloq…")
      try {
        const res = await dashFetch(`/api/v1/users/${userId}/bloqs/agents?bloq_id=${bloqId}`)
        const body = (await res.json()) as any
        const agents: any[] = (Array.isArray(body) ? body : body?.data) ?? []
        const scoped = agents.filter((a) => Number(a.bloq_id) === Number(bloqId))
        const active = scoped.filter((a) => a.active)
        const pick = active.length ? active : scoped
        if (pick.length === 1) { agentId = Number(pick[0].id); agentName = pick[0].name }
        else if (pick.length === 0) { sp.stop(`No agents on bloq ${bloqId} — pass --agent-id`, 1); prompts.outro("Done"); return }
        else {
          sp.stop(`${pick.length} agents on bloq ${bloqId} — pass --agent-id to pick one:`, 1)
          pick.forEach((a) => console.log(`  ${a.id}  ${dim(a.name)}`))
          prompts.outro("Done"); return
        }
      } catch (err) {
        sp.stop("Agent lookup failed — pass --agent-id", 1); prompts.outro("Done"); return
      }
    }

    // Backfill bloq from the agent record if still unknown.
    if (!bloqId && agentId) {
      try {
        const res = await dashFetch(`/api/v1/users/${userId}/bloqs/agents/${agentId}`)
        const a = ((await res.json()) as any)?.data ?? (await res.json().catch(() => ({})))
        if (a?.bloq_id) bloqId = Number(a.bloq_id)
        if (!agentName && a?.name) agentName = a.name
      } catch { /* non-fatal */ }
    }

    // 3. Build the AiChat block.
    const title = (args.title as string) || `${page.title || slug} AI Assistant`
    const initials =
      (title.replace(/[^A-Za-z ]/g, "").split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("")) || "AI"
    const suggestions =
      (args.suggestion as (string | number)[] | undefined)?.map((s) => ({ label: String(s) })) ?? [
        { label: "What can you help me with?" },
        { label: "Give me a summary of my data" },
      ]

    const chat = {
      type: "AiChat",
      id: "ai-chat",
      props: {
        agentId,
        ...(bloqId ? { bloqId } : {}),
        title,
        subtitle: (args.subtitle as string) || "Ask about your data",
        agentInitials: initials,
        placeholder: "Ask anything…",
        model: args.model as string,
        height: "calc(100vh - 260px)",
        themeMode: jc?.theme?.mode === "dark" ? "dark" : "light",
        suggestions,
      },
    }

    // 4. Inject into the page's components.
    if (!Array.isArray(jc.components)) jc.components = []
    if (args.replace) {
      const banner = jc.components.find((c: any) => c.type === "WidgetWorkspaceBanner")
      jc.components = [...(banner ? [banner] : []), chat]
    } else {
      const idx = jc.components.findIndex((c: any) => c.type === "AiChat")
      if (idx >= 0) jc.components[idx] = chat
      else jc.components.push(chat)
    }

    // 5. Optionally wire this page's "AI Assistant" nav item here.
    if (args.nav && Array.isArray(jc.layout?.navItems)) {
      const item = jc.layout.navItems.find((n: any) => /ai assistant/i.test(String(n.label || "")))
      jc.layout.navItems.forEach((n: any) => { n.active = false })
      if (item) { item.url = `/p/${slug}`; item.active = true }
    }

    // 6. Save (server validates AiChat against the component registry).
    sp.message("Saving page…")
    try {
      const res = await dashFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ json_content: jc }),
      })
      if (!res.ok) {
        const err = (await res.json().catch(() => ({}))) as any
        const msg = err?.errors ? JSON.stringify(err.errors) : err?.message || `HTTP ${res.status}`
        sp.stop(`Push failed: ${msg}`, 1); prompts.outro("Done"); return
      }
    } catch (err) {
      sp.stop("Error saving page", 1); prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done"); return
    }

    // 7. Publish + purge cache (default).
    if (args.publish !== false) {
      sp.message("Publishing…")
      await dashFetch(`/api/v1/pages/${page.id}/publish`, { method: "POST" }).catch(() => {})
      await dashFetch("/api/internal/cache/purge-page", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      }).catch(() => {})
      sp.stop(success("Assistant added + published"))
    } else {
      sp.stop(success("Assistant added (draft)"))
    }

    printDivider()
    printKV("Page", slug)
    printKV("Agent", `#${agentId}${agentName ? ` (${agentName})` : ""}`)
    if (bloqId) printKV("Bloq", String(bloqId))
    printKV("URL", publicUrl(slug))
    printDivider()
    prompts.outro(dim(`iris pages get ${slug} components`))
  },
})

// ─── export ──────────────────────────────────────────────────────────────────

export const PlatformDashboardCommand = cmd({
  command: "dashboard",
  describe: "manage client dashboards — create, status, add-assistant",
  builder: (y) =>
    y
      .command(CreateCmd)
      .command(StatusCmd)
      .command(AddAssistantCmd)
      .demandCommand(1, "Run iris dashboard <command> --help"),
  handler() {},
})
