import path from "path"
import { Global } from "../../global"
import { RemoteResource } from "../../util/remote-resource"
import type { Entry } from "./platform-find"

/**
 * IP-07 phase 2 (#189850) — workspace playbooks and skills are PRIVATE prose. Up to v1.3.352 the
 * full lowercased text of 406 of them (3.8 MB) was folded into capabilities.json, which is
 * committed to a public repo and embedded in every public binary. They are now served by the
 * private IRIS API and merged into `iris find` at runtime for a signed-in user.
 * The committed index holds commands and how-tos only (guarded by capabilities-ip-guard.test.ts).
 *
 * Contract: GET {IRIS_API}/api/v1/cli/capabilities, Bearer auth
 *   200 → { version: "<12 hex>", entries: [ <capabilities.json entry>, … ] }, ETag: "<version>"
 *   If-None-Match: "<version>" → 304 · 401 when unauthenticated
 *
 * Same rules as RemotePrompts (util/remote-resource.ts): one fetch per process, ≤1500 ms,
 * 24 h cache at 0600, If-None-Match after that, stale cache when offline, no network without a
 * token, never throws into the command path.
 */
export namespace RemoteCapabilities {
  export type Fetcher = RemoteResource.Fetcher
  export type Source = RemoteResource.Source

  export const PATH = "/api/v1/cli/capabilities"

  const defaults = (): RemoteResource.Options => ({
    fetcher: RemoteResource.irisFetcher(PATH),
    token: RemoteResource.irisToken("OPENCODE_DISABLE_REMOTE_CAPABILITIES"),
    cacheFile: path.join(Global.Path.cache, "cli-capabilities.json"),
    now: () => Date.now(),
    timeoutMs: 1500,
  })

  const resource = RemoteResource.create({ service: "remote-capabilities", parse, defaults })

  /** Test seam: inject the fetcher, token source, cache path, clock and timeout. */
  export function configure(input: Partial<RemoteResource.Options>) {
    resource.configure(input)
  }

  export function reset() {
    resource.reset()
  }

  /** Workspace entries (possibly none) and where they came from. Memoised; never rejects. */
  export async function load(): Promise<{ entries: Entry[]; source: Source }> {
    const r = await resource.load()
    return { entries: r.body?.entries ?? [], source: r.source }
  }

  const str = (v: unknown): v is string => typeof v === "string"

  function entry(v: unknown): Entry | undefined {
    if (!v || typeof v !== "object") return undefined
    const e = v as Record<string, unknown>
    if (!str(e.kind) || !str(e.name) || !str(e.run) || !str(e.haystack)) return undefined
    if (!["command", "how-to", "playbook", "skill"].includes(e.kind)) return undefined
    const aliases = Array.isArray(e.aliases) ? e.aliases.filter(str) : []
    return {
      kind: e.kind as Entry["kind"],
      name: e.name,
      describe: str(e.describe) ? e.describe : "",
      aliases,
      run: e.run,
      haystack: e.haystack.toLowerCase(),
      ...(str(e.client) ? { client: e.client } : {}),
    }
  }

  function parse(value: unknown): { version: string; entries: Entry[] } | undefined {
    if (!value || typeof value !== "object") return undefined
    const { version, entries } = value as Record<string, unknown>
    if (typeof version !== "string" || !Array.isArray(entries)) return undefined
    return { version, entries: entries.map(entry).filter((e): e is Entry => !!e) }
  }
}
