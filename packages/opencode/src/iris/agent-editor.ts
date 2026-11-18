/**
 * Agents › New agent / Edit agent (#191840) — the sidecar half.
 *
 * The Desktop port of ELON's SimpleAgentModal. Every call here is one ELON (or the CLI) already
 * makes; nothing is invented server-side. The webview never talks to fl-api or iris-api itself:
 * the token stays in this process, the same as every other /iris route.
 *
 *   agent         fl-api   GET|POST|PUT /api/v1/users/{u}/bloqs/agents[/{id}]   (store/bloqs.js)
 *   heartbeat     fl-api   PUT /api/v1/bloqs/agents/{id}/heartbeat              (HeartbeatConfig.vue)
 *   models        iris-api GET /api/v6/openai/models — the SAME manifest Desktop's chat model
 *                 picker reads (provider.ts), filtered the same way: `available` only. The server
 *                 builds `available` from MODEL_PROXY_OFFERED_MODELS (OpenCode Go routes).
 *   tool catalog  iris-api GET /api/v1/agents/tool-catalog — fl-iris-api #253 (P2 #191437). A 404
 *                 is reported as `available: false`, never as an error, so the editor falls back.
 *   tools         iris-api GET|PUT /api/v1/agents/{id}/tools (#253) — the allowlist, validated.
 *                 NOT fl-api's agent PUT: that replaces the whole config column.
 *   policy        iris-api GET|PUT /api/v1/agents/{id}/policy (fl-iris-api #230, P3 #191438)
 *   alerts        fl-api   GET|PUT /api/v1/users/{u}[/bloqs/{b}]/status-settings,
 *                          POST /api/v1/users/{u}/status-settings/test (fl-api #170)
 *
 * Every function answers in one envelope — `{ ok, status, reason?, data? }` — with the upstream
 * HTTP status kept, because "422 with these field errors" and "could not reach" need different
 * words on screen, and a 404 on the catalogue is a fact about the server, not a failure.
 */
import { FL_API, IRIS_API, irisFetch, resolveUserId, tokenSource } from "./platform"

export type Proxied = { ok: boolean; status: number; reason?: string; data?: unknown }

/** The chat picker's endpoint — kept in step with provider.ts IRIS_OPENAI_BASE. */
const MODELS_URL = `${IRIS_API}/api/v6/openai/models`

/** fl-api / iris-api error bodies come in four shapes; say the most specific thing they carry. */
export function failureReason(status: number, body: any): string {
  const first = (v: unknown): string | undefined => {
    if (typeof v === "string" && v.trim()) return v.trim()
    if (Array.isArray(v)) return first(v[0])
    return undefined
  }
  const fields = body?.errors && typeof body.errors === "object" && !Array.isArray(body.errors) ? body.errors : null
  const fieldLine = fields
    ? Object.entries(fields)
        .map(([k, v]) => `${k}: ${first(v) ?? "invalid"}`)
        .join("; ")
    : undefined
  return first(body?.message) ?? first(body?.error) ?? fieldLine ?? `HTTP ${status}`
}

async function call(base: string, path: string, init: RequestInit = {}): Promise<Proxied> {
  try {
    const res = await irisFetch(path, base, init)
    const text = await res.text()
    let body: any = undefined
    try {
      body = text ? JSON.parse(text) : undefined
    } catch {
      body = undefined
    }
    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        reason: failureReason(res.status, body),
        // 422 field errors ride along so the step can mark the field, not just the page.
        data:
          (body?.errors && typeof body.errors === "object") || Array.isArray(body?.unknown)
            ? { errors: body?.errors, unknown: Array.isArray(body?.unknown) ? body.unknown : undefined, field: body?.field }
            : undefined,
      }
    }
    return { ok: true, status: res.status, data: body }
  } catch (e) {
    return { ok: false, status: 0, reason: e instanceof Error ? e.message : String(e) }
  }
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
})

async function user(): Promise<number | Proxied> {
  const id = await resolveUserId()
  return id ?? { ok: false, status: 401, reason: `not signed in (token: ${tokenSource()})` }
}

/** fl-api wraps a record as `{data: {...}}`, sometimes `{data: {data: {...}}}`. */
export function unwrapRecord(body: any): any {
  const d = body?.data ?? body
  return d && typeof d === "object" && !Array.isArray(d) && d.data && typeof d.data === "object" && !Array.isArray(d.data) && d.id === undefined
    ? d.data
    : d
}

export async function readAgent(agentId: number): Promise<Proxied> {
  const u = await user()
  if (typeof u !== "number") return u
  const r = await call(FL_API, `/api/v1/users/${u}/bloqs/agents/${agentId}`)
  return r.ok ? { ...r, data: unwrapRecord(r.data) } : r
}

/**
 * Create (no id) or update.
 *
 * fl-api REPLACES `config` wholesale on update (AgentController::update), so an update never sends
 * a config the editor built from what it read minutes ago: that would erase a policy, an autonomy
 * level or a tool list changed since. Instead the editor sends `configPatch` — only the keys it
 * owns (model, temperature…) — and this re-reads the agent and merges the patch into the config
 * as it is NOW. A save that touches no config key (Personality) sends no config at all.
 * Tools and rules never travel this way: they have their own endpoints (/tools, /policy).
 */
export async function saveAgent(
  agentId: number | undefined,
  body: unknown,
  configPatch?: Record<string, unknown>,
): Promise<Proxied> {
  const u = await user()
  if (typeof u !== "number") return u
  const payload: Record<string, unknown> = { ...((body as Record<string, unknown>) ?? {}) }
  if (agentId) {
    delete payload.config
    if (configPatch && Object.keys(configPatch).length) {
      const fresh = await call(FL_API, `/api/v1/users/${u}/bloqs/agents/${agentId}`)
      if (!fresh.ok) return { ...fresh, reason: `could not re-read the agent before saving — ${fresh.reason}` }
      payload.config = mergeConfig(unwrapRecord(fresh.data)?.config, configPatch)
    }
  }
  const r = agentId
    ? await call(FL_API, `/api/v1/users/${u}/bloqs/agents/${agentId}`, json("PUT", payload))
    : await call(FL_API, `/api/v1/users/${u}/bloqs/agents`, json("POST", payload))
  return r.ok ? { ...r, data: unwrapRecord(r.data) } : r
}

/** The stored config (object or JSON string, or nothing) with `patch` laid over it, key by key. */
export function mergeConfig(stored: unknown, patch: Record<string, unknown>): Record<string, unknown> {
  let base: unknown = stored
  if (typeof base === "string") {
    try {
      base = JSON.parse(base)
    } catch {
      base = {}
    }
  }
  const out: Record<string, unknown> = base && typeof base === "object" && !Array.isArray(base) ? { ...(base as object) } : {}
  for (const [k, v] of Object.entries(patch)) out[k] = v
  return out
}

/** The agent's allowlist as iris-api reads it (fl-iris-api #253): {state, tools, resolved, unknown}. */
export const readTools = (agentId: number) => call(IRIS_API, `/api/v1/agents/${agentId}/tools`)

/**
 * Save the allowlist through iris-api's /tools, which validates every name and touches nothing
 * else in config. Until that endpoint is deployed (404), fall back to fl-api with a config patch
 * — merged into a fresh read, so policy and autonomy survive — and say which way it went.
 */
export async function saveTools(agentId: number, tools: string[]): Promise<Proxied> {
  const r = await call(IRIS_API, `/api/v1/agents/${agentId}/tools`, json("PUT", { tools }))
  if (r.ok || (r.status !== 404 && r.status !== 405)) return r
  const fallback = await saveAgent(agentId, {}, { tools })
  return fallback.ok ? { ...fallback, data: { via: "fl-api", tools } } : fallback
}

export async function saveHeartbeat(agentId: number, body: unknown): Promise<Proxied> {
  return call(FL_API, `/api/v1/bloqs/agents/${agentId}/heartbeat`, json("PUT", body))
}

export type OfferedModel = { id: string; name: string; reasoning: boolean; toolCalling: boolean; context: number | null }

/** The manifest, as the chat picker reads it: only what the server says it will serve. */
export function readModels(body: any): OfferedModel[] {
  const rows: any[] = Array.isArray(body?.data) ? body.data : []
  return rows
    .filter((m) => m && typeof m.id === "string" && m.available === true)
    .map((m) => ({
      id: m.id,
      name: typeof m.name === "string" && m.name ? m.name : m.id.replace(/^iris\//, ""),
      reasoning: m.reasoning === true,
      toolCalling: m.tool_calling !== false,
      context: typeof m.limits?.context === "number" ? m.limits.context : null,
    }))
}

export async function fetchModels(): Promise<Proxied> {
  try {
    const res = await irisFetch("", MODELS_URL, { signal: AbortSignal.timeout(8000) })
    if (!res.ok) return { ok: false, status: res.status, reason: `model manifest HTTP ${res.status}` }
    return { ok: true, status: res.status, data: { models: readModels(await res.json()) } }
  } catch (e) {
    return { ok: false, status: 0, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * The tool catalogue. `available: false` on a 404 or 405 — the endpoint is not deployed yet, and
 * the editor shows its built-in default set instead of an error. Any other failure is a failure.
 */
export async function fetchToolCatalog(): Promise<Proxied> {
  const r = await call(IRIS_API, `/api/v1/agents/tool-catalog`)
  if (!r.ok && (r.status === 404 || r.status === 405)) {
    return { ok: true, status: r.status, data: { available: false, catalog: null } }
  }
  if (!r.ok) return r
  // fl-iris-api #253: {version, effects, approval, trust_levels, groups, defaults, always_on,
  // tools, integrations}. Passed through whole — the view-model reads it, and is tested on it.
  const body: any = r.data
  const catalog = body?.tools ? body : body?.data?.tools ? body.data : Array.isArray(body?.data) ? { tools: body.data } : { tools: [] }
  return { ok: true, status: r.status, data: { available: true, catalog } }
}

export const readPolicy = (agentId: number) => call(IRIS_API, `/api/v1/agents/${agentId}/policy`)
export const savePolicy = (agentId: number, policy: unknown) =>
  call(IRIS_API, `/api/v1/agents/${agentId}/policy`, json("PUT", { policy: policy ?? null }))

/** Account level always; the board's level too when a board is named. */
export async function readStatusSettings(bloqId?: number): Promise<Proxied> {
  const u = await user()
  if (typeof u !== "number") return u
  const r = await call(FL_API, bloqId ? `/api/v1/users/${u}/bloqs/${bloqId}/status-settings` : `/api/v1/users/${u}/status-settings`)
  return r.ok ? { ...r, data: (r.data as any)?.data ?? r.data } : r
}

export async function saveStatusSettings(bloqId: number | undefined, changes: unknown): Promise<Proxied> {
  const u = await user()
  if (typeof u !== "number") return u
  const path = bloqId ? `/api/v1/users/${u}/bloqs/${bloqId}/status-settings` : `/api/v1/users/${u}/status-settings`
  const r = await call(FL_API, path, json("PUT", changes ?? {}))
  return r.ok ? { ...r, data: (r.data as any)?.data ?? r.data } : r
}

export async function testStatusSettings(bloqId?: number): Promise<Proxied> {
  const u = await user()
  if (typeof u !== "number") return u
  return call(FL_API, `/api/v1/users/${u}/status-settings/test`, json("POST", bloqId ? { bloq_id: bloqId } : {}))
}
