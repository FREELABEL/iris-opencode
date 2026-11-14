import fs from "fs/promises"
import path from "path"
import { Log } from "./log"

/**
 * IP-07 (#189850) — fetch-with-cache for IRIS-private content that must NOT be compiled into the
 * public binary (system prompts, workspace playbooks/skills). Shared by RemotePrompts and
 * RemoteCapabilities so the two can never drift on the rules below.
 *
 * Contract: GET {IRIS_API}{path}, Bearer auth
 *   200 → { version: "<12 hex>", ...body }, ETag: "<version>"
 *   If-None-Match: "<version>" → 304 · 401 when unauthenticated
 *
 * Rules:
 *  - at most ONE network fetch per process (memoised promise, shared by concurrent callers)
 *  - timeout ≤ 1500 ms; never throws into the caller
 *  - no token → no network at all (cache, else nothing)
 *  - cache ≤ 24 h is used as-is; stale → revalidate with If-None-Match (304 bumps fetchedAt);
 *    network/HTTP failure → stale cache; nothing → nothing
 *  - cache file written 0600 (it holds private text)
 */
export namespace RemoteResource {
  export type Fetcher = (input: { token: string; etag?: string; signal: AbortSignal }) => Promise<Response>

  export type Options = {
    fetcher: Fetcher
    token: () => Promise<string>
    cacheFile: string
    now: () => number
    timeoutMs: number
  }

  /**
   * Where the body came from — or, when there is none, why:
   *  cache · remote · revalidated (304) · stale-cache (offline/failed, used anyway)
   *  signed-out (no token, or 401, and nothing cached) · unavailable (network/HTTP failure, nothing cached)
   */
  export type Source = "cache" | "remote" | "revalidated" | "stale-cache" | "signed-out" | "unavailable"

  export type Result<B> = { body: B | undefined; source: Source }

  export const FRESH_MS = 24 * 60 * 60 * 1000

  /** The production fetcher: irisFetch against IRIS_API (NOT the default FL_API base, which 404s). */
  export function irisFetcher(apiPath: string): Fetcher {
    return async ({ etag, signal }) => {
      // Lazy import: iris-api pulls in CLI UI modules the session path should not load eagerly.
      const { irisFetch, IRIS_API } = await import("../cli/cmd/iris-api")
      return irisFetch(apiPath, { signal, headers: etag ? { "If-None-Match": etag } : {} }, IRIS_API)
    }
  }

  /**
   * The production token source. `disableEnv` is set by test/preload.ts: behave as signed out, so
   * a test run on a machine holding a real IRIS token never reaches the API. Same idea as
   * OPENCODE_DISABLE_MODELS_FETCH.
   */
  export function irisToken(disableEnv: string): () => Promise<string> {
    return async () => {
      if (process.env[disableEnv] === "true") return ""
      const { resolveToken } = await import("../cli/cmd/iris-api")
      return resolveToken()
    }
  }

  export function create<B extends { version: string }>(spec: {
    service: string
    /** Validate a response body (also used on the cache file). undefined = unusable. */
    parse: (value: unknown) => B | undefined
    defaults: () => Options
  }) {
    const log = Log.create({ service: spec.service })
    let options = spec.defaults()
    let loaded: Promise<Result<B>> | undefined

    async function resolve(opts: Options): Promise<Result<B>> {
      const cache = await readCache(opts.cacheFile)
      if (cache && opts.now() - cache.fetchedAt <= FRESH_MS) return { body: cache.body, source: "cache" }

      const fallback = (why: "signed-out" | "unavailable"): Result<B> =>
        cache ? { body: cache.body, source: "stale-cache" } : { body: undefined, source: why }

      const token = await opts.token().catch(() => "")
      if (!token) return fallback("signed-out")

      const res = await fetchWithTimeout(opts, token, cache ? `"${cache.body.version}"` : undefined)
      if (!res) return fallback("unavailable")

      if (res.status === 304 && cache) {
        await writeCache(opts.cacheFile, cache.body, opts.now())
        return { body: cache.body, source: "revalidated" }
      }
      if (res.status === 200) {
        const body = spec.parse(await res.json().catch(() => undefined))
        if (body) {
          await writeCache(opts.cacheFile, body, opts.now())
          return { body, source: "remote" }
        }
      }
      log.info("fetch not usable", { status: res.status })
      return fallback(res.status === 401 ? "signed-out" : "unavailable")
    }

    async function fetchWithTimeout(opts: Options, token: string, etag: string | undefined) {
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
        log.info("fetch failed", { error: String(err) })
        return undefined
      } finally {
        clearTimeout(timer)
      }
    }

    async function readCache(file: string): Promise<{ body: B; fetchedAt: number } | undefined> {
      try {
        const raw = JSON.parse(await fs.readFile(file, "utf8"))
        const body = spec.parse(raw)
        if (!body || typeof raw.fetchedAt !== "number") return undefined
        return { body, fetchedAt: raw.fetchedAt }
      } catch {
        return undefined
      }
    }

    async function writeCache(file: string, body: B, fetchedAt: number) {
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        const tmp = `${file}.${process.pid}.tmp`
        await fs.writeFile(tmp, JSON.stringify({ ...body, fetchedAt }), { mode: 0o600 })
        await fs.chmod(tmp, 0o600)
        await fs.rename(tmp, file)
      } catch (err) {
        log.warn("cache write failed", { error: String(err) })
      }
    }

    return {
      /** Test seam: inject the fetcher, token source, cache path, clock and timeout. */
      configure(input: Partial<Options>) {
        options = { ...options, ...input }
        loaded = undefined
      },
      reset() {
        options = spec.defaults()
        loaded = undefined
      },
      /** Memoised per process; never rejects. */
      load(): Promise<Result<B>> {
        if (!loaded)
          loaded = resolve(options).catch((err): Result<B> => {
            log.warn("resolution failed", { error: String(err) })
            return { body: undefined, source: "unavailable" }
          })
        return loaded
      },
    }
  }
}
