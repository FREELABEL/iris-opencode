/**
 * Hive › Scripts (#188817) — the sidecar half.
 *
 * The same cloud calls `iris scripts list | pull | push | run | doctor` make on the CLI line
 * (`platform-scripts.ts` on main), served to the desktop webview, which cannot read the token on
 * disk. Everything is on IRIS_API (fl-iris-api) — user scripts and node tasks live there, and a
 * call to fl-api 404s, which here would read as "no such script".
 *
 * `read*` functions are pure, so the shapes the panel depends on are tested without a network.
 *
 * Two things this deliberately does NOT do, because the CLI does not:
 *  - pass ARGUMENTS. The daemon's `user_script` executor reads `config.script_slug` and
 *    `config.script_sha256` only; a header's `arg=` lines are not delivered to the script today.
 *    Sending them under an invented key would look like it works and change nothing.
 *  - report which LINE is running. Nothing on the wire says so.
 */
import { createHash } from "crypto"
import { IRIS_API, irisFetch, resolveUserId, tokenSource } from "./platform"

type Result<T> = { measured: boolean; reason?: string; data: T }

export type DoctorUnmet = { requirement: string; reason: string }
export type DoctorRow = { node: string; verdict?: { ok?: boolean; unmet?: DoctorUnmet[]; summary?: string } }
export type ScriptDoctor = {
  slug: string
  requires: string[]
  manifest_errors: string[]
  timeout: number | null
  eligible: DoctorRow[]
  eligible_online: number | null
  blocked: DoctorRow[]
  runnable_now?: boolean
}

export type ScriptSummary = {
  slug: string
  name?: string
  description?: string
  runtime?: string
  updatedAt?: string
  lastExecutedAt: string | null
  doctor: ScriptDoctor | null
  tags: string[]
}

export type ScriptSource = {
  slug: string
  name?: string
  description?: string
  runtime: string
  content: string
  sha256: string
  updatedAt?: string
  autoPull: boolean
  visibility?: string
  tags: string[]
}

export type TaskView = {
  id: string
  status: string
  terminal: boolean
  createdAt: string | null
  dispatchedAt: string | null
  arrivedAt: string | null
  startedAt: string | null
  completedAt: string | null
  stdout: string
  stderr: string
  exitCode: number | null
  exitCodeSource: "metadata" | "result" | "error_text" | null
  error: string | null
  nodeName: string | null
  durationMs: number | null
  /** Constellation Gate held this run for its owner's approval (#189589). It has not been sent. */
  held: boolean
  gate: { explanation: string; reasons: string[]; action: string | null; score: number | null; hardware: string[] } | null
}

/** The CLI's terminal set (platform-scripts.ts RunCmd). */
export const TERMINAL = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])

/** The content hash IS the script's identity — the node runs exactly this version or refuses. */
export function scriptDigest(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v !== "" ? v : undefined)
const nul = (v: unknown): string | null => (typeof v === "string" && v !== "" ? v : null)

function readRows(v: unknown): DoctorRow[] {
  if (!Array.isArray(v)) return []
  return v.map((r: any) => ({
    node: String(r?.node ?? ""),
    verdict: {
      ok: Boolean(r?.verdict?.ok),
      unmet: Array.isArray(r?.verdict?.unmet)
        ? r.verdict.unmet.map((u: any) => ({ requirement: String(u?.requirement ?? ""), reason: String(u?.reason ?? "") }))
        : [],
      summary: str(r?.verdict?.summary),
    },
  }))
}

export function readDoctor(d: any): ScriptDoctor | null {
  if (!d || typeof d !== "object" || typeof d.slug !== "string") return null
  return {
    slug: d.slug,
    requires: Array.isArray(d.requires) ? d.requires.map(String) : [],
    manifest_errors: Array.isArray(d.manifest_errors) ? d.manifest_errors.map(String) : [],
    timeout: typeof d.timeout === "number" ? d.timeout : null,
    eligible: readRows(d.eligible),
    // null, not 0, when the hub did not say: "not counted" must not read as "none online"
    eligible_online: typeof d.eligible_online === "number" ? d.eligible_online : null,
    blocked: readRows(d.blocked),
    runnable_now: typeof d.runnable_now === "boolean" ? d.runnable_now : undefined,
  }
}

export function readSource(d: any): ScriptSource | null {
  if (!d || typeof d.slug !== "string" || typeof d.script_content !== "string") return null
  return {
    slug: d.slug,
    name: str(d.name),
    description: str(d.description),
    runtime: str(d.runtime) ?? "bash",
    content: d.script_content,
    sha256: scriptDigest(d.script_content),
    updatedAt: str(d.updated_at),
    autoPull: Boolean(d.auto_pull),
    visibility: str(d.visibility),
    tags: tagsOf(d.tags),
  }
}

/** The hub stores tags as JSON that may be null, an array, or (old rows) a comma string. */
export function tagsOf(v: unknown): string[] {
  const raw = Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []
  return [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))]
}

/**
 * A Hive task, as the panel reads it. The exit-code rules mirror `fromHiveTask` on main
 * (hive-script-result.ts): the daemon reports it under `metadata.exit_code` — top-level or inside
 * `result` — and only as a last resort is it recovered from the daemon's English, tagged
 * `error_text` so the panel can say it was inferred.
 */
export function readTask(t: any): TaskView | null {
  if (!t || typeof t !== "object" || t.id == null) return null
  const r = t.result && typeof t.result === "object" ? t.result : {}
  let exitCode: number | null = null
  let exitCodeSource: TaskView["exitCodeSource"] = null
  if (typeof t.metadata?.exit_code === "number") [exitCode, exitCodeSource] = [t.metadata.exit_code, "metadata"]
  else if (typeof r.metadata?.exit_code === "number") [exitCode, exitCodeSource] = [r.metadata.exit_code, "metadata"]
  else if (typeof r.exit_code === "number") [exitCode, exitCodeSource] = [r.exit_code, "result"]
  else if (typeof r.exitCode === "number") [exitCode, exitCodeSource] = [r.exitCode, "result"]
  else {
    const m = /\bexited with code\s+(\d{1,3})\b/i.exec(String(t.error ?? ""))
    if (m) [exitCode, exitCodeSource] = [Number(m[1]), "error_text"]
  }
  const status = String(t.status ?? "unknown")
  return {
    id: String(t.id),
    status,
    terminal: TERMINAL.has(status),
    createdAt: nul(t.created_at),
    dispatchedAt: nul(t.dispatched_at),
    arrivedAt: nul(t.arrived_at),
    startedAt: nul(t.started_at),
    completedAt: nul(t.completed_at),
    // Prefer the separated stream; `output` is the merged fallback for older nodes.
    stdout: String(r.stdout ?? r.output ?? ""),
    stderr: String(r.stderr ?? ""),
    exitCode,
    exitCodeSource,
    error: nul(t.error),
    nodeName: str(t.node?.name) ?? str(r.metadata?.executed_by_node_name) ?? null,
    durationMs: typeof t.duration_ms === "number" ? t.duration_ms : null,
    held: status === "awaiting_approval",
    gate:
      t.gate && typeof t.gate === "object"
        ? {
            explanation: String(t.gate.explanation ?? ""),
            reasons: Array.isArray(t.gate.reasons) ? t.gate.reasons.map(String) : [],
            action: t.gate.action ?? null,
            score: typeof t.gate.score === "number" ? t.gate.score : null,
            hardware: Array.isArray(t.gate.hardware) ? t.gate.hardware.map(String) : [],
          }
        : null,
  }
}

const notSignedIn = () => `not signed in (token: ${tokenSource()})`
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** Run `fn` over `items`, at most `n` at a time. */
async function pool<T, R>(items: readonly T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      while (next < items.length) {
        const i = next++
        out[i] = await fn(items[i])
      }
    }),
  )
  return out
}

async function getDoctor(slug: string): Promise<ScriptDoctor | null> {
  const res = await irisFetch(`/api/v1/scripts/${encodeURIComponent(slug)}/doctor`, IRIS_API)
  if (!res.ok) return null
  return readDoctor(((await res.json()) as any)?.data)
}

// The doctor for every script is ~27 calls; the verdicts change when a computer comes or goes,
// not per click. Cached for 30 s; a save or a run on a slug clears that slug.
const DOCTOR_TTL_MS = 30_000
const doctorCache = new Map<string, { at: number; doctor: ScriptDoctor | null }>()
export function forgetDoctor(slug?: string) {
  if (slug) doctorCache.delete(slug)
  else doctorCache.clear()
}

async function cachedDoctor(slug: string): Promise<ScriptDoctor | null> {
  const hit = doctorCache.get(slug)
  if (hit && Date.now() - hit.at < DOCTOR_TTL_MS) return hit.doctor
  const doctor = await getDoctor(slug).catch(() => null)
  // A failed doctor is not remembered — "could not ask" must not stick for 30 s.
  if (doctor) doctorCache.set(slug, { at: Date.now(), doctor })
  return doctor
}

/** `account` is the IRIS user the list belongs to — scripts are per account, so a second sign-in sees none. */
export async function fetchScripts(): Promise<Result<{ scripts: ScriptSummary[]; account?: number }>> {
  const account = await resolveUserId()
  if (!account) return { measured: false, reason: notSignedIn(), data: { scripts: [] } }
  try {
    const res = await irisFetch(`/api/v1/scripts`, IRIS_API)
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { scripts: [], account } }
    const rows: any[] = ((await res.json()) as any)?.data ?? []
    const doctors = await pool(rows, 8, (r) => cachedDoctor(String(r.slug)))
    const scripts: ScriptSummary[] = rows.map((r, i) => ({
      slug: String(r.slug),
      name: str(r.name),
      description: str(r.description),
      runtime: str(r.runtime),
      updatedAt: str(r.updated_at),
      lastExecutedAt: nul(r.last_executed_at),
      doctor: doctors[i],
      tags: tagsOf(r.tags),
    }))
    scripts.sort((a, b) => a.slug.localeCompare(b.slug))
    return { measured: true, data: { scripts, account } }
  } catch (e) {
    return { measured: false, reason: errText(e), data: { scripts: [] } }
  }
}

export async function fetchScript(slug: string): Promise<Result<{ script: ScriptSource | null }>> {
  if (!(await resolveUserId())) return { measured: false, reason: notSignedIn(), data: { script: null } }
  try {
    const res = await irisFetch(`/api/v1/scripts/${encodeURIComponent(slug)}`, IRIS_API)
    if (res.status === 404) return { measured: true, reason: `no script named '${slug}'`, data: { script: null } }
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { script: null } }
    return { measured: true, data: { script: readSource(((await res.json()) as any)?.data) } }
  } catch (e) {
    return { measured: false, reason: errText(e), data: { script: null } }
  }
}

export async function fetchDoctor(slug: string): Promise<Result<{ doctor: ScriptDoctor | null }>> {
  if (!(await resolveUserId())) return { measured: false, reason: notSignedIn(), data: { doctor: null } }
  try {
    forgetDoctor(slug)
    const doctor = await cachedDoctor(slug)
    return doctor
      ? { measured: true, data: { doctor } }
      : { measured: false, reason: "the hub did not answer the doctor check", data: { doctor: null } }
  } catch (e) {
    return { measured: false, reason: errText(e), data: { doctor: null } }
  }
}

export type SaveResult = { ok: boolean; reason?: string; sha256?: string; updatedAt?: string; created?: boolean }

/**
 * Save = `iris scripts push`: the same upsert. Name, description, runtime and auto-pull are
 * carried over from the saved copy, because the push endpoint is an upsert and a field left out
 * is not "unchanged" to every server version.
 */
export async function saveScript(
  slug: string,
  content: string,
  opts: { tags?: string[]; name?: string; description?: string; runtime?: string; mustBeNew?: boolean } = {},
): Promise<SaveResult> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  try {
    const read = await fetchScript(slug)
    const current = read.data.script
    if (opts.mustBeNew && !read.measured) return { ok: false, reason: read.reason ?? "could not check your scripts first" }
    if (opts.mustBeNew && current) return { ok: false, reason: `you already have a script named '${slug}'` }
    // The hub writes `tags` as sent, and a push without them ERASES them — so they always go back.
    if (!read.measured && opts.tags === undefined) return { ok: false, reason: read.reason ?? "could not read the saved copy" }
    const tags = opts.tags ?? current?.tags ?? []
    const res = await irisFetch(`/api/v1/scripts`, IRIS_API, {
      method: "POST",
      body: JSON.stringify({
        slug,
        name: opts.name ?? current?.name,
        description: opts.description ?? current?.description,
        runtime: opts.runtime ?? current?.runtime ?? "bash",
        script_content: content,
        auto_pull: current?.autoPull ?? false,
        tags: tags.length ? tags : null,
        user_id: userId,
      }),
    })
    if (!res.ok) {
      const body = (await res.text().catch(() => "")).slice(0, 300)
      return { ok: false, reason: `iris-api ${res.status}${body ? ` — ${body}` : ""}` }
    }
    const json = (await res.json().catch(() => ({}))) as any
    forgetDoctor(slug)
    return { ok: true, sha256: scriptDigest(content), updatedAt: str(json?.data?.updated_at), created: res.status === 201 }
  } catch (e) {
    return { ok: false, reason: errText(e) }
  }
}

/** Tag a script into or out of a project. Same push, same content — the hub burns no version. */
export async function setScriptTags(slug: string, tags: string[]): Promise<SaveResult> {
  const read = await fetchScript(slug)
  if (!read.data.script) return { ok: false, reason: read.reason ?? `no script named '${slug}'` }
  return saveScript(slug, read.data.script.content, { tags: tagsOf(tags) })
}

// ── Marketplace: the public directory behind /p/hive-scripts. Unauthenticated by design. ──

export type MarketScript = {
  slug: string
  name?: string
  description?: string
  runtime?: string
  author?: string
  version?: number
  publishedAt?: string
  requires: string[]
}
export type MarketSource = MarketScript & {
  content: string
  timeout?: number
  egress?: string
  assets: number
  checks: { title: string; status: string }[]
}

const readMarket = (r: any): MarketScript => ({
  slug: String(r.slug),
  name: str(r.name),
  description: str(r.description),
  runtime: str(r.runtime),
  author: str(r.author),
  version: typeof r.version === "number" ? r.version : undefined,
  publishedAt: str(r.published_at),
  requires: Array.isArray(r.requires) ? r.requires.map(String) : [],
})

export async function fetchMarket(q?: string): Promise<Result<{ scripts: MarketScript[] }>> {
  try {
    const res = await fetch(`${IRIS_API}/api/v1/public/scripts${q ? `?q=${encodeURIComponent(q)}` : ""}`, {
      headers: { Accept: "application/json" },
    })
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { scripts: [] } }
    const rows: any[] = ((await res.json()) as any)?.data ?? []
    return { measured: true, data: { scripts: rows.map(readMarket) } }
  } catch (e) {
    return { measured: false, reason: errText(e), data: { scripts: [] } }
  }
}

export async function fetchMarketScript(slug: string): Promise<Result<{ script: MarketSource | null }>> {
  try {
    const res = await fetch(`${IRIS_API}/api/v1/public/scripts/${encodeURIComponent(slug)}`, {
      headers: { Accept: "application/json" },
    })
    if (res.status === 404) return { measured: true, reason: `no public script named '${slug}'`, data: { script: null } }
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { script: null } }
    const d = ((await res.json()) as any)?.data
    if (!d || typeof d.script_content !== "string") return { measured: false, reason: "no source in the answer", data: { script: null } }
    return {
      measured: true,
      data: {
        script: {
          ...readMarket(d),
          content: d.script_content,
          timeout: typeof d.timeout === "number" ? d.timeout : undefined,
          egress: str(d.egress),
          assets: Array.isArray(d.assets) ? d.assets.length : 0,
          checks: Array.isArray(d.checks)
            ? d.checks.map((c: any) => ({ title: String(c.title ?? c.id ?? ""), status: String(c.status ?? "") }))
            : [],
        },
      },
    }
  } catch (e) {
    return { measured: false, reason: errText(e), data: { script: null } }
  }
}

/**
 * Add a marketplace script to my account: a copy of its source under the same slug, refused if
 * I already have one by that name (an install must never overwrite my own script). Attached files
 * are not copied — the answer says how many were left behind.
 */
export async function installScript(slug: string, tags: string[] = []): Promise<SaveResult & { assetsLeft?: number }> {
  const pub = await fetchMarketScript(slug)
  const src = pub.data.script
  if (!src) return { ok: false, reason: pub.reason ?? `no public script named '${slug}'` }
  const saved = await saveScript(slug, src.content, {
    mustBeNew: true,
    name: src.name,
    description: src.description,
    runtime: src.runtime,
    tags: tagsOf(tags),
  })
  return src.assets ? { ...saved, assetsLeft: src.assets } : saved
}

export type RunResult = { ok: boolean; reason?: string; taskId?: string; nodeId?: string; nodeName?: string; sha256?: string | null; timeoutSeconds?: number }

/** Resolve a node the way `resolveNode` does on the CLI: id, exact name, id prefix, name prefix. */
export function pickNode<N extends { id: string; name: string }>(nodes: readonly N[], target: string): N | undefined {
  const t = target.toLowerCase()
  return (
    nodes.find((n) => n.id === target) ??
    nodes.find((n) => n.name.toLowerCase() === t) ??
    nodes.find((n) => n.id.startsWith(target)) ??
    nodes.find((n) => n.name.toLowerCase().startsWith(t))
  )
}

/** The CLI's clamp: 30 s to an hour, 120 by default. */
export function clampTimeout(v: unknown): number {
  return Math.max(30, Math.min(3600, Number(v) || 120))
}

/** `iris scripts run <slug> --node <node>`: dispatch, return the task id. The caller polls. */
export async function runScript(slug: string, node: string, timeout?: number): Promise<RunResult> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, reason: notSignedIn() }
  try {
    const nr = await irisFetch(`/api/v6/nodes/?user_id=${userId}`, IRIS_API)
    if (!nr.ok) return { ok: false, reason: `could not list computers: iris-api ${nr.status}` }
    const nodes: any[] = ((await nr.json()) as any)?.nodes ?? []
    // An online registration wins over an offline one with the same name.
    const ranked = [...nodes].sort((a, b) => Number(b.connection_status === "online") - Number(a.connection_status === "online"))
    const target = pickNode(
      ranked.map((n) => ({ id: String(n.id), name: String(n.name ?? ""), status: String(n.connection_status ?? "unknown") })),
      node,
    )
    if (!target) return { ok: false, reason: `No computer matching "${node}"` }
    if (target.status !== "online") return { ok: false, reason: `${target.name} is ${target.status} — cannot dispatch` }

    // Pin the content hash, as the CLI does. Unresolvable = an UNVERIFIED run, reported as such.
    const src = (await fetchScript(slug)).data.script
    const digest = src?.sha256 ?? null
    const timeoutSeconds = clampTimeout(timeout)
    const res = await irisFetch(`/api/v6/nodes/tasks`, IRIS_API, {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        title: `iris scripts run: ${slug}`,
        type: "user_script",
        node_id: target.id,
        prompt: slug,
        config: { script_slug: slug, ...(digest ? { script_sha256: digest } : {}) },
        timeout_seconds: timeoutSeconds,
      }),
    })
    if (!res.ok) return { ok: false, reason: `Dispatch failed: ${res.status} ${(await res.text().catch(() => "")).slice(0, 300)}` }
    const created = (await res.json()) as any
    const taskId = created?.task?.id
    if (!taskId) return { ok: false, reason: "the hub accepted the dispatch but returned no task id" }
    forgetDoctor(slug)
    return { ok: true, taskId: String(taskId), nodeId: target.id, nodeName: target.name, sha256: digest, timeoutSeconds }
  } catch (e) {
    return { ok: false, reason: errText(e) }
  }
}

/**
 * Approve or reject a run Constellation Gate held (#189589). Approving re-runs it through the hub's
 * single dispatch path; the answer names the NEW task, which is the one to follow.
 */
export async function decideHeldTask(id: string, decision: "approve" | "reject"): Promise<Result<{ taskId: string | null }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { taskId: null } }
  try {
    const res = await irisFetch(`/api/v6/nodes/tasks/${encodeURIComponent(id)}/${decision}?user_id=${userId}`, IRIS_API, { method: "POST" })
    const body = (await res.json().catch(() => ({}))) as any
    if (!res.ok) return { measured: false, reason: String(body?.message ?? `iris-api ${res.status}`), data: { taskId: null } }
    return { measured: true, data: { taskId: body?.task?.id != null ? String(body.task.id) : null } }
  } catch (e) {
    return { measured: false, reason: errText(e), data: { taskId: null } }
  }
}

export async function fetchTask(id: string): Promise<Result<{ task: TaskView | null }>> {
  const userId = await resolveUserId()
  if (!userId) return { measured: false, reason: notSignedIn(), data: { task: null } }
  try {
    const res = await irisFetch(`/api/v6/nodes/tasks/${encodeURIComponent(id)}?user_id=${userId}`, IRIS_API)
    if (!res.ok) return { measured: false, reason: `iris-api ${res.status}`, data: { task: null } }
    return { measured: true, data: { task: readTask(((await res.json()) as any)?.task) } }
  } catch (e) {
    return { measured: false, reason: errText(e), data: { task: null } }
  }
}
