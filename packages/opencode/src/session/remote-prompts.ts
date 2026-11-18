import path from "path"
import { Global } from "../global"
import { RemoteResource } from "../util/remote-resource"

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
 *
 * The fetch/cache mechanics live in util/remote-resource.ts, shared with RemoteCapabilities.
 */
export namespace RemotePrompts {
  export type Id =
    | "iris.identity"
    | "session.anthropic"
    | "session.qwen"
    | "session.beast"
    | "session.copilot-gpt-5"
    | "session.gemini"

  export type Fetcher = RemoteResource.Fetcher

  export const PATH = "/api/v1/cli/prompts"

  const defaults = (): RemoteResource.Options => ({
    fetcher: RemoteResource.irisFetcher(PATH),
    token: RemoteResource.irisToken("OPENCODE_DISABLE_REMOTE_PROMPTS"),
    cacheFile: path.join(Global.Path.cache, "cli-prompts.json"),
    now: () => Date.now(),
    timeoutMs: 1500,
  })

  const resource = RemoteResource.create({ service: "remote-prompts", parse, defaults })

  /** Test seam: inject the fetcher, token source, cache path and clock. */
  export function configure(input: Partial<RemoteResource.Options>) {
    resource.configure(input)
  }

  export function reset() {
    resource.reset()
  }

  /** The prompt text for `id`: remote/cached when available, otherwise `fallback`. */
  export async function get(id: Id, fallback: string): Promise<string> {
    const prompts = await load()
    const text = prompts[id]
    return typeof text === "string" && text.trim() ? text : fallback
  }

  /** All available remote prompts (possibly empty). Memoised per process; never rejects. */
  export async function load(): Promise<Record<string, string>> {
    return (await resource.load()).body?.prompts ?? {}
  }

  function parse(value: unknown): { version: string; prompts: Record<string, string> } | undefined {
    if (!value || typeof value !== "object") return undefined
    const { version, prompts } = value as Record<string, unknown>
    if (typeof version !== "string" || !prompts || typeof prompts !== "object" || Array.isArray(prompts)) return
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(prompts)) if (typeof v === "string") out[k] = v
    return { version, prompts: out }
  }
}
