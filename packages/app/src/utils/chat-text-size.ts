// Chat text size (#193464): the conversation's text grows or shrinks on its own, without zooming
// the whole app. Stored as appearance.fontSize, in px at the default scale.

export const CHAT_TEXT_SIZES = [13, 14, 16, 18, 20] as const
export const CHAT_TEXT_DEFAULT = 14

/** The step nearest a stored value. An old or hand-edited setting still lands on a real step. */
export function chatTextSize(value: unknown): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : CHAT_TEXT_DEFAULT
  return CHAT_TEXT_SIZES.reduce((best, s) => (Math.abs(s - n) < Math.abs(best - n) ? s : best), CHAT_TEXT_DEFAULT)
}

/** One step bigger (+1) or smaller (-1), stopping at the ends. */
export function stepChatTextSize(value: unknown, dir: 1 | -1): number {
  const i = CHAT_TEXT_SIZES.indexOf(chatTextSize(value) as (typeof CHAT_TEXT_SIZES)[number])
  return CHAT_TEXT_SIZES[Math.min(CHAT_TEXT_SIZES.length - 1, Math.max(0, i + dir))]
}

/** The multiplier the chat's CSS reads (--chat-text-size). */
export function chatTextScale(value: unknown): number {
  return chatTextSize(value) / CHAT_TEXT_DEFAULT
}
