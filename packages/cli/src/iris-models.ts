// The TUI's IRIS model list comes from the server, the same way IRIS Desktop's does (#188596):
// GET <baseURL>/models is the source of truth and only `available` models are offered, so a model
// switched off on the server (MODEL_PROXY_OFFERED_MODELS, a missing provider key) disappears from
// every client with no release. The bundled iris-provider.json is the fallback, as in the desktop
// (iris/1.18.23 packages/opencode/src/provider/provider.ts).
//
// Startup must stay fast and work offline: a fresh cache is used without a request; otherwise one
// request with a short timeout, then the cache at any age, then the bundled list.

import fs from "node:fs"
import path from "node:path"

export type ManifestModel = {
  id: string
  name?: string
  available?: boolean
  tool_calling?: boolean
  reasoning?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limits?: { context?: number; input?: number; output?: number }
  pricing?: { input?: number; output?: number }
}

// The v1 model shape v2's config normalizer migrates (core/src/v1/config/provider.ts).
export type V1Model = {
  name: string
  tool_call?: boolean
  reasoning?: boolean
  modalities?: { input?: string[]; output?: string[] }
  limit?: { context: number; input?: number; output: number }
  cost?: { input: number; output: number }
}

export type Source = "cache" | "live" | "stale-cache" | "bundled"

const MODALITIES = new Set(["text", "audio", "image", "video", "pdf"])
export const FRESH_MS = 10 * 60 * 1000
export const TIMEOUT_MS = 1500

/** Available IRIS models from a /models response, keyed by id without the `iris/` prefix. */
export function modelsFromManifest(data: unknown): Record<string, V1Model> | undefined {
  const rows = (data as { data?: unknown })?.data
  if (!Array.isArray(rows)) return
  const models = Object.fromEntries(
    rows
      .filter((m): m is ManifestModel => !!m && typeof m === "object" && typeof (m as ManifestModel).id === "string")
      .filter((m) => m.available === true && m.id.startsWith("iris/"))
      .map((m) => {
        const modalities = (list?: string[]) => list?.filter((x) => MODALITIES.has(x))
        const limit =
          typeof m.limits?.context === "number" && typeof m.limits?.output === "number"
            ? { context: m.limits.context, output: m.limits.output, ...(m.limits.input ? { input: m.limits.input } : {}) }
            : undefined
        const cost =
          typeof m.pricing?.input === "number" && typeof m.pricing?.output === "number"
            ? { input: m.pricing.input, output: m.pricing.output }
            : undefined
        const model: V1Model = {
          name: m.name ?? m.id.slice("iris/".length),
          tool_call: m.tool_calling ?? true,
          ...(m.reasoning !== undefined ? { reasoning: m.reasoning } : {}),
          ...(m.modalities
            ? { modalities: { input: modalities(m.modalities.input), output: modalities(m.modalities.output) } }
            : {}),
          ...(limit ? { limit } : {}),
          ...(cost ? { cost } : {}),
        }
        return [m.id.slice("iris/".length), model] as const
      }),
  )
  // An empty list is a broken response, not "no models": never leave the TUI with nothing to pick.
  return Object.keys(models).length ? models : undefined
}

/** The desktop seed's `tools` flag is the v1 schema's `tool_call`. */
export function modelsFromSeed(seed: Record<string, { tools?: boolean } & Record<string, unknown>>) {
  return Object.fromEntries(
    Object.entries(seed).map(([id, { tools, ...model }]) => [id, { ...model, tool_call: tools } as V1Model]),
  )
}

export async function loadIrisModels(input: {
  baseURL: string
  apiKey?: string
  cacheFile: string
  seed: Record<string, V1Model>
  now?: number
  fetch?: typeof fetch
}): Promise<{ models: Record<string, V1Model>; source: Source }> {
  const now = input.now ?? Date.now()
  const cached = readCache(input.cacheFile)
  if (cached && cached.baseURL === input.baseURL && now - cached.at < FRESH_MS) return { models: cached.models, source: "cache" }

  const live = await (input.fetch ?? fetch)(`${input.baseURL}/models`, {
    headers: { Accept: "application/json", ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}) },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  })
    .then((r) => (r.ok ? r.json() : undefined))
    .then(modelsFromManifest)
    .catch(() => undefined)
  if (live) {
    writeCache(input.cacheFile, { at: now, baseURL: input.baseURL, models: live })
    return { models: live, source: "live" }
  }
  if (cached) return { models: cached.models, source: "stale-cache" }
  return { models: input.seed, source: "bundled" }
}

type Cache = { at: number; baseURL: string; models: Record<string, V1Model> }

function readCache(file: string): Cache | undefined {
  try {
    const value = JSON.parse(fs.readFileSync(file, "utf8")) as Cache
    if (typeof value?.at !== "number" || !value.models || !Object.keys(value.models).length) return
    return value
  } catch {
    return
  }
}

function writeCache(file: string, value: Cache) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  } catch {}
}
