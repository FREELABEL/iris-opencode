import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, resolveUserId, handleApiError, printDivider, printKV, dim, bold, success, highlight, IRIS_API, FL_API } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"
import { profileFromBrand, rebrandJsonContent, type BrandProfile } from "./rebrand"

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
    : `https://freelabel.net/p/${slug}`
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

export async function getBySlug(slug: string, includeJson = false): Promise<any | null> {
  const params = new URLSearchParams({
    include_json: includeJson ? "1" : "0",
    include_drafts: "1",
  })
  const path = `/api/v1/pages/by-slug/${encodeURIComponent(slug)}?${params}`
  // #150147: large-page by-slug intermittently 502s on Railway (slow include_json serialization).
  // GET is idempotent, so retry transient gateway 5xx with backoff — the fl-api cache warms on the
  // first (failed) attempt, so a retry usually lands a fast warm response. Self-contained loop so
  // it doesn't depend on irisFetch's (currently absent) retry plumbing.
  const TRANSIENT = new Set([429, 502, 503, 504])
  let res!: Response
  for (let attempt = 1; attempt <= 4; attempt++) {
    res = await pagesFetch(path)
    if (res.ok || !TRANSIENT.has(res.status) || attempt === 4) break
    await new Promise((r) => setTimeout(r, 300 * attempt + Math.floor(Math.random() * 150)))
  }
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

// Create a page from already-built json_content (reused by `sites clone`).
// Returns the created page record, or null on failure.
export async function createPageFromJson(opts: {
  slug: string
  title: string
  seo_title?: string
  seo_description?: string
  og_image?: string
  owner_type?: string
  owner_id?: number
  json_content: any
  publish?: boolean
  requires_auth?: boolean
}): Promise<any | null> {
  const payload: Record<string, unknown> = {
    slug: opts.slug,
    title: opts.title,
    seo_title: opts.seo_title ?? opts.title,
    seo_description: opts.seo_description,
    og_image: opts.og_image,
    owner_type: opts.owner_type,
    owner_id: opts.owner_id,
    status: "draft",
    json_content: opts.json_content,
  }
  // requires_auth is a top-level page COLUMN (the login gate) — set it at create
  // so the page is auth-gated from the first publish (no follow-up PATCH needed).
  if (opts.requires_auth !== undefined) payload.requires_auth = opts.requires_auth
  const res = await pagesFetch("/api/v1/pages", { method: "POST", body: JSON.stringify(payload) })
  if (!(await handleApiError(res, `Create page ${opts.slug}`))) return null
  const p = ((await res.json()) as { data?: any }).data ?? {}
  if (opts.publish && p?.id) {
    const pub = await pagesFetch(`/api/v1/pages/${p.id}/publish`, { method: "POST" })
    if (await handleApiError(pub, "Publish")) {
      await pagesFetch("/api/internal/cache/purge-page", {
        method: "POST",
        body: JSON.stringify({ slug: opts.slug }),
      }).catch(() => {})
    }
  }
  return p
}

// ============================================================================
// Subcommands
// ============================================================================

// Shared list/search renderer. The /api/v1/pages endpoint supports server-side
// per_page, page and search — previously hardcoded per_page=50 with no way to
// page or search, so any page past the first 50 was undiscoverable (#147317).
async function fetchAndRenderPages(args: {
  "page-type"?: string
  search?: string
  limit?: number
  page?: number
  json?: boolean
}) {
  UI.empty()
  prompts.intro(args.search ? `◈  Pages — search "${args.search}"` : "◈  Pages")
  if (!(await requireAuth())) { prompts.outro("Done"); return }

  const sp = prompts.spinner()
  sp.start("Loading pages…")
  try {
    const params = new URLSearchParams({
      per_page: String(args.limit ?? 50),
      page: String(args.page ?? 1),
      include_json: "0",
      slim: "1",
    })
    if (args.search) params.set("search", args.search)

    const res = await pagesFetch(`/api/v1/pages?${params.toString()}`)
    if (!(await handleApiError(res, "List pages"))) { sp.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
    const json = (await res.json()) as any

    // Laravel paginator meta when present ({ data: { current_page, last_page, total, data: [...] } })
    const meta = json?.data && !Array.isArray(json.data) ? json.data : null
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

    const total = meta?.total ?? pages.length
    const currentPage = meta?.current_page ?? args.page ?? 1
    const lastPage = meta?.last_page ?? 1
    sp.stop(`${pages.length} of ${total} page(s)${lastPage > 1 ? ` — page ${currentPage}/${lastPage}` : ""}`)

    if (args.json) {
      // Back-compat flat array; enumerate via --limit/--page (documented page size + cursor).
      console.log(JSON.stringify(pages, null, 2))
      prompts.outro("Done")
      return
    }
    if (pages.length === 0) {
      prompts.log.warn(args.search ? `No pages match "${args.search}"` : "No pages found")
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
    const hints: string[] = ["iris pages view <slug>"]
    if (currentPage < lastPage) hints.push(`iris pages list --page ${currentPage + 1}`)
    if (!args.search) hints.push("iris pages search <query>")
    prompts.outro(dim(hints.join("  ·  ")))
  } catch (err) {
    sp.stop("Error", 1)
    prompts.log.error(err instanceof Error ? err.message : String(err))
    prompts.outro("Done")
  }
}

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list pages (supports --search, --limit, --page)",
  builder: (y) =>
    y
      .option("page-type", { describe: "filter by template type", type: "string" })
      .option("search", { describe: "filter by title or slug", type: "string" })
      .option("limit", { describe: "results per page", type: "number", default: 50 })
      .option("page", { describe: "page number", type: "number", default: 1 })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    await fetchAndRenderPages(args as any)
  },
})

const SearchCmd = cmd({
  command: "search <query>",
  aliases: ["find"],
  describe: "search pages by title or slug",
  builder: (y) =>
    y
      .positional("query", { describe: "search text (title or slug)", type: "string", demandOption: true })
      .option("limit", { describe: "results per page", type: "number", default: 50 })
      .option("page", { describe: "page number", type: "number", default: 1 })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    await fetchAndRenderPages({ ...(args as any), search: String(args.query) })
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
      if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
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
      .positional("path", { describe: "dot notation path", type: "string" })
      // `pages get` already emits JSON; accept --json for parity with other
      // commands (and to stop agents that reflexively append it from erroring).
      .option("json", { describe: "force JSON output (default for object values)", type: "boolean", default: false }),
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
    if (args.json || typeof value === "object") console.log(JSON.stringify(value, null, 2))
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

      // Top-level page COLUMNS are record fields, NOT json_content paths (#137875).
      // Route them straight to the update endpoint so e.g.
      //   iris pages set <slug> requires_auth true
      // actually gates the page (PublicPageController reads the column) instead of
      // nesting a dead `json_content.requires_auth` key that the gate ignores.
      const PAGE_COLUMNS = new Set(["requires_auth", "status", "title", "seo_title", "seo_description", "og_image"])
      if (PAGE_COLUMNS.has(args.path)) {
        const colVal = parseValue(args.value)
        const colRes = await pagesFetch(`/api/v1/pages/${page.id}`, {
          method: "PUT",
          body: JSON.stringify({ [args.path]: colVal }),
        })
        if (!(await handleApiError(colRes, `Update ${args.path}`))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
        sp.stop(success(`Updated page column ${args.path} = ${JSON.stringify(colVal)}`))
        prompts.outro(dim(`iris pages cache-clear ${args.slug}   # purge the rendered cache so the change takes effect`))
        return
      }

      const json = page.json_content ?? {}
      const parsed = parseValue(args.value)
      setNestedValue(json, args.path, parsed)

      // Validate components if the update touches json_content.components
      if (args.path.startsWith("json_content.components") || args.path === "json_content") {
        const target = args.path === "json_content" ? parsed : json
        const validation = await validateComponents(target)
        if (!validation.valid) {
          sp.stop("Validation failed", 1)
          for (const err of validation.errors) {
            if (err) prompts.log.error(err)
          }
          prompts.outro("Done")
          return
        }
      }

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
  describe: "upload local page JSON to API (auto-drafts for safe preview)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("dir", { describe: "input directory", type: "string", default: "./pages" })
      .option("live", { describe: "skip draft — push directly to live (dangerous)", type: "boolean", default: false })
      .option("publish", { describe: "publish immediately after push", type: "boolean", default: false }),
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

      // Validate component types BEFORE pushing
      const validation = await validateComponents(jsonContent)
      if (!validation.valid) {
        sp.stop("Validation failed", 1)
        for (const err of validation.errors) {
          if (err === "") console.log()
          else prompts.log.error(err)
        }
        prompts.outro("Done")
        return
      }

      const updateData: Record<string, unknown> = { json_content: jsonContent }
      if (local.title) updateData.title = local.title
      if (local.seo_title) updateData.seo_title = local.seo_title
      if (local.seo_description) updateData.seo_description = local.seo_description
      if (local.og_image) updateData.og_image = local.og_image
      if (local.owner_type) updateData.owner_type = local.owner_type
      if (local.owner_id !== undefined) updateData.owner_id = local.owner_id
      // Never send status during push — use publish/unpublish commands instead.
      // Sending status=published here caused the page to briefly publish with OLD content
      // before createVersion saved the new json_content, poisoning the iris-api cache.

      const res = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify(updateData),
      })
      if (!(await handleApiError(res, "Push page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const cnt = jsonContent?.components?.length ?? 0

      // --publish: push + publish in one step
      if (args.publish) {
        const pubRes = await pagesFetch(`/api/v1/pages/${page.id}/publish`, { method: "POST" })
        if (!(await handleApiError(pubRes, "Publish"))) { sp.stop("Pushed but publish failed", 1); prompts.outro("Done"); return }
        // Explicitly purge iris-api cache
        await pagesFetch("/api/internal/cache/purge-page", {
          method: "POST",
          body: JSON.stringify({ slug: args.slug }),
        }).catch(() => {})
        sp.stop(success(`Pushed (${cnt} components) + published`))
        console.log(`  ${highlight(publicUrl(args.slug))}`)
      // Safe-by-default: unpublish after push so live page is untouched
      } else if (!args.live && page.status === "published") {
        await pagesFetch(`/api/v1/pages/${page.id}/unpublish`, { method: "POST" })
        sp.stop(success(`Pushed (${cnt} components) → draft`))

        // Re-fetch to get rotated cache_key for preview URL
        const updated = await getBySlug(args.slug, false)
        if (updated?.cache_key) {
          const token = Buffer.from(`${updated.id}:${updated.cache_key}`).toString("base64")
          const url = `${publicUrl(args.slug)}?preview=true&token=${token}`
          console.log()
          console.log(`  ${highlight("Preview:")} ${url}`)
          console.log()
          console.log(`  ${dim("Share with client, then: iris pages publish " + args.slug)}`)
        }
      } else {
        sp.stop(success(`Pushed (${cnt} components, new version)`))
      }

      prompts.outro("Done")
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
      // Explicitly purge iris-api cache — fl-api's fire-and-forget purge may silently fail
      await pagesFetch("/api/internal/cache/purge-page", {
        method: "POST",
        body: JSON.stringify({ slug: args.slug }),
      }).catch(() => {})
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

const PreviewCmd = cmd({
  command: "preview <slug>",
  describe: "generate a shareable preview URL for a draft page",
  builder: (y) => y.positional("slug", { describe: "page slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Preview ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Generating preview link…")
    try {
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      if (!page.cache_key) {
        sp.stop("No cache_key", 1)
        prompts.log.error("Page has no cache_key — push content first to generate one.")
        prompts.outro("Done")
        return
      }
      const token = Buffer.from(`${page.id}:${page.cache_key}`).toString("base64")
      const url = `${publicUrl(args.slug)}?preview=true&token=${token}`
      sp.stop(success("Preview link ready"))
      console.log()
      console.log(`  ${highlight(url)}`)
      console.log()
      console.log(`  ${dim("Works for anyone, even logged out.")}`)
      console.log(`  ${dim("Link expires when the page is next saved (cache_key rotates).")}`)
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
        version: "1.0",
        type: template,
        theme: { mode: "dark", backgroundColor: "#000000", branding: { name: args.title, primaryColor: "#34d399" } },
        components: [
          {
            type: "Hero",
            id: `${args.slug}-hero`,
            props: {
              themeMode: "dark",
              title: args.title,
              subtitle: args["seo-description"] ?? "",
              labelText: "NEW",
              labelColor: "#34d399",
              textAlign: "center",
            },
          },
          {
            type: "SiteFooter",
            id: `${args.slug}-footer`,
            props: {
              themeMode: "dark",
              brandName: args.title,
              links: [],
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

const DuplicateCmd = cmd({
  command: "duplicate <source>",
  describe: "clone an existing page with a new slug",
  builder: (y) =>
    y
      .positional("source", { describe: "source page slug to clone", type: "string", demandOption: true })
      .option("slug", { describe: "new page slug", type: "string", demandOption: true })
      .option("title", { describe: "new page title (defaults to source title)", type: "string" })
      .option("publish", { describe: "publish immediately", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Duplicate ${args.source} → ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Cloning…")
    try {
      // Fetch source page with full JSON
      const source = await getBySlug(args.source, true)
      if (!source) { sp.stop("Source not found", 1); prompts.outro("Done"); return }

      const jsonContent = source.json_content
      if (!jsonContent) {
        sp.stop("Source has no content", 1)
        prompts.outro("Done")
        return
      }

      // Update title in theme branding if it matches the source title
      if (jsonContent.theme?.branding?.name === source.title && args.title) {
        jsonContent.theme.branding.name = args.title
      }

      const title = args.title ?? source.title
      const payload: Record<string, unknown> = {
        slug: args.slug,
        title,
        seo_title: args.title ? title : source.seo_title,
        seo_description: source.seo_description,
        og_image: source.og_image,
        owner_type: source.owner_type,
        owner_id: source.owner_id,
        status: "draft",
        json_content: jsonContent,
      }
      const res = await pagesFetch("/api/v1/pages", { method: "POST", body: JSON.stringify(payload) })
      if (!(await handleApiError(res, "Create page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any }
      const p = data?.data ?? data
      sp.stop(success(`Cloned → #${p.id}`))

      // Save local file
      const dir = pagesDir("./pages")
      const filePath = join(dir, `${args.slug}.json`)
      const localData = {
        id: p.id,
        slug: args.slug,
        title,
        seo_title: payload.seo_title,
        seo_description: payload.seo_description,
        og_image: payload.og_image,
        status: p.status,
        owner_type: payload.owner_type,
        owner_id: payload.owner_id,
        json_content: jsonContent,
      }
      writeFileSync(filePath, JSON.stringify(localData, null, 2))

      printDivider()
      printKV("ID", p.id)
      printKV("Slug", args.slug)
      printKV("Source", args.source)
      printKV("Components", (jsonContent.components?.length ?? 0).toString())
      printKV("File", filePath)
      printDivider()

      if (args.publish) {
        const pubRes = await pagesFetch(`/api/v1/pages/${p.id}/publish`, { method: "POST" })
        if (await handleApiError(pubRes, "Publish")) {
          await pagesFetch("/api/internal/cache/purge-page", {
            method: "POST",
            body: JSON.stringify({ slug: args.slug }),
          }).catch(() => {})
          console.log(`  ${success("Published")} ${highlight(publicUrl(args.slug))}`)
        }
      } else {
        console.log(`  ${dim("Edit body:")} iris pages set ${args.slug} components[2].props.body "New content"`)
        console.log(`  ${dim("Publish:")}  iris pages push ${args.slug} --publish`)
      }

      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const RebrandCmd = cmd({
  command: "rebrand <source>",
  describe: "clone a page and swap brand identity from a brand profile (PII safety gate)",
  builder: (y) =>
    y
      .positional("source", { describe: "source page slug to clone", type: "string", demandOption: true })
      .option("as", { describe: "new page slug", type: "string", demandOption: true })
      .option("brand", { describe: "brand slug whose profile to apply", type: "string", demandOption: true })
      .option("title", { describe: "new page title (defaults to brand name)", type: "string" })
      .option("owner-type", { describe: "owner type (defaults to source)", type: "string" })
      .option("owner-id", { describe: "owner id (defaults to source)", type: "number" })
      .option("site", { describe: "attach the cloned page to this site id", type: "number" })
      .option("publish", { describe: "publish immediately", type: "boolean", default: false })
      .option("force", { describe: "proceed even if PII leaks are detected", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Rebrand ${args.source} → ${args.as}  ${dim(`(brand: ${args.brand})`)}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading source + brand…")
    try {
      const source = await getBySlug(args.source, true)
      if (!source) { sp.stop("Source not found", 1); prompts.outro("Done"); return }
      const jsonContent = source.json_content
      if (!jsonContent) { sp.stop("Source has no content", 1); prompts.outro("Done"); return }

      let target: BrandProfile
      try {
        target = await profileFromBrand(String(args.brand))
      } catch (e) {
        sp.stop("Brand not found", 1)
        prompts.log.error(e instanceof Error ? e.message : String(e))
        prompts.outro("Done"); return
      }

      sp.message("Rebranding…")
      const { json, leaks } = rebrandJsonContent(jsonContent, target)
      sp.stop(leaks.length ? `${leaks.length} possible leak(s)` : success("Rebranded — clean"))

      // --- Safety gate: refuse to create/publish if source PII survived ---
      if (leaks.length > 0) {
        printDivider()
        for (const l of leaks) {
          console.log(`  ${UI.Style.TEXT_WARNING}⚠${UI.Style.TEXT_NORMAL}  ${bold(l.needle)}  ${dim("at")} ${dim(l.path)}  ${dim(`("${l.value}")`)}`)
        }
        printDivider()
        prompts.log.warn(`Source client data survived. Populate the missing fields on brand "${args.brand}" (iris brands profile set ${args.brand} --file ...) then retry — or pass --force to clone anyway.`)
        if (!args.force) { prompts.outro("Blocked — nothing created"); return }
        prompts.log.warn("--force set: cloning despite leaks")
      }

      const sp2 = prompts.spinner()
      sp2.start("Creating…")
      const title = (args.title as string) ?? target.name ?? source.title
      const payload: Record<string, unknown> = {
        slug: args.as,
        title,
        seo_title: json.seo_title ?? title,
        seo_description: json.seo_description ?? source.seo_description,
        og_image: source.og_image,
        owner_type: (args["owner-type"] as string) ?? source.owner_type,
        owner_id: (args["owner-id"] as number) ?? source.owner_id,
        status: "draft",
        json_content: json,
      }
      const res = await pagesFetch("/api/v1/pages", { method: "POST", body: JSON.stringify(payload) })
      if (!(await handleApiError(res, "Create page"))) { sp2.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any }
      const p = data?.data ?? data
      sp2.stop(success(`Cloned → #${p.id}`))

      // Save local file
      const filePath = join(pagesDir("./pages"), `${args.as}.json`)
      writeFileSync(filePath, JSON.stringify({
        id: p.id, slug: args.as, title,
        seo_title: payload.seo_title, seo_description: payload.seo_description, og_image: payload.og_image,
        status: p.status, owner_type: payload.owner_type, owner_id: payload.owner_id, json_content: json,
      }, null, 2))

      // Optional: attach to a site (sites live on FL_API)
      if (args.site != null) {
        const aRes = await irisFetch(`/api/v1/sites/${args.site}/pages/${p.id}`, { method: "POST" }, FL_API)
        await handleApiError(aRes, "Attach to site")
      }

      printDivider()
      printKV("ID", p.id)
      printKV("Slug", args.as)
      printKV("Brand", args.brand)
      printKV("Leaks", leaks.length === 0 ? success("none") : `${leaks.length} (forced)`)
      printKV("Components", (json.components?.length ?? 0).toString())
      printKV("File", filePath)
      printDivider()

      if (args.publish) {
        const pubRes = await pagesFetch(`/api/v1/pages/${p.id}/publish`, { method: "POST" })
        if (await handleApiError(pubRes, "Publish")) {
          await pagesFetch("/api/internal/cache/purge-page", { method: "POST", body: JSON.stringify({ slug: args.as }) }).catch(() => {})
          console.log(`  ${success("Published")} ${highlight(publicUrl(args.as))}`)
        }
      } else {
        console.log(`  ${dim("Review:")}  ${publicUrl(args.as)}`)
        console.log(`  ${dim("Publish:")} iris pages publish ${args.as}`)
      }
      prompts.outro("Done")
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
      if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
      const res = await pagesFetch(`/api/v1/pages/${page.id}/versions`)
      if (!(await handleApiError(res, "Versions"))) { sp.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any }
      // Bug #57236: API may return {} or {data: {}} instead of an array — normalize
      const raw = data?.data
      const versions: any[] = Array.isArray(raw) ? raw : (typeof raw === "object" && raw !== null ? Object.values(raw) : [])
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
      if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
      const res = await pagesFetch(`/api/v1/pages/${page.id}/rollback/${args.version}`, { method: "POST" })
      if (!(await handleApiError(res, "Rollback"))) {
        sp.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(`Version ${args.version} not found for page "${args.slug}". Run: iris pages versions ${args.slug}`)
        prompts.outro("Done")
        return
      }
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
// Component Validation — reject invalid types before push/create
//
// SINGLE SOURCE OF TRUTH: .schema.json files in iris-api PageBuilder directory.
// The CLI fetches valid types from the API at /v1/pages/schema-registry.
// Fallback to a hardcoded set if the API is unreachable.
// ============================================================================

// Fallback list — only used when API is unreachable.
// Auto-generated from 152 .schema.json files in PageBuilder/
const FALLBACK_COMPONENT_TYPES = new Set([
  "ActivityFeed", "AgencyHero", "AgentCompatibilityStrip", "AgentExamples", "AllCasesGrid", "AnnouncementBanner",
  "ApexChart", "AppDownloadCard", "AppDownloadGrid", "ArticleAuthorBlock", "ArticleBodyBlock", "ArticleHeroBlock",
  "BeforeAfter", "BenefitsSection", "BlogGrid", "BookingCalendar", "BookingWizard", "ButtonCTA",
  "CareersListing", "CaseCard", "CaseEconomics", "CaseEditorChatPanel", "CaseEditorContent", "CaseEditorModal",
  "CaseEditorSidebar", "CasePipelineBoard", "CaseSlidePanel", "CategoryFilterBar", "ChatPanel", "ClientGrid",
  "CodeShowcase", "CommunityCTA", "ComparisonCards", "ComparisonMatrix", "ContactSection", "DataChart",
  "DataTable", "DemandTracker", "EarningsTable", "EditorialComparison", "EditorialSection", "EnrollmentForm",
  "EventAdminPanel", "EventCalendar", "EventGrid", "EventHeroBlock", "EventStaffBlock", "EventTicketsBlock",
  "EventVendorsBlock", "FAQAccordion", "FeatureCardsGrid", "FeatureComparisonTable", "FeatureGrid", "FeatureIconsGrid",
  "FeatureShowcase", "FeatureTabs", "FeedCard", "FeedFilterBar", "FeedHero", "FeedLayout",
  "FeedSidebar", "FileUpload", "FilterTabBar", "FundingTiers", "GettingStartedSteps", "Hero",
  "IconBlockGrid", "ImageBanner", "ImageBlock", "ImageGallery", "InstagramFeed", "InstallInstructions",
  "IntegrationsGrid", "IrisNavigation", "JumbotronHero", "KanbanBoard", "LeadershipGrid", "LogoMarquee",
  "LogoStrip", "MapSection", "MarketingHero", "MembershipCards", "NewsletterBodyBlock", "NewsletterHeaderBlock",
  "NewsletterSignup", "NodeSpecsGrid", "OrderConfirmation", "PortfolioGallery", "PortfolioGrid", "PricingPlans",
  "PricingRows", "PricingTiers", "ProcessSteps", "ProcessTimeline", "ProductCard", "ProductDetailCard",
  "ProductGrid", "ProductQuickView", "ProductReviews", "ProductShowcase", "ProfileContent", "ProfileEvents",
  "ProfileHeader", "ProfileMemberships", "ProfileServices", "ProfileSocialFeed", "ProfileTwitchEmbed", "ProgressTracker",
  "ProjectTimeline", "PromoBanner", "ProtectionPicker", "QuickActions", "QuoteBlock", "RoleSelector",
  "ScatteredImageHero", "ScrollShowcase", "Section", "ServiceDetail", "ServiceListing", "ServiceMenu",
  "ServicesGrid", "ShopNavigation", "ShoppingCart", "SiteFooter", "SiteNavigation", "SkillsGrid",
  "SplitAccordion", "SplitContent", "StatsCounter", "StatsSection", "StepWizard", "Survey",
  "TaskQueueList", "TeamSection", "TestimonialBlock", "TestimonialsSection", "TextBlock", "TimelineCarousel",
  "UnifiedCheckout", "ValuePillars", "VariantSelector", "VehicleCard", "VehicleGrid", "VideoBlock",
  "WidgetAreaChartCard", "WidgetChecklistCard", "WidgetProjectCard", "WidgetStatsRow", "WidgetTeamGrid", "WidgetWorkspaceBanner",
  "WorkflowTrigger", "WorkspaceStudio",
])

let _cachedValidTypes: Set<string> | null = null

/**
 * Fetch valid component types from the API schema registry.
 * Falls back to hardcoded set if API is unreachable.
 */
async function getValidComponentTypes(): Promise<Set<string>> {
  if (_cachedValidTypes) return _cachedValidTypes

  try {
    const { IRIS_API } = await import("./iris-api")
    const res = await irisFetch("/api/v1/pages/schema-registry", {}, IRIS_API)
    if (res.ok) {
      const body = (await res.json()) as any
      const types: string[] = body?.data?.types ?? []
      if (types.length > 0) {
        _cachedValidTypes = new Set(types)
        return _cachedValidTypes
      }
    }
  } catch {
    // API unreachable — use fallback
  }

  _cachedValidTypes = FALLBACK_COMPONENT_TYPES
  return _cachedValidTypes
}

async function validateComponents(jsonContent: any): Promise<{ valid: boolean; errors: string[] }> {
  const validTypes = await getValidComponentTypes()
  const components = jsonContent?.components ?? []
  const errors: string[] = []

  for (let i = 0; i < components.length; i++) {
    const c = components[i]
    if (!c?.type) {
      errors.push(`components[${i}]: missing "type" field`)
      continue
    }
    if (!validTypes.has(c.type)) {
      errors.push(`components[${i}]: "${c.type}" is not a valid component type`)
    }
    if (!c.id) {
      errors.push(`components[${i}] (${c.type}): missing "id" field`)
    }
  }

  if (errors.length > 0) {
    errors.push("")
    errors.push(`Valid types: ${[...validTypes].join(", ")}`)
    errors.push(`Run: iris pages component-registry`)
  }

  return { valid: errors.length === 0, errors }
}

// ============================================================================
// Component Registry — available component types for the page builder
// ============================================================================

const COMPONENT_REGISTRY: { type: string; description: string; requiredProps: string[] }[] = [
  // Core layout
  { type: "Hero", description: "Full-width hero banner with title, subtitle, CTA buttons", requiredProps: ["title"] },
  { type: "SiteNavigation", description: "Top navigation bar with logo, links, CTA button", requiredProps: ["logo"] },
  { type: "SiteFooter", description: "Footer with brand name, links, copyright", requiredProps: ["copyright"] },
  { type: "TextBlock", description: "Markdown/rich text content block", requiredProps: ["content"] },
  { type: "AnnouncementBanner", description: "Dismissible banner strip at top of page", requiredProps: ["text"] },
  // Content sections
  { type: "FeatureShowcase", description: "Feature highlights with icons and descriptions", requiredProps: ["features"] },
  { type: "FeatureTabs", description: "Tabbed feature showcase with images", requiredProps: ["tabs"] },
  { type: "FeatureGrid", description: "Icon grid with stat callouts", requiredProps: ["features"] },
  { type: "FeatureIconsGrid", description: "Simple icon + text feature grid", requiredProps: [] },
  { type: "ScrollShowcase", description: "Full-width scrolling cards with images (service pages)", requiredProps: ["items"] },
  { type: "ProcessSteps", description: "Numbered process steps with icons and callouts", requiredProps: ["heading", "steps"] },
  { type: "StatsSection", description: "Key metrics/stats with optional image", requiredProps: ["stats"] },
  { type: "StatsCounter", description: "Animated stat counters", requiredProps: ["stats"] },
  { type: "BenefitsSection", description: "Benefit cards with icons", requiredProps: [] },
  { type: "GettingStartedSteps", description: "Numbered getting started guide", requiredProps: [] },
  { type: "SplitContent", description: "Side-by-side text + image section", requiredProps: [] },
  { type: "EditorialSection", description: "Long-form editorial content block", requiredProps: [] },
  { type: "QuoteBlock", description: "Pull quote with attribution and CTA", requiredProps: ["quote"] },
  { type: "FAQAccordion", description: "Collapsible FAQ section", requiredProps: ["items"] },
  { type: "CommunityCTA", description: "Community join CTA (Discord, etc.)", requiredProps: [] },
  // Media
  { type: "ImageBlock", description: "Single image with caption", requiredProps: ["imageUrl"] },
  { type: "VideoBlock", description: "Embedded video player", requiredProps: ["videoUrl"] },
  { type: "BeforeAfter", description: "Before/after image slider comparison", requiredProps: ["beforeImage", "afterImage"] },
  { type: "PortfolioGallery", description: "Image/project gallery grid with lightbox", requiredProps: ["items"] },
  { type: "BlogGrid", description: "Blog post card grid", requiredProps: [] },
  // Social proof
  { type: "TestimonialsSection", description: "Customer testimonials (text, name, role, rating)", requiredProps: ["testimonials"] },
  { type: "TeamSection", description: "Team member grid with photos and roles", requiredProps: ["members"] },
  { type: "LogoMarquee", description: "Auto-scrolling logo carousel", requiredProps: ["logos"] },
  { type: "ClientGrid", description: "Client/partner logo grid", requiredProps: ["clients"] },
  // Conversion
  { type: "ContactSection", description: "Contact form with configurable fields", requiredProps: ["heading"] },
  { type: "NewsletterSignup", description: "Email signup form", requiredProps: ["heading"] },
  { type: "MapSection", description: "Interactive map with location pin", requiredProps: ["latitude", "longitude"] },
  { type: "PricingTiers", description: "Pricing tier cards with features", requiredProps: ["tiers"] },
  { type: "ComparisonMatrix", description: "Feature comparison table", requiredProps: ["plans", "features"] },
  { type: "ServiceMenu", description: "Service/menu items with prices", requiredProps: ["categories"] },
  // E-commerce
  { type: "ProductGrid", description: "Product cards with prices", requiredProps: ["products"] },
  { type: "ShoppingCart", description: "Shopping cart with line items", requiredProps: [] },
  { type: "OrderConfirmation", description: "Order confirmation/receipt", requiredProps: [] },
  { type: "ProtectionPicker", description: "Protection plan selector", requiredProps: [] },
  { type: "VehicleGrid", description: "Vehicle inventory grid", requiredProps: [] },
  // Events
  { type: "EventGrid", description: "Event cards with dates and venues", requiredProps: ["events"] },
  { type: "FundingTiers", description: "Funding/sponsorship tier cards", requiredProps: ["tiers"] },
  { type: "CareersListing", description: "Job listings with filters", requiredProps: ["jobs"] },
  // Interactive
  { type: "StepWizard", description: "Multi-step form wizard", requiredProps: ["steps"] },
  { type: "FileUpload", description: "File upload dropzone", requiredProps: [] },
  { type: "BookingWizard", description: "Appointment booking flow", requiredProps: [] },
  { type: "Survey", description: "Survey/questionnaire form", requiredProps: [] },
  // Dashboard widgets
  { type: "WidgetWorkspaceBanner", description: "Dashboard workspace header", requiredProps: [] },
  { type: "WidgetStatsRow", description: "Row of stat cards", requiredProps: ["stats"] },
  { type: "WidgetTeamGrid", description: "Team member widget grid", requiredProps: [] },
  { type: "FilterTabBar", description: "Tab-based filter bar", requiredProps: [] },
  { type: "DataTable", description: "Sortable/searchable data table", requiredProps: ["columns"] },
  { type: "DataChart", description: "Chart visualization (bar, line, pie)", requiredProps: [] },
  { type: "ActivityFeed", description: "Chronological activity feed", requiredProps: ["items"] },
  { type: "QuickActions", description: "Quick action button grid", requiredProps: ["actions"] },
  { type: "CasePipelineBoard", description: "Kanban-style case pipeline", requiredProps: [] },
  { type: "TaskQueueList", description: "Task queue with status badges", requiredProps: ["tasks"] },
  { type: "ProgressTracker", description: "Step-by-step progress tracker", requiredProps: ["steps"] },
  { type: "CaseCard", description: "Individual case summary card", requiredProps: [] },
  { type: "DemandTracker", description: "Demand/settlement tracker", requiredProps: [] },
  { type: "CaseEconomics", description: "Case financial breakdown", requiredProps: ["lineItems"] },
]

const ComposeCmd = cmd({
  command: "compose <description..>",
  describe: "AI-compose a page from a text description (uses Gemini)",
  builder: (y) =>
    y
      .positional("description", { describe: "what the page should be", type: "string", array: true })
      .option("slug", { describe: "page slug (auto-generated if omitted)", type: "string" })
      .option("title", { describe: "page title", type: "string" })
      .option("theme", { describe: "dark or light", type: "string", default: "dark", choices: ["dark", "light"] })
      .option("style", { describe: "page style", type: "string", default: "landing", choices: ["landing", "dashboard", "product", "portfolio"] })
      .option("model", { describe: "AI model override", type: "string" })
      .option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    const desc = (args.description as string[]).join(" ")
    prompts.intro(`◈  Compose Page`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const userId = await resolveUserId()
    if (!userId) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Composing with AI (this may take 10-30s)…")

    try {
      const payload: Record<string, unknown> = {
        description: desc,
        user_id: userId,
        style: args.style,
        theme_mode: args.theme,
      }
      if (args.slug) payload.slug = args.slug
      if (args.title) payload.title = args.title
      if (args.model) payload.model = args.model

      const res = await pagesFetch("/api/v1/pages/compose", {
        method: "POST",
        body: JSON.stringify(payload),
      })

      if (!res.ok) {
        const body = await res.json().catch(() => ({})) as any
        sp.stop("Failed", 1)
        prompts.log.error(body.error ?? body.message ?? `HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as any
      if (!data.success) {
        sp.stop("Failed", 1)
        prompts.log.error(data.error ?? "Composition failed")
        prompts.outro("Done")
        return
      }

      sp.stop(success(`Created "${data.slug}"`))
      printDivider()
      printKV("Page ID", data.page_id)
      printKV("Slug", data.slug)
      printKV("URL", data.url)
      printKV("Components", data.component_count ?? data.components?.length)
      if (data.self_heal_attempts) printKV("Self-heal attempts", data.self_heal_attempts)
      printDivider()

      if (args.json) {
        console.log(JSON.stringify(data, null, 2))
      }

      prompts.log.info(`View: ${dim(`iris pages view ${data.slug}`)}`)
      prompts.log.info(`Edit: ${dim(`iris pages pull ${data.slug}`)}`)
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ComponentRegistryCmd = cmd({
  command: "component-registry",
  aliases: ["registry", "available-components"],
  describe: "list available component types for the page builder (fetched from API)",
  builder: (y) => y.option("json", { type: "boolean" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Page Component Registry")

    // Try to fetch from API (single source of truth)
    let registry: { type: string; description: string; category: string; props: any }[] = []
    let source = "api"

    try {
      const { IRIS_API } = await import("./iris-api")
      const res = await irisFetch("/api/v1/pages/schema-registry", {}, IRIS_API)
      if (res.ok) {
        const body = (await res.json()) as any
        const schemas = body?.data?.schemas ?? {}
        registry = Object.values(schemas).map((s: any) => ({
          type: s.type,
          description: s.description ?? "",
          category: s.category ?? "other",
          props: s.props ?? {},
        }))
      }
    } catch {
      source = "fallback"
    }

    // Fallback to hardcoded COMPONENT_REGISTRY
    if (registry.length === 0) {
      source = "fallback"
      registry = COMPONENT_REGISTRY.map(c => ({
        type: c.type,
        description: c.description,
        category: "other",
        props: {},
      }))
    }

    if (args.json) {
      console.log(JSON.stringify(registry, null, 2))
      prompts.outro("Done")
      return
    }

    // Group by category
    const byCategory: Record<string, typeof registry> = {}
    for (const c of registry) {
      const cat = c.category || "other"
      byCategory[cat] = byCategory[cat] || []
      byCategory[cat]!.push(c)
    }

    console.log()
    console.log(`  ${bold("Available components for Genesis pages:")}`)
    console.log(`  ${dim(`Source: ${source} · ${registry.length} components`)}`)
    console.log()

    for (const [category, components] of Object.entries(byCategory).sort()) {
      console.log(`  ${bold(category.toUpperCase())}`)
      for (const c of components) {
        const requiredProps = Object.entries(c.props)
          .filter(([, v]: [string, any]) => v?.required)
          .map(([k]: [string, any]) => k)
        console.log(`    ${highlight(c.type)}`)
        console.log(`      ${dim(c.description)}`)
        if (requiredProps.length) {
          console.log(`      ${dim("Required: " + requiredProps.join(", "))}`)
        }
      }
      console.log()
    }

    prompts.log.info(`Schema source: ${dim(".schema.json files in iris-api/PageBuilder/")}`)
    prompts.log.info(`Add new component: ${dim("create Component.schema.json next to Component.vue")}`)
    prompts.outro("Done")
  },
})

// ============================================================================
// QR Code — generate short URL + QR for any page
// ============================================================================

const QrCmd = cmd({
  command: "qr <slug>",
  describe: "get short URL + QR code for a page",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("size", { type: "number", default: 400, describe: "QR image size in pixels" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  QR Code: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Generating short URL + QR…")
    try {
      const { FL_API } = await import("./iris-api")
      const res = await irisFetch(`/api/v1/pages/${encodeURIComponent(String(args.slug))}/short-url`, {
        method: "POST",
        body: JSON.stringify({ size: args.size }),
      }, FL_API)

      if (!res.ok) {
        const err = await res.text().catch(() => "")
        sp.stop("Failed")
        prompts.log.error(`Failed: ${err || `HTTP ${res.status}`}`)
        prompts.outro("Done")
        return
      }

      const data = ((await res.json()) as any)?.data ?? {}
      sp.stop(success("Ready"))

      if (args.json) {
        console.log(JSON.stringify(data, null, 2))
        prompts.outro("Done")
        return
      }

      console.log()
      console.log(`  ${bold("Page")}:       ${publicUrl(String(args.slug))}`)
      console.log(`  ${bold("Short URL")}: ${highlight(data.short_url)}`)
      console.log(`  ${bold("QR Image")}:  ${dim(data.qr_url)}`)
      console.log(`  ${bold("QR Download")}: ${dim(data.qr_download)}`)
      console.log()
      prompts.log.info(`Open QR in browser: ${dim(data.qr_url)}`)
      prompts.log.info(`Download PNG:       ${dim(data.qr_download)}`)

      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Screenshot
// ============================================================================

const ScreenshotCmd = cmd({
  command: "screenshot <slug>",
  aliases: ["snap", "ss"],
  describe: "capture a full-page screenshot of a rendered page via Playwright",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .option("width", { type: "number", default: 1440, describe: "viewport width" })
      .option("out", { type: "string", describe: "output path (default: ./pages/<slug>.png)" })
      .option("open", { type: "boolean", default: true, describe: "open image after capture" }),
  async handler(args) {
    UI.empty()
    const slug = String(args.slug)
    prompts.intro(`◈  Screenshot: ${slug}`)

    const sp = prompts.spinner()
    sp.start("Launching browser…")

    try {
      // playwright is an optional runtime dep (huge + browser binaries), not
      // bundled — the catch below handles its absence. Cast the specifier so TS
      // doesn't fail resolution (TS2307), which was breaking `bun typecheck`.
      const { chromium } = await import("playwright" as string)
      const url = publicUrl(slug)
      const outDir = join(process.cwd(), "pages")
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
      const outPath = args.out ? String(args.out) : join(outDir, `${slug}.png`)

      const browser = await chromium.launch()
      const page = await browser.newPage({ viewport: { width: args.width, height: 900 } })

      sp.message(`Navigating to ${url}…`)
      await page.goto(url, { waitUntil: "networkidle" })
      await page.waitForTimeout(2000)

      sp.message("Capturing…")
      await page.screenshot({ path: outPath, fullPage: true })
      await browser.close()

      sp.stop("Captured")
      prompts.log.success(`Saved: ${outPath}`)
      prompts.log.info(`URL: ${url}`)

      if (args.open) {
        const { exec } = await import("child_process")
        exec(`open "${outPath}"`)
      }

      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      if (e.message?.includes("Cannot find module") || e.message?.includes("playwright")) {
        prompts.log.error("Playwright not installed. Run: npm install playwright")
      } else {
        prompts.log.error(e.message ?? String(e))
      }
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Cache Clear — purge rendered page cache on iris-api
// ============================================================================

const CacheClearCmd = cmd({
  command: "cache-clear [slug]",
  aliases: ["cc", "purge"],
  describe: "purge the rendered page cache on production (slug or --all)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", describe: "page slug to purge" })
      .option("all", { type: "boolean", default: false, describe: "flush ALL page caches" }),
  async handler(args) {
    UI.empty()
    const slug = args.slug ? String(args.slug) : null
    if (!slug && !args.all) {
      prompts.log.error("Provide a slug or --all")
      prompts.outro("Done")
      return
    }

    prompts.intro(`◈  Cache clear${slug ? `: ${slug}` : " (all pages)"}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Purging…")
    try {
      const body: Record<string, unknown> = {}
      if (slug) body.slug = slug
      if (args.all) body.flush_all_html = true

      const res = await irisFetch("/api/internal/cache/purge-page", {
        method: "POST",
        body: JSON.stringify(body),
      }, IRIS_API)

      if (!res.ok) {
        sp.stop("Failed")
        prompts.log.error(`HTTP ${res.status}`)
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as { purged?: string[] }
      sp.stop(success("Purged"))
      for (const entry of data.purged ?? []) {
        prompts.log.success(entry)
      }
      if (slug) {
        prompts.log.info(`Verify: ${dim(publicUrl(slug))}`)
      }
      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Reassign — change page ownership (owner_type + owner_id)
// ============================================================================

const ReassignCmd = cmd({
  command: "reassign <slug>",
  aliases: ["chown"],
  describe: "change page ownership (owner_type + owner_id)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("owner-type", { describe: "owner type", type: "string", choices: ["system", "user", "bloq", "lead"], demandOption: true })
      .option("owner-id", { describe: "owner ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Reassign ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Updating ownership…")
    try {
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Page not found", 1); prompts.outro("Done"); return }

      const ownerType = args["owner-type"] as string
      const ownerId = ownerType === "system" ? null : args["owner-id"]
      if (ownerType !== "system" && !ownerId) {
        sp.stop("Failed", 1)
        prompts.log.error("--owner-id is required for non-system owner types")
        prompts.outro("Done")
        return
      }

      const updateData: Record<string, unknown> = { owner_type: ownerType, owner_id: ownerId }
      const res = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify(updateData),
      })
      if (!(await handleApiError(res, "Reassign"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const updated = ((await res.json()) as any).data ?? {}
      sp.stop(success(`Reassigned to ${ownerType}:${ownerId ?? "null"}`))
      printDivider()
      printKV("Page", `${updated.slug ?? args.slug} (#${updated.id ?? page.id})`)
      printKV("Owner Type", updated.owner_type)
      printKV("Owner ID", updated.owner_id ?? "null")
      printDivider()
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
  describe: "manage composable pages — list, view, get/set, pull/push/diff, publish, preview, versions, qr, screenshot",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(SearchCmd)
      .command(ViewCmd)
      .command(GetCmd)
      .command(SetCmd)
      .command(PullCmd)
      .command(PushCmd)
      .command(DiffCmd)
      .command(PublishCmd)
      .command(UnpublishCmd)
      .command(PreviewCmd)
      .command(CreateCmd)
      .command(DuplicateCmd)
      .command(RebrandCmd)
      .command(ComponentsCmd)
      .command(ComposeCmd)
      .command(ComponentRegistryCmd)
      .command(VersionsCmd)
      .command(RollbackCmd)
      .command(QrCmd)
      .command(ScreenshotCmd)
      .command(ReassignCmd)
      .command(CacheClearCmd)
      .demandCommand(),
  async handler() {},
})
