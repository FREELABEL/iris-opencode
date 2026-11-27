/**
 * IRIS model ids the server has retired, and the model each one now means.
 *
 * Mirrors fl-iris-api `ModelRegistry::RETIRED_MODELS`. The server already forwards these, but
 * the client never gets that far: a retired id is absent from the live manifest, so a saved
 * selection (an agent's `model`, `opencode.json`'s `model`, a session's last pick) failed
 * locally with "Model unavailable: iris/kimi-k2.6" before any request was sent (#194085).
 *
 * Ids are bare (no `iris/` prefix), as the desktop stores them under the `iris` provider.
 * The live manifest may send its own `retired` map; that is merged over this one, so a later
 * retirement needs no desktop release. A forward is used only when its target is offered.
 */
export const IRIS_RETIRED_MODELS: Readonly<Record<string, string>> = {
  "nemotron-3-super": "nemotron-3.5-lightning",
  "glm-4.7": "big-pickle",
  "grok-code": "deepseek-v4-flash",
  "glm-5.2": "glm-5.3-flash",
  "space-bunny-free": "mimo-v2.6-flash",
  "space-bunny": "mimo-v2.6-flash",
  // Gone from OpenCode Go 2026-11-23 (#194085).
  "minimax-m2.7": "minimax-m3",
  "kimi-k2.6": "kimi-k2.7-code",
  "kimi-k2.6-zen": "kimi-k2.7-code",
  "mimo-v2.5-go": "mimo-v2.6-flash",
  "deepseek-v4-flash-go": "deepseek-v4.1-flash",
}

const bare = (id: string) => id.replace(/^iris\//, "")

/** Reads a manifest's optional `retired` field: `{ "iris/old": "iris/new" }`. Anything else is ignored. */
export function parseRetired(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return {}
  const out: Record<string, string> = {}
  for (const [from, to] of Object.entries(input)) {
    if (typeof to === "string" && from && to) out[bare(from)] = bare(to)
  }
  return out
}

/**
 * The model a retired IRIS id now means, or undefined. Follows chains (a → b → c) and stops at
 * the first id `offered` accepts, so a forward to a model this install cannot use is skipped.
 */
export function forwardRetired(
  modelID: string,
  offered: (id: string) => boolean,
  table: Readonly<Record<string, string>> = IRIS_RETIRED_MODELS,
): string | undefined {
  const seen = new Set<string>()
  let id = bare(modelID)
  while (table[id] && !seen.has(id)) {
    seen.add(id)
    id = table[id]
    if (offered(id)) return id
  }
  return undefined
}
