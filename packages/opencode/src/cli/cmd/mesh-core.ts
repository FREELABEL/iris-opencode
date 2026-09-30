import path from "path"

/**
 * Shared compute via Mesh LLM (epic #187246, slices M1 + M4) — the pure half.
 *
 * Mesh LLM (github.com/Mesh-LLM/mesh-llm) serves an OpenAI-compatible API on loopback :9337 and a
 * management API on :3131. Buzz desktop embeds the same engine on the same port. Everything here is
 * a pure function so the rules below are tested, not remembered:
 *
 *  1. NEVER `--auto` / `--publish` (and never `--listen-all`) from any IRIS path.
 *  2. :9337 is loopback only — the provider we write points at 127.0.0.1 and nothing else.
 *  3. Health data (PHI) never routes to a mesh — refuse before anything is written or started.
 *  4. The port comes from IRIS_MESH_API_PORT (default 9337) everywhere a port is read.
 */

export const MESH_PROVIDER_ID = "mesh"
export const MESH_DEFAULT_PORT = 9337
export const MESH_CONSOLE_PORT = 3131
export const MESH_API_KEY = "mesh-local"
export const MESH_VIRTUAL_MODEL = "mesh"
export const MESH_DEFAULT_MODEL = "Qwen3-8B-Q4_K_M"
export const MESH_PROBE_TIMEOUT_MS = 1500

/** Rule 4: one reader for the port. Anything that is not a valid TCP port falls back to the default. */
export function meshPort(env: Record<string, string | undefined>): number {
  const raw = env.IRIS_MESH_API_PORT?.trim()
  if (!raw || !/^\d+$/.test(raw)) return MESH_DEFAULT_PORT
  const n = Number(raw)
  return n >= 1 && n <= 65535 ? n : MESH_DEFAULT_PORT
}

/** Rule 2: the base URL is loopback, always. There is deliberately no host parameter. */
export function meshBaseURL(port: number): string {
  return `http://127.0.0.1:${port}/v1`
}

export type MeshProbe = {
  url: string
  serving: boolean
  models: string[]
  /** why it is not serving, in words a person can act on; null when serving */
  reason: string | null
}

/**
 * Turn one GET /v1/models outcome into a verdict. `status` null means no HTTP answer at all
 * (refused, timed out). Serving means exactly what the Hive capability means (contract):
 * HTTP 200 with a NON-EMPTY `data` array — a mesh that is up but has no model loaded is not serving.
 */
export function parseModelsResponse(url: string, status: number | null, body: unknown, error?: string): MeshProbe {
  if (status === null) {
    return { url, serving: false, models: [], reason: error ? `no answer (${error})` : "no answer" }
  }
  if (status !== 200) return { url, serving: false, models: [], reason: `HTTP ${status}` }
  const data = (body as { data?: unknown } | null)?.data
  if (!Array.isArray(data)) return { url, serving: false, models: [], reason: "answered, but not an OpenAI model list" }
  const models = data
    .map((m) => (m && typeof m === "object" ? (m as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string" && id.length > 0)
  if (models.length === 0) return { url, serving: false, models: [], reason: "answering, but no model is loaded yet" }
  return { url, serving: true, models: Array.from(new Set(models)), reason: null }
}

export type FetchLike = (url: string, init?: { signal?: AbortSignal }) => Promise<{ status: number; json(): Promise<unknown> }>

/** Probe the loopback API. Never throws; a timeout is a "no answer". */
export async function probeMesh(
  port: number,
  fetchImpl: FetchLike = fetch as unknown as FetchLike,
  timeoutMs = MESH_PROBE_TIMEOUT_MS,
): Promise<MeshProbe> {
  const url = `${meshBaseURL(port)}/models`
  let res: { status: number; json(): Promise<unknown> }
  try {
    res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    const err = e as Error
    const timedOut = err?.name === "TimeoutError" || err?.name === "AbortError"
    return parseModelsResponse(url, null, null, timedOut ? `timed out after ${timeoutMs}ms` : "connection refused")
  }
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  return parseModelsResponse(url, res.status, body)
}

/** Upstream `mesh-llm opencode` defaults (crates/mesh-llm-commands/src/agent_cli.rs). */
export const MESH_DEFAULT_CONTEXT_LIMIT = 32_768
export const MESH_OUTPUT_LIMIT = 4_096

type MeshModelEntry = { name: string; limit: { context: number; output: number } }

export type MeshProviderEntry = {
  npm: string
  name: string
  options: { baseURL: string; apiKey: string }
  models: Record<string, MeshModelEntry>
}

/**
 * The provider IRIS reads — id `mesh`, loopback, placeholder key; models = what the mesh lists +
 * `mesh`. Mirrors the shape upstream's own `mesh-llm opencode` launcher writes into an OpenCode
 * config (name/npm/options.baseURL/models[id].{name,limit}), plus the contract's apiKey.
 */
export function meshProviderEntry(port: number, models: string[]): MeshProviderEntry {
  const limit = { context: MESH_DEFAULT_CONTEXT_LIMIT, output: MESH_OUTPUT_LIMIT }
  const entries: Record<string, MeshModelEntry> = {
    [MESH_VIRTUAL_MODEL]: { name: "auto — the mesh decides", limit },
  }
  for (const id of models) {
    if (id === MESH_VIRTUAL_MODEL) continue
    entries[id] = { name: id, limit }
  }
  return {
    npm: "@ai-sdk/openai-compatible",
    name: "Mesh LLM (local)",
    options: { baseURL: meshBaseURL(port), apiKey: MESH_API_KEY },
    models: entries,
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v)

/**
 * Add the mesh provider to a config object. Returns a NEW object; every other key is carried over
 * untouched. If the config restricts providers with `enabled_providers`, `mesh` is appended —
 * otherwise the entry would be written and silently never offered. `use` is an explicit request,
 * so a `mesh` in `disabled_providers` is lifted.
 */
export function applyMeshProvider<T extends Obj>(config: T, entry: MeshProviderEntry): T {
  const next: Obj = { ...config }
  next.provider = { ...(isObj(config.provider) ? config.provider : {}), [MESH_PROVIDER_ID]: entry }
  if (Array.isArray(config.enabled_providers) && !config.enabled_providers.includes(MESH_PROVIDER_ID)) {
    next.enabled_providers = [...config.enabled_providers, MESH_PROVIDER_ID]
  }
  if (Array.isArray(config.disabled_providers) && config.disabled_providers.includes(MESH_PROVIDER_ID)) {
    next.disabled_providers = config.disabled_providers.filter((p) => p !== MESH_PROVIDER_ID)
  }
  return next as T
}

/** Remove only what `use` added: `provider.mesh` and `mesh` in `enabled_providers`. Nothing else. */
export function removeMeshProvider<T extends Obj>(config: T): T {
  const next: Obj = { ...config }
  if (isObj(config.provider) && MESH_PROVIDER_ID in config.provider) {
    const { [MESH_PROVIDER_ID]: _gone, ...rest } = config.provider
    next.provider = rest
  }
  if (Array.isArray(config.enabled_providers) && config.enabled_providers.includes(MESH_PROVIDER_ID)) {
    next.enabled_providers = config.enabled_providers.filter((p) => p !== MESH_PROVIDER_ID)
  }
  return next as T
}

/** Is the mesh provider present AND offered (not filtered out by enabled/disabled lists)? */
export function meshConfigState(config: Obj): { present: boolean; offered: boolean; baseURL: string | null } {
  const provider = isObj(config.provider) ? config.provider[MESH_PROVIDER_ID] : undefined
  const present = isObj(provider)
  const baseURL = present && isObj(provider.options) ? String(provider.options.baseURL ?? "") || null : null
  const enabled = Array.isArray(config.enabled_providers) ? config.enabled_providers : null
  const disabled = Array.isArray(config.disabled_providers) ? config.disabled_providers : []
  const offered =
    present && !disabled.includes(MESH_PROVIDER_ID) && (enabled === null || enabled.includes(MESH_PROVIDER_ID))
  return { present, offered, baseURL }
}

const truthy = (v: string | undefined) => !!v && /^(1|true|yes|on)$/i.test(v.trim())

/**
 * Rule 3. There is no health-data context signal in the CLI yet, so this reads an explicit one:
 * env IRIS_PHI_CONTEXT=1, or `"phi": true` in ~/.iris/config.json. Returns the refusal, or null.
 */
export function phiRefusal(env: Record<string, string | undefined>, irisConfig: unknown): string | null {
  const source = truthy(env.IRIS_PHI_CONTEXT)
    ? "IRIS_PHI_CONTEXT is set"
    : isObj(irisConfig) && irisConfig.phi === true
      ? '~/.iris/config.json has "phi": true'
      : null
  if (!source) return null
  return (
    `Refusing: this is a health-data (PHI) context (${source}). ` +
    "Health data never routes to a shared-compute mesh — other people's machines serve it. " +
    "Use a BAA-covered provider or an on-device model instead."
  )
}

/**
 * Flags/values that would make a mesh discoverable, join a public one, bind the API beyond
 * loopback, or weaken admission below an owner allowlist (`require-owned` "is not an owner
 * allowlist" — MESHES.md).
 */
export const FORBIDDEN_SERVE_FLAGS = [
  "--auto",
  "--publish",
  "--discover",
  "--listen-all",
  "require-owned",
  "prefer-owned",
] as const

/**
 * argv for `iris mesh up`. An owner-restricted, unpublished mesh on loopback — per Mesh-LLM
 * docs/MESHES.md "Ownership and admission control": "For controlled membership, initialize an owner
 * key and configure owner allowlisting on the participating nodes … `allowlist` additionally checks
 * the owner against the local trusted-owner set". Throws rather than start an unrestricted mesh.
 */
export function buildServeArgv(input: {
  bin: string
  model: string
  port: number
  ownerKey: string
  trustOwners: string[]
  nodeLabel?: string
}): string[] {
  const owners = Array.from(new Set(input.trustOwners.map((o) => o.trim()).filter(Boolean)))
  if (!input.ownerKey) throw new Error("an owner key is required — an IRIS mesh is never unrestricted")
  if (owners.length === 0) throw new Error("at least one trusted owner id is required for an allowlisted mesh")
  if (!input.model.trim()) throw new Error("a model is required")
  const argv = [
    input.bin,
    "serve",
    "--model",
    input.model,
    "--headless",
    "--port",
    String(input.port),
    "--owner-key",
    input.ownerKey,
    "--trust-policy",
    "allowlist",
  ]
  for (const o of owners) argv.push("--trust-owner", o)
  if (input.nodeLabel) argv.push("--node-label", input.nodeLabel)
  // Belt and braces: a model name or label must never smuggle a forbidden flag in.
  for (const a of argv) {
    if ((FORBIDDEN_SERVE_FLAGS as readonly string[]).includes(a)) throw new Error(`refusing to pass ${a} to mesh-llm`)
  }
  return argv
}

/** Where `mesh-llm` might be: PATH, then the installer's ~/.local/bin, then Homebrew. */
export function findMeshBinary(home: string, exists: (p: string) => boolean, pathEnv: string | undefined): string | null {
  const candidates = [
    ...(pathEnv ?? "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, "mesh-llm")),
    path.join(home, ".local", "bin", "mesh-llm"),
    "/opt/homebrew/bin/mesh-llm",
  ]
  return candidates.find((c) => exists(c)) ?? null
}

/** The owner id in a mesh-llm owner keystore (`mesh-llm auth init`). Reads only `owner_id`. */
export function ownerIdFromKeystore(keystore: unknown): string | null {
  if (!isObj(keystore)) return null
  const id = keystore.owner_id
  return typeof id === "string" && id.trim() ? id.trim() : null
}

/**
 * M4 — should `iris acp` (Buzz) get the mesh provider for this session? Only when the loopback
 * mesh is actually serving, the context is not PHI, and the user has not already configured
 * `mesh` themselves (their entry wins; we never overwrite it in memory either).
 */
export function acpMeshDecision(input: {
  probe: MeshProbe
  phi: string | null
  config: Obj
}): { apply: false; reason: string } | { apply: true; reason: string } {
  if (input.phi) return { apply: false, reason: "PHI context" }
  if (!input.probe.serving) return { apply: false, reason: `mesh not serving: ${input.probe.reason}` }
  if (meshConfigState(input.config).present) return { apply: false, reason: "mesh already configured" }
  return { apply: true, reason: `mesh serving ${input.probe.models.length} model(s)` }
}
