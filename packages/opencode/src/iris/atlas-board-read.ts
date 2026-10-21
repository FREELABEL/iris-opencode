import { deleteBoardCopy, readBoardCopy, readBoardListCopy, writeBoardCopy, writeBoardListCopy } from "./atlas-local-copy"
import { fetchAtlas, fetchBloqs, resolveUserId, type AtlasList, type Bloq } from "./platform"

type Read = Awaited<ReturnType<typeof fetchAtlas>>

export interface BoardRead {
  r: Read
  source: "live" | "copy"
  copiedAt?: string
  offline?: boolean
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
 * Where one board read comes from (#190231 phase 1):
 *  - a search      → fl-api with bodies, always (the copy has no bodies to search);
 *  - a plain open  → this machine's copy when there is one, so the board draws at once;
 *                    the panel then asks again with `fresh` to bring it up to date;
 *  - `fresh`, or no copy → fl-api, and the copy is replaced with what came back;
 *  - fl-api unreachable → the copy, marked offline, with the reason.
 */
export async function readAtlasBoard(bloqId: number, q: { q?: string; fresh?: string } = {}): Promise<BoardRead> {
  if (q.q) return { r: await fetchAtlas(bloqId, { bodies: true }), source: "live" }

  const userId = await resolveUserId()
  if (userId && !q.fresh) {
    const c = readBoardCopy<AtlasList>(userId, bloqId)
    if (c) return { r: { measured: true, data: { lists: c.lists } }, source: "copy", copiedAt: c.copiedAt }
  }

  const r = await fetchAtlas(bloqId)
  if (!userId) return { r, source: "live" }
  if (r.measured) {
    writeBoardCopy(userId, bloqId, !!r.data.containsPhi, r.data.lists)
    return { r, source: "live" }
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
