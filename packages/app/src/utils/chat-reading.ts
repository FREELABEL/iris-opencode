// Chat font and spacing (#193477): presets for the conversation only, beside chat text size (#193464).
// Stored as appearance.chatFont and appearance.chatSpacing; the defaults leave the chat exactly as it was.

export const CHAT_FONTS = ["sans", "serif", "mono"] as const
export type ChatFont = (typeof CHAT_FONTS)[number]
export const CHAT_SPACINGS = ["compact", "default", "roomy"] as const
export type ChatSpacing = (typeof CHAT_SPACINGS)[number]

export function chatFont(value: unknown): ChatFont {
  return CHAT_FONTS.includes(value as ChatFont) ? (value as ChatFont) : "sans"
}

export function chatSpacing(value: unknown): ChatSpacing {
  return CHAT_SPACINGS.includes(value as ChatSpacing) ? (value as ChatSpacing) : "default"
}

const SERIF = 'ui-serif, "New York", "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif'

/** The font-family the chat's CSS reads (--chat-font). Sans and Mono follow the fonts chosen in Settings. */
export function chatFontFamily(value: unknown): string {
  const font = chatFont(value)
  if (font === "serif") return SERIF
  if (font === "mono") return "var(--font-family-mono)"
  return "var(--font-family-sans)"
}

/** Multipliers the chat's CSS reads: line height (--chat-leading) and the gap between blocks (--chat-gap). */
export function chatSpacingScale(value: unknown): { leading: number; gap: number } {
  const spacing = chatSpacing(value)
  if (spacing === "compact") return { leading: 0.875, gap: 0.6 }
  if (spacing === "roomy") return { leading: 1.175, gap: 1.5 }
  return { leading: 1, gap: 1 }
}
