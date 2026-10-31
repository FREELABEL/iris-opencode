import { enqueueCreate, enqueueMove, enqueueSave, hasWaiting, pump, replay } from "./atlas-outbox"
import { ITEM_STATUSES, createItem, itemPatchBody, moveItem, resolveUserId, saveItem, type ItemPatch } from "./platform"

/**
 * A card write from the panel, with fl-api reachable or not (#190537 W3).
 *
 * Online it is the same write as before. When fl-api cannot be reached it waits in the outbox
 * and the panel is told `queued` — saved on this computer, to be sent. A refusal is still a
 * refusal: only "could not be reached" is queued.
 *
 * A card with edits already waiting is queued even online, behind them. Sent straight away it
 * would land first and the older edits, sent after, would undo it.
 */
export type WriteResult = { ok: boolean; reason?: string; queued?: boolean; offline?: boolean; id?: number }

function queuedOr(userId: number, q: ReturnType<typeof enqueueSave>, offlineReason?: string): WriteResult {
  if (!q.queued) return { ok: false, reason: q.reason, offline: true }
  pump(userId)
  return { ok: true, queued: true, ...(q.id !== undefined ? { id: q.id } : {}), ...(offlineReason ? { reason: offlineReason } : {}) }
}

/** `base.body` is the body the editor showed before this edit: what a body merge compares against. */
export async function saveCard(itemId: number, patch: ItemPatch & { base?: { body?: string } }): Promise<WriteResult> {
  const { base, ...fields } = patch
  const userId = await resolveUserId()
  const uiBase = base?.body !== undefined ? { content: base.body } : {}
  if (userId && (itemId < 0 || hasWaiting(userId, itemId))) {
    if (fields.status !== undefined && !(ITEM_STATUSES as readonly string[]).includes(fields.status)) {
      return { ok: false, reason: `"${fields.status}" is not a status fl-api accepts (${ITEM_STATUSES.join(", ")})` }
    }
    const r = queuedOr(userId, enqueueSave(userId, itemId, itemPatchBody(fields), uiBase))
    if (r.queued) void replay(userId).catch(() => {})
    return r
  }
  const r = await saveItem(itemId, fields)
  if (r.ok || !r.offline || !userId) return r
  return queuedOr(userId, enqueueSave(userId, itemId, itemPatchBody(fields), uiBase), r.reason)
}

export async function moveCard(itemId: number, listId: number, position: number): Promise<WriteResult> {
  const userId = await resolveUserId()
  if (userId && (itemId < 0 || hasWaiting(userId, itemId))) {
    const r = queuedOr(userId, enqueueMove(userId, itemId, listId, position))
    if (r.queued) void replay(userId).catch(() => {})
    return r
  }
  const r = await moveItem(itemId, listId, position)
  if (r.ok || !r.offline || !userId) return r
  return queuedOr(userId, enqueueMove(userId, itemId, listId, position), r.reason)
}

export async function createCard(bloqId: number, listId: number, input: { title: string; body?: string }): Promise<WriteResult> {
  const r = await createItem(bloqId, listId, input)
  const userId = await resolveUserId()
  if (r.ok || !r.offline || !userId) return r
  return queuedOr(userId, enqueueCreate(userId, bloqId, listId, input), r.reason)
}
