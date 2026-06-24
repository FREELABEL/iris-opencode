// Shared logic for publishing/sharing bloq items, used by both the `bloqs` and
// branded `atlas:item` command families so they never drift.
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, isNonInteractive } from "./iris-api"
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

async function updateItem(itemId: number, title: string, content: string): Promise<any | null> {
  const payload: Record<string, unknown> = { content }
  if (title) payload.title = title
  const res = await irisFetch(`/api/v1/user/bloqs/list/item/${itemId}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    await handleApiError(res, "Update item")
    return null
  }
  return unwrap(res)
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

  const spinner = json ? null : prompts.spinner()
  spinner?.start(existingItemId ? `Updating item #${existingItemId}…` : "Creating item…")

  try {
    let itemId: number
    let bloqId = fm.iris_bloq_id ? Number(fm.iris_bloq_id) : args.bloq ?? null
    let listId = fm.iris_list_id ? Number(fm.iris_list_id) : null

    if (existingItemId) {
      const updated = await updateItem(existingItemId, title, body)
      if (!updated) { spinner?.stop("Failed", 1); if (!json) prompts.outro("Done"); return }
      itemId = existingItemId
    } else {
      const dest = await resolveDestination(userId, args)
      if (!dest) {
        spinner?.stop("Could not resolve a bloq/list to publish into", 1)
        if (json) console.log(JSON.stringify({ success: false, error: "No destination (try --bloq <id>)" }))
        else prompts.outro("Done")
        return
      }
      bloqId = dest.bloqId
      listId = dest.listId
      const created = await createItem(userId, bloqId, listId, title, body)
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
      const pub = await apiMakePublic(userId, itemId)
      if (pub) { publicUrl = pub.public_url; publicUuid = pub.public_uuid }
    }

    if (!args["no-frontmatter"]) {
      const newData: Record<string, any> = { ...fm, iris_item_id: itemId }
      if (bloqId) newData.iris_bloq_id = bloqId
      if (listId) newData.iris_list_id = listId
      if (publicUrl) newData.iris_public_url = publicUrl
      writeFileSync(args.file, matter.stringify(body, newData))
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
