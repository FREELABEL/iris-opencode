/**
 * LISTS AND BOARDS, ROUND TRIP — the same nomenclature as items, one level up.
 *
 * `atlas:item pull|diff|push` moves ONE item. This moves a whole list, or a whole board, as a
 * folder of markdown files: every item a file, every list a directory, with the ids kept in
 * frontmatter so the trip back knows what it is updating.
 *
 * The item format is not re-invented here — it is `atlas-item-sync`'s, so a file pulled as part of
 * a board is the same file `atlas:item push` accepts on its own.
 *
 * THE TWO RULES THAT MAKE A TREE PUSH SAFE, because a tree push is where data gets destroyed:
 *
 *   1. ABSENCE IS NOT DELETION. A file you deleted locally (or never pulled, or moved) means the
 *      item is unmentioned, not condemned. Deleting requires --prune, and --prune still only ever
 *      removes ITEMS whose file was pulled and then removed — never a list, never a board.
 *   2. A FILE WITHOUT AN ID CREATES, AND ONLY ONCE. A new file becomes a new item, unless an item
 *      with that title already sits in the list — which is how a re-pull-after-rename turns into a
 *      duplicate. That needs saying yes to (--allow-duplicate).
 */

import { contentSha, normalizeBody, pullDecision, divergenceRefusal, type LocalFile, type RemoteItem } from "./atlas-item-sync"

export interface RemoteList {
  id: number | string
  name?: string | null
  items?: RemoteItem[] | null
}

export interface RemoteBoard {
  id: number | string
  name?: string | null
  title?: string | null
  lists?: RemoteList[] | null
}

export const slug = (s: unknown, max = 48): string =>
  String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, max)

export const boardDirName = (b: RemoteBoard): string => `${slug(b.name ?? b.title) || "board"}-${b.id}`
export const listDirName = (l: RemoteList): string => `${slug(l.name) || "list"}-${l.id}`

/** Metadata files. Plain frontmatter so a person can read the folder without the CLI. */
export const boardMeta = (b: RemoteBoard) => ({ iris_bloq_id: Number(b.id), title: String(b.name ?? b.title ?? "") })
/**
 * `pulled_item_ids` is what --prune is allowed to act within, and it MUST be recorded here rather
 * than derived from the files present at push time. Derived from the files, a deleted file's id is
 * missing from the set by definition, so prune can never see the one deletion it exists for —
 * measured: --prune reported nothing and deleted nothing.
 */
export const listMeta = (l: RemoteList, boardId: number | string) => ({
  iris_list_id: Number(l.id),
  iris_bloq_id: Number(boardId),
  name: String(l.name ?? ""),
  pulled_item_ids: (l.items ?? []).map((i) => Number(i.id)).filter((n) => Number.isFinite(n)),
})

export type PullActionKind = "write" | "identical" | "refuse-local-edits" | "orphan-local"

export interface PullStep {
  path: string
  itemId: number | string | null
  action: PullActionKind
  reason: string
}

/**
 * What a pull would do to the folder, file by file, BEFORE touching anything.
 *
 * `orphan-local` is the case a naive sync gets wrong in the expensive direction: a file on disk
 * whose item is gone from the server. It is reported, never deleted — the item may have been moved
 * to another list, or deleted by mistake, and the copy on disk might be the only one left.
 */
export function planPull(args: {
  board: RemoteBoard
  /** Files already on disk, keyed by their path relative to the board directory. */
  local: Record<string, LocalFile>
  force?: boolean
  itemFilename: (i: RemoteItem) => string
}): PullStep[] {
  const steps: PullStep[] = []
  const seen = new Set<string>()

  for (const list of args.board.lists ?? []) {
    const dir = listDirName(list)
    for (const item of list.items ?? []) {
      const path = `${dir}/${args.itemFilename(item)}`
      seen.add(path)
      const d = pullDecision({ local: args.local[path] ?? null, remote: item, force: args.force })
      steps.push({
        path,
        itemId: item.id,
        action: d.action === "refuse-no-item" ? "refuse-local-edits" : d.action,
        reason: d.reason,
      })
    }
  }

  for (const path of Object.keys(args.local)) {
    if (seen.has(path) || path.endsWith("_list.md") || path.endsWith("_board.md")) continue
    const id = args.local[path]?.fm?.iris_item_id
    // No id means it was never pulled — it is a new file waiting to be pushed, not an orphan.
    if (!id) continue
    steps.push({ path, itemId: Number(id), action: "orphan-local", reason: "this item is no longer on the server — it may have been moved or deleted; the file is left alone" })
  }

  return steps
}

export type PushActionKind = "update" | "create" | "skip" | "refuse-diverged" | "refuse-no-list" | "refuse-duplicate" | "delete"

export interface PushStep {
  path: string
  itemId: number | string | null
  listId: number | string | null
  action: PushActionKind
  reason: string
}

export interface LocalEntry {
  path: string
  file: LocalFile
  /** The list this file's directory belongs to, from its `_list.md`. */
  listId: number | string | null
}

/**
 * What a push would do, file by file, before anything is written.
 *
 * Everything that is not plainly safe becomes a refusal with a reason, so the summary a person
 * reads before confirming is the whole truth: what updates, what is created, what is refused and
 * why, and what would be deleted only because they asked for --prune.
 */
export function planPush(args: {
  entries: LocalEntry[]
  /** Every item the server currently has, by id. */
  remoteById: Record<string, RemoteItem>
  /** Titles present per list on the server, for the duplicate guard. */
  titlesByList: Record<string, string[]>
  force?: boolean
  prune?: boolean
  allowDuplicate?: boolean
  /** Item ids that were pulled into this folder — only these may be pruned. */
  pulledIds?: Array<number | string>
}): PushStep[] {
  const steps: PushStep[] = []
  const localIds = new Set<string>()

  for (const e of args.entries) {
    const fm = e.file.fm ?? {}
    const id = fm.iris_item_id ? String(fm.iris_item_id) : null

    if (id) {
      localIds.add(id)
      const remote = args.remoteById[id]
      if (!remote) {
        steps.push({ path: e.path, itemId: id, listId: e.listId, action: "refuse-no-list", reason: `item #${id} is not on the server any more — push cannot resurrect it` })
        continue
      }
      const bodyChanged = normalizeBody(e.file.body) !== normalizeBody(remote.content)
      const titleChanged = String(fm.title ?? "") !== String(remote.title ?? "")
      if (!bodyChanged && !titleChanged) {
        steps.push({ path: e.path, itemId: id, listId: e.listId, action: "skip", reason: "identical" })
        continue
      }
      const refusal = divergenceRefusal({ itemId: id, markerIso: fm.atlas_published_at ?? null, serverIso: remote.updated_at ?? null, force: args.force })
      if (refusal) {
        steps.push({ path: e.path, itemId: id, listId: e.listId, action: "refuse-diverged", reason: refusal })
        continue
      }
      steps.push({ path: e.path, itemId: id, listId: e.listId, action: "update", reason: [titleChanged ? "title" : null, bodyChanged ? "content" : null].filter(Boolean).join(" + ") })
      continue
    }

    // No id: a file somebody added to the folder. It becomes a new item in that list.
    if (!e.listId) {
      steps.push({ path: e.path, itemId: null, listId: null, action: "refuse-no-list", reason: "this file is not inside a pulled list folder, so there is no list to create it in" })
      continue
    }
    const title = String(fm.title ?? "").trim()
    const existing = args.titlesByList[String(e.listId)] ?? []
    if (title && existing.includes(title) && !args.allowDuplicate) {
      steps.push({ path: e.path, itemId: null, listId: e.listId, action: "refuse-duplicate", reason: `an item titled "${title}" is already in this list — pass --allow-duplicate to add a second one` })
      continue
    }
    steps.push({ path: e.path, itemId: null, listId: e.listId, action: "create", reason: title ? `new item "${title}"` : "new item" })
  }

  // Deletions: only with --prune, only for items this folder actually pulled, and only when the
  // file is gone. Anything outside that set is simply unmentioned.
  if (args.prune) {
    for (const pid of args.pulledIds ?? []) {
      const key = String(pid)
      if (localIds.has(key)) continue
      if (!args.remoteById[key]) continue
      steps.push({ path: "(file removed)", itemId: key, listId: null, action: "delete", reason: "the file for this item was removed and --prune was given" })
    }
  }

  return steps
}

export interface PushSummary {
  update: number
  create: number
  skip: number
  delete: number
  refused: number
  /** True when nothing would change — worth saying instead of printing an empty plan. */
  noop: boolean
}

export function summarize(steps: PushStep[]): PushSummary {
  const count = (k: PushActionKind) => steps.filter((s) => s.action === k).length
  const refused = steps.filter((s) => s.action.startsWith("refuse")).length
  const s: PushSummary = {
    update: count("update"),
    create: count("create"),
    skip: count("skip"),
    delete: count("delete"),
    refused,
    noop: false,
  }
  s.noop = s.update === 0 && s.create === 0 && s.delete === 0
  return s
}

/** The ids a pulled folder claims, so --prune has a set it is allowed to act within. */
export function pulledIdsFrom(entries: LocalEntry[]): Array<number> {
  return entries.map((e) => Number(e.file.fm?.iris_item_id)).filter((n) => Number.isFinite(n) && n > 0)
}

export { contentSha }
