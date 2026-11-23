import type { Config } from "@/config/config"
import { ConfigV1 } from "@opencode-ai/core/v1/config/config"
import { SessionV1 } from "@opencode-ai/core/v1/session"
import type { Provider } from "@/provider/provider"
import { ProviderTransform } from "@/provider/transform"
import type { MessageV2 } from "./message-v2"

const COMPACTION_BUFFER = 20_000

/**
 * Compact at this many tokens even when the model's window is far larger (#194083).
 *
 * Measured 2026-11-23: a DeepSeek V4.1 Flash browser session (1M window) reached ~600 messages
 * without compacting, because the trigger was "the window is nearly full" (~970k). Every agent
 * step resends the whole history, so each browser step took 25–30 s and one answer spent ~10M
 * tokens. Most IRIS models now report ~1M windows, so window-relative alone almost never fires.
 */
export const DEFAULT_TRIGGER_TOKENS = 200_000

/** The token count at which a session compacts: the smaller of the usable window and the cap. */
export function threshold(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const window = usable(input)
  const cap = input.cfg.compaction?.trigger_tokens ?? DEFAULT_TRIGGER_TOKENS
  return cap > 0 ? Math.min(window, cap) : window
}

export function usable(input: { cfg: ConfigV1.Info; model: Provider.Model; outputTokenMax?: number }) {
  const context = input.model.limit.context
  if (context === 0) return 0

  const reserved =
    input.cfg.compaction?.reserved ??
    Math.min(COMPACTION_BUFFER, ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
  return input.model.limit.input
    ? Math.max(0, input.model.limit.input - reserved)
    : Math.max(0, context - ProviderTransform.maxOutputTokens(input.model, input.outputTokenMax))
}

export function isOverflow(input: {
  cfg: ConfigV1.Info
  tokens: SessionV1.Assistant["tokens"]
  model: Provider.Model
  outputTokenMax?: number
}) {
  if (input.cfg.compaction?.auto === false) return false
  if (input.model.limit.context === 0) return false

  const count =
    input.tokens.total || input.tokens.input + input.tokens.output + input.tokens.cache.read + input.tokens.cache.write
  return count >= threshold(input)
}
