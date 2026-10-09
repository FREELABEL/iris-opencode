import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import path from "path"
import { FL_API, fetchBloqs, irisFetch, resolveUserId, tokenSource, unknownBloqReason } from "./platform"

/**
 * Atlas Epic — a multi-list plan the agent shows in chat and (by default) saves to Atlas.
 *
 * The pure half (normalize, content) is separate from the network half (saveEpic) so the shape
 * the card reads can be tested without a platform, and a save that fails can never take the plan
 * down with it: the tool always has a normalized epic to return, saved or not.
 */

export const EPIC_LIMITS = {
  lists: 12,
  items: 50,
  title: 191, // fl-api BloqItem::TITLE_MAX — a longer title is a 422
  listTitle: 120,
  summary: 300,
  subtitle: 300,
  label: 60,
  body: 8000,
} as const

export const EPIC_STATUSES = ["ready", "needs", "done", "none"] as const
export const EPIC_KINDS = ["draft", "alert", "record", "note"] as const
export const EPIC_ACTIONS = ["send", "edit", "open", "dismiss"] as const

export type EpicStatus = (typeof EPIC_STATUSES)[number]
export type EpicKind = (typeof EPIC_KINDS)[number]
export type EpicAction = (typeof EPIC_ACTIONS)[number]

export interface EpicItem {
  title: string
  subtitle?: string
  body?: string
  kind?: EpicKind
  actions?: EpicAction[]
  ref?: { type: string; id: string }
  /** Atlas item id, once saved. */
  id?: number
  done?: boolean
}

export interface EpicList {
  title: string
  source?: string
  status?: EpicStatus
  label?: string
  items: EpicItem[]
}

export interface Epic {
  title: string
  summary?: string
  lists: EpicList[]
}

export interface EpicInput {
  title: string
  summary?: string
  lists: ReadonlyArray<{
    title: string
    source?: string
    status?: string
    label?: string
    items: ReadonlyArray<{
      title: string
      subtitle?: string
      body?: string
      kind?: string
      actions?: ReadonlyArray<string>
      ref?: { type: string; id: string }
    }>
  }>
}

const clip = (s: unknown, max: number): string | undefined => {
  if (typeof s !== "string") return undefined
  const t = s.trim()
  if (!t) return undefined
  return t.length > max ? t.slice(0, max - 1).trimEnd() + "…" : t
}
const oneOf = <T extends string>(set: readonly T[], v: unknown): T | undefined =>
  typeof v === "string" && (set as readonly string[]).includes(v) ? (v as T) : undefined

/**
 * Trim, cap and validate. Returns the epic plus what was dropped, so the model is told rather
 * than discovering later that item 51 never existed.
 */
export function normalizeEpic(input: EpicInput): { epic: Epic; dropped: string[] } | { error: string } {
  const title = clip(input.title, EPIC_LIMITS.title)
  if (!title) return { error: "title is empty — say what the plan is for" }
  const dropped: string[] = []

  const rawLists = Array.isArray(input.lists) ? input.lists : []
  if (rawLists.length > EPIC_LIMITS.lists) dropped.push(`${rawLists.length - EPIC_LIMITS.lists} list(s) past ${EPIC_LIMITS.lists}`)

  const lists: EpicList[] = []
  for (const l of rawLists.slice(0, EPIC_LIMITS.lists)) {
    const lt = clip(l?.title, EPIC_LIMITS.listTitle)
    if (!lt) {
      dropped.push("a list with no title")
      continue
    }
    const rawItems = Array.isArray(l.items) ? l.items : []
    if (rawItems.length > EPIC_LIMITS.items)
      dropped.push(`${rawItems.length - EPIC_LIMITS.items} item(s) past ${EPIC_LIMITS.items} in "${lt}"`)
    const items: EpicItem[] = []
    for (const i of rawItems.slice(0, EPIC_LIMITS.items)) {
      const it = clip(i?.title, EPIC_LIMITS.title)
      if (!it) {
        dropped.push(`an item with no title in "${lt}"`)
        continue
      }
      const rawActions: readonly unknown[] = Array.isArray(i.actions) ? i.actions : []
      const actions: EpicAction[] = Array.from(
        new Set(rawActions.map((a) => oneOf(EPIC_ACTIONS, a)).filter((a): a is EpicAction => !!a)),
      )
      const refType = clip(i.ref?.type, 60)
      const refId = clip(i.ref?.id, 200)
      items.push({
        title: it,
        subtitle: clip(i.subtitle, EPIC_LIMITS.subtitle),
        body: clip(i.body, EPIC_LIMITS.body),
        kind: oneOf(EPIC_KINDS, i.kind),
        actions: actions.length ? actions : undefined,
        ref: refType && refId ? { type: refType, id: refId } : undefined,
      })
    }
    lists.push({
      title: lt,
      source: clip(l.source, 40)?.toLowerCase(),
      status: oneOf(EPIC_STATUSES, l.status),
      label: clip(l.label, EPIC_LIMITS.label),
      items,
    })
  }
  if (lists.length === 0) return { error: "an epic needs at least one list with a title" }
  return { epic: { title, summary: clip(input.summary, EPIC_LIMITS.summary), lists }, dropped }
}

export function countItems(epic: Epic): number {
  return epic.lists.reduce((n, l) => n + l.items.length, 0)
}

/** The marker that carries what fl-api has no column for. See itemContent. */
export const EPIC_MARKER = "iris:atlas_epic"

/**
 * The card body an Atlas item gets.
 *
 * fl-api's item create accepts title/description/content/type/status/card_type/… but NO free
 * metadata field (`attachments` exists and is reserved for bounty attribution — writing there
 * would be a misuse). So the human part is markdown, and kind/actions/ref/source ride along in
 * a trailing HTML comment: invisible in the rendered card, still machine-readable for whatever
 * later turns the card back into an action ("send the draft for gmail_message 1a11…").
 */
export function itemContent(list: EpicList, item: EpicItem, listIndex: number): string {
  const head = `**${list.title}**${list.source ? ` · ${list.source}` : ""}`
  const parts = [head]
  if (item.subtitle) parts.push(item.subtitle)
  if (item.body) parts.push(item.body.split("\n").map((l) => `> ${l}`).join("\n"))
  const meta = {
    list: listIndex,
    source: list.source,
    kind: item.kind,
    actions: item.actions,
    ref: item.ref,
  }
  // `--` cannot appear inside an HTML comment; refs are ids, but be safe.
  parts.push(`<!-- ${EPIC_MARKER} ${JSON.stringify(meta).replace(/--/g, "-\\u002d")} -->`)
  return parts.join("\n\n")
}

export interface SaveResult {
  saved: boolean
  bloqId?: number
  listIds?: number[]
  /** Item ids in epic order: ids[listIndex][itemIndex], undefined where that item failed. */
  itemIds?: (number | undefined)[][]
  reason?: string
}

/** Where to save when the model did not say. Env, then ~/.iris/config.json `default_bloq_id`. */
export function configuredBloqId(configPath = path.join(homedir(), ".iris", "config.json")): number | undefined {
  const fromEnv = Number(process.env.IRIS_BLOQ_ID ?? "")
  if (Number.isInteger(fromEnv) && fromEnv > 0) return fromEnv
  try {
    if (!existsSync(configPath)) return undefined
    const cfg = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>
    const n = Number(cfg["default_bloq_id"])
    return Number.isInteger(n) && n > 0 ? n : undefined
  } catch {
    return undefined
  }
}

export const PLANS_BOARD = "Plans"

async function readJson(res: Response): Promise<any> {
  return res.json().catch(() => ({}))
}
const idOf = (j: any): number | undefined => {
  // Board create answers { data: { bloq: { id }, lists } }; list/item create answer { data: { id } }.
  const raw = j?.data?.bloq?.id ?? j?.data?.data?.id ?? j?.data?.id ?? j?.id
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : undefined
}
const failure = (j: any, status: number) => {
  const errs = j?.errors && typeof j.errors === "object" ? Object.values(j.errors).flat().join("; ") : ""
  return String(errs || j?.message || `fl-api ${status}`)
}

/** Run `fn` over `xs` with at most `n` in flight — 600 sequential POSTs is minutes. */
async function pool<T, R>(xs: T[], n: number, fn: (x: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(xs.length)
  let next = 0
  const worker = async () => {
    while (next < xs.length) {
      const i = next++
      out[i] = await fn(xs[i])
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, xs.length) }, worker))
  return out
}

/**
 * Persist an epic to Atlas.
 *
 * SHAPE: ONE Atlas list per epic, titled with the epic's title; every epic item becomes a card in
 * it, its epic-list named on the first line of the card body. Atlas lists are a board's COLUMNS
 * and a board holds many plans over time — one column per epic keeps a plan together and the
 * board readable, where one column per epic-list would add three or four columns per plan and
 * scatter it across the board with nothing tying the columns together.
 *
 * Endpoints (fl-api; all in the `user/{userId}/bloqs` flexible.auth group, the one saveItem uses):
 *   GET  /api/v1/user/{uid}/bloqs?simplified=true            pick / validate the board
 *   POST /api/v1/user/{uid}/bloqs              {name}        create "Plans" if needed
 *   POST /api/v1/user/{uid}/bloqs/{bloq}/lists {name}        the epic's list
 *   POST /api/v1/user/{uid}/bloqs/{bloq}/lists/{list}/items  one per item
 *   DELETE /api/v1/user/{uid}/bloqs/list/{list}              cleanup if no item landed
 *
 * NEVER THROWS. Every failure becomes `{ saved: false, reason }` — the plan still renders.
 */
export async function saveEpic(epic: Epic, opts: { bloqId?: number; signal?: AbortSignal } = {}): Promise<SaveResult> {
  try {
    const userId = await resolveUserId()
    if (!userId) return { saved: false, reason: `not signed in to IRIS (token: ${tokenSource()})` }
    const init = (method: string, body?: unknown): RequestInit => ({
      method,
      signal: opts.signal,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })

    // ── Which board ──
    const bloqs = await fetchBloqs()
    let bloqId = opts.bloqId ?? configuredBloqId()
    if (bloqId != null) {
      const unknown = unknownBloqReason(bloqId, bloqs)
      if (unknown) {
        if (opts.bloqId != null) return { saved: false, reason: `board ${bloqId} is not one of yours` }
        bloqId = undefined // a stale default is not worth failing over; fall through to Plans
      }
    }
    if (bloqId == null) {
      if (!bloqs.measured) return { saved: false, reason: `could not list your boards (${bloqs.reason ?? "unknown"})` }
      const plans = bloqs.data.bloqs.find((b) => b.name.trim().toLowerCase() === PLANS_BOARD.toLowerCase())
      if (plans) bloqId = plans.id
      else {
        const res = await irisFetch(`/api/v1/user/${userId}/bloqs`, FL_API, init("POST", { name: PLANS_BOARD }))
        const j = await readJson(res)
        const id = res.ok ? idOf(j) : undefined
        if (!id) return { saved: false, reason: `could not create the "${PLANS_BOARD}" board: ${failure(j, res.status)}` }
        bloqId = id
      }
    }

    // ── The epic's list ──
    const lr = await irisFetch(
      `/api/v1/user/${userId}/bloqs/${bloqId}/lists`,
      FL_API,
      init("POST", { name: epic.title.slice(0, EPIC_LIMITS.listTitle), sort_order: 0 }),
    )
    const lj = await readJson(lr)
    const listId = lr.ok ? idOf(lj) : undefined
    if (!listId) return { saved: false, bloqId, reason: `could not create the list: ${failure(lj, lr.status)}` }

    // ── The items ──
    const jobs = epic.lists.flatMap((l, li) => l.items.map((it, ii) => ({ l, li, it, ii }))).map((j, k) => ({ ...j, k }))
    let lastError = ""
    const ids = await pool(jobs, 6, async ({ l, li, it, k }) => {
      try {
        const res = await irisFetch(
          `/api/v1/user/${userId}/bloqs/${bloqId}/lists/${listId}/items`,
          FL_API,
          init("POST", {
            title: it.title,
            description: it.subtitle ?? null,
            content: itemContent(l, it, li),
            content_format: "markdown",
            type: "task",
            status: l.status === "done" ? "done" : "todo",
            sort_order: k,
          }),
        )
        const j = await readJson(res)
        const id = res.ok ? idOf(j) : undefined
        if (!id) lastError = failure(j, res.status)
        return id
      } catch (e) {
        lastError = e instanceof Error ? e.message : String(e)
        return undefined
      }
    })

    const itemIds: (number | undefined)[][] = epic.lists.map(() => [])
    jobs.forEach((j, k) => (itemIds[j.li][j.ii] = ids[k]))
    const landed = ids.filter((x) => x != null).length

    if (jobs.length > 0 && landed === 0) {
      // An empty column titled like a plan is worse than nothing — remove it, best effort.
      await irisFetch(`/api/v1/user/${userId}/bloqs/list/${listId}`, FL_API, init("DELETE")).catch(() => undefined)
      return { saved: false, bloqId, reason: `no item could be saved (${lastError || "unknown error"})` }
    }
    const missed = jobs.length - landed
    return {
      saved: true,
      bloqId,
      listIds: [listId],
      itemIds,
      reason: missed ? `${missed} of ${jobs.length} items did not save (${lastError})` : undefined,
    }
  } catch (e) {
    return { saved: false, reason: e instanceof Error ? e.message : String(e) }
  }
}
