import fs from "fs/promises"
import path from "path"
import { Global } from "../global"
import { Log } from "../util/log"

/**
 * IP-07 (#189850) — IRIS-authored system prompts are served by the private IRIS API and are
 * NEVER compiled into the public binary. The repo ships only upstream opencode text as the
 * fallback (guarded by prompt-ip-guard.test.ts).
 *
 * Contract: GET {IRIS_API}/api/v1/cli/prompts, Bearer auth
 *   200 → { version: "<12 hex>", prompts: { "<id>": "<text>" } }, ETag: "<version>"
 *   If-None-Match: "<version>" → 304 · 401 when unauthenticated
 *
 * Rules:
 *  - at most ONE network fetch per process (memoised promise, shared by concurrent callers)
 *  - timeout ≤ 1500 ms; never throws into the session path
 *  - no token → no network at all (cache, else fallback)
 *  - cache ≤ 24 h is used as-is; stale → revalidate with If-None-Match (304 bumps fetchedAt);
 *    network/HTTP failure → stale cache; nothing → fallback
 */
export namespace RemotePrompts {
  const log = Log.create({ service: "remote-prompts" })

  export type Id =
    | "iris.identity"
    | "session.anthropic"
    | "session.qwen"
    | "session.beast"
    | "session.copilot-gpt-5"
    | "session.gemini"

  export type Fetcher = (input: { token: string; etag?: string; signal: AbortSignal }) => Promise<Response>

  type Cache = { version: string; fetchedAt: number; prompts: Record<string, string> }

  export const PATH = "/api/v1/cli/prompts"
  const FRESH_MS = 24 * 60 * 60 * 1000

  const defaultFetcher: Fetcher = async ({ etag, signal }) => {
    // Lazy import: iris-api pulls in CLI UI modules the session path should not load eagerly.
    const { irisFetch, IRIS_API } = await import("../cli/cmd/iris-api")
    return irisFetch(PATH, { signal, headers: etag ? { "If-None-Match": etag } : {} }, IRIS_API)
  }

  const defaultToken = async () => {
    // Set by test/preload.ts: behave as signed out, so a test run on a machine holding a
    // real IRIS token never reaches the API. Same idea as OPENCODE_DISABLE_MODELS_FETCH.
    if (process.env["OPENCODE_DISABLE_REMOTE_PROMPTS"] === "true") return ""
    const { resolveToken } = await import("../cli/cmd/iris-api")
    return resolveToken()
  }

  const defaults = () => ({
    fetcher: defaultFetcher,
    token: defaultToken as () => Promise<string>,
    cacheFile: path.join(Global.Path.cache, "cli-prompts.json"),
    now: () => Date.now(),
    timeoutMs: 1500,
  })

  let options = defaults()
  let loaded: Promise<Record<string, string>> | undefined

  /** Test seam: inject the fetcher, token source, cache path and clock. */
  export function configure(input: Partial<ReturnType<typeof defaults>>) {
    options = { ...options, ...input }
    loaded = undefined
  }

  export function reset() {
    options = defaults()
    loaded = undefined
  }

  /** The prompt text for `id`: remote/cached when available, otherwise `fallback`. */
  export async function get(id: Id, fallback: string): Promise<string> {
    const prompts = await load()
    const text = prompts[id]
    return typeof text === "string" && text.trim() ? text : fallback
  }

  /** All available remote prompts (possibly empty). Memoised per process; never rejects. */
  export function load(): Promise<Record<string, string>> {
    if (!loaded) loaded = resolve().catch((err) => {
      log.warn("prompt resolution failed", { error: String(err) })
      return {}
    })
    return loaded
  }

  async function resolve(): Promise<Record<string, string>> {
    const opts = options
    const cache = await readCache(opts.cacheFile)
    if (cache && opts.now() - cache.fetchedAt <= FRESH_MS) return cache.prompts

    const token = await opts.token().catch(() => "")
    if (!token) return cache?.prompts ?? {}

    const res = await fetchWithTimeout(opts, token, cache ? `"${cache.version}"` : undefined)
    if (!res) return cache?.prompts ?? {}

    if (res.status === 304 && cache) {
      await writeCache(opts.cacheFile, { ...cache, fetchedAt: opts.now() })
      return cache.prompts
    }
    if (res.status === 200) {
      const body = parse(await res.json().catch(() => undefined))
      if (body) {
        await writeCache(opts.cacheFile, { ...body, fetchedAt: opts.now() })
        return body.prompts
      }
    }
    log.info("prompt fetch not usable", { status: res.status })
    return cache?.prompts ?? {}
  }

  async function fetchWithTimeout(
    opts: ReturnType<typeof defaults>,
    token: string,
    etag: string | undefined,
  ): Promise<Response | undefined> {
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<undefined>((r) => {
      timer = setTimeout(() => {
        controller.abort()
        r(undefined)
      }, opts.timeoutMs)
    })
    try {
      return await Promise.race([opts.fetcher({ token, etag, signal: controller.signal }), timeout])
    } catch (err) {
      log.info("prompt fetch failed", { error: String(err) })
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  function parse(value: unknown): { version: string; prompts: Record<string, string> } | undefined {
    if (!value || typeof value !== "object") return undefined
    const { version, prompts } = value as Record<string, unknown>
    if (typeof version !== "string" || !prompts || typeof prompts !== "object" || Array.isArray(prompts)) return
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(prompts)) if (typeof v === "string") out[k] = v
    return { version, prompts: out }
  }

  async function readCache(file: string): Promise<Cache | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(file, "utf8"))
      const body = parse(raw)
      if (!body || typeof raw.fetchedAt !== "number") return undefined
      return { ...body, fetchedAt: raw.fetchedAt }
    } catch {
      return undefined
    }
  }

  async function writeCache(file: string, cache: Cache) {
    try {
      await fs.mkdir(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      await fs.writeFile(tmp, JSON.stringify(cache), { mode: 0o600 })
      await fs.chmod(tmp, 0o600)
      await fs.rename(tmp, file)
    } catch (err) {
      log.warn("prompt cache write failed", { error: String(err) })
    }
  }
}
