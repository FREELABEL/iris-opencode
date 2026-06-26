// Shared logic for publishing/sharing bloq items, used by both the `bloqs` and
// branded `atlas:item` command families so they never drift.
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, isNonInteractive, FL_API } from "./iris-api"
import * as prompts from "./clack"
import { UI } from "../ui"
import matter from "gray-matter"
import { readFileSync, writeFileSync, existsSync } from "fs"
import path from "path"

const DEFAULT_BLOQ_NAME = "Published Docs"
const DEFAULT_LIST_NAME = "Published"

// ── API helpers ─────────────────────────────────────────────────────────────

async function unwrap(res: Response): Promise<any> {
  const j = (await res.json().catch(() => null)) as any
  return j?.data ?? j
}

export async function apiMakePublic(
  userId: number,
  itemId: number,
): Promise<{ public_url: string | null; public_uuid: string | null } | null> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/list/item/${itemId}/make-public`, {
    method: "POST",
    body: "{}",
  })
  if (!res.ok) {
    await handleApiError(res, "Make public")
    return null
  }
  const d = await unwrap(res)
  return { public_url: d?.public_url ?? null, public_uuid: d?.public_uuid ?? null }
}

export async function apiMakePrivate(userId: number, itemId: number): Promise<boolean> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/list/item/${itemId}/make-private`, {
    method: "POST",
    body: "{}",
  })
  if (!res.ok) {
    await handleApiError(res, "Make private")
    return false
  }
  return true
}

async function apiDeleteItem(itemId: number): Promise<boolean> {
  const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}`, { method: "DELETE" })
  if (!res.ok) {
    await handleApiError(res, "Delete item")
    return false
  }
  return true
}

async function fetchItems(userId: number, bloqId: number): Promise<any[]> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/items?per_page=500`)
  if (!res.ok) return []
  const j = (await res.json()) as { data?: any }
  const raw = j?.data
  return Array.isArray(raw) ? raw : (raw?.items ?? [])
}

async function fetchBloqs(userId: number): Promise<any[]> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs?per_page=100&simplified=1`)
  if (!res.ok) return []
  const j = (await res.json()) as { data?: any[] }
  return j?.data ?? []
}

async function fetchLists(userId: number, bloqId: number): Promise<any[]> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`)
  if (!res.ok) return []
  const j = (await res.json()) as { data?: any[] }
  return j?.data ?? []
}

async function createList(userId: number, bloqId: number, name: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`, {
    method: "POST",
    body: JSON.stringify({ name }),
  })
  if (!res.ok) return null
  return unwrap(res)
}

async function createBloq(userId: number, name: string): Promise<any | null> {
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, {
    method: "POST",
    body: JSON.stringify({ name, description: "Documents published via iris atlas:item publish" }),
  })
  if (!res.ok) return null
  return unwrap(res)
}

async function createItem(
  userId: number,
  bloqId: number,
  listId: number,
  title: string,
  content: string,
): Promise<any | null> {
  const payload: Record<string, unknown> = { content }
  if (title) payload.title = title
  const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${bloqId}/lists/${listId}/items`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    await handleApiError(res, "Create item")
    return null
  }
  // store() double-nests: { data: { data: { id, ... } } } → unwrap gives { data: {id} }.
  // Other create paths return { data: { id } }. Normalize to the inner item either way.
  const d = await unwrap(res)
  return d?.data ?? d
}

// Returns the updated item, the sentinel "NOT_FOUND" if the item was deleted
// upstream (so the caller can recreate), or null on any other failure.
async function updateItem(itemId: number, title: string, content: string): Promise<any | "NOT_FOUND" | null> {
  const payload: Record<string, unknown> = { content }
  if (title) payload.title = title
  const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  })
  if (res.ok) {
    const d = await unwrap(res)
    return d?.data ?? d
  }
  // A deleted item updates as HTTP 500 "Resource not found" (backend findOrFail
  // throws instead of 404), so detect "not found" in the body too — the caller
  // then recreates it and rewrites the frontmatter.
  const text = await res.text().catch(() => "")
  if (process.argv.includes("--print-logs")) console.error(`[updateItem] HTTP ${res.status} body=${text.slice(0, 200)}`)
  // Laravel returns either "not found" or "No query results for model" when the
  // item is gone (soft-deleted) — both mean recreate.
  if (res.status === 404 || /not[\s_-]*found|no query results/i.test(text)) return "NOT_FOUND"
  prompts.log.error(`Update item failed (HTTP ${res.status})`)
  return null
}

// ── Destination resolution (the fallback cascade) ───────────────────────────

function isNumericId(v: unknown): boolean {
  const n = Number(v)
  return Number.isInteger(n) && String(n) === String(v)
}

async function resolveListForBloq(
  userId: number,
  bloqId: number,
  listArg: string | number | undefined,
): Promise<number | null> {
  const lists = await fetchLists(userId, bloqId)
  if (listArg !== undefined && listArg !== null && listArg !== "") {
    if (isNumericId(listArg)) return Number(listArg)
    const found = lists.find((l) => String(l.name).toLowerCase() === String(listArg).toLowerCase())
    if (found) return found.id
    const created = await createList(userId, bloqId, String(listArg))
    return created?.id ?? null
  }
  if (lists.length > 0) return lists[0].id
  const created = await createList(userId, bloqId, DEFAULT_LIST_NAME)
  return created?.id ?? null
}

async function resolveDestination(
  userId: number,
  args: PublishArgs,
): Promise<{ bloqId: number; listId: number } | null> {
  // 1. explicit --bloq
  if (args.bloq) {
    const listId = await resolveListForBloq(userId, args.bloq, args.list)
    if (!listId) return null
    return { bloqId: args.bloq, listId }
  }
  // 2. interactive prompt
  if (!isNonInteractive() && !args.json) {
    const bloqs = await fetchBloqs(userId)
    if (bloqs.length > 0) {
      const pick = await prompts.select({
        message: "Publish to which bloq?",
        options: bloqs.slice(0, 50).map((b) => ({ value: b.id, label: `${b.name} (#${b.id})` })),
      })
      if (prompts.isCancel(pick)) return null
      const listId = await resolveListForBloq(userId, Number(pick), args.list)
      if (!listId) return null
      return { bloqId: Number(pick), listId }
    }
  }
  // 3. non-interactive default: find-or-create "Published Docs"
  const bloqs = await fetchBloqs(userId)
  let target = bloqs.find((b) => String(b.name).toLowerCase() === DEFAULT_BLOQ_NAME.toLowerCase())
  if (!target) target = await createBloq(userId, DEFAULT_BLOQ_NAME)
  if (!target?.id) return null
  const listId = await resolveListForBloq(userId, target.id, args.list)
  if (!listId) return null
  return { bloqId: target.id, listId }
}

// ── Local image upload (so relative image paths resolve on the public page) ──

function isLocalPath(url: string): boolean {
  return !/^(https?:|data:|\/\/|#|mailto:)/i.test(url.trim())
}

/** Find every image reference (markdown ![](url) + <img src>) in the body. */
function findImageUrls(body: string): string[] {
  const urls = new Set<string>()
  let m: RegExpExecArray | null
  const md = /!\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g
  while ((m = md.exec(body))) urls.add(m[1])
  const html = /<img\b[^>]*?\ssrc=["']([^"']+)["']/gi
  while ((m = html.exec(body))) urls.add(m[1])
  return [...urls]
}

async function uploadImage(localPath: string, userId: number, token: string): Promise<string | null> {
  try {
    const buf = readFileSync(localPath)
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(buf)]), path.basename(localPath))
    form.append("type", "digital_product")
    form.append("user_id", String(userId))
    const res = await fetch(`${FL_API}/api/v1/cloud-files/upload`, {
      method: "POST",
      body: form,
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
    })
    if (!res.ok) return null
    const data = (await res.json()) as any
    const r = data?.data ?? data
    return r?.cdn_url ?? r?.url ?? r?.filepath ?? null
  } catch {
    return null
  }
}

/**
 * Upload any LOCAL images referenced in the markdown to the CDN and rewrite the
 * body to point at the CDN URLs (so they render on the public page). Rewrites are
 * persisted back to the file too, so re-publishing is idempotent (https → skipped).
 */
async function uploadLocalImages(
  body: string,
  baseDir: string,
  userId: number,
  token: string,
  warn: (s: string) => void,
): Promise<string> {
  const local = findImageUrls(body).filter(isLocalPath)
  if (local.length === 0) return body

  // Upload each distinct FILE once (dedup by resolved path), map original url → CDN.
  const byPath: Record<string, string | null> = {}
  const urlToCdn: Record<string, string> = {}
  for (const url of local) {
    const abs = path.isAbsolute(url) ? url : path.resolve(baseDir, url)
    if (!(abs in byPath)) {
      if (!existsSync(abs)) { byPath[abs] = null; warn(`image not found, left as-is: ${url}`) }
      else {
        byPath[abs] = await uploadImage(abs, userId, token)
        if (!byPath[abs]) warn(`image upload failed, left as-is: ${url}`)
      }
    }
    if (byPath[abs]) urlToCdn[url] = byPath[abs]!
  }

  // Replace ONLY within image references, matching the exact URL (no substring
  // bleed into already-rewritten CDN URLs).
  let out = body.replace(/(!\[[^\]]*\]\(\s*)([^)\s]+)(\s*(?:"[^"]*")?\s*\))/g,
    (full, pre, url, post) => (urlToCdn[url] ? `${pre}${urlToCdn[url]}${post}` : full))
  out = out.replace(/(<img\b[^>]*?\ssrc=["'])([^"']+)(["'])/gi,
    (full, pre, url, post) => (urlToCdn[url] ? `${pre}${urlToCdn[url]}${post}` : full))
  return out
}

function deriveTitle(explicit: unknown, fmTitle: unknown, body: string, file: string): string {
  if (explicit) return String(explicit)
  if (fmTitle) return String(fmTitle)
  const h1 = body.match(/^\s*#\s+(.+)$/m)
  if (h1) return h1[1].trim()
  return path.basename(file, path.extname(file))
}

// ── Public command handlers ─────────────────────────────────────────────────

export interface PublishArgs {
  file: string
  bloq?: number
  list?: string | number
  title?: string
  private?: boolean
  "no-frontmatter"?: boolean
  json?: boolean
  "user-id"?: number
}

/** Publish a markdown file as a bloq item + public URL. Idempotent re-sync via frontmatter. */
export async function executePublish(args: PublishArgs): Promise<void> {
  const json = !!args.json
  if (!json) {
    UI.empty()
    prompts.intro(`◈  Publish ${path.basename(args.file)}`)
  }

  const token = await requireAuth()
  if (!token) { if (!json) prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"])
  if (!userId) { if (!json) prompts.outro("Done"); return }

  if (!existsSync(args.file)) {
    const msg = `File not found: ${args.file}`
    if (json) console.log(JSON.stringify({ success: false, error: msg }))
    else { prompts.log.error(msg); prompts.outro("Done") }
    process.exitCode = 2
    return
  }

  const raw = readFileSync(args.file, "utf8")
  const parsed = matter(raw)
  const fm: Record<string, any> = parsed.data || {}
  const body = parsed.content.trim()
  const title = deriveTitle(args.title, fm.title, body, args.file)
  const existingItemId = fm.iris_item_id ? Number(fm.iris_item_id) : null

  if (!body) {
    const msg = "File has no content to publish (empty body)."
    if (json) console.log(JSON.stringify({ success: false, error: msg }))
    else { prompts.log.error(msg); prompts.outro("Done") }
    process.exitCode = 2
    return
  }

  const spinner = json ? null : prompts.spinner()
  spinner?.start(existingItemId ? `Updating item #${existingItemId}…` : "Creating item…")

  try {
    let itemId: number | null = null
    let bloqId = fm.iris_bloq_id ? Number(fm.iris_bloq_id) : args.bloq ?? null
    let listId = fm.iris_list_id ? Number(fm.iris_list_id) : null

    // Upload any LOCAL images to the CDN and rewrite the body so they render publicly.
    let content = body
    const localImages = findImageUrls(body).filter(isLocalPath)
    if (localImages.length > 0) {
      spinner?.message?.(`Uploading ${localImages.length} local image(s)…`)
      content = await uploadLocalImages(body, path.dirname(args.file), userId, token, (s) => { if (!json) prompts.log.warn(s) })
    }

    // Re-sync path: try to update the item the file already points at.
    if (existingItemId) {
      const updated = await updateItem(existingItemId, title, content)
      if (updated === "NOT_FOUND") {
        // Item was deleted upstream — fall through and recreate it.
        spinner?.message?.(`Item #${existingItemId} was deleted — recreating…`)
      } else if (!updated) {
        spinner?.stop("Update failed", 1)
        if (json) console.log(JSON.stringify({ success: false, error: "Update failed" }))
        else prompts.outro("Done")
        return
      } else {
        itemId = existingItemId
      }
    }

    // Create path: brand-new file, or the previous item was deleted upstream.
    if (!itemId) {
      const dest = await resolveDestination(userId, args)
      if (!dest) {
        const msg = args.bloq
          ? `Bloq ${args.bloq} not found or has no writable list.`
          : "Could not resolve a destination — pass --bloq <id>."
        spinner?.stop(msg, 1)
        if (json) console.log(JSON.stringify({ success: false, error: msg }))
        else prompts.outro("Done")
        return
      }
      bloqId = dest.bloqId
      listId = dest.listId
      const created = await createItem(userId, bloqId, listId, title, content)
      if (!created?.id) {
        spinner?.stop("Failed to create item", 1)
        if (json) console.log(JSON.stringify({ success: false, error: "Create item failed" }))
        else prompts.outro("Done")
        return
      }
      itemId = created.id
    }

    let publicUrl: string | null = null
    let publicUuid: string | null = null
    if (!args.private) {
      const pub = await apiMakePublic(userId, itemId!)
      if (pub) { publicUrl = pub.public_url; publicUuid = pub.public_uuid }
    }

    if (!args["no-frontmatter"]) {
      const newData: Record<string, any> = { ...fm, iris_item_id: itemId }
      if (bloqId) newData.iris_bloq_id = bloqId
      if (listId) newData.iris_list_id = listId
      if (publicUrl) newData.iris_public_url = publicUrl
      writeFileSync(args.file, matter.stringify(content, newData))
    }

    if (json) {
      console.log(JSON.stringify({
        success: true, item_id: itemId, bloq_id: bloqId, list_id: listId,
        public_url: publicUrl, public_uuid: publicUuid, is_public: !args.private,
      }))
      return
    }

    spinner?.stop(`${success("✓")} ${existingItemId ? "Updated" : "Published"} "${title}" (#${itemId})`)
    if (publicUrl) {
      console.log()
      console.log(`  ${bold("Public URL")}  ${publicUrl}`)
      console.log()
    } else if (args.private) {
      prompts.log.info("Saved privately. Re-run without --private to publish.")
    }
    prompts.outro(dim(args["no-frontmatter"] ? "edit + re-run to sync" : "frontmatter updated — edit + re-run to sync the same URL"))
  } catch (err) {
    spinner?.stop("Error", 1)
    if (json) console.log(JSON.stringify({ success: false, error: err instanceof Error ? err.message : String(err) }))
    else { prompts.log.error(err instanceof Error ? err.message : String(err)); prompts.outro("Done") }
  }
}

/** Publish one or many markdown files (shells expand globs like ./docs/*.md). */
export async function executePublishMany(args: PublishArgs & { files: string[] }): Promise<void> {
  const files = (args.files ?? []).filter(Boolean)
  if (files.length <= 1) {
    await executePublish({ ...args, file: files[0] ?? args.file })
    return
  }
  const results: any[] = []
  for (const file of files) {
    // Capture each file's JSON result so we can print a single summary.
    const captured: string[] = []
    const orig = console.log
    console.log = (...a: any[]) => captured.push(a.join(" "))
    try {
      await executePublish({ ...args, file, json: true })
    } finally {
      console.log = orig
    }
    let r: any = null
    try { r = JSON.parse(captured[captured.length - 1] ?? "null") } catch {}
    results.push({ file, ...(r ?? { success: false }) })
  }
  if (args.json) { console.log(JSON.stringify({ success: true, count: results.length, results })); return }
  UI.empty()
  prompts.intro(`◈  Published ${results.filter((r) => r.success).length}/${results.length} files`)
  for (const r of results) {
    if (r.success) prompts.log.success(`${path.basename(r.file)} → ${r.public_url ?? "(private)"}`)
    else prompts.log.error(`${path.basename(r.file)} → ${r.error ?? "failed"}`)
  }
  prompts.outro("Done")
}

export interface ItemActionArgs {
  "item-id": number
  json?: boolean
  "user-id"?: number
}

export async function executeMakePublic(args: ItemActionArgs): Promise<void> {
  const json = !!args.json
  if (!json) { UI.empty(); prompts.intro(`◈  Share Item #${args["item-id"]}`) }
  const token = await requireAuth()
  if (!token) { if (!json) prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"])
  if (!userId) { if (!json) prompts.outro("Done"); return }

  const spinner = json ? null : prompts.spinner()
  spinner?.start("Making item public…")
  const pub = await apiMakePublic(userId, args["item-id"])
  if (!pub) { spinner?.stop("Failed", 1); if (json) console.log(JSON.stringify({ success: false })); else prompts.outro("Done"); return }

  if (json) { console.log(JSON.stringify({ success: true, ...pub, is_public: true })); return }
  spinner?.stop(`${success("✓")} Item is now public`)
  if (pub.public_url) {
    console.log()
    console.log(`  ${bold("Public URL")}  ${pub.public_url}`)
    console.log(`  ${dim(`uuid: ${pub.public_uuid ?? "?"}`)}`)
    console.log()
  } else {
    prompts.log.warn("Item made public but no URL was returned")
  }
  prompts.outro("Done")
}

export async function executeMakePrivate(args: ItemActionArgs): Promise<void> {
  const json = !!args.json
  if (!json) { UI.empty(); prompts.intro(`◈  Unshare Item #${args["item-id"]}`) }
  const token = await requireAuth()
  if (!token) { if (!json) prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"])
  if (!userId) { if (!json) prompts.outro("Done"); return }

  const spinner = json ? null : prompts.spinner()
  spinner?.start("Making item private…")
  const ok = await apiMakePrivate(userId, args["item-id"])
  if (!ok) { spinner?.stop("Failed", 1); if (json) console.log(JSON.stringify({ success: false })); else prompts.outro("Done"); return }
  if (json) { console.log(JSON.stringify({ success: true, is_public: false })); return }
  spinner?.stop(`${success("✓")} Item is now private`)
  prompts.outro("Done")
}

export interface UnpublishArgs {
  file: string
  delete?: boolean
  json?: boolean
  "user-id"?: number
}

/** Unpublish (make private) the item a markdown file points at; optionally delete it. */
export async function executeUnpublish(args: UnpublishArgs): Promise<void> {
  const json = !!args.json
  if (!json) { UI.empty(); prompts.intro(`◈  Unpublish ${path.basename(args.file)}`) }
  const token = await requireAuth()
  if (!token) { if (!json) prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"])
  if (!userId) { if (!json) prompts.outro("Done"); return }

  if (!existsSync(args.file)) {
    const msg = `File not found: ${args.file}`
    if (json) console.log(JSON.stringify({ success: false, error: msg }))
    else { prompts.log.error(msg); prompts.outro("Done") }
    process.exitCode = 2
    return
  }

  const fm: Record<string, any> = matter(readFileSync(args.file, "utf8")).data || {}
  const itemId = fm.iris_item_id ? Number(fm.iris_item_id) : null
  if (!itemId) {
    const msg = "No iris_item_id in this file's frontmatter — it hasn't been published."
    if (json) console.log(JSON.stringify({ success: false, error: msg }))
    else { prompts.log.error(msg); prompts.outro("Done") }
    return
  }

  const spinner = json ? null : prompts.spinner()
  spinner?.start(args.delete ? `Deleting item #${itemId}…` : `Making item #${itemId} private…`)
  const priv = await apiMakePrivate(userId, itemId)
  let deleted = false
  if (args.delete && priv) deleted = await apiDeleteItem(itemId)

  if (!priv) { spinner?.stop("Failed", 1); if (json) console.log(JSON.stringify({ success: false })); else prompts.outro("Done"); return }

  // Drop the public-url marker from the file (it's no longer reachable).
  if (!args.delete) {
    const body = matter(readFileSync(args.file, "utf8")).content
    const { iris_public_url, ...rest } = fm
    writeFileSync(args.file, matter.stringify(body, rest))
  }

  if (json) { console.log(JSON.stringify({ success: true, item_id: itemId, is_public: false, deleted })); return }
  spinner?.stop(`${success("✓")} ${args.delete ? "Deleted" : "Unpublished"} item #${itemId}`)
  prompts.outro("Done")
}

export interface ListArgs {
  bloq?: number
  json?: boolean
  "user-id"?: number
}

/** List the caller's published (public) bloq items + their URLs. */
export async function executeListPublished(args: ListArgs): Promise<void> {
  const json = !!args.json
  if (!json) { UI.empty(); prompts.intro("◈  Published items") }
  const token = await requireAuth()
  if (!token) { if (!json) prompts.outro("Done"); return }
  const userId = await requireUserId(args["user-id"])
  if (!userId) { if (!json) prompts.outro("Done"); return }

  const spinner = json ? null : prompts.spinner()
  spinner?.start("Scanning for published items…")

  const bloqs = args.bloq ? [{ id: args.bloq }] : (await fetchBloqs(userId)).slice(0, 50)
  const published: any[] = []
  for (const b of bloqs) {
    const items = await fetchItems(userId, b.id)
    for (const it of items) {
      if (it.is_public && (it.public_url || it.public_uuid)) {
        published.push({ id: it.id, title: it.title ?? "(untitled)", bloq_id: b.id, public_url: it.public_url ?? it.public_uuid })
      }
    }
  }

  if (json) { spinner?.stop(); console.log(JSON.stringify({ success: true, count: published.length, items: published })); return }
  spinner?.stop(`${published.length} published item(s)`)
  console.log()
  for (const p of published) {
    console.log(`  ${dim(`#${p.id}`)}  ${bold(p.title)}`)
    console.log(`      ${p.public_url}`)
  }
  console.log()
  prompts.outro(dim("iris atlas:item unpublish <file>  |  iris atlas:item make-private <id>"))
}
