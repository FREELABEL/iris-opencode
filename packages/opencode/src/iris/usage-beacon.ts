import { existsSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"

/**
 * The desktop app's usage beacon (#186171).
 *
 * The CLI has had a beacon (telemetry/beacon.ts on main) for months; this branch had none, so
 * the desktop app — where most people now use IRIS — reported nothing at all. This is the
 * smallest honest port: one event, `app_open`, sent when the desktop starts its engine.
 *
 * Same rules as the CLI, deliberately, so one switch covers both apps:
 *   - off with IRIS_TELEMETRY=0, DO_NOT_TRACK=1, or `iris telemetry off` (~/.iris/telemetry.json,
 *     the file the CLI writes);
 *   - names and counts only — no arguments, paths or content;
 *   - no analytics SDK or token here. It posts to our own ingest, which forwards to Mixpanel
 *     server-side when that is switched on.
 * Fire-and-forget, 3 s timeout, never throws: telemetry must never break the app.
 */
export namespace UsageBeacon {
  const falsy = (v: string | undefined) => v !== undefined && ["0", "off", "false", "no"].includes(v.trim().toLowerCase())
  const truthy = (v: string | undefined) => v !== undefined && ["1", "true", "yes", "on"].includes(v.trim().toLowerCase())

  export function enabled(env: NodeJS.ProcessEnv = process.env, home = homedir()): boolean {
    if (falsy(env.IRIS_TELEMETRY) || truthy(env.DO_NOT_TRACK)) return false
    try {
      const p = join(home, ".iris", "telemetry.json")
      if (existsSync(p) && JSON.parse(readFileSync(p, "utf8"))?.enabled === false) return false
    } catch {}
    return true
  }

  export async function send(
    eventType: "app_open",
    opts: { token: string | null; apiBase: string; version: string; env?: NodeJS.ProcessEnv; home?: string; fetchImpl?: typeof fetch },
  ): Promise<boolean> {
    try {
      if (!enabled(opts.env, opts.home) || !opts.token) return false
      const res = await (opts.fetchImpl ?? fetch)(`${opts.apiBase}/api/v6/telemetry/errors`, {
        method: "POST",
        headers: { Authorization: `Bearer ${opts.token}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          cli_version: opts.version,
          os: process.platform,
          events: [{ source: "desktop", event_type: eventType, severity: "info" }],
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null)
      return !!res?.ok
    } catch {
      return false
    }
  }
}
