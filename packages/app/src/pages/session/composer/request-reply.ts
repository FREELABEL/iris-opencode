/**
 * ANSWERING AN APPROVAL OR A QUESTION (#191772).
 *
 * The server keeps a pending request in memory and forgets it the moment it is answered. The app
 * used to forget it only when the matching `*.replied` event came back over the event stream, so
 * any second answer — the same request shown in two columns (a chat and its subagent side by
 * side), a double click, an event that never arrived — reached a server that no longer had it and
 * came back as "Request failed · Permission request not found: per_…". Nothing was wrong: the
 * request had already been answered.
 *
 * So: once the server has answered, or says the request is gone, the card goes away here and now,
 * without waiting for the event, and a "gone" answer is not reported as a failure.
 */

const GONE_TAGS = new Set(["PermissionNotFoundError", "QuestionNotFoundError", "NotFoundError"])
const GONE_MESSAGE = /\b(permission|question) request not found\b/i

function field(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return undefined
  return (value as Record<string, unknown>)[key]
}

/** True when a reply failed because the server no longer has the request (already answered). */
export function requestGone(error: unknown): boolean {
  const candidates = [error, field(error, "data"), field(error, "error"), field(error, "cause")]
  for (const item of candidates) {
    const tag = field(item, "_tag") ?? field(item, "name")
    if (typeof tag === "string" && GONE_TAGS.has(tag)) return true
    const message = typeof item === "string" ? item : field(item, "message")
    if (typeof message === "string" && GONE_MESSAGE.test(message)) return true
  }
  return false
}

/**
 * Send a reply. On success, or when the request is already gone, `drop` removes it from this
 * window right away. Any other failure is rethrown for the caller to report; the card stays so
 * the user can try again.
 */
export async function settleReply(send: () => Promise<unknown>, drop: () => void): Promise<void> {
  try {
    await send()
  } catch (error) {
    if (!requestGone(error)) throw error
  }
  drop()
}

/** A list without the answered request, or the same list when it is not there. */
export function withoutRequest<T extends { id: string }>(list: T[] | undefined, requestID: string): T[] | undefined {
  if (!list) return list
  if (!list.some((item) => item.id === requestID)) return list
  return list.filter((item) => item.id !== requestID)
}
