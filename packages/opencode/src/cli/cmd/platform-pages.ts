import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, IRIS_API } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"

// ============================================================================
// Helpers
// ============================================================================

/**
 * Get the public URL for a page. Prefers the API-provided public_url,
 * falls back to constructing from slug.
 */
function publicUrl(slugOrPage: string | { public_url?: string; slug?: string }): string {
  if (typeof slugOrPage === "object" && slugOrPage.public_url) {
    return slugOrPage.public_url
  }
  const slug = typeof slugOrPage === "string" ? slugOrPage : (slugOrPage.slug ?? "")
  const env = process.env.IRIS_ENV ?? "production"
  return env === "local"
    ? `http://local.iris.freelabel.net:9300/p/${slug}`
    : `https://main.heyiris.io/p/${slug}`
}

// Pages CRUD routes through iris-api (which proxies to fl-api with service token).
// The SDK key authenticates against iris-api; fl-api doesn't recognize it directly.
function pagesFetch(path: string, options?: RequestInit): Promise<Response> {
  return irisFetch(path, options ?? {}, IRIS_API)
}

function formatStatus(status: string): string {
  if (status === "published") return success("● Published")
  if (status === "draft") return `${UI.Style.TEXT_WARNING}○ Draft${UI.Style.TEXT_NORMAL}`
  if (status === "archived") return dim("◌ Archived")
  return status
}

async function getBySlug(slug: string, includeJson = false): Promise<any | null> {
  const params = new URLSearchParams({
    include_json: includeJson ? "1" : "0",
    include_drafts: "1",
  })
  const res = await pagesFetch(`/api/v1/pages/by-slug/${encodeURIComponent(slug)}?${params}`)
  if (!res.ok) {
    await handleApiError(res, `Get page ${slug}`)
    return null
  }
  const data = (await res.json()) as { data?: any }
  return data?.data ?? data
}

function parseValue(raw: string): unknown {
  // Try JSON first (handles numbers, booleans, arrays, objects, null)
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

function getNestedValue(obj: any, path: string): unknown {
  const parts = path.split(".")
  let cur: any = obj
  for (const p of parts) {
    if (cur == null) return undefined
    const idx = /^\d+$/.test(p) ? Number(p) : p
    cur = cur[idx as any]
  }
  return cur
}

function setNestedValue(obj: any, path: string, value: unknown): void {
  const parts = path.split(".")
  let cur: any = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    const key = /^\d+$/.test(p) ? Number(p) : p
    if (cur[key as any] == null || typeof cur[key as any] !== "object") {
      const nextIsIndex = /^\d+$/.test(parts[i + 1])
      cur[key as any] = nextIsIndex ? [] : {}
    }
    cur = cur[key as any]
  }
  const last = parts[parts.length - 1]
  cur[/^\d+$/.test(last) ? Number(last) : last] = value
}

function pagesDir(custom?: string): string {
  return custom ?? join(process.cwd(), "pages")
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list pages",
  builder: (y) =>
    y
      .option("page-type", { describe: "filter by template type", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Pages")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading pages…")
    try {
      const res = await pagesFetch("/api/v1/pages")
      if (!(await handleApiError(res, "List pages"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const json = (await res.json()) as any
      // Handle both direct array and Laravel paginator ({ data: { data: [...] } })
      let pages: any[] = []
      if (Array.isArray(json?.data)) pages = json.data
      else if (Array.isArray(json?.data?.data)) pages = json.data.data
      else if (Array.isArray(json)) pages = json
      if (args["page-type"]) {
        pages = pages.filter((p: any) => {
          const tpl = p?.json_content?.meta?.template ?? p?.json_content?.type
          return tpl === args["page-type"]
        })
      }
      sp.stop(`${pages.length} page(s)`)

      if (args.json) {
        console.log(JSON.stringify(pages, null, 2))
        prompts.outro("Done")
        return
      }
      if (pages.length === 0) {
        prompts.log.warn("No pages found")
        prompts.outro("Done")
        return
      }
      printDivider()
      for (const p of pages) {
        const tpl = p?.json_content?.meta?.template ?? p?.json_content?.type ?? "-"
        console.log(`  ${bold(p.slug)}  ${dim(`#${p.id}`)}  ${formatStatus(p.status)}`)
        console.log(`    ${dim(p.title ?? "")}  ${dim(`[${tpl}]`)}`)
        console.log(`    ${dim(publicUrl(p))}`)
        console.log()
      }
      printDivider()
      prompts.outro(dim("iris pages view <slug>"))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ViewCmd = cmd({
  command: "view <slug>",
  describe: "view page details",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Page: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const page = await getBySlug(args.slug, true)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(String(page.title ?? page.slug))

      if (args.json) {
        console.log(JSON.stringify(page, null, 2))
        prompts.outro("Done")
        return
      }
      printDivider()
      printKV("ID", page.id)
      printKV("Slug", page.slug)
      printKV("Title", page.title)
      printKV("Status", formatStatus(page.status))
      printKV("Published", page.published_at ?? "Not published")
      printKV("URL", publicUrl(page))
      const compCount = page?.json_content?.components?.length ?? 0
      printKV("Components", compCount)
      printDivider()
      prompts.outro(dim(`iris pages get ${args.slug} "components.0.props"`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const GetCmd = cmd({
  command: "get <slug> [path]",
  describe: "get value at dot-notation path (no path = full json_content)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .positional("path", { describe: "dot notation path", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const page = await getBySlug(args.slug, true)
    if (!page) return
    const json = page.json_content ?? {}
    if (!args.path) {
      console.log(JSON.stringify(json, null, 2))
      return
    }
    const value = getNestedValue(json, args.path)
    if (value === undefined || value === null) {
      console.error(`Path '${args.path}' not found in '${args.slug}'`)
      process.exit(1)
    }
    if (typeof value === "object") console.log(JSON.stringify(value, null, 2))
    else console.log(String(value))
  },
})

const SetCmd = cmd({
  command: "set <slug> <path> <value>",
  describe: "set value at dot-notation path (auto-detects JSON values)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .positional("path", { describe: "dot notation path", type: "string", demandOption: true })
      .positional("value", { describe: "new value (JSON or string)", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set ${args.slug} → ${args.path}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Updating…")
    try {
      const page = await getBySlug(args.slug, true)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const json = page.json_content ?? {}
      const parsed = parseValue(args.value)
      setNestedValue(json, args.path, parsed)
      const res = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ json_content: json }),
      })
      if (!(await handleApiError(res, "Update path"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success(`Updated ${args.path}`))
      prompts.outro(dim(`iris pages get ${args.slug} ${args.path}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCmd = cmd({
  command: "pull <slug>",
  describe: "download page JSON to local file",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("dir", { describe: "output directory", type: "string", default: "./pages" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Pull ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Fetching…")
    try {
      const page = await getBySlug(args.slug, true)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const dir = pagesDir(args.dir)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const filePath = join(dir, `${args.slug}.json`)
      const exp = {
        id: page.id,
        slug: page.slug,
        title: page.title,
        seo_title: page.seo_title ?? null,
        seo_description: page.seo_description ?? null,
        og_image: page.og_image ?? null,
        status: page.status,
        owner_type: page.owner_type ?? "system",
        owner_id: page.owner_id ?? null,
        json_content: page.json_content ?? {},
      }
      writeFileSync(filePath, JSON.stringify(exp, null, 2) + "\n")
      const cnt = exp.json_content?.components?.length ?? 0
      sp.stop(success(`Pulled → ${filePath} (${cnt} components)`))
      prompts.outro(dim(`iris pages push ${args.slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCmd = cmd({
  command: "push <slug>",
  describe: "upload local page JSON to API",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("dir", { describe: "input directory", type: "string", default: "./pages" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Push ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    try {
      const filePath = join(pagesDir(args.dir), `${args.slug}.json`)
      if (!existsSync(filePath)) {
        prompts.log.error(`Local file not found: ${filePath}`)
        prompts.log.info(dim(`Pull first: iris pages pull ${args.slug}`))
        prompts.outro("Done")
        return
      }
      sp.start("Pushing…")
      const local = JSON.parse(readFileSync(filePath, "utf-8"))
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }

      let jsonContent: any
      if (local.json_content) jsonContent = local.json_content
      else if (local.components) jsonContent = local
      else {
        sp.stop("Failed", 1)
        prompts.log.error("No 'json_content' or 'components' in file")
        prompts.outro("Done")
        return
      }

      const updateData: Record<string, unknown> = { json_content: jsonContent }
      if (local.title) updateData.title = local.title
      if (local.seo_title) updateData.seo_title = local.seo_title
      if (local.seo_description) updateData.seo_description = local.seo_description
      if (local.og_image) updateData.og_image = local.og_image

      const res = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify(updateData),
      })
      if (!(await handleApiError(res, "Push page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const cnt = jsonContent?.components?.length ?? 0
      sp.stop(success(`Pushed (${cnt} components, new version)`))
      prompts.outro(dim(`iris pages versions ${args.slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const DiffCmd = cmd({
  command: "diff <slug>",
  describe: "compare local vs remote page",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("dir", { describe: "directory", type: "string", default: "./pages" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Diff ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Comparing…")
    try {
      const filePath = join(pagesDir(args.dir), `${args.slug}.json`)
      if (!existsSync(filePath)) {
        sp.stop("Failed", 1)
        prompts.log.error(`Local file not found: ${filePath}`)
        prompts.outro("Done")
        return
      }
      const local = JSON.parse(readFileSync(filePath, "utf-8"))
      const page = await getBySlug(args.slug, true)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }

      const localContent = local.json_content ?? {}
      const remoteContent = page.json_content ?? {}
      const lEnc = JSON.stringify(localContent, null, 2)
      const rEnc = JSON.stringify(remoteContent, null, 2)

      if (lEnc === rEnc) {
        sp.stop(success("In sync"))
        prompts.outro("Done")
        return
      }
      sp.stop("Differences found")

      printDivider()
      const metaFields = ["title", "seo_title", "seo_description"]
      for (const f of metaFields) {
        const lv = local[f] ?? null
        const rv = page[f] ?? null
        if (lv !== rv) {
          console.log(`  ${UI.Style.TEXT_WARNING}~ ${f}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_DANGER}- remote: ${String(rv ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
          console.log(`    ${UI.Style.TEXT_SUCCESS}+ local:  ${String(lv ?? "(empty)").slice(0, 120)}${UI.Style.TEXT_NORMAL}`)
        }
      }

      const lComps: any[] = localContent.components ?? []
      const rComps: any[] = remoteContent.components ?? []
      console.log()
      console.log(`  ${dim("Components:")}  remote=${rComps.length}  local=${lComps.length}`)
      const max = Math.max(lComps.length, rComps.length)
      for (let i = 0; i < max; i++) {
        const l = lComps[i]
        const r = rComps[i]
        if (l == null) console.log(`  ${UI.Style.TEXT_DANGER}[${i}] removed (was ${r?.type})${UI.Style.TEXT_NORMAL}`)
        else if (r == null) console.log(`  ${UI.Style.TEXT_SUCCESS}[${i}] added (${l?.type})${UI.Style.TEXT_NORMAL}`)
        else if (JSON.stringify(l) !== JSON.stringify(r))
          console.log(`  ${UI.Style.TEXT_WARNING}[${i}] changed (${r?.type} → ${l?.type})${UI.Style.TEXT_NORMAL}`)
      }
      printDivider()
      prompts.outro(dim(`iris pages push ${args.slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PublishCmd = cmd({
  command: "publish <slug>",
  describe: "publish a page",
  builder: (y) => y.positional("slug", { describe: "page slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Publish ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Publishing…")
    try {
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const res = await pagesFetch(`/api/v1/pages/${page.id}/publish`, { method: "POST" })
      if (!(await handleApiError(res, "Publish"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success("Published"))
      console.log(`  ${highlight(publicUrl(args.slug))}`)
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const UnpublishCmd = cmd({
  command: "unpublish <slug>",
  describe: "unpublish a page (back to draft)",
  builder: (y) => y.positional("slug", { describe: "page slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Unpublish ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Unpublishing…")
    try {
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const res = await pagesFetch(`/api/v1/pages/${page.id}/unpublish`, { method: "POST" })
      if (!(await handleApiError(res, "Unpublish"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success("Unpublished (draft)"))
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const CreateCmd = cmd({
  command: "create",
  describe: "create a new page",
  builder: (y) =>
    y
      .option("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("title", { describe: "page title", type: "string", demandOption: true })
      .option("seo-title", { describe: "SEO title", type: "string" })
      .option("seo-description", { describe: "SEO description", type: "string" })
      .option("template", { describe: "template name (landing/product/about/contact)", type: "string" })
      .option("owner-type", { describe: "owner type", type: "string", default: "bloq" })
      .option("owner-id", { describe: "owner ID", type: "number", default: 38 }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Create Page: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Creating…")
    try {
      // Build initial json_content — the API requires it
      const template = args.template ?? "landing"
      const jsonContent = {
        meta: { template, version: 1 },
        theme: {},
        components: [
          {
            type: "HeroSection",
            props: {
              title: args.title,
              subtitle: args["seo-description"] ?? "",
            },
          },
        ],
      }

      const payload: Record<string, unknown> = {
        slug: args.slug,
        title: args.title,
        seo_title: args["seo-title"] ?? args.title,
        seo_description: args["seo-description"],
        owner_type: args["owner-type"],
        owner_id: args["owner-id"],
        status: "draft",
        json_content: jsonContent,
        auto_publish: true,
      }
      const res = await pagesFetch("/api/v1/pages", { method: "POST", body: JSON.stringify(payload) })
      if (!(await handleApiError(res, "Create page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any }
      const p = data?.data ?? data
      sp.stop(success(`Created #${p.id}`))
      printDivider()
      printKV("ID", p.id)
      printKV("Slug", p.slug)
      printKV("Title", p.title)
      printKV("Status", p.status)
      printKV("URL", publicUrl(p))
      printDivider()
      prompts.outro(dim(`iris pages publish ${p.slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ComponentsCmd = cmd({
  command: "components <slug>",
  describe: "list components on a page",
  builder: (y) => y.positional("slug", { describe: "page slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Components: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const page = await getBySlug(args.slug, true)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const components: any[] = page?.json_content?.components ?? []
      sp.stop(`${components.length} component(s)`)
      if (components.length === 0) { prompts.outro("None"); return }
      printDivider()
      components.forEach((c, i) => {
        const preview = c?.props?.title ?? c?.props?.text ?? c?.props?.content ?? ""
        console.log(`  ${dim(`[${i}]`)} ${bold(c.type ?? "?")}  ${dim(c.id ?? "")}`)
        if (preview) console.log(`      ${dim(String(preview).slice(0, 80))}`)
      })
      printDivider()
      prompts.outro(dim(`iris pages set ${args.slug} "components.0.props.title" "..."`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const VersionsCmd = cmd({
  command: "versions <slug>",
  describe: "show version history",
  builder: (y) => y.positional("slug", { describe: "page slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Versions: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const res = await pagesFetch(`/api/v1/pages/${page.id}/versions`)
      if (!(await handleApiError(res, "Versions"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any[] }
      const versions = data?.data ?? []
      sp.stop(`${versions.length} version(s)`)
      if (versions.length === 0) { prompts.outro("None"); return }
      printDivider()
      for (const v of versions) {
        console.log(`  ${bold(`v${v.version_number ?? "?"}`)}  ${dim(v.created_at ?? "")}  ${dim(`by ${v.changed_by ?? "?"}`)}`)
        if (v.change_summary) console.log(`    ${dim(v.change_summary)}`)
      }
      printDivider()
      prompts.outro(dim(`iris pages rollback ${args.slug} --version=N`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const RollbackCmd = cmd({
  command: "rollback <slug>",
  describe: "rollback page to a previous version",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("version", { describe: "version number", type: "number", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Rollback ${args.slug} → v${args.version}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Rolling back…")
    try {
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const res = await pagesFetch(`/api/v1/pages/${page.id}/rollback/${args.version}`, { method: "POST" })
      if (!(await handleApiError(res, "Rollback"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success(`Rolled back to v${args.version}`))
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformPagesCommand = cmd({
  command: "pages",
  aliases: ["genesis"],
  describe: "manage composable pages — list, view, get/set, pull/push/diff, publish, versions",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(ViewCmd)
      .command(GetCmd)
      .command(SetCmd)
      .command(PullCmd)
      .command(PushCmd)
      .command(DiffCmd)
      .command(PublishCmd)
      .command(UnpublishCmd)
      .command(CreateCmd)
      .command(ComponentsCmd)
      .command(VersionsCmd)
      .command(RollbackCmd)
      .demandCommand(),
  async handler() {},
})
