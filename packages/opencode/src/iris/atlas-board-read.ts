import {
  deleteBoardCopy,
  deleteCardCopy,
  findCardInCopies,
  readBoardCopy,
  readBoardListCopy,
  readCardCopy,
  writeBoardCopy,
  writeBoardListCopy,
  writeCardCopy,
} from "./atlas-local-copy"
import { fetchAtlas, fetchAtlasChanges, fetchBloqs, fetchItem, resolveUserId, type AtlasItem, type AtlasList, type Bloq, type ItemDoc } from "./platform"
import { counts, heldOn, overlay, overlayCard, readOutbox, replay, type HeldView } from "./atlas-outbox"

type Read = Awaited<ReturnType<typeof fetchAtlas>>

export interface BoardRead {
  r: Read
  source: "live" | "copy"
  copiedAt?: string
  offline?: boolean
  /**
   * How a refresh reached fl-api (#190231 phase 3): `unchanged` — asked, nothing moved, no board
   * sent; `delta` — only the cards that moved were fetched; `full` — the whole board.
   */
  sync?: "unchanged" | "delta" | "full"
}

/**
 * fl-api said NO, as opposed to "could not be reached". A refusal is the truth about this board
 * now — access revoked, board deleted, signed out — so the copy is deleted rather than shown.
 * Only an unreachable fl-api (network error, 5xx) falls back to the copy.
 */
export function isRefusal(reason: string | undefined): boolean {
  return /unknown bloq|not signed in|fl-api 4\d\d/.test(reason ?? "")
}

/**
 * Where one board read comes from (#190231 phases 1 + 3):
 *  - a search      → fl-api with bodies, always (the copy has no bodies to search);
 *  - a plain open  → this machine's copy when there is one, so the board draws at once;
 *                    the panel then asks again with `fresh` to bring it up to date;
 *  - `fresh` with a versioned copy → fl-api is asked what changed since that version: nothing
 *                    (the copy stands), or only the cards that moved, merged into the copy;
 *  - `fresh` otherwise, or no copy → the whole board from fl-api, and the copy is replaced;
 *  - fl-api unreachable → the copy, marked offline, with the reason.
 */
export async function readAtlasBoard(bloqId: number, q: { q?: string; fresh?: string } = {}): Promise<BoardRead> {
  if (q.q) return { r: await fetchAtlas(bloqId, { bodies: true }), source: "live" }

  const userId = await resolveUserId()
  if (userId && !q.fresh) {
    const c = readBoardCopy<AtlasList>(userId, bloqId)
    if (c) return { r: { measured: true, data: { lists: c.lists } }, source: "copy", copiedAt: c.copiedAt }
  }

  if (userId && q.fresh) {
    const c = readBoardCopy<AtlasList>(userId, bloqId)
    if (c?.version) {
      const ch = await fetchAtlasChanges(bloqId, { version: c.version, lists: c.lists })
      if (ch.kind === "unchanged") {
        // Rewritten so `copiedAt` says when it was last confirmed, which is what "copy from 12m ago" means.
        writeBoardCopy(userId, bloqId, c.containsPhi, c.lists, ch.version)
        return { r: { measured: true, data: { lists: c.lists, containsPhi: c.containsPhi } }, source: "live", sync: "unchanged" }
      }
      if (ch.kind === "merged") {
        writeBoardCopy(userId, bloqId, ch.containsPhi, ch.lists, ch.version)
        return { r: { measured: true, data: { lists: ch.lists, containsPhi: ch.containsPhi } }, source: "live", sync: "delta" }
      }
      if (ch.kind === "error") {
        if (isRefusal(ch.reason)) {
          deleteBoardCopy(userId, bloqId)
          return { r: { measured: false, reason: ch.reason, data: { lists: [] } }, source: "live" }
        }
        return { r: { measured: true, reason: ch.reason, data: { lists: c.lists } }, source: "copy", copiedAt: c.copiedAt, offline: true }
      }
      // "full": fall through to the whole read.
    }
  }

  const r = await fetchAtlas(bloqId)
  if (!userId) return { r, source: "live" }
  if (r.measured) {
    writeBoardCopy(userId, bloqId, !!r.data.containsPhi, r.data.lists, r.data.version)
    return { r, source: "live", sync: "full" }
  }
  if (isRefusal(r.reason)) {
    deleteBoardCopy(userId, bloqId)
    return { r, source: "live" }
  }
  const c = readBoardCopy<AtlasList>(userId, bloqId)
  if (c) return { r: { measured: true, reason: r.reason, data: { lists: c.lists } }, source: "copy", copiedAt: c.copiedAt, offline: true }
  return { r, source: "live" }
}

/**
 * The board list, with the same rule: kept when it is read, shown from the copy (marked offline)
 * only when fl-api cannot be reached — never when it refuses.
 */
export async function readBoardList(): Promise<{ r: Awaited<ReturnType<typeof fetchBloqs>>; offline?: boolean; copiedAt?: string }> {
  const r = await fetchBloqs()
  const userId = await resolveUserId()
  if (!userId) return { r }
  if (r.measured) {
    writeBoardListCopy(userId, r.data.bloqs)
    return { r }
  }
  if (isRefusal(r.reason)) return { r }
  const c = readBoardListCopy<Bloq>(userId)
  if (!c) return { r }
  return { r: { measured: true, reason: r.reason, data: { bloqs: c.bloqs } }, offline: true, copiedAt: c.copiedAt }
}

/**
 * The board read with this machine's waiting edits on it (#190537 W3): what the panel shows.
 * Cards with edits waiting are drawn as edited and marked; the reply says how many wait and which
 * are held for a person. A read that reached fl-api means it is reachable again, so the queue is
 * sent — the live channel then sees the board change and the panel reads it once more.
 */
export async function readAtlasBoardWithEdits(
  bloqId: number,
  q: { q?: string; fresh?: string } = {},
): Promise<BoardRead & { outbox?: { waiting: number; held: number; heldItems: HeldView[] } }> {
  const read = await readAtlasBoard(bloqId, q)
  const userId = await resolveUserId()
  if (!userId || !read.r.measured) return { ...read }
  const c = counts(userId, bloqId)
  if (c.waiting === 0 && c.held === 0) return { ...read }
  if (read.source === "live" && c.waiting > 0) void replay(userId).catch(() => {})
  const lists = overlay(userId, bloqId, read.r.data.lists)
  return {
    ...read,
    r: { ...read.r, data: { ...read.r.data, lists } },
    outbox: { waiting: c.waiting, held: c.held, heldItems: heldOn(userId, bloqId) },
  }
}

/** What a card says offline (#191003): when it was read, and whether its notes are here at all. */
export interface CardOffline {
  copiedAt: string
  /** false: never opened here online, so the body is not on this computer — not that it is empty. */
  body: boolean
  /** The start of the body, from the board, when the body itself is not here. */
  preview?: string
}

/** fl-api said no about this card (gone, not yours, signed out) — as opposed to not answering. */
export function isCardRefusal(reason: string | undefined): boolean {
  return /not signed in|no item \d+ visible|fl-api 4\d\d/.test(reason ?? "")
}

/**
 * One card for the editor (#191003). Online it is fl-api's, and kept here whole when its board is
 * kept. When fl-api cannot be reached it is the kept card — or, for a card never opened here, its
 * face from the board copy, with the body marked as not here — with this machine's waiting edits
 * on it. Offline, before this, a card could only be edited if it was already open.
 */
export async function readCard(itemId: number): Promise<Awaited<ReturnType<typeof fetchItem>> & { offline?: CardOffline }> {
  const r = await fetchItem(itemId)
  const userId = await resolveUserId()
  if (!userId) return r
  if (r.measured) {
    writeCardCopy(userId, itemId, r.data)
    return r
  }
  if (isCardRefusal(r.reason)) {
    deleteCardCopy(userId, itemId)
    return r
  }
  const found = findCardInCopies<AtlasItem>(userId, itemId)
  if (!found) return r
  const kept = readCardCopy<ItemDoc>(userId, found.bloqId, itemId)
  const face = found.item
  // The board copy is refreshed on every board read, the card only when opened: its face wins.
  const base: ItemDoc = {
    ...(kept?.doc ?? { id: itemId, content: "", contentKind: "markdown", labels: [], isPublic: false, tasks: [], tasksMeasured: false }),
    title: face.title,
    status: face.status,
    priority: face.priority,
    cardType: face.cardType,
    dueDate: face.dueDate ? String(face.dueDate).slice(0, 10) : undefined,
    listId: found.listId,
    listName: found.listName,
  }
  const doc = overlayCard(userId, itemId, base)
  const { pending: _pending, ...data } = doc
  // A body saved offline is the whole body, so it is here even when the card never was.
  const body = !!kept || readOutbox(userId).ops.some((op) => op.kind === "save" && op.itemId === itemId && typeof op.patch.content === "string")
  return {
    measured: true,
    data: { ...data, ...(kept ? {} : { tasksReason: "not on this computer" }) },
    offline: {
      copiedAt: kept?.copiedAt ?? found.copiedAt,
      body,
      ...(!body && face.preview ? { preview: face.preview } : {}),
    },
  }
}
