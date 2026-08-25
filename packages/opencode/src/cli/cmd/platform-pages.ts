import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import { buildListEnvelope, projectFields, LIST_FIELDS } from "./list-envelope"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, resolveUserId, handleApiError, isNonInteractive, printDivider, printKV, dim, bold, success, highlight, IRIS_API, FL_API, writeJson } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join, resolve, dirname } from "path"
import { profileFromBrand, rebrandJsonContent, type BrandProfile } from "./rebrand"
import { LibraryCmd } from "./platform-components"

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
  // Same normalisation as setNestedValue — otherwise `get` walks the dead string key a
  // broken `set` created and cheerfully confirms it (#181119).
  const parts = normalizePathIndexes(path).split(".")
  let cur: any = obj
  for (const p of parts) {
    if (cur == null) return undefined
    const idx = /^\d+$/.test(p) ? Number(p) : p
    cur = cur[idx as any]
  }
  return cur
}

/**
 * Pull the version rows out of whatever `/pages/{id}/versions` returns (#179314).
 *
 * It returns a LARAVEL PAGINATOR: `{ current_page, data: [...], first_page_url, last_page,
 * links, next_page_url, path, per_page, ... }`. The previous code fell back to
 * `Object.values(raw)` for any object, so it enumerated the paginator's OWN FIELDS — reporting
 * "13 version(s)" when 13 was the number of envelope keys, printing `v?` for the scalars, and
 * then throwing `null is not an object` on `next_page_url: null`.
 *
 * The count was wrong before it ever crashed, which is the worse half: a version list you
 * cannot read is obvious, a version COUNT that is silently the wrong thing is not. Handles the
 * bare array and the `{data: {data: []}}` double-wrap too, since this API does both elsewhere.
 */
export function extractVersions(raw: unknown): Record<string, any>[] {
  const rows = Array.isArray(raw)
    ? raw
    : raw !== null && typeof raw === "object" && Array.isArray((raw as any).data)
      ? (raw as any).data
      : []
  return rows.filter((v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v))
}

/** Append tokens: `foo.-1`, `foo.+` and `foo.[]` all mean "push onto this array". */
const APPEND_TOKENS = new Set(["-1", "+", "[]"])

/**
 * Normalise bracket indexing into dot segments: `components[4].props.x` -> `components.4.props.x`.
 *
 * Without this, `components[4]` was a STRING KEY. `iris pages set <slug>
 * "components[4].props.leadBloqId" 359` wrote a dead `json_content["components[4]"]` that
 * nothing renders, printed "Updated", and `pages get` walked the same dead path so it read
 * 359 straight back and agreed with itself (#181119). 51 green ticks, 17 client pages, zero
 * writes.
 *
 * Append tokens survive: `foo[]` -> `foo.[]`, `foo[-1]` -> `foo.-1`.
 */
export function normalizePathIndexes(path: string): string {
  return path.replace(/(?<!\.)\[([^\]]*)\]/g, (_m, inner: string) => (inner === "" ? ".[]" : `.${inner}`))
}

/**
 * Strip a redundant leading `json_content.` from a `pages set` path.
 *
 * The nested writer below is already rooted AT json_content, so `json_content.requireOtp`
 * addressed `json_content.json_content.requireOtp` — a dead key. The write "succeeded", and
 * the read-back verifier resolved the same dead path, found what it had just written, and
 * confirmed it. An instrument agreeing with itself (#181940).
 *
 * Stripped rather than refused: everyone who typed the prefix meant the key inside
 * json_content, and there is nothing else it could have addressed.
 */
export function normaliseSetPath(path: string): { path: string; stripped: boolean } {
  const PREFIX = "json_content."
  if (path.startsWith(PREFIX) && path.length > PREFIX.length) {
    return { path: path.slice(PREFIX.length), stripped: true }
  }
  return { path, stripped: false }
}

/**
 * Is this page gated, and by which flag?
 *
 * The OTP gate is TWO flags with different names in different places — the `requires_auth`
 * COLUMN and `requireOtp` inside json_content — and fl-api re-derives the column from the
 * key on write. Anything that asks "is this gated" while reading one of them gets the right
 * answer only by luck, which is most of #181940. One reader, both flags.
 */
export function pageGateFlags(page: { requires_auth?: unknown; json_content?: any } | null | undefined): {
  gated: boolean
  requiresAuth: boolean
  requireOtp: boolean
  which: string
} {
  const requiresAuth = Boolean(page?.requires_auth)
  const requireOtp = Boolean(page?.json_content?.requireOtp)
  const which = [requiresAuth ? "requires_auth" : null, requireOtp ? "json_content.requireOtp" : null]
    .filter(Boolean)
    .join(" + ")

  return { gated: requiresAuth || requireOtp, requiresAuth, requireOtp, which }
}

export function setNestedValue(obj: any, path: string, value: unknown): void {
  const parts = normalizePathIndexes(path).split(".")
  let cur: any = obj
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i]
    const key = /^\d+$/.test(p) ? Number(p) : p
    // An intermediate index past the end of an array would extend it with holes and
    // invent an element nobody asked for. The last-segment branch below already refuses
    // this; the traversal did not, which is how `components[9]` on a 9-component page
    // (max index 8) reported success.
    if (Array.isArray(cur) && typeof key === "number" && key > cur.length) {
      throw new Error(
        `Index ${key} is out of range at "${path}" — the array has ${cur.length} item(s) (max index ${cur.length - 1}). Use -1 to append.`,
      )
    }
    if (cur[key as any] == null || typeof cur[key as any] !== "object") {
      const nextIsIndex = /^\d+$/.test(parts[i + 1])
      cur[key as any] = nextIsIndex ? [] : {}
    }
    cur = cur[key as any]
  }

  const last = parts[parts.length - 1]

  // APPEND. Previously `-1` fell through to the string-key branch below, because
  // /^\d+$/ does not match a leading minus. That set a NON-INDEX property on the array
  // — which JSON.stringify drops — so the command reported success and wrote nothing.
  // A write path that prints "Updated" after changing nothing is worse than one that
  // errors, because the natural next move is to trust it.
  if (APPEND_TOKENS.has(last)) {
    if (!Array.isArray(cur)) {
      throw new Error(`Cannot append at "${path}" — the target is ${cur === null ? "null" : typeof cur}, not an array.`)
    }
    cur.push(value)
    return
  }

  if (Array.isArray(cur)) {
    // A numeric index is fine, including one position past the end (that is an append).
    // Anything else would become a property the array ignores, so refuse it rather than
    // pretend. Out-of-range past the end would create holes; say so.
    if (!/^\d+$/.test(last)) {
      throw new Error(
        `Cannot set "${last}" on an array at "${path}" — use a numeric index, or -1 to append.`,
      )
    }
    const idx = Number(last)
    if (idx > cur.length) {
      throw new Error(
        `Index ${idx} is past the end of the array at "${path}" (length ${cur.length}) — use -1 to append.`,
      )
    }
    cur[idx] = value
    return
  }

  cur[/^\d+$/.test(last) ? Number(last) : last] = value
}

function pagesDir(custom?: string): string {
  return custom ?? join(process.cwd(), "pages")
}

/**
 * #181601 — the directory you happen to be standing in decides what ships.
 *
 * `pagesDir` resolves ./pages from the CWD. fl-iris-api contains its own stale six-file
 * `pages/` next to the workspace's canonical 190, so a persisted `cd` into that repo made
 * `iris pages push docs` ship an Aug-17 shadow copy over the live page — and print "Done".
 * Nothing in the output named a path, so there was no way to see which of the two it had
 * read. That is the whole defect: not that it picked wrong, but that picking wrong and
 * picking right looked identical.
 *
 * The workspace root is the directory holding BOTH `pages/` and `daily-diary/`. If that
 * exists and is not the directory we are about to read, the local file is almost certainly
 * a shadow. Return both so the caller can show them and refuse.
 */
export function detectShadowPagesDir(usedDir: string, from: string = process.cwd()): { canonical: string } | null {
  let d = from

  for (let i = 0; i < 8; i++) {
    if (existsSync(join(d, "pages")) && existsSync(join(d, "daily-diary"))) {
      const canonical = join(d, "pages")
      return resolve(canonical) === resolve(usedDir) ? null : { canonical }
    }
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }

  return null
}

/**
 * Accept a file path where a slug is expected.
 *
 * `pull` writes `./pages/<slug>.json`, so the obvious next move is to hand that
 * path straight back to `push` — and every slug-positional command then rebuilt
 * the path around it and looked for `./pages/pages/<slug>.json.json`. The error
 * said "Local file not found" and advised `pull` (which had already been run),
 * so the one thing it never mentioned was the actual mistake.
 *
 * Nothing is lost by accepting both: a real slug can contain neither `/` nor a
 * `.json` suffix, so this is unambiguous rather than a guess.
 *
 * Returns the normalized slug and whether it changed, so callers can say so.
 */
export function normalizeSlugArg(input: string): { slug: string; corrected: boolean } {
  const trimmed = input.trim()
  // Basename, then drop a .json extension. Handles "pages/x.json", "./pages/x.json", "x.json".
  const base = trimmed.split("/").pop() ?? trimmed
  const slug = base.endsWith(".json") ? base.slice(0, -".json".length) : base
  return { slug, corrected: slug !== trimmed }
}

/** Print the "I took a path, using the slug" note. Keeps the wording in one place. */
function noteSlugCorrection(original: string, slug: string) {
  prompts.log.info(dim(`Read "${original}" as slug "${slug}" — these commands take a slug, not a file path.`))
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
      // Was a back-compat flat array. That back-compat is what hid truncation: a
      // page of results that looks like the whole set produces confident wrong
      // answers. The envelope names what is withheld and how to get the rest.
      await writeJson(
        buildListEnvelope(projectFields(pages, LIST_FIELDS.pages), {
          total,
          limit: pages.length,
          resource: "pages",
        }),
      )
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
      const vis = readVisibility(p)
      const visNote = vis.declared && vis.mode !== "public" ? `  ${formatVisibility(vis)}` : ""
      console.log(`  ${bold(p.slug)}  ${dim(`#${p.id}`)}  ${formatStatus(p.status)}${visNote}`)
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
        await writeJson(page)
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
      await writeJson(json)
      return
    }
    const value = getNestedValue(json, args.path)
    if (value === undefined || value === null) {
      console.error(`Path '${args.path}' not found in '${args.slug}'`)
      process.exit(1)
    }
    if (args.json || typeof value === "object") await writeJson(value)
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

      // A leading `json_content.` is REDUNDANT here and used to be silently destructive
      // (#181940). The nested write below is already rooted AT json_content, so
      // `set <slug> json_content.requireOtp false` wrote json_content.json_content.requireOtp
      // — a dead key — while the read-back verifier resolved that same dead path, found the
      // value it had just written, and reported success. The instrument agreed with itself.
      //
      // That is the whole reason #181940 was filed as "the gate cannot be lifted": the
      // documented two-command fix included this exact path, so the OTP flag never moved and
      // the CLI said it had. Strip the prefix rather than refuse — every caller who typed it
      // meant the key inside json_content, and there is no other thing they could have meant.
      {
        const norm = normaliseSetPath(args.path)
        if (norm.stripped) {
          prompts.log.info(`Path is already rooted at json_content — using '${norm.path}'.`)
          args.path = norm.path
        }
      }

      // Top-level page COLUMNS are record fields, NOT json_content paths (#137875).
      // Route them straight to the update endpoint so e.g.
      //   iris pages set <slug> requires_auth true
      // actually gates the page (PublicPageController reads the column) instead of
      // nesting a dead `json_content.requires_auth` key that the gate ignores.
      // Real record columns. `visibility` and `owner_*` were missing here, which meant
      // `iris pages set <slug> visibility public` nested a dead json_content key instead of
      // changing the column — the same #137875 failure the comment above describes.
      const PAGE_COLUMNS = new Set([
        "requires_auth", "status", "title", "seo_title", "seo_description", "og_image",
        "visibility", "slug", "owner_type", "owner_id",
      ])

      // IMMUTABLE. The API accepts a PUT carrying owner_id, returns 200, and does not apply
      // it — the write-verifier below then catches the mismatch and reports "Not applied",
      // which is honest but late: the caller has already been told the request went through
      // and has to reason about a 200 that meant nothing (#181940). Refuse up front and name
      // the command that CAN do it. Ownership moves through reassign, which updates
      // owner_type and owner_id together — the pair, because either alone is a broken record.
      if (args.path === "owner_id" || args.path === "owner_type") {
        sp.stop("Refused", 1)
        prompts.log.error(
          `'${args.path}' cannot be changed through 'pages set' — the API accepts the request and ignores it.\n\n` +
            `  iris pages reassign ${args.slug} --owner-type bloq --owner-id <id>`,
        )
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      // Legitimate TOP-LEVEL json_content keys. Anything else with no dot is almost certainly
      // a column the caller expected to exist — nesting it silently is how
      // `set <slug> thumbnail_url ""` reported "Updated thumbnail_url" while writing a dead
      // `json_content.thumbnail_url` that nothing reads (#179802). Refuse rather than guess.
      const JSON_TOP_KEYS = new Set(["version", "type", "theme", "layout", "components", "requireOtp"])
      if (!args.path.includes(".") && !PAGE_COLUMNS.has(args.path) && !JSON_TOP_KEYS.has(args.path)) {
        sp.stop("Refused", 1)
        prompts.log.error(
          `'${args.path}' is not a page column and not a known json_content key.\n` +
            `Writing it here would nest a dead key that nothing reads.\n\n` +
            `  Columns:      ${[...PAGE_COLUMNS].sort().join(", ")}\n` +
            `  json_content: ${[...JSON_TOP_KEYS].sort().join(", ")}\n\n` +
            `If you really meant a nested value, be explicit: json_content.${args.path}`,
        )
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      if (PAGE_COLUMNS.has(args.path)) {
        const colVal = parseValue(args.value)
        const colRes = await pagesFetch(`/api/v1/pages/${page.id}`, {
          method: "PUT",
          body: JSON.stringify({ [args.path]: colVal }),
        })
        if (!(await handleApiError(colRes, `Update ${args.path}`))) { sp.stop("Failed", 1); prompts.outro("Done"); return }

        // VERIFY THE WRITE LANDED (#179802). This printed "Updated" on a page whose slug did
        // not even resolve. Re-read the record and compare rather than trusting the 200.
        let landed: unknown = undefined
        try {
          const fresh = await getBySlug(args.slug, false)
          if (fresh) landed = (fresh as any)[args.path]
        } catch { /* unreadable — fall through to the honest warning below */ }

        if (landed !== undefined && String(landed) !== String(colVal)) {
          sp.stop("Not applied", 1)
          prompts.log.error(
            `The API accepted the request but ${args.path} is still ${JSON.stringify(landed)}, not ${JSON.stringify(colVal)}.`,
          )
          process.exitCode = 1
          prompts.outro("Done")
          return
        }
        sp.stop(success(`Updated page column ${args.path} = ${JSON.stringify(colVal)}`))
        if (landed === undefined) {
          prompts.log.warn(`Could not read the page back to confirm. Check: iris pages view ${args.slug}`)
        }

        // HALF A GATE IS A GATE (#181940). The OTP gate is TWO flags with different names in
        // different places — the requires_auth column and json_content.requireOtp — and
        // fl-api's PageController::update forces the column back ON whenever requireOtp is
        // still true. So clearing only this one looks like it worked, survives a purge, and
        // the page keeps asking for a code. Say so here rather than let someone re-derive it.
        if (args.path === "requires_auth" && colVal === false && (page.json_content as any)?.requireOtp) {
          prompts.log.warn(
            `json_content.requireOtp is still true, and the server re-applies requires_auth from it.\n` +
              `This page will keep asking for a code. Use the one verb that clears both:\n\n` +
              `  iris pages ungate ${args.slug}`,
          )
        }
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

      // VERIFY THE WRITE LANDED (#181119). This printed "Updated" 51 times across 17 client
      // pages while writing nothing — the path resolved to a dead key, so the PUT succeeded
      // and changed no rendered content. Re-read and compare rather than trusting the 200.
      let landed: unknown = undefined
      let readBack = false
      try {
        const fresh = await getBySlug(args.slug, true)
        if (fresh) {
          landed = getNestedValue(fresh.json_content ?? {}, args.path)
          readBack = true
        }
      } catch { /* unreadable — fall through to the honest warning below */ }

      if (readBack && JSON.stringify(landed) !== JSON.stringify(parsed)) {
        sp.stop("Not applied", 1)
        prompts.log.error(
          `The API accepted the request but ${args.path} reads back as ${JSON.stringify(landed)}, not ${JSON.stringify(parsed)}.`,
        )
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      sp.stop(success(`Updated ${args.path}`))
      if (!readBack) {
        prompts.log.warn(`Could not read the page back to confirm. Check: iris pages get ${args.slug} ${args.path}`)
      }
      prompts.outro(dim(`iris pages cache-clear ${args.slug}   # purge the rendered cache so the change takes effect`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCmd = cmd({
  command: "pull <slug>",
  describe: "download page JSON to ./pages/<slug>.json (overwrites local edits — run `pages diff` first)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug — e.g. `my-page`, not `pages/my-page.json`", type: "string", demandOption: true })
      .option("dir", { describe: "output directory", type: "string", default: "./pages" }),
  async handler(args) {
    const { slug, corrected } = normalizeSlugArg(args.slug)
    UI.empty()
    prompts.intro(`◈  Pull ${slug}`)
    if (corrected) noteSlugCorrection(args.slug, slug)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Fetching…")
    try {
      const page = await getBySlug(slug, true)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const dir = pagesDir(args.dir)
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const filePath = join(dir, `${slug}.json`)
      const exp = {
        id: page.id,
        slug: page.slug,
        title: page.title,
        seo_title: page.seo_title ?? null,
        seo_description: page.seo_description ?? null,
        og_image: page.og_image ?? null,
        status: page.status,
        // Round-trip visibility so the local file is a COMPLETE representation of the
        // page. It was omitted, which made `pull` lossy: nothing downstream could restore
        // it, and a page whose visibility drifted had no CLI path back — `pages visibility`
        // is a separate command a user has no reason to know they now need. Page 318 has
        // been silently demoted to `unlisted` twice this way, and an unlisted page 404s on
        // its /p/{slug} address, so it reads as deleted. (#178609)
        visibility: page.visibility ?? null,
        // Same lossy-pull defect as visibility above, one field over — and this is the
        // field that decides whether the page is readable by strangers. `requires_auth`
        // turns on the OTP email gate; without it here, `pull` → edit → `push` silently
        // returned a gated page to fully open, serving its whole body to anonymous
        // requests. That is exactly how page 395 went public with client material in it
        // (#180009). Round-trip it so an edit cycle cannot drop the gate.
        requires_auth: page.requires_auth ?? false,
        owner_type: page.owner_type ?? "system",
        owner_id: page.owner_id ?? null,
        json_content: page.json_content ?? {},
      }
      writeFileSync(filePath, JSON.stringify(exp, null, 2) + "\n")
      const cnt = exp.json_content?.components?.length ?? 0
      sp.stop(success(`Pulled → ${filePath} (${cnt} components)`))
      prompts.outro(dim(`iris pages push ${slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PushCmd = cmd({
  command: "push <slug>",
  // A push on an already-live page DEMOTES it to draft unless --publish is passed,
  // and a drafted page 404s at its public url. Say that here — it is the single
  // most surprising thing this command does.
  describe: "upload local page JSON (a SLUG, not a path). Live pages drop to draft — pass --publish to keep them up",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug — e.g. `my-page`, not `pages/my-page.json`", type: "string", demandOption: true })
      .option("dir", { describe: "input directory", type: "string", default: "./pages" })
      .option("live", { describe: "skip draft — push directly to live (dangerous)", type: "boolean", default: false })
      .option("publish", { describe: "publish right after push — use this on any page that is already live, or it 404s until you publish", type: "boolean", default: false })
      .option("force", { describe: "push even if the local file looks like a stale shadow copy (#181601)", type: "boolean", default: false }),
  async handler(args) {
    const { slug, corrected } = normalizeSlugArg(args.slug)
    UI.empty()
    prompts.intro(`◈  Push ${slug}`)
    if (corrected) noteSlugCorrection(args.slug, slug)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    try {
      const dirUsed = pagesDir(args.dir)
      const filePath = join(dirUsed, `${slug}.json`)
      if (!existsSync(filePath)) {
        prompts.log.error(`Local file not found: ${filePath}`)
        prompts.log.info(dim(`Pull first: iris pages pull ${slug}`))
        prompts.outro("Done")
        return
      }

      // #181601. Refuse a shadow ./pages unless the caller aimed there deliberately.
      // `--dir` is an explicit aim; the yargs default is not, so check argv rather than
      // args.dir, which is always populated.
      const aimedDeliberately = process.argv.includes("--dir")
      const shadow = args.force || aimedDeliberately ? null : detectShadowPagesDir(dirUsed)
      if (shadow) {
        prompts.log.error(`Refusing to push from what looks like a stale shadow copy.`)
        prompts.log.info(`  reading:   ${resolve(filePath)}`)
        prompts.log.info(`  canonical: ${resolve(join(shadow.canonical, `${slug}.json`))}`)
        prompts.log.info(dim(`This is #181601: a persisted cd into fl-iris-api shipped an Aug-17`))
        prompts.log.info(dim(`shadow of /p/docs over the live page and printed Done.`))
        prompts.log.info(dim(`Run from the workspace root, or pass --dir to aim on purpose, or --force.`))
        // Non-zero, because a REFUSAL that exits 0 is the same defect this guard exists to
        // stop. Caught verifying the v1.3.192 release: the guard correctly refused to clobber
        // /p/docs from the shadow dir and then exited 0, so a script would have read the
        // refusal as a successful push — exactly what item 11 fixed across 21 other commands,
        // reproduced inside the fix for #181601 hours after shipping it.
        process.exit(1)
      }

      // Always name the file. The push used to report only the slug, so a push from the
      // right directory and a push from the wrong one produced identical output.
      prompts.log.info(dim(`from ${resolve(filePath)}`))
      sp.start("Pushing…")
      const local = JSON.parse(readFileSync(filePath, "utf-8"))
      let page = await getBySlug(slug, false)

      // A slug with no page yet is a CREATE, not an error. `push` used to stop at
      // "Page not found", so shipping a new page meant discovering that `pages create`
      // exists, running it, and pushing again — for a file that already carried
      // everything create needs. The file is the intent; honour it.
      if (!page) {
        sp.message("No page for that slug yet — creating…")
        const created = await createPageFromJson({
          slug,
          title: local.title || slug,
          seo_title: local.seo_title,
          seo_description: local.seo_description,
          og_image: local.og_image,
          // `owner_type` is required upstream; `pages create` defaults it the same way, and a
          // hand-written page file rarely carries one.
          owner_type: local.owner_type ?? "user",
          owner_id: local.owner_id ?? (await resolveUserId()),
          json_content: local.json_content ?? local,
          publish: !!args.publish,
          requires_auth: local.requires_auth,
        })
        if (!created) { sp.stop("Failed", 1); prompts.log.error(`Could not create "${slug}".`); process.exitCode = 1; prompts.outro("Done"); return }
        prompts.log.info(dim(`created page #${created.id}`))
        page = created
      }

      let jsonContent: any
      if (local.json_content) jsonContent = local.json_content
      else if (local.components) jsonContent = local
      else {
        sp.stop("Failed", 1)
        prompts.log.error("No 'json_content' or 'components' in file")
        prompts.outro("Done")
        return
      }

      // Backfill any missing component ids before validating, so a file produced by
      // `pages pull` (which may carry none) is valid push input (#177898).
      const backfilled = assignComponentIds(jsonContent)

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
      // Re-assert visibility when the local file carries one. Unlike status (below), this
      // is safe: visibility is orthogonal to the publish cycle, and re-sending the value
      // we pulled can only preserve it. Sending nothing is what let it drift silently, and
      // a page demoted to `unlisted` 404s on its /p/{slug} address — indistinguishable
      // from deleted.
      if (local.visibility) updateData.visibility = local.visibility
      // ACCESS CONTROL DOES NOT TRAVEL IN A CONTENT FILE. (#181984)
      //
      // push used to re-assert `requires_auth` from the local JSON, on the reasoning that
      // dropping a field lets it drift (#180009). That reasoning was wrong for this field:
      // fl-api's PageController::update assigns the column only inside
      // `if ($request->has('requires_auth'))`, so NOT sending it leaves the gate exactly as
      // it was. Verified against production on a gated probe page — pushed content with the
      // key removed from the file, and the column read back `true`.
      //
      // Re-asserting was therefore pure downside, and it collected: a pull wrote
      // `requires_auth: false` for a page that was provably gated, push wrote that false
      // back, and an internal document was served publicly for about thirty seconds. Every
      // step reported success, because every step was telling the truth about itself.
      //
      // The stale-file guard added for the previous instance (#181940) could not catch it.
      // It compared the local value against `getBySlug()` — the SAME endpoint the pull had
      // just read — so when that read was wrong both sides agreed and the guard went blind
      // precisely when it was needed. A check whose two inputs share a failure mode is not a
      // check.
      //
      // So: never send it. A gate is changed with `pages set`, `pages ungate` or the create
      // path, all of which are explicit about what they are doing. A content push has no
      // business carrying the flag that decides who may read the content.
      const liveGate = Boolean((page as any)?.requires_auth)
      if (local.requires_auth !== undefined && Boolean(local.requires_auth) !== liveGate) {
        // Say so rather than syncing either way. The file is now informational for this
        // field, and a reader who believes otherwise is the person this note is for.
        prompts.log.warn(
          `${slug}.json says requires_auth = ${JSON.stringify(local.requires_auth)}, live is ${liveGate}. ` +
            `Not sent — push never changes the gate.\n` +
            `  Change it deliberately:  ${highlight(`iris pages set ${slug} requires_auth <true|false>`)}` +
            `  ${dim("or")} ${highlight(`iris pages ungate ${slug}`)}\n` +
            `  Confirm what a stranger sees: ${highlight(`iris pages check-public ${slug}`)}`,
        )
      }
      // Never send status during push — use publish/unpublish commands instead.
      // Sending status=published here caused the page to briefly publish with OLD content
      // before createVersion saved the new json_content, poisoning the iris-api cache.

      const res = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify(updateData),
      })
      if (!(await handleApiError(res, "Push page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const cnt = jsonContent?.components?.length ?? 0

      // Persist the backfilled ids locally so the file matches what the server now holds —
      // otherwise `pages diff` would report a permanent phantom difference on every page
      // whose ids we generated at push time.
      if (backfilled > 0) {
        try {
          writeFileSync(filePath, JSON.stringify(local, null, 2) + "\n")
        } catch {
          // Non-fatal: the push already succeeded; the local file just keeps its old shape.
        }
      }

      // --publish: push + publish in one step
      if (args.publish) {
        const pubRes = await pagesFetch(`/api/v1/pages/${page.id}/publish`, { method: "POST" })
        if (!(await handleApiError(pubRes, "Publish"))) { sp.stop("Pushed but publish failed", 1); prompts.outro("Done"); return }
        // Explicitly purge iris-api cache
        await pagesFetch("/api/internal/cache/purge-page", {
          method: "POST",
          body: JSON.stringify({ slug }),
        }).catch(() => {})
        sp.stop(success(`Pushed (${cnt} components) + published`))
        console.log(`  ${highlight(publicUrl(slug))}`)
        printDesignStandardHint(slug)
      // Safe-by-default: unpublish after push so live page is untouched
      } else if (!args.live && page.status === "published") {
        await pagesFetch(`/api/v1/pages/${page.id}/unpublish`, { method: "POST" })
        sp.stop(success(`Pushed (${cnt} components) → draft`))

        // Re-fetch to get rotated cache_key for preview URL
        const updated = await getBySlug(slug, false)
        if (updated?.cache_key) {
          const token = Buffer.from(`${updated.id}:${updated.cache_key}`).toString("base64")
          const url = `${publicUrl(slug)}?preview=true&token=${token}`
          console.log()
          console.log(`  ${highlight("Preview:")} ${url}`)
          console.log()
          console.log(`  ${dim("Share with client, then: iris pages publish " + slug)}`)
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
  describe: "compare local ./pages/<slug>.json against what is live",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug \u2014 e.g. `my-page`, not `pages/my-page.json`", type: "string", demandOption: true })
      .option("dir", { describe: "directory", type: "string", default: "./pages" }),
  async handler(args) {
    const { slug, corrected } = normalizeSlugArg(args.slug)
    UI.empty()
    prompts.intro(`◈  Diff ${slug}`)
    if (corrected) noteSlugCorrection(args.slug, slug)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Comparing…")
    try {
      const filePath = join(pagesDir(args.dir), `${slug}.json`)
      if (!existsSync(filePath)) {
        sp.stop("Failed", 1)
        prompts.log.error(`Local file not found: ${filePath}`)
        prompts.outro("Done")
        return
      }
      const local = JSON.parse(readFileSync(filePath, "utf-8"))
      const page = await getBySlug(slug, true)
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
      printDesignStandardHint(String(args.slug))
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
        components: scaffoldComponents({
          slug: args.slug,
          title: args.title,
          seoDescription: args["seo-description"],
        }),
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
      printDesignStandardHint(p.slug)
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
      .option("owner-type", { describe: "owner type for the clone (default: inherit from source)", type: "string" })
      .option("owner-id", { describe: "owner id for the clone (default: inherit from source)", type: "number" })
      .option("allow-gated-owner", {
        describe: "clone onto a gated owner bloq anyway (the clone will be gated too)",
        type: "boolean",
        default: false,
      })
      .option("publish", { describe: "publish immediately", type: "boolean", default: false })
      .option("force", {
        describe: "overwrite an existing local ./pages/<slug>.json (default: keep it)",
        type: "boolean",
        default: false,
      }),
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

      // WHO WILL OWN THE CLONE — say it out loud, and refuse the trap. (#181940)
      //
      // The Atlas gate is bound to the OWNER BLOQ, not to the page. Copying the source's
      // owner therefore copies its gate, and clearing requires_auth on the clone does not
      // lift it. Until the owner_id fix landed alongside this there was no route back at
      // all: the clone was gated, un-gatable, and the only remedy was to delete it.
      //
      // Inheriting silently is what made that reachable by accident, so an inherited GATED
      // owner now stops the command. An explicit --owner-id is always honoured — the person
      // who typed it knows what they are asking for.
      const ownerInherited = args["owner-type"] === undefined && args["owner-id"] === undefined
      const ownerType = args["owner-type"] ?? source.owner_type
      const ownerId = args["owner-id"] ?? source.owner_id

      // BOTH flags, because the gate is both (#181940). Reading only the column misses a
      // source whose json_content still carries requireOtp — the clone would copy it, the
      // server would re-derive requires_auth from it, and the "ungated" clone would ask for
      // a code. The two are one gate wearing two names; a check on half of it is half a check.
      const sourceGate = pageGateFlags({ requires_auth: source.requires_auth, json_content: jsonContent })
      const sourceGated = sourceGate.gated

      if (ownerInherited && sourceGated && !args["allow-gated-owner"]) {
        sp.stop("Source is gated", 1)
        prompts.log.error(
          `${args.source} is gated (${sourceGate.which}) and owned by ${source.owner_type} ${source.owner_id}.`,
        )
        prompts.log.warn("A clone inherits that owner, and the gate follows the owner — not the page.")
        prompts.log.info(dim(`Own it yourself:   iris pages duplicate ${args.source} --slug=${args.slug} --owner-id=<bloq>`))
        prompts.log.info(dim(`Clone it gated:    iris pages duplicate ${args.source} --slug=${args.slug} --allow-gated-owner`))
        prompts.log.info(dim(`Check any page:    iris pages check-public ${args.source}`))
        prompts.outro("Done")
        return
      }

      // Ownership was chosen deliberately, or the source is not gated — either way the clone
      // proceeds. But if the SOURCE carried a gate flag in its content, the clone carries it
      // too, and that is the "cloned a gated page to make an open one and got a gated one"
      // surprise the ticket opens with. Not a refusal here: the caller has already made the
      // ownership call. Just never silent.
      if (sourceGated) {
        prompts.log.warn(
          `Cloned from a gated page — the gate comes with it.\n` +
            `  ${args.slug} will ask visitors for an emailed code.\n` +
            `  Lift it with:  iris pages ungate ${args.slug}`,
        )
      }

      const title = args.title ?? source.title
      const payload: Record<string, unknown> = {
        slug: args.slug,
        title,
        seo_title: args.title ? title : source.seo_title,
        seo_description: source.seo_description,
        og_image: source.og_image,
        owner_type: ownerType,
        owner_id: ownerId,
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
      // NEVER clobber an already-authored local file (#177899). The destination filename is
      // derived from --slug, which is exactly the filename someone would have drafted the new
      // page into — so the most natural use of `duplicate` was also its most destructive, and
      // `pages diff` reported "In sync" afterwards because local and remote were both wrong the
      // same way. Keep the local draft unless --force is explicit.
      const fileExisted = existsSync(filePath)
      const wroteFile = !fileExisted || args.force
      if (wroteFile) writeFileSync(filePath, JSON.stringify(localData, null, 2) + "\n")

      printDivider()
      printKV("ID", p.id)
      printKV("Slug", args.slug)
      printKV("Source", args.source)
      // Printed, never assumed. Which bloq owns the clone decides whether strangers can read
      // it, and it was previously invisible at the one moment it was being decided.
      printKV(
        "Owner",
        `${ownerType ?? "system"}${ownerId ? ` ${ownerId}` : ""} ${dim(ownerInherited ? "(inherited from source)" : "(explicit)")}`,
      )
      printKV("Components", (jsonContent.components?.length ?? 0).toString())
      printKV("File", wroteFile ? filePath : `${filePath} ${dim("(kept — not overwritten)")}`)
      printDivider()

      if (fileExisted && !args.force) {
        prompts.log.warn(
          `Local ${filePath} already existed and was left untouched — the remote page was cloned from ${args.source}.`,
        )
        prompts.log.info(dim(`Push your local version:  iris pages push ${args.slug}`))
        prompts.log.info(dim(`Or take the clone's content: iris pages duplicate ${args.source} --slug=${args.slug} --force`))
      }

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

/**
 * What a STRANGER sees. (#181940)
 *
 * Every other instrument here reports on the authenticated view, and during that ticket three
 * of them agreed on the wrong answer in a row:
 *
 *   curl                          -> 200 with the right SEO title (the gate is client-rendered)
 *   a signed-in browser           -> the whole page (a stale atlas_session opened the gate)
 *   pages set requires_auth false -> "Updated" (true, and irrelevant — the OWNER BLOQ gates it)
 *
 * A gated Genesis page still returns 200 and still carries correct metadata; the refusal lives
 * in the `data-page` props the SPA hydrates from. So the only honest check is an unauthenticated
 * request whose `gateRequired` / `gateBloqId` are read out of that payload — which is what this
 * does, deliberately WITHOUT any credential, cookie or SDK key.
 */
const CheckPublicCmd = cmd({
  command: "check-public <slug>",
  describe: "fetch a page as a stranger would and report whether it is actually readable",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("url", { describe: "check this exact address instead of resolving the page's own", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    // ASK THE PAGE WHERE IT LIVES. publicUrl(slug) falls back to freelabel.net, and a page served
    // on heyiris.io or a client's own domain would then be checked at an address that is not the
    // one anybody was given — an instrument built to stop false answers, returning one. The lookup
    // is authenticated and is used ONLY to learn the host; if it fails (not the owner, no key) we
    // fall back to the default rather than refusing, because a checked-at-the-default answer with
    // the url printed beside it is still honest.
    let url = typeof args.url === "string" && args.url ? args.url : publicUrl(String(args.slug))
    if (!args.url) {
      try {
        const page = await getBySlug(String(args.slug))
        if (page?.public_url) url = page.public_url
      } catch {
        // fall through to the default host
      }
    }

    // The FETCH is unauthenticated by design. requireAuth() is deliberately NOT called: the
    // question is what an anonymous visitor gets, and answering it with a credential attached is
    // the exact mistake this command exists to stop anyone repeating.
    let status = 0
    let html = ""
    try {
      const res = await fetch(url, { headers: { "User-Agent": "iris-pages-check-public" }, redirect: "follow" })
      status = res.status
      html = await res.text()
    } catch (err) {
      if (args.json) {
        console.log(JSON.stringify({ slug: args.slug, url, reachable: false, error: String(err) }, null, 2))
      } else {
        UI.empty()
        prompts.intro(`◈  Check public — ${args.slug}`)
        prompts.log.error(`Could not reach ${url}: ${err instanceof Error ? err.message : String(err)}`)
        prompts.outro("Done")
      }
      return
    }

    // Two render lanes. A composable page hydrates from a `data-page` attribute holding the
    // Inertia props; a bespoke render_mode=html page serves the author's blade with no such
    // attribute at all — and no data-page on a 200 means nothing was withheld.
    let props: any = null
    const match = html.match(/data-page="([^"]*)"/)
    if (match) {
      try {
        props = JSON.parse(match[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&#039;/g, "'"))
      } catch {
        props = null
      }
    }

    const page = props?.props ?? props ?? {}
    const gateRequired = page.gateRequired === true
    const gateBloqId = page.gateBloqId ?? null
    const bespoke = status === 200 && !match
    const readable = status === 200 && !gateRequired

    if (args.json) {
      console.log(JSON.stringify({
        slug: args.slug, url, status, readable, gateRequired,
        gateBloqId, render: bespoke ? "bespoke" : "composable", bytes: html.length,
      }, null, 2))
      return
    }

    UI.empty()
    prompts.intro(`◈  Check public — ${args.slug}`)
    printDivider()
    printKV("URL", url)
    printKV("Status", String(status))
    printKV("Render", bespoke ? "bespoke (render_mode=html)" : match ? "composable (data-page)" : "unknown")
    printKV("Bytes", String(html.length))
    printKV(
      "Gate",
      gateRequired
        ? `${UI.Style.TEXT_WARNING}REQUIRED${UI.Style.TEXT_NORMAL}${gateBloqId ? ` ${dim(`(owner bloq ${gateBloqId})`)}` : ""}`
        : "none",
    )
    printDivider()

    if (readable) {
      console.log(`  ${success("A stranger can read this page.")}`)
    } else if (gateRequired) {
      prompts.log.warn("A stranger CANNOT read this page — the gate withholds the content.")
      // Naming the bloq matters: clearing requires_auth on the page will not lift a gate the
      // OWNER is carrying. That mismatch is what made this look impossible to diagnose.
      if (gateBloqId) {
        prompts.log.info(dim(`The gate is bound to owner bloq ${gateBloqId}, not to the page's own flags.`))
        prompts.log.info(dim(`Move it:  iris pages set ${args.slug} owner_id <ungated-bloq>`))
      }
    } else {
      prompts.log.warn(`A stranger gets HTTP ${status}.`)
    }

    prompts.outro("Done")
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
      const versions = extractVersions(data?.data)
      // A paginated history that quietly shows page 1 is the same failure as the count being
      // wrong — you would roll back to "the oldest version" that is merely the oldest ON SCREEN.
      const pager: any = data?.data
      const more =
        pager && !Array.isArray(pager) && typeof pager === "object" && Number(pager.last_page ?? 1) > 1
          ? { page: Number(pager.current_page ?? 1), pages: Number(pager.last_page), total: Number(pager.total ?? 0) }
          : null
      sp.stop(`${versions.length} version(s)`)
      if (versions.length === 0) { prompts.outro("None"); return }
      printDivider()
      for (const v of versions) {
        const num = v.version_number ?? v.version ?? v.id
        console.log(`  ${bold(`v${num ?? "?"}`)}  ${dim(String(v.created_at ?? v.updated_at ?? ""))}  ${dim(`by ${v.changed_by ?? v.created_by ?? "?"}`)}`)
        if (v.change_summary) console.log(`    ${dim(String(v.change_summary))}`)
      }
      printDivider()
      if (more) {
        console.log(`  ${dim(`showing page ${more.page} of ${more.pages}${more.total ? ` — ${more.total} versions total` : ""}`)}`)
      }
      prompts.outro(dim(`iris pages rollback ${args.slug} --version=N`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const RollbackCmd = cmd({
  // Version is a POSITIONAL, not `--version`.
  //
  // It used to be `.option("version")`, which collides with yargs' own global `--version`
  // (print the CLI version). yargs resolved the collision in its own favour, so the value
  // arrived as the boolean `false` and every invocation died on "Version false not found" —
  // making rollback impossible from the CLI at exactly the moment someone needs it, which is
  // after they have broken a page. `--to` stays as an alias for anyone with it in a script.
  command: "rollback <slug> [rev]",
  describe: "rollback page to a previous version (iris pages rollback <slug> <version>)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      // NOT named `version`: yargs owns `--version` globally (print the CLI version) and wins
      // the collision even for a POSITIONAL, so the value arrived as undefined/false and every
      // rollback died on "Version false not found" — at exactly the moment someone needs it,
      // which is after they have broken a page.
      .positional("rev", { describe: "version number (see: iris pages versions <slug>)", type: "number" })
      .option("to", { describe: "version number (alias for the positional)", type: "number" })
      .example("$0 pages rollback atlas-console 4", "restore version 4"),
  async handler(args) {
    UI.empty()
    const version = (args.rev ?? args.to) as number | undefined
    if (typeof version !== "number" || Number.isNaN(version)) {
      prompts.intro(`◈  Rollback ${args.slug}`)
      prompts.log.error(
        `Which version? Pass it as a positional:\n\n` +
          `  iris pages rollback ${args.slug} <version>\n\n` +
          `List them with:  iris pages versions ${args.slug}`,
      )
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    prompts.intro(`◈  Rollback ${args.slug} → v${version}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Rolling back…")
    try {
      const page = await getBySlug(args.slug, false)
      if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
      const res = await pagesFetch(`/api/v1/pages/${page.id}/rollback/${version}`, { method: "POST" })
      if (!(await handleApiError(res, "Rollback"))) {
        sp.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error(`Version ${version} not found for page "${args.slug}". Run: iris pages versions ${args.slug}`)
        prompts.outro("Done")
        return
      }
      sp.stop(success(`Rolled back to v${version}`))
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

/**
 * Give every component a stable `id`, in place.
 *
 * The API requires an `id` on each component, but a page's stored json_content may not carry
 * one — so `pages pull` writes a file that `pages push` then rejects with `missing "id" field`,
 * and the documented pull → edit → push loop can never complete (#177898). Backfilling here
 * makes the round-trip work regardless of how the page was authored.
 *
 * Ids are derived from the component type + index rather than random, so re-running produces the
 * same value and a no-op edit stays a no-op diff. Existing ids are never touched, and collisions
 * (two components already sharing an id, or a generated id matching a real one) get a numeric
 * suffix so ids stay unique within the page.
 */
export function assignComponentIds(jsonContent: any): number {
  const components = jsonContent?.components
  if (!Array.isArray(components)) return 0
  const taken = new Set<string>(
    components.map((c: any) => (typeof c?.id === "string" ? c.id : "")).filter(Boolean),
  )
  let added = 0
  components.forEach((c: any, i: number) => {
    if (!c || typeof c !== "object" || (typeof c.id === "string" && c.id)) return
    const type = typeof c.type === "string" && c.type ? c.type : "component"
    const base = `${type.charAt(0).toLowerCase()}${type.slice(1)}-${i}`
    let id = base
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`
    taken.add(id)
    c.id = id
    added++
  })
  return added
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

/**
 * The components `pages create` starts a new page with.
 *
 * Extracted from the command handler so it can be checked against
 * COMPONENT_REGISTRY in a test (#180123). It was inline, and it shipped a
 * SiteFooter with no `copyright` — a prop this very file lists as required —
 * so `pages create` rejected every page it built: "Component validation failed
 * … SiteFooter: The copyright field is required." Since `pages push` errors
 * with "Page not found" on a slug that does not exist yet, that left no
 * create-then-push path at all.
 */
export function scaffoldComponents(opts: { slug: string; title: string; seoDescription?: string }) {
  const { slug, title, seoDescription } = opts
  return [
    {
      type: "Hero",
      id: `${slug}-hero`,
      props: {
        themeMode: "dark",
        title,
        subtitle: seoDescription ?? "",
        labelText: "NEW",
        labelColor: "#34d399",
        textAlign: "center",
      },
    },
    {
      type: "SiteFooter",
      id: `${slug}-footer`,
      props: {
        themeMode: "dark",
        brandName: title,
        // Required by COMPONENT_REGISTRY below, and by the API. Derived from the
        // page's own title so a fresh page is valid without the author editing it.
        copyright: `© ${new Date().getFullYear()} ${title}`,
        links: [],
      },
    },
  ]
}

export const COMPONENT_REGISTRY: { type: string; description: string; requiredProps: string[] }[] = [
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
  describe: "AI-compose a page from a text description",
  builder: (y) =>
    y
      .positional("description", { describe: "what the page should be", type: "string", array: true })
      .option("slug", { describe: "page slug (auto-generated if omitted)", type: "string" })
      .option("title", { describe: "page title", type: "string" })
      .option("theme", { describe: "dark or light", type: "string", default: "dark", choices: ["dark", "light"] })
      .option("style", { describe: "page style", type: "string", default: "landing", choices: ["landing", "dashboard", "product", "portfolio"] })
      .option("model", { describe: "builder model override (server default: gpt-5.6-luna)", type: "string" })
      .option("domain", { describe: "publish onto this connected custom domain (e.g. catodrive.com)", type: "string" })
      .option("publish", { describe: "publish immediately (use --no-publish to leave a draft)", type: "boolean", default: true })
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
        publish: args.publish !== false,
      }
      if (args.slug) payload.slug = args.slug
      if (args.title) payload.title = args.title
      if (args.model) payload.model = args.model
      if (args.domain) payload.domain = args.domain

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

      const published = data.published !== false

      sp.stop(success(`Created "${data.slug}"${published ? "" : " (draft)"}`))
      printDivider()
      printKV("Page ID", data.page_id)
      printKV("Slug", data.slug)
      if (data.domain) printKV("Domain", data.domain)
      printKV("URL", data.url)
      printKV("Status", published ? "Published" : "Draft")
      printKV("Components", data.component_count ?? data.components?.length)
      if (data.self_heal_attempts) printKV("Self-heal attempts", data.self_heal_attempts)
      printDivider()

      if (args.json) {
        await writeJson(data)
      }

      prompts.log.info(`View: ${dim(`iris pages view ${data.slug}`)}`)
      prompts.log.info(`Edit: ${dim(`iris pages pull ${data.slug}`)}`)
      if (!published) prompts.log.info(`Publish: ${dim(`iris pages publish ${data.slug}`)}`)
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// add-table — scaffold a DataTable onto a page from an Atlas dataset schema (SDR-06)
// ============================================================================

/**
 * The bridge that was missing between a dataset and a page.
 *
 * Everything else in the schema-driven-rendering epic (SDR-01..05) is plumbing: the feed
 * carries the schema's labels and types, DataTable consumes them, and an Atlas field can
 * declare how it wants to be drawn. None of it is reachable without hand-editing page JSON
 * — which is the authoring step this replaces.
 *
 * NOTE ON WHAT THIS DELIBERATELY DOES NOT DO
 * ------------------------------------------
 * It does not map Atlas storage types to Genesis render types. That map lives in exactly one
 * place (iris-api `utils/atlasFieldTypes.ts`, SDR-04) and a copy here would be a third — the
 * precise disease this epic exists to cure (#178186). So the emitted component carries NO
 * column types: either the feed ships `fields` and the renderer derives everything, or it
 * does not and the columns fall back to text, which is the documented honest fallback.
 */
const AddTableCmd = cmd({
  command: "add-table <slug>",
  aliases: ["add-datatable"],
  describe: "scaffold a DataTable onto a page from an Atlas dataset schema (SDR-06)",
  builder: (y) =>
    y
      .positional("slug", { describe: "target page slug", type: "string", demandOption: true })
      .option("from-dataset", { type: "string", demandOption: true, describe: "Atlas schema slug (see: iris atlas:datasets schemas list)" })
      .option("data-source", { type: "string", demandOption: true, describe: "feed URL the table fetches at render time" })
      .option("title", { type: "string", describe: "table title (defaults to the schema name)" })
      .option("fields", { type: "string", describe: "comma-separated field keys to include, in order (default: all)" })
      .option("component-id", { type: "string", describe: "component id (default: derived from the schema slug)" })
      .option("position", { type: "number", describe: "index to insert at (default: before SiteFooter, else appended)" })
      .option("dry-run", { type: "boolean", default: false, describe: "print the component JSON without writing" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Add table to ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Reading schema…")

    // ── 1. the schema ────────────────────────────────────────────────────────
    const schemaRes = await irisFetch(`/api/v1/atlas/schemas/${args["from-dataset"]}`)
    if (!(await handleApiError(schemaRes, "Read schema"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
    const schemaBody = (await schemaRes.json()) as any
    const schema = schemaBody?.data?.schema ?? schemaBody?.data
    const allFields: any[] = schema?.fields?.fields ?? []

    if (allFields.length === 0) {
      sp.stop("Refused", 1)
      prompts.log.error(`Schema '${args["from-dataset"]}' declares no fields — there is nothing to build a table from.`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // Optional subset/order. An unknown key is refused rather than skipped: silently
    // dropping it produces a table missing a column the author explicitly asked for.
    let fields = allFields
    if (args.fields) {
      const want = args.fields.split(",").map((f) => f.trim()).filter(Boolean)
      const known = new Set(allFields.map((f) => f.key))
      const missing = want.filter((w) => !known.has(w))
      if (missing.length) {
        sp.stop("Refused", 1)
        prompts.log.error(
          `Not in schema '${args["from-dataset"]}': ${missing.join(", ")}\n\n` +
            `  Available: ${allFields.map((f) => f.key).join(", ")}`,
        )
        process.exitCode = 1
        prompts.outro("Done")
        return
      }
      fields = want.map((w) => allFields.find((f) => f.key === w))
    }

    // ── 2. does the feed carry field metadata? (SDR-01) ──────────────────────
    // This decides whether the page needs columns written into it at all, so it is
    // probed rather than assumed — the answer differs by deploy, not by configuration.
    sp.message("Probing the feed…")
    let feedHasFields = false
    let feedNote = ""
    try {
      const probe = await fetch(args["data-source"], { headers: { Accept: "application/json" } })
      if (!probe.ok) {
        feedNote = `the feed returned HTTP ${probe.status}`
      } else {
        const payload = (await probe.json()) as any
        feedHasFields = Array.isArray(payload?.fields) && payload.fields.length > 0
        if (!feedHasFields) feedNote = "the feed responded but sends no `fields` block"
      }
    } catch (e: any) {
      feedNote = `the feed could not be reached (${e?.message ?? "unknown error"})`
    }

    // ── 3. build the component ───────────────────────────────────────────────
    const componentId = args["component-id"] ?? `table-${args["from-dataset"]}`
    const props: Record<string, unknown> = {
      title: args.title ?? schema?.name ?? args["from-dataset"],
      dataSource: args["data-source"],
    }

    // Columns are written ONLY when the feed cannot describe itself. Note they carry key
    // and label but no `type` — deriving a render type needs the Atlas→Genesis map, which
    // lives in iris-api and must not be duplicated here. Untyped columns render as text.
    if (!feedHasFields) {
      props.columns = fields.map((f) => ({ key: f.key, label: f.label ?? f.key }))
    }

    const component = { type: "DataTable", id: componentId, props }

    if (args["dry-run"]) {
      sp.stop("Dry run — nothing written")
      if (args.json) { await writeJson(component); prompts.outro("Done"); return }
      console.log(JSON.stringify(component, null, 2))
      UI.empty()
      console.log(
        feedHasFields
          ? dim("  Feed ships `fields` — columns are derived at render time from the schema.")
          : dim(`  Columns written explicitly (untyped) because ${feedNote}.`),
      )
      prompts.outro("Done")
      return
    }

    // ── 4. insert into the page ──────────────────────────────────────────────
    sp.message("Reading page…")
    const page = await getBySlug(args.slug, true)
    if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }

    const json = page.json_content ?? {}
    const components: any[] = Array.isArray(json.components) ? [...json.components] : []

    if (components.some((c) => c?.id === componentId)) {
      sp.stop("Refused", 1)
      prompts.log.error(
        `Page '${args.slug}' already has a component with id '${componentId}'.\n` +
          `Pass --component-id to add a second table from the same dataset.`,
      )
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    // Default position lands the table above the footer rather than below it, which is
    // where an appended component would otherwise go.
    const footerIdx = components.findIndex((c) => c?.type === "SiteFooter")
    const at =
      args.position !== undefined
        ? Math.max(0, Math.min(args.position, components.length))
        : footerIdx >= 0
          ? footerIdx
          : components.length
    components.splice(at, 0, component)

    sp.message("Writing…")
    const res = await pagesFetch(`/api/v1/pages/${page.id}`, {
      method: "PUT",
      body: JSON.stringify({ json_content: { ...json, components } }),
    })
    if (!(await handleApiError(res, "Add table"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }

    // Re-read and confirm, rather than trusting the 200 (#179802 — `set` reported success
    // on a page whose slug did not even resolve).
    const fresh = await getBySlug(args.slug, true)
    const landed = (fresh?.json_content?.components ?? []).some((c: any) => c?.id === componentId)
    if (!landed) {
      sp.stop("Not applied", 1)
      prompts.log.error(`The API accepted the write but '${componentId}' is not on the page.`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    sp.stop("Added")
    printKV("Page", args.slug)
    printKV("Component", `${componentId} (position ${at})`)
    printKV("Dataset", args["from-dataset"])
    printKV("Columns", feedHasFields ? "derived from the feed's schema at render time" : `${fields.length} written explicitly, untyped`)
    if (!feedHasFields) {
      UI.empty()
      prompts.log.warn(
        `Wrote explicit columns because ${feedNote}.\n` +
          `They carry labels but no types, so every column renders as text.\n` +
          `Once the feed ships a \`fields\` block (SDR-01), remove the columns prop and the\n` +
          `renderer will take dates, links, enums and display hints straight from the schema.`,
      )
    }
    UI.empty()
    console.log(dim(`  ${publicUrl(page)}`))
    prompts.outro("Done")
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
      await writeJson(registry)
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
        await writeJson(data)
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
      const resp = await page.goto(url, { waitUntil: "networkidle" })
      await page.waitForTimeout(2000)

      // REFUSE TO SCREENSHOT THE 404. This command is the evidence for check 10 of the
      // design standard ("render verified in a browser"), and it used to capture whatever
      // /p/ returned and report "Captured · Saved · Done" with exit 0 — including a
      // picture of the not-found page for any UNPUBLISHED slug. A verification tool that
      // cannot tell "renders correctly" from "there is no page" produces the same green
      // for both, which is the precise failure the standard exists to prevent. See #180796.
      //
      // Status alone is not enough: the not-found view can be served with 200 by the SPA
      // route, so the title is checked too.
      const status = resp?.status() ?? 0
      const title = (await page.title().catch(() => "")) || ""

      if (status >= 400 || /page not found/i.test(title)) {
        await browser.close()
        sp.stop("Not captured")
        prompts.log.error(
          status >= 400
            ? `${url} returned HTTP ${status} — nothing was captured.`
            : `${url} served the not-found page — nothing was captured.`,
        )
        prompts.log.info(`/p/ serves PUBLISHED pages only. If this is a draft: iris pages publish ${slug}`)
        prompts.outro("Done")
        process.exitCode = 1
        return
      }

      sp.message("Capturing…")
      await page.screenshot({ path: outPath, fullPage: true })
      await browser.close()

      sp.stop("Captured")
      prompts.log.success(`Saved: ${outPath}`)
      prompts.log.info(`URL: ${url}`)
      // Printed so a wrong capture is visible in the output without opening the file.
      if (title) prompts.log.info(`Title: ${title}`)

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
// Ungate — lift the OTP gate. Both flags, right order, then the purge.
// ============================================================================

/**
 * Lifting the gate takes three steps that nothing told you about (#181940).
 *
 * The gate is TWO flags with different names living in different places — the
 * `requires_auth` COLUMN and the `requireOtp` key inside json_content — and they are not
 * independent: fl-api's PageController::update re-applies the column from requireOtp, and
 * that block runs AFTER the explicit assignment. So the order is forced. Clear requireOtp
 * first; clear the column LAST, or the json write turns it straight back on. Then purge,
 * because the gate decision is read from a cached page record and a stale cache is
 * indistinguishable from a gate that will not lift.
 *
 * That last point is not theoretical: it is how #181940 came to be filed as "permanently
 * gated, no route back". The commands were right, the order was wrong, and the cache made
 * the failure look permanent. One verb, so nobody has to know any of this.
 */
const UngateCmd = cmd({
  command: "ungate <slug>",
  describe: "lift the OTP gate on a page — clears both flags in the order that works, then purges",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true, describe: "page slug" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Ungate ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Lifting the gate…")
    try {
      const page = await getBySlug(String(args.slug), true)
      if (!page) { sp.stop("Failed", 1); prompts.outro("Done"); return }

      const before = {
        requires_auth: (page as any).requires_auth ?? false,
        requireOtp: ((page.json_content as any) ?? {}).requireOtp ?? false,
      }

      if (!before.requires_auth && !before.requireOtp) {
        sp.stop(success("Already open"))
        prompts.log.info(`No gate on this page. ${dim(publicUrl(String(args.slug)))}`)
        prompts.outro("Done")
        return
      }

      // 1. requireOtp first — a json_content write re-derives the column, so doing this
      //    second would undo step 2.
      const json: Record<string, unknown> = { ...((page.json_content as any) ?? {}) }
      json.requireOtp = false
      // Written by an older CLI that treated `json_content.x` as a path INSIDE json_content
      // (#181940). Harmless but confusing, and it is the fingerprint of the bug — clear it
      // while we are here rather than leave a dead key that reads like a real setting.
      if (json.json_content && typeof json.json_content === "object") delete json.json_content

      const jsonRes = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ json_content: json }),
      })
      if (!(await handleApiError(jsonRes, "Clear requireOtp"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }

      // 2. the column LAST.
      const colRes = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ requires_auth: false }),
      })
      if (!(await handleApiError(colRes, "Clear requires_auth"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }

      // 3. purge, or the cached gate decision keeps answering.
      let purged = false
      try {
        const purgeRes = await irisFetch("/api/internal/cache/purge-page", {
          method: "POST",
          body: JSON.stringify({ slug: String(args.slug) }),
        }, IRIS_API)
        purged = purgeRes.ok
      } catch { /* reported below — a failed purge is a delay, not a failed ungate */ }

      // VERIFY, against the record rather than against our own intent.
      let after: { requires_auth: unknown; requireOtp: unknown } | null = null
      try {
        const fresh = await getBySlug(String(args.slug), true)
        if (fresh) {
          after = {
            requires_auth: (fresh as any).requires_auth ?? false,
            requireOtp: ((fresh.json_content as any) ?? {}).requireOtp ?? false,
          }
        }
      } catch { /* fall through to the honest warning */ }

      if (after && (after.requires_auth || after.requireOtp)) {
        sp.stop("Not fully applied", 1)
        prompts.log.error(
          `The API accepted both writes but the page still reads ` +
            `requires_auth=${JSON.stringify(after.requires_auth)}, requireOtp=${JSON.stringify(after.requireOtp)}.`,
        )
        process.exitCode = 1
        prompts.outro("Done")
        return
      }

      sp.stop(success("Gate lifted"))
      if (args.json) {
        await writeJson({ slug: args.slug, before, after, purged })
        prompts.outro("Done")
        return
      }

      printKV("requires_auth", `${before.requires_auth} → false`)
      printKV("requireOtp", `${before.requireOtp} → false`)
      if (!after) prompts.log.warn("Could not read the page back to confirm.")

      // Deliberately NOT "Verify: <url>". See CacheClearCmd — propagation is not instant,
      // and an immediate check is how this ticket got the wrong root cause.
      if (purged) {
        prompts.log.info("Cache purged. Propagation is not instant — give it a minute before checking the URL.")
      } else {
        prompts.log.warn(`Cache purge did not confirm. Run: iris pages cache-clear ${args.slug}`)
      }
      prompts.log.info(dim(publicUrl(String(args.slug))))
      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error", 1)
      prompts.log.error(e.message ?? String(e))
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
        // NOT "Verify: <url>" any more (#181940). Propagation is not instant, and an
        // immediate check returns the PREVIOUS answer — which is how a working two-command
        // gate fix got diagnosed as an unliftable gate and written up with the wrong root
        // cause. A stale cache and a change that did not apply are indistinguishable from
        // out here, so the one thing this must not do is invite the check straight away.
        prompts.log.info("Propagation is not instant — give it a minute before checking:")
        prompts.log.info(dim(publicUrl(slug)))
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
// Visibility + share links — who can actually reach a page (#178589)
//
// Two independent controls, easy to confuse:
//
//   visibility  a page COLUMN deciding which of the page's OWN urls resolve:
//                 public    /p/{slug} ✓   /p/{uuid} ✓    (default — today's behaviour)
//                 unlisted  /p/{slug} ✗   /p/{uuid} ✓    (hand someone the UUID link)
//                 private   /p/{slug} ✗   /p/{uuid} ✗    (only /s/{token} works)
//
//   share links  disposable CAPABILITY urls at /s/{token}. They ignore visibility
//                and serve the page even while it is unpublished — the token IS the
//                grant. Anyone holding one is in; that is not access control.
//
// Endpoint routing gotcha: the share-link routes exist ONLY on fl-api. The iris-api
// /v1/pages proxy has no route for them (verified in production: iris-api → 404,
// fl-api → 200), so these use FL_API directly instead of pagesFetch. The visibility
// write is a plain page-column PUT, so it goes through the normal proxied path.
// ============================================================================

const VISIBILITY_MODES = ["public", "unlisted", "private"] as const
type VisibilityMode = (typeof VISIBILITY_MODES)[number]

type ShareLink = {
  id?: number
  token: string
  label?: string | null
  expires_at?: string | null
  max_views?: number | null
  view_count?: number | null
  revoked_at?: string | null
  active?: boolean
  share_url?: string
}

/** Share-link endpoints are fl-api-only — the iris-api pages proxy doesn't route them. */
function shareFetch(path: string, options?: RequestInit): Promise<Response> {
  return irisFetch(path, options ?? {}, FL_API)
}

/** Scheme + host that serves /p/ and /s/ urls. Prefers the host the API itself used. */
function pagesOrigin(page?: { public_url?: string }): string {
  const m = /^(https?:\/\/[^/]+)/.exec(page?.public_url ?? "")
  if (m) return m[1]
  const env = process.env.IRIS_ENV ?? "production"
  return env === "local" ? "http://local.iris.freelabel.net:9300" : "https://freelabel.net"
}

/** The permanent unguessable /p/{uuid} alias (page.public_id), if the API exposes one. */
function uuidUrl(page: any): string | null {
  const id = page?.public_id
  return id ? `${pagesOrigin(page)}/p/${id}` : null
}

function shareUrlFor(link: ShareLink, page?: any): string {
  return link.share_url ?? `${pagesOrigin(page)}/s/${link.token}`
}

/**
 * Read the page's visibility mode.
 *
 * `visibility` is newer than most pages and newer than some API builds — it comes
 * back absent or null, which means the page behaves the way it always has: fully
 * public. Report that as "public (default)" instead of crashing or printing
 * `undefined`.
 */
function readVisibility(page: any): { mode: VisibilityMode; declared: boolean } {
  for (const raw of [page?.visibility, page?.effective_visibility]) {
    if (typeof raw === "string" && (VISIBILITY_MODES as readonly string[]).includes(raw)) {
      return { mode: raw as VisibilityMode, declared: true }
    }
  }
  // Matches the server's own fail-open rule (Page::effectiveVisibility): absent,
  // null or unrecognised means the page behaves exactly as it always has.
  return { mode: "public", declared: false }
}

function formatVisibility(v: { mode: VisibilityMode; declared: boolean }): string {
  if (!v.declared) return `${success("public")} ${dim("(default — never set on this page)")}`
  if (v.mode === "public") return success("public")
  if (v.mode === "unlisted") return `${UI.Style.TEXT_WARNING}unlisted${UI.Style.TEXT_NORMAL}`
  return `${UI.Style.TEXT_DANGER}private${UI.Style.TEXT_NORMAL}`
}

/** Which of the page's own urls resolve under a given mode. */
function reachFor(mode: VisibilityMode): { slug: boolean; uuid: boolean } {
  if (mode === "private") return { slug: false, uuid: false }
  if (mode === "unlisted") return { slug: false, uuid: true }
  return { slug: true, uuid: true }
}

/** Why a share link is (or isn't) currently usable — mirrors PageShareLink::isActive(). */
function shareLinkState(l: ShareLink): { active: boolean; reason: string } {
  if (l.revoked_at) return { active: false, reason: `revoked ${String(l.revoked_at).slice(0, 10)}` }
  if (l.expires_at && new Date(l.expires_at).getTime() <= Date.now()) {
    return { active: false, reason: `expired ${String(l.expires_at).slice(0, 10)}` }
  }
  if (l.max_views != null && (l.view_count ?? 0) >= l.max_views) {
    return { active: false, reason: `view cap reached (${l.view_count ?? 0}/${l.max_views})` }
  }
  return { active: true, reason: "" }
}

function shareLinkIsActive(l: ShareLink): boolean {
  return typeof l.active === "boolean" ? l.active : shareLinkState(l).active
}

/** `"Approval preview"  ·  expires 2026-08-13  ·  1/5 views` */
function shareLinkMeta(l: ShareLink): string {
  const seen = l.view_count ?? 0
  const bits: string[] = []
  if (l.label) bits.push(`"${l.label}"`)
  bits.push(l.expires_at ? `expires ${String(l.expires_at).slice(0, 10)}` : "never expires")
  bits.push(l.max_views != null ? `${seen}/${l.max_views} views` : `${seen} view${seen === 1 ? "" : "s"} · no cap`)
  const st = shareLinkState(l)
  if (!st.active) bits.push(st.reason)
  return bits.join("  ·  ")
}

/** `--expires` accepts a duration (30m, 12h, 7d, 2w) or a date (2026-12-31, ISO 8601). */
function parseExpiry(raw: string): { iso: string } | { error: string } {
  const trimmed = raw.trim()
  const rel = /^(\d+)\s*(m|h|d|w)$/i.exec(trimmed)
  if (rel) {
    const n = Number(rel[1])
    if (n <= 0) return { error: `--expires ${raw}: duration must be greater than zero` }
    const ms: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }
    return { iso: new Date(Date.now() + n * ms[rel[2].toLowerCase()]).toISOString() }
  }
  const at = new Date(trimmed)
  if (isNaN(at.getTime())) {
    return { error: `--expires ${raw}: use a duration (30m, 12h, 7d, 2w) or a date (2026-12-31, 2026-12-31T18:00:00Z)` }
  }
  if (at.getTime() <= Date.now()) return { error: `--expires ${raw}: that is already in the past` }
  return { iso: at.toISOString() }
}

/**
 * Fetch a page's share links. Returns null when they couldn't be read (not the
 * owner, older API) so callers can say "unknown" rather than "none" — an empty
 * list and an unreadable list mean very different things for a privacy report.
 */
async function fetchShareLinks(pageId: number, opts: { quiet?: boolean } = {}): Promise<ShareLink[] | null> {
  const res = await shareFetch(`/api/v1/pages/${pageId}/share-links`)
  if (!res.ok) {
    if (!opts.quiet) await handleApiError(res, "List share links")
    return null
  }
  const body = (await res.json()) as { data?: ShareLink[] }
  return Array.isArray(body?.data) ? body.data : []
}

/**
 * The whole point of `iris pages visibility <slug>`: print every url that points at
 * this page and say plainly which of them work right now.
 */
function renderReach(page: any, v: { mode: VisibilityMode; declared: boolean }, links: ShareLink[] | null): void {
  const r = reachFor(v.mode)
  const published = page.status === "published"
  const active = (links ?? []).filter(shareLinkIsActive)

  printDivider()
  printKV("Page", `${page.slug} (#${page.id})`)
  printKV("Visibility", formatVisibility(v))
  printKV("Status", formatStatus(page.status))
  // Print this in BOTH states. Reporting only the "on" case made an ungated page look
  // exactly like a page nobody had checked, which is how the leak in #180009 read as
  // fine. "off" is the answer people most need to see, so it is the one that must show.
  printKV(
    "Email gate",
    page.requires_auth
      ? `${UI.Style.TEXT_WARNING}on${UI.Style.TEXT_NORMAL} ${dim("(requires_auth — visitors must pass an OTP emailed to them)")}`
      : `${dim("off — the full page body is served to anyone with a working url, no login")}`,
  )
  if (page.requires_auth) {
    // requires_auth alone is lead capture, not access control: any address that completes
    // the OTP is accepted and an Atlas record is created for it on the spot. Only an
    // allowedDomains list makes it a restriction.
    console.log(
      `      ${dim("check the allowlist: iris pages get " + page.slug + " gate.allowedDomains")}\n` +
      `      ${dim("without one, ANY email that completes the OTP gets in")}`,
    )
  }
  // WHERE THE GATE IS BOUND. (#181940) The flag above is the page's own; the gate itself is
  // evaluated against the OWNER BLOQ, which is why clearing requires_auth on a page cloned
  // from a gated source did not free it and looked impossible. Naming the owner here — and
  // pointing at the one instrument that reads the served payload rather than this record —
  // is the difference between a diagnosable state and a mystery.
  if (page.owner_type === "bloq" && page.owner_id) {
    console.log(`      ${dim(`the gate binds to owner bloq ${page.owner_id}, not to this flag`)}`)
  }
  console.log(`      ${dim("what a stranger actually gets: iris pages check-public " + page.slug)}`)
  console.log()
  console.log(`  ${bold("Who can reach this page right now")}`)
  console.log()

  const row = (ok: boolean, url: string, note: string) => {
    console.log(`  ${ok ? success("●") : dim("○")} ${ok ? url : dim(url)}`)
    console.log(`      ${dim(note)}`)
  }

  // /p/{slug}
  const slugOk = r.slug && published
  row(
    slugOk,
    publicUrl(page),
    !r.slug
      ? `blocked — visibility is ${v.mode}, this url 404s for everyone`
      : !published
        ? `page is ${page.status} — 404s until you run: iris pages publish ${page.slug}`
        : "anyone with the link · discoverable & search-indexable",
  )

  // /p/{uuid}
  const uuid = uuidUrl(page)
  if (uuid) {
    const uuidOk = r.uuid && published
    row(
      uuidOk,
      uuid,
      !r.uuid
        ? `blocked — visibility is private, this url 404s for everyone`
        : !published
          ? `page is ${page.status} — 404s until published`
          : "anyone with the link · unguessable, not discoverable",
    )
  } else {
    console.log(`  ${dim("○ /p/{uuid}")}`)
    console.log(`      ${dim("this page has no public_id UUID alias")}`)
  }

  // /s/{token}
  if (links === null) {
    console.log(`  ${dim("? /s/{token}")}`)
    console.log(`      ${dim("share links could not be read — you may not own this page")}`)
  } else if (active.length === 0) {
    console.log(`  ${dim("○ /s/{token}")}`)
    console.log(`      ${dim(`no active share links — mint one: iris pages share ${page.slug}`)}`)
  } else {
    for (const l of active) {
      row(true, shareUrlFor(l, page), `${shareLinkMeta(l)}  ·  works even while unpublished`)
    }
  }

  const stale = (links ?? []).length - active.length
  if (stale > 0) {
    console.log()
    console.log(`  ${dim(`${stale} inactive share link(s) — see: iris pages share:list ${page.slug}`)}`)
  }
  printDivider()
}

const VisibilityCmd = cmd({
  command: "visibility <slug> [mode]",
  aliases: ["vis"],
  // NOT an access gate, and it reads like one. `unlisted`/`private` change whether a
  // page is LISTED and indexed; anyone holding the url still gets the full body. The
  // gate is `requires_auth` + json_content.gate.allowedDomains. Setting visibility and
  // believing the page was protected is how a client page stayed readable (#180009).
  describe: "show or set how a page is LISTED (public | unlisted | private) — discoverability, not access",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .positional("mode", {
        describe: "public | unlisted | private (omit to show the current mode + working urls). Does NOT require a login — anyone with the url still reads the page",
        type: "string",
        choices: VISIBILITY_MODES as unknown as string[],
      })
      .option("yes", { describe: "skip the confirmation when restricting visibility", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const slug = String(args.slug)
    const mode = args.mode ? (String(args.mode) as VisibilityMode) : null
    prompts.intro(`◈  Visibility: ${slug}${mode ? ` → ${mode}` : ""}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const page = await getBySlug(slug, false)
      if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
      const links = await fetchShareLinks(page.id, { quiet: true })
      const current = readVisibility(page)

      // ---- Report mode -----------------------------------------------------
      if (!mode) {
        sp.stop(`Visibility: ${current.declared ? current.mode : "public (default)"}`)
        if (args.json) {
          const r = reachFor(current.mode)
          await writeJson({
            slug: page.slug,
            id: page.id,
            visibility: current.declared ? current.mode : null,
            effective_visibility: current.mode,
            visibility_supported: current.declared,
            status: page.status,
            requires_auth: !!page.requires_auth,
            slug_url: { url: publicUrl(page), reachable: r.slug && page.status === "published" },
            uuid_url: { url: uuidUrl(page), reachable: !!uuidUrl(page) && r.uuid && page.status === "published" },
            share_links: (links ?? []).map((l) => ({
              token: l.token,
              url: shareUrlFor(l, page),
              label: l.label ?? null,
              expires_at: l.expires_at ?? null,
              max_views: l.max_views ?? null,
              view_count: l.view_count ?? 0,
              active: shareLinkIsActive(l),
            })),
            share_links_readable: links !== null,
          })
          prompts.outro("Done")
          return
        }
        renderReach(page, current, links)
        const next: VisibilityMode = current.mode === "public" ? "unlisted" : "public"
        prompts.outro(dim(`iris pages visibility ${slug} ${next}   ·   iris pages share ${slug}`))
        return
      }

      // ---- Set mode --------------------------------------------------------
      if (current.declared && current.mode === mode) {
        sp.stop(`Already ${mode}`)
        renderReach(page, current, links)
        prompts.outro("Done")
        return
      }
      sp.stop(`Currently ${current.declared ? current.mode : "public (default)"}`)

      // Restricting breaks every /p/{slug} link already in the wild. Say so before doing it.
      const restricting = mode !== "public" && reachFor(current.mode).slug
      if (restricting) {
        console.log()
        prompts.log.warn(
          `Any /p/${slug} link you have already shared WILL BREAK — it 404s from the moment this lands.\n` +
          `  Breaking now:  ${publicUrl(page)}` +
          (mode === "private" && uuidUrl(page) ? `\n  Also breaking: ${uuidUrl(page)}` : "") +
          `\n  Still works:   ${mode === "unlisted" ? (uuidUrl(page) ?? "(no UUID alias on this page)") : "only active /s/{token} share links"}`,
        )
        if (!args.yes && !isNonInteractive()) {
          const ok = await prompts.confirm({ message: `Set ${slug} to ${mode}?` })
          if (prompts.isCancel(ok) || !ok) { prompts.outro("Cancelled — nothing changed"); return }
        }
      }

      const sp2 = prompts.spinner()
      sp2.start(`Setting visibility to ${mode}…`)
      const res = await pagesFetch(`/api/v1/pages/${page.id}`, {
        method: "PUT",
        body: JSON.stringify({ visibility: mode }),
      })
      if (!(await handleApiError(res, "Set visibility"))) { sp2.stop("Failed", 1); prompts.outro("Done"); return }
      const updated = ((await res.json()) as any)?.data ?? {}
      const after = readVisibility(updated)

      // The API accepted the PUT but dropped the field → this build predates the
      // visibility column. Don't claim a change that didn't happen.
      if (!after.declared || after.mode !== mode) {
        sp2.stop("Not applied", 1)
        process.exitCode = 1
        prompts.log.error(
          `The API accepted the request but the page still reports visibility=${after.declared ? after.mode : "(absent)"}.\n` +
          `  This backend doesn't support page visibility yet — nothing changed.`,
        )
        prompts.outro("Done")
        return
      }

      // A stale rendered page would keep serving the old reachability, so purge it
      // here rather than making the operator remember two cache keys.
      await pagesFetch("/api/internal/cache/purge-page", {
        method: "POST",
        body: JSON.stringify({ slug }),
      }).catch(() => {})

      sp2.stop(success(`Visibility set to ${mode}`))
      console.log()
      if (mode === "public") {
        console.log(`  ${bold("Share this:")}  ${highlight(publicUrl(page))}`)
        console.log(`  ${dim("Anyone can reach it and search engines can index it.")}`)
      } else if (mode === "unlisted") {
        const uu = uuidUrl(page)
        console.log(`  ${bold("Share this:")}  ${highlight(uu ?? publicUrl(page))}`)
        console.log(`  ${dim(uu ? "Unguessable and not discoverable — but anyone holding it gets in." : "This page has no UUID alias; mint a share link instead.")}`)
        console.log(`  ${dim(`Dead now:     ${publicUrl(page)}`)}`)
      } else {
        console.log(`  ${bold("Both /p/ urls are now dead.")} ${dim("The only way in is a share link:")}`)
        console.log(`  ${highlight(`iris pages share ${slug}`)}`)
        console.log(`  ${dim(`Dead now:     ${publicUrl(page)}${uuidUrl(page) ? `  and  ${uuidUrl(page)}` : ""}`)}`)
      }
      console.log()
      console.log(`  ${dim(`Revert: iris pages visibility ${slug} ${current.mode}`)}`)
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ShareCmd = cmd({
  command: "share <slug>",
  describe: "mint a disposable /s/{token} capability link (works even while unpublished)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("expires", { describe: "expiry — duration (30m, 12h, 7d, 2w) or date (2026-12-31)", type: "string" })
      .option("max-views", { describe: "burn the link after N views", type: "number" })
      .option("label", { describe: "who/what this link is for (shown in share:list)", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const slug = String(args.slug)
    prompts.intro(`◈  Share link: ${slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Minting…")
    try {
      let expiresAt: string | null = null
      if (args.expires) {
        const parsed = parseExpiry(String(args.expires))
        if ("error" in parsed) {
          sp.stop("Invalid --expires", 1)
          process.exitCode = 1
          prompts.log.error(parsed.error)
          prompts.outro("Done")
          return
        }
        expiresAt = parsed.iso
      }
      const maxViews = args["max-views"] as number | undefined
      if (maxViews != null && (!Number.isInteger(maxViews) || maxViews < 1)) {
        sp.stop("Invalid --max-views", 1)
        process.exitCode = 1
        prompts.log.error("--max-views must be a whole number of 1 or more")
        prompts.outro("Done")
        return
      }

      const page = await getBySlug(slug, false)
      if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const payload: Record<string, unknown> = {}
      if (args.label) payload.label = String(args.label)
      if (expiresAt) payload.expires_at = expiresAt
      if (maxViews != null) payload.max_views = maxViews

      const res = await shareFetch(`/api/v1/pages/${page.id}/share-links`, {
        method: "POST",
        body: JSON.stringify(payload),
      })
      if (!(await handleApiError(res, "Create share link"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const body = (await res.json()) as { data?: ShareLink; share_url?: string }
      const link = body?.data
      if (!link?.token) {
        sp.stop("Failed", 1)
        process.exitCode = 1
        prompts.log.error("The API returned no token for the new share link.")
        prompts.outro("Done")
        return
      }
      const url = body.share_url ?? shareUrlFor(link, page)
      sp.stop(success("Share link created"))

      if (args.json) {
        await writeJson({ ...link, url })
        prompts.outro("Done")
        return
      }

      console.log()
      console.log(`  ${highlight(url)}`)
      console.log()
      printKV("Label", link.label ?? dim("(none)"))
      printKV("Expires", link.expires_at ? `${String(link.expires_at).slice(0, 19).replace("T", " ")} UTC` : dim("never — this link lives forever until revoked"))
      printKV("Max views", link.max_views != null ? String(link.max_views) : dim("unlimited"))
      printKV("Serves", page.status === "published" ? "the published page" : `the ${page.status} page — share links bypass publishing`)
      console.log()
      prompts.log.warn(
        "This is a capability url, not access control: anyone who has the link gets in —\n" +
        "  no login, no allowlist. Forwarded, pasted, or logged means shared.",
      )
      console.log(`  ${dim(`Revoke: iris pages share:revoke ${link.token}`)}`)
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ShareListCmd = cmd({
  command: "share:list <slug>",
  aliases: ["shares", "share-links"],
  describe: "list a page's share links with view counts and expiry",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug", type: "string", demandOption: true })
      .option("all", { describe: "include revoked/expired/burnt links", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const slug = String(args.slug)
    prompts.intro(`◈  Share links: ${slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading…")
    try {
      const page = await getBySlug(slug, false)
      if (!page) { sp.stop("Page not found", 1); process.exitCode = 1; prompts.outro("Done"); return }
      const links = await fetchShareLinks(page.id)
      if (links === null) { sp.stop("Failed", 1); prompts.outro("Done"); return }

      const shown = args.all ? links : links.filter(shareLinkIsActive)
      sp.stop(`${shown.length} ${args.all ? "" : "active "}link(s)${args.all ? "" : links.length > shown.length ? ` (${links.length - shown.length} inactive hidden — use --all)` : ""}`)

      if (args.json) {
        await writeJson(shown.map((l) => ({ ...l, url: shareUrlFor(l, page), active: shareLinkIsActive(l) })))
        prompts.outro("Done")
        return
      }
      if (shown.length === 0) {
        prompts.log.info(dim(`No ${args.all ? "" : "active "}share links. Mint one: iris pages share ${slug}`))
        prompts.outro("Done")
        return
      }
      printDivider()
      for (const l of shown) {
        const active = shareLinkIsActive(l)
        console.log(`  ${active ? success("●") : dim("○")} ${active ? shareUrlFor(l, page) : dim(shareUrlFor(l, page))}`)
        console.log(`      ${dim(shareLinkMeta(l))}`)
        console.log()
      }
      printDivider()
      prompts.log.warn("Every active link above grants full access to anyone holding it.")
      prompts.outro(dim(`iris pages share:revoke <token>   ·   iris pages visibility ${slug}`))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const ShareRevokeCmd = cmd({
  command: "share:revoke <token>",
  aliases: ["unshare"],
  describe: "revoke a share link so its /s/{token} url stops working",
  builder: (y) =>
    y
      .positional("token", { describe: "share token (from `iris pages share:list`) or a full /s/ url", type: "string", demandOption: true })
      .option("yes", { describe: "skip the confirmation", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    // Accept a pasted /s/{token} url as well as a bare token — the url is what the
    // operator actually has in hand.
    const token = String(args.token).trim().replace(/^.*\/s\//, "").replace(/[/?#].*$/, "")
    prompts.intro(`◈  Revoke share link`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    if (!args.yes && !isNonInteractive()) {
      const ok = await prompts.confirm({ message: `Revoke ${token.slice(0, 12)}… permanently? Anyone using this link loses access immediately.` })
      if (prompts.isCancel(ok) || !ok) { prompts.outro("Cancelled — nothing changed"); return }
    }

    const sp = prompts.spinner()
    sp.start("Revoking…")
    try {
      const res = await shareFetch(`/api/v1/pages/share-links/${encodeURIComponent(token)}`, { method: "DELETE" })
      if (!(await handleApiError(res, "Revoke share link"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      sp.stop(success("Revoked"))
      console.log(`  ${dim(`/s/${token} now 404s for everyone.`)}`)
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Read / Verify — the READ-BACK surface
// ============================================================================

/**
 * Until these commands existed, every `iris pages` verb was a WRITE verb (create,
 * duplicate, push, publish, set, reassign, cache-clear) with exactly one read-back:
 * `screenshot`, which returns a PNG and therefore no pass/fail. So anyone — human or
 * agent — who had just published a page and wanted to know whether it worked had no
 * CLI-shaped way to ask, and fell back to `curl | grep`.
 *
 * That fallback does not merely fail, it fails GREEN and it fails RED at random. Measured
 * on /p/harness-position-paper (2026-08-22), on a page that had published perfectly:
 *
 *   grep -c 'THE HARNESS'      -> 0   the headline is text-transform:uppercase (8 rules in
 *                                     that stylesheet); the bytes say "The harness"
 *   data-page regex            -> AttributeError   the page is bespoke, served by
 *                                     public-html.blade, so there IS no data-page attr.
 *                                     The right answer, raised as a crash.
 *   grep -c 'already shipping' -> 0   the phrase differs from the one remembered; the
 *                                     count cannot distinguish "absent" from "reworded"
 *   wc -c -> 21294                    no threshold exists that separates a bespoke doc
 *                                     from an Inertia shell
 *
 * Four checks, zero information, on a page that was fine. This is the same family as
 * confirming a deploy with `grep -c <symbol>` (PRODUCTION_DEBUGGING_GUIDE) — a check that
 * cannot tell "broken" from "not measured".
 *
 * The fix is to read the page the way a reader does: render it in a browser and return
 * the TEXT LAYER, then match against that with normalization. Not to wrap grep.
 */

export type PageLane = "composable" | "bespoke"

export interface RenderedPage {
  url: string
  status: number
  title: string
  lane: PageLane
  gated: boolean
  text: string
  headings: string[]
  words: number
  bytes: number
}

/**
 * `data-page` is the Inertia payload attribute. Present => the composable Genesis viewer
 * rendered this; absent => it came from public-html.blade, i.e. a bespoke render_mode:html
 * page. Reporting which lane served the page turns the single most confusing failure in
 * this area ("my data-page parser threw") into a fact on stderr.
 */
export function detectLane(rawHtml: string): PageLane {
  return /\sdata-page\s*=/.test(rawHtml) ? "composable" : "bespoke"
}

/**
 * Is this the OTP gate rather than the page?
 *
 * An unauthenticated fetch of a `requires_auth` page returns HTTP 200 with a fully
 * rendered gate, so every signal these commands rely on reads as a normal success:
 * status 200, a title, real text. Measured on /p/iris-harness-gap-analysis — `read`
 * returned "Welcome to IRIS / Instant access — no code, no password / Email address /
 * Continue" as if that were the document, and `--min-words 400` would have failed with
 * "52 words", which reads as an EMPTY page rather than one you were never let into.
 *
 * That is the exact defect these commands exist to remove — a check that cannot tell
 * "broken" from "not measured" — so the gate has to be a refusal, not a low word count.
 *
 * The authoritative signal is the Inertia payload: `props.gateRequired`. The copy-based
 * fallback covers a gate rendered outside that payload; it is deliberately narrow (an
 * email input alone is not a gate — plenty of real pages have one).
 */
export function detectGated(rawHtml: string): boolean {
  const m = rawHtml.match(/\sdata-page\s*=\s*"([^"]*)"/)
  if (m) {
    try {
      const decoded = m[1]
        .replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&apos;/g, "'")
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      const props = (JSON.parse(decoded) as any)?.props ?? {}
      if (props.gateRequired === true) return true
      // An authenticated read is NOT gated even when the page carries a gate.
      if (props.gateRequired === false) return false
    } catch {
      // fall through to the copy heuristic
    }
  }
  return /Instant access\s*—\s*no code, no password/i.test(rawHtml)
}

/**
 * Normalize both haystack and needle before matching.
 *
 * Case folding is not a convenience here, it is the whole point: CSS `text-transform`
 * means what a reader sees ("THE HARNESS") and what any text layer holds ("The harness")
 * differ, so a case-sensitive match on remembered-as-seen text is a guaranteed false
 * negative. Typographic folding covers the same class one layer down — bespoke pages are
 * written with curly quotes, em dashes and non-breaking spaces, and nobody retypes those
 * correctly into a shell argument.
 */
export function normalizeForMatch(input: string, opts?: { caseSensitive?: boolean }): string {
  let s = input
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐‑‒–—―]/g, "-")
    .replace(/[   ]/g, " ")
    .replace(/…/g, "...")
    .replace(/\s+/g, " ")
    .trim()
  if (!opts?.caseSensitive) s = s.toLowerCase()
  return s
}

/**
 * Render a published page in a real browser and return its text layer.
 *
 * Shared by `read` and `verify` so the two can never disagree about what the page says —
 * `verify` is exactly `read` plus assertions plus an exit code.
 */
async function renderPage(slug: string, opts: { width: number; timeout: number; allowGated?: boolean }): Promise<RenderedPage> {
  const { chromium } = await import("playwright" as string)
  const url = publicUrl(slug)
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({ viewport: { width: opts.width, height: 900 } })
    const resp = await page.goto(url, { waitUntil: "networkidle", timeout: opts.timeout })
    // The composable lane hydrates after networkidle; without this the text layer of a
    // Genesis page is the empty Inertia shell and every expectation fails for the wrong
    // reason. Bespoke pages are already complete and just pay the wait.
    await page.waitForTimeout(1500)

    const status = resp?.status() ?? 0
    const title = (await page.title().catch(() => "")) || ""
    const rawHtml = await page.content()

    // Same refusal as `screenshot` (#180796): /p/ serves PUBLISHED pages only, and the SPA
    // route can serve the not-found view with HTTP 200. A read-back tool that returns the
    // 404 page's text as if it were the page is the exact defect these commands exist to
    // remove, so this throws rather than returning something plausible.
    if (status >= 400 || /page not found/i.test(title)) {
      throw new Error(
        status >= 400
          ? `${url} returned HTTP ${status} — nothing was read.\n  /p/ serves PUBLISHED pages only. If this is a draft: iris pages publish ${slug}`
          : `${url} served the not-found page — nothing was read.\n  /p/ serves PUBLISHED pages only. If this is a draft: iris pages publish ${slug}`,
      )
    }

    const extracted = await page.evaluate(() => {
      const body = document.body
      // innerText, not textContent: a display-block child inside a heading (the usual
      // way a bespoke display headline is line-broken) yields no separator under
      // textContent, so "The harness / is not / the moat" came back as
      // "The harnessis notthe moat" — unmatchable and unreadable.
      const heads = Array.from(document.querySelectorAll("h1,h2,h3"))
        .map((h) => ((h as HTMLElement).innerText ?? h.textContent ?? "").replace(/\s+/g, " ").trim())
        .filter(Boolean)
      return { text: body ? body.innerText : "", headings: heads }
    })

    // Refuse the gate for the same reason we refuse the 404: returning its text as the
    // page's would make every downstream assertion answer a question nobody asked.
    if (detectGated(rawHtml) && !opts.allowGated) {
      throw new Error(
        `${url} served the OTP GATE, not the page — you are not authenticated.\n` +
          `  Anything read here is the gate's own text, not the document.\n` +
          `  Check who can actually read it:  iris pages check-public ${slug}\n` +
          `  To inspect the gate itself:      add --allow-gated`,
      )
    }

    const text = String(extracted.text ?? "")
    return {
      url,
      status,
      title,
      lane: detectLane(rawHtml),
      gated: detectGated(rawHtml),
      text,
      headings: extracted.headings ?? [],
      words: text.split(/\s+/).filter(Boolean).length,
      bytes: rawHtml.length,
    }
  } finally {
    await browser.close()
  }
}

function playwrightHint(e: any): string {
  const m = e?.message ?? String(e)
  if (m.includes("Cannot find module") || m.toLowerCase().includes("playwright")) {
    return "Playwright not installed. Run: npm install playwright"
  }
  return m
}

const ReadCmd = cmd({
  command: "read <slug>",
  aliases: ["text"],
  describe: "render a live page in a browser and print its TEXT (stdout) — pipe it to grep",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug — e.g. `my-page`, not `pages/my-page.json`", type: "string", demandOption: true })
      .option("json", { describe: "emit a JSON envelope (url, lane, title, headings, words, text)", type: "boolean", default: false })
      .option("headings", { describe: "print only h1/h2/h3", type: "boolean", default: false })
      .option("allow-gated", { describe: "read the OTP gate itself instead of refusing (the text will NOT be the page)", type: "boolean", default: false })
      .option("width", { describe: "viewport width", type: "number", default: 1440 })
      .option("timeout", { describe: "navigation timeout (ms)", type: "number", default: 30000 }),
  async handler(args) {
    const { slug } = normalizeSlugArg(args.slug)
    try {
      const r = await renderPage(slug, { width: Number(args.width), timeout: Number(args.timeout), allowGated: !!args["allow-gated"] })

      if (args.json) {
        writeJson(r)
        return
      }

      // Diagnostics on STDERR, content on STDOUT. `read | grep` is the intended use, and a
      // pipe that swallowed the lane/status line would rebuild the hazard this command was
      // written to remove — you would filter away the one line saying the read was bad and
      // see a clean empty result. stderr survives the pipe.
      process.stderr.write(
        `${dim(`  ${r.url}  ·  lane: ${r.lane}${r.gated ? "  ·  GATED (this is the gate, not the page)" : ""}  ·  HTTP ${r.status}  ·  ${r.words} words`)}\n` +
          `${dim(`  title: ${r.title}`)}\n`,
      )
      process.stdout.write((args.headings ? r.headings.join("\n") : r.text) + "\n")
    } catch (e: any) {
      process.stderr.write(`${UI.Style.TEXT_DANGER}  ${playwrightHint(e)}${UI.Style.TEXT_NORMAL}\n`)
      process.exitCode = 1
    }
  },
})

const VerifyCmd = cmd({
  command: "verify <slug>",
  aliases: ["check"],
  describe: "assert a live page renders and contains expected text — exits non-zero on failure",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug — e.g. `my-page`, not `pages/my-page.json`", type: "string", demandOption: true })
      .option("expect", { describe: "text that MUST appear (repeatable)", type: "string", array: true, default: [] as string[] })
      .option("not-expect", { describe: "text that must NOT appear (repeatable)", type: "string", array: true, default: [] as string[] })
      .option("min-words", { describe: "fail if the rendered page has fewer words than this", type: "number" })
      .option("lane", { describe: "assert which renderer served the page", type: "string", choices: ["composable", "bespoke"] })
      .option("case-sensitive", { describe: "match case exactly (default folds case — CSS uppercase makes exact matching a false-negative machine)", type: "boolean", default: false })
      .option("allow-gated", { describe: "assert against the OTP gate itself instead of refusing", type: "boolean", default: false })
      .option("width", { describe: "viewport width", type: "number", default: 1440 })
      .option("timeout", { describe: "navigation timeout (ms)", type: "number", default: 30000 })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const { slug, corrected } = normalizeSlugArg(args.slug)
    if (!args.json) prompts.intro(`◈  Verify: ${slug}`)
    if (corrected && !args.json) noteSlugCorrection(args.slug, slug)

    const sp = args.json ? null : prompts.spinner()
    sp?.start("Rendering…")

    try {
      const r = await renderPage(slug, { width: Number(args.width), timeout: Number(args.timeout), allowGated: !!args["allow-gated"] })
      const caseSensitive = !!args["case-sensitive"]
      const hay = normalizeForMatch(r.text, { caseSensitive })

      type Check = { kind: string; label: string; pass: boolean }
      const checks: Check[] = []

      for (const raw of (args.expect as string[]) ?? []) {
        checks.push({ kind: "expect", label: raw, pass: hay.includes(normalizeForMatch(raw, { caseSensitive })) })
      }
      for (const raw of (args["not-expect"] as string[]) ?? []) {
        checks.push({ kind: "not-expect", label: raw, pass: !hay.includes(normalizeForMatch(raw, { caseSensitive })) })
      }
      if (args["min-words"] !== undefined) {
        const min = Number(args["min-words"])
        checks.push({ kind: "min-words", label: `>= ${min} words (got ${r.words})`, pass: r.words >= min })
      }
      if (args.lane) {
        checks.push({ kind: "lane", label: `lane == ${args.lane} (got ${r.lane})`, pass: r.lane === args.lane })
      }

      const failed = checks.filter((c) => !c.pass)

      if (args.json) {
        writeJson({ slug, url: r.url, lane: r.lane, gated: r.gated, status: r.status, title: r.title, words: r.words, checks, ok: failed.length === 0 })
        if (failed.length) process.exitCode = 1
        return
      }

      sp?.stop(failed.length === 0 ? success("Rendered") : "Rendered")
      printKV("URL", r.url)
      printKV("Lane", r.lane)
      if (r.gated) printKV("Gated", "YES — asserting against the GATE, not the page")
      printKV("Title", r.title)
      printKV("Words", String(r.words))

      if (checks.length === 0) {
        // No assertions is not a pass. It renders and that is all we established — say so
        // rather than printing a green outro that reads as "verified".
        console.log()
        prompts.log.warn("No assertions given — this only proves the page RENDERS.")
        prompts.log.info(dim(`Add some: iris pages verify ${slug} --expect "a phrase from the page"`))
        prompts.outro("Done")
        return
      }

      console.log()
      for (const c of checks) {
        const mark = c.pass ? success("✓") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
        console.log(`  ${mark} ${dim(c.kind)}  ${c.label}`)
      }
      console.log()

      if (failed.length) {
        prompts.log.error(`${failed.length} of ${checks.length} checks failed.`)
        // The commonest cause of a failing --expect is a phrase remembered from the draft
        // rather than read off the page. Point at the tool that settles it instead of
        // leaving someone to re-derive curl+grep.
        prompts.log.info(dim(`See what it actually says: iris pages read ${slug} | less`))
        process.exitCode = 1
      } else {
        prompts.log.success(`All ${checks.length} checks passed.`)
      }
      prompts.outro("Done")
    } catch (e: any) {
      sp?.stop("Failed", 1)
      prompts.log.error(playwrightHint(e))
      process.exitCode = 1
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Publish HTML — a local .html file becomes a live bespoke page
// ============================================================================

/**
 * The bespoke playbook (.claude/skills/bespoke/SKILL.md) shipped a `python3 -c` script for
 * this, with no decisions in it — which is a verb that had not been written yet. Every
 * bespoke page therefore went out through hand-rolled JSON surgery in a shell heredoc, and
 * that path has two banked failure modes, both of them from the SAME cause: it works
 * through ./pages, relative to the current working directory.
 *
 *   - a shell whose cwd was reset mid-session -> FileNotFoundError on the file just pulled
 *   - a persisted `cd` into fl-iris-api -> an Aug-17 shadow of /p/docs shipped OVER the
 *     live page, printing Done (#181601)
 *
 * This command writes no local file at all unless asked (--keep-json), so neither is
 * reachable from it.
 */

export interface ParsedHtmlDoc {
  title: string | null
  description: string | null
  css: string
  body: string
  isFullDocument: boolean
}

/**
 * Split an authored HTML file into the fields a Genesis page needs.
 *
 * Regex, not a parser, and deliberately: the input is a file we authored for this purpose,
 * not arbitrary web HTML. Anything with a <style> in the body or a </body> inside a string
 * literal is out of contract — and `pages verify` is the backstop that catches it, which
 * is the point of shipping the two together.
 */
export function parseHtmlDocument(src: string): ParsedHtmlDoc {
  const titleMatch = src.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const descMatch = src.match(/<meta\s+[^>]*name\s*=\s*["']description["'][^>]*content\s*=\s*["']([\s\S]*?)["']/i)

  const styles: string[] = []
  const styleRe = /<style[^>]*>([\s\S]*?)<\/style>/gi
  let m: RegExpExecArray | null
  while ((m = styleRe.exec(src)) !== null) styles.push(m[1].trim())

  const isFullDocument = /<html[\s>]/i.test(src)
  let body: string
  const bodyMatch = src.match(/<body[^>]*>([\s\S]*?)<\/body>/i)
  if (bodyMatch) {
    body = bodyMatch[1]
  } else {
    // A fragment: everything that is not head furniture.
    body = src
      .replace(/<!DOCTYPE[^>]*>/gi, "")
      .replace(/<\/?html[^>]*>/gi, "")
      .replace(/<head[\s\S]*?<\/head>/gi, "")
      .replace(/<\/?body[^>]*>/gi, "")
  }
  body = body.replace(styleRe, "").trim()

  return {
    title: titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null,
    description: descMatch ? descMatch[1].replace(/\s+/g, " ").trim() : null,
    css: styles.join("\n\n"),
    body,
    isFullDocument,
  }
}

/**
 * Build the json_content for either bespoke lane.
 *
 * `requiresAuth` must drive `json_content.requireOtp` here, not just the `requires_auth`
 * record column the caller sets separately. The gate is genuinely two flags (#182059):
 * `requires_auth` decides whether the page is LOCKED at all; `requireOtp` decides which
 * modal the visitor sees once it is — a real emailed 6-digit code, or the frictionless
 * "instant access, no code, no password" capture form. This function used to hardcode
 * `requireOtp: false` on the standalone lane (and omit it entirely on the custom lane,
 * which is the same false), so `publish-html --requires-auth` locked the page but always
 * handed visitors the frictionless form — which for a page nobody had pre-registered on
 * simply looped, because the "instant access" path has no code to submit at all. Measured
 * live on /p/mediguide-boundary: the owner could not get past the email step.
 */
export function buildBespokeJsonContent(
  doc: ParsedHtmlDoc,
  lane: "standalone" | "custom",
  opts?: { themeMode?: string; backgroundColor?: string; brandName?: string; requiresAuth?: boolean },
): Record<string, any> {
  const requireOtp = !!opts?.requiresAuth
  if (lane === "standalone") {
    // render_mode:html -> public-html.blade.php serves the document with a minimal reset.
    return { version: "2.0", type: "article", render_mode: "html", html: doc.body, css: doc.css, requireOtp }
  }
  // CustomHtml lane: one v-html block inside the normal composable shell. The CSS has to
  // ride along inside the fragment because props.html is a single field.
  const fragment = doc.css ? `<style>\n${doc.css}\n</style>\n${doc.body}` : doc.body
  return {
    version: "2.0",
    type: "landing",
    theme: {
      mode: opts?.themeMode ?? "light",
      backgroundColor: opts?.backgroundColor ?? "#ffffff",
      branding: { name: opts?.brandName ?? "IRIS", description: doc.description ?? "" },
    },
    requireOtp,
    components: [{ type: "CustomHtml", id: "doc", props: { html: fragment } }],
  }
}

const PublishHtmlCmd = cmd({
  command: "publish-html <slug>",
  aliases: ["ship-html"],
  describe: "publish a local .html file as a bespoke Genesis page (replaces the hand-rolled JSON surgery)",
  builder: (y) =>
    y
      .positional("slug", { describe: "page slug to create or update", type: "string", demandOption: true })
      .option("file", { describe: "path to the .html file", type: "string", demandOption: true })
      .option("lane", {
        describe: "standalone (render_mode:html, own document) | custom (CustomHtml in the composable shell). Default: inferred from the file",
        type: "string",
        choices: ["standalone", "custom"],
      })
      .option("title", { describe: "page title (default: the file's <title>)", type: "string" })
      .option("description", { describe: "SEO description (default: the file's meta description)", type: "string" })
      .option("owner-type", { describe: "owner type", type: "string", default: "bloq" })
      .option("owner-id", { describe: "owner bloq id", type: "number", default: 38 })
      .option("theme-mode", { describe: "custom lane only: light | dark", type: "string", default: "light" })
      .option("requires-auth", { describe: "put the page behind the OTP gate", type: "boolean", default: false })
      .option("publish", { describe: "publish after upload (default)", type: "boolean", default: true })
      // boolean-negation is disabled globally (src/index.ts:224), so `--no-publish` is NOT
      // the negation of `--publish` — it is an unknown key, and `.strict()` turns it into a
      // usage dump. Caught claiming the opposite in the playbook: a filtered check showed a
      // leftover "Draft" from an earlier unpublish and read as a pass, while the command had
      // not run at all. Register the literal flag, as `pulse check --no-push` does.
      .option("no-publish", { describe: "upload but leave it a draft", type: "boolean", default: false })
      .option("keep-json", { describe: "also write ./pages/<slug>.json", type: "boolean", default: false })
      .option("dry-run", { describe: "show what would be sent, send nothing", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const { slug, corrected } = normalizeSlugArg(args.slug)
    prompts.intro(`◈  Publish HTML: ${slug}`)
    if (corrected) noteSlugCorrection(args.slug, slug)

    const filePath = resolve(String(args.file))
    if (!existsSync(filePath)) {
      prompts.log.error(`File not found: ${filePath}`)
      process.exitCode = 1
      prompts.outro("Done")
      return
    }

    const src = readFileSync(filePath, "utf-8")
    const doc = parseHtmlDocument(src)
    const lane = (args.lane as "standalone" | "custom" | undefined) ?? (doc.isFullDocument ? "standalone" : "custom")

    const title = (args.title as string) ?? doc.title ?? slug
    const description = (args.description as string) ?? doc.description ?? undefined

    if (!doc.body.trim()) {
      prompts.log.error("No body content found in that file — nothing to publish.")
      process.exitCode = 1
      prompts.outro("Done")
      return
    }
    // A bespoke page with no CSS is nearly always a file that was split wrong, and it
    // publishes as unstyled text without erroring. Warn rather than block — a plain
    // semantic document is legitimate.
    if (!doc.css.trim()) prompts.log.warn("No <style> found — the page will publish unstyled.")

    const jsonContent = buildBespokeJsonContent(doc, lane, {
      themeMode: String(args["theme-mode"]),
      requiresAuth: !!args["requires-auth"],
    })

    prompts.log.info(dim(`from ${filePath}`))
    printKV("Lane", lane === "standalone" ? "standalone (render_mode:html)" : "custom (CustomHtml component)")
    printKV("Title", title)
    printKV("HTML", `${doc.body.length} chars`)
    printKV("CSS", `${doc.css.length} chars`)
    if (description) printKV("Description", description)

    if (args["dry-run"]) {
      console.log()
      prompts.log.info("Dry run — nothing sent.")
      prompts.outro("Done")
      return
    }

    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const shouldPublish = !!args.publish && !args["no-publish"]

    const sp = prompts.spinner()
    sp.start("Uploading…")
    try {
      let page = await getBySlug(slug, false)

      if (!page) {
        sp.message("No page for that slug yet — creating…")
        page = await createPageFromJson({
          slug,
          title,
          seo_title: title,
          seo_description: description,
          owner_type: String(args["owner-type"]),
          owner_id: Number(args["owner-id"]),
          json_content: jsonContent,
          publish: shouldPublish,
          requires_auth: !!args["requires-auth"],
        })
        if (!page) { sp.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
      } else {
        const updateData: Record<string, unknown> = {
          json_content: jsonContent,
          title,
          seo_title: title,
          requires_auth: !!args["requires-auth"],
        }
        if (description) updateData.seo_description = description
        const res = await pagesFetch(`/api/v1/pages/${page.id}`, { method: "PUT", body: JSON.stringify(updateData) })
        if (!(await handleApiError(res, "Update page"))) { sp.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

        if (shouldPublish) {
          const pubRes = await pagesFetch(`/api/v1/pages/${page.id}/publish`, { method: "POST" })
          if (!(await handleApiError(pubRes, "Publish"))) { sp.stop("Uploaded but publish failed", 1); process.exitCode = 1; prompts.outro("Done"); return }
        }
      }

      // Purge unconditionally. `push --publish` does this too; the failure it prevents is
      // verifying a stale render and concluding the publish did not work.
      await pagesFetch("/api/internal/cache/purge-page", {
        method: "POST",
        body: JSON.stringify({ slug }),
      }).catch(() => {})

      if (args["keep-json"]) {
        const dir = pagesDir()
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
        writeFileSync(
          join(dir, `${slug}.json`),
          JSON.stringify(
            { id: page.id, slug, title, seo_title: title, seo_description: description ?? null, status: shouldPublish ? "published" : "draft", owner_type: String(args["owner-type"]), owner_id: Number(args["owner-id"]), requires_auth: !!args["requires-auth"], json_content: jsonContent },
            null,
            2,
          ) + "\n",
        )
        prompts.log.info(dim(`wrote ${join(dir, `${slug}.json`)}`))
      }

      // Report the status the SERVER now holds, not the one the flags imply. `--no-publish`
      // skips the publish call; it does not unpublish, so on an already-live page the old
      // inferred message said "Uploaded (draft)" while the page was Published and still
      // serving. A status line that can be wrong is worse than none — it is the same
      // "cannot tell broken from not-measured" failure these commands were written to kill,
      // reproduced inside the fix for it. Measured on cli-publish-html-selftest.
      const after = await getBySlug(slug, false)
      const liveNow = after?.status === "published"
      sp.stop(success(liveNow ? "Published" : "Uploaded (draft)"))

      if (!shouldPublish && liveNow) {
        prompts.log.warn("--no-publish skips publishing; it does NOT unpublish.")
        prompts.log.warn(`This page was already live, so the new version is LIVE now.`)
        prompts.log.info(dim(`To take it down: iris pages unpublish ${slug}`))
      }
      console.log(`  ${highlight(publicUrl(slug))}`)
      console.log()
      // The publish is not the evidence. Hand over the command that produces evidence,
      // with the page's own title pre-filled so it is one paste to run.
      if (liveNow) {
        // The shared hint below prints the generic verify line; this one is better because
        // the title is a phrase we KNOW is on the page, so it is one paste to a real check.
        prompts.log.info(`Verify it: ${highlight(`iris pages verify ${slug} --expect ${JSON.stringify(title)}`)}`)
      } else {
        // verify reads /p/, which serves PUBLISHED pages only — suggesting it on a draft
        // would hand over a command guaranteed to fail for a reason unrelated to the page.
        prompts.log.info(dim(`Draft — /p/ will 404 until: iris pages publish ${slug}`))
      }
      printDesignStandardHint(slug)
      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error", 1)
      prompts.log.error(e?.message ?? String(e))
      process.exitCode = 1
      prompts.outro("Done")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

/**
 * The house design standard is easy to have and easy to skip — it lived in a Genesis page, a bloq
 * item and agent memory, and pages still shipped that had never been scored against it. Printing it
 * at the moment a page is created or published puts it in front of the person actually shipping,
 * which is the only place it reliably lands.
 */
function printDesignStandardHint(slug?: string): void {
  console.log()
  console.log(`  ${dim("Design standard:")} ${highlight("iris how-to view genesis-design-standard")}`)
  console.log(`  ${dim("Score the 10-point audit before this goes out — and open it in a browser.")}`)
  // Discoverability by adjacency. `pages read`/`verify` exist because publishing used to
  // dead-end here with nothing to run next, so people reached for `curl | grep` — which
  // returns false negatives in both directions (see the ReadCmd header). A verb nobody
  // knows about is the same as a verb that does not exist, and the moment someone wants it
  // is the moment a publish finishes. Print it there.
  if (slug) {
    console.log()
    console.log(`  ${dim("Verify the render:")} ${highlight(`iris pages verify ${slug} --expect "a phrase from the page"`)}`)
    console.log(`  ${dim("Read it as text:  ")} ${highlight(`iris pages read ${slug}`)}`)
  }
}

// Genesis is the product; "pages" is the noun it operates on. As an alias, `iris genesis
// --help` printed "iris pages" (#181888 PROD-4). Canonical name flipped; `iris pages ...`
// is unchanged and still works everywhere it is already written down.
export const PlatformPagesCommand = productCommand({
  name: "genesis",
  aliases: ["pages"],
  purpose:
    "Genesis — composable pages, sites and COMPONENTS: browse the component library with its props/emits/slots, see which pages use a component before changing it, roll a component back, plus pages list/view/get/set/pull/push/diff/publish/screenshot",
  keywords: ["genesis", "page", "site", "component", "components", "library", "catalogue", "props", "emits", "slots", "usage", "rollback", "versions", "stale", "publish", "artifact", "landing", "screenshot", "verify", "read", "bespoke", "html"],
  howtos: ["genesis-design-standard", "bespoke", "genesis-sdk", "pages"],
  playbooks: ["pages", "seed-pages"],
  builder: (y) =>
    y
      .command(LibraryCmd)
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
      .command(VisibilityCmd)
      .command(ShareCmd)
      .command(ShareListCmd)
      .command(ShareRevokeCmd)
      .command(CreateCmd)
      .command(DuplicateCmd)
      .command(CheckPublicCmd)
      .command(RebrandCmd)
      .command(ComponentsCmd)
      .command(ComposeCmd)
      .command(ComponentRegistryCmd)
      .command(AddTableCmd)
      .command(VersionsCmd)
      .command(RollbackCmd)
      .command(QrCmd)
      .command(ScreenshotCmd)
      .command(ReadCmd)
      .command(VerifyCmd)
      .command(PublishHtmlCmd)
      .command(ReassignCmd)
      .command(UngateCmd)
      .command(CacheClearCmd)
      .demandCommand(),
})
