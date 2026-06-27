import { Auth } from "../auth"

/**
 * Client error beacon → fl-iris-api POST /api/v6/telemetry/errors.
 *
 * The client half of per-client telemetry (server side: ClientTelemetryService +
 * TelemetryController). Reports CLI errors so we can see "is it working for THIS
 * client", not just aggregate logs. The server attributes the event to the user
 * via the iris token.
 *
 * Rules: best-effort, fire-and-forget, NEVER throws, NEVER blocks meaningfully
 * (3s timeout). Telemetry must never break the CLI.
 */
export namespace Beacon {
  export type EventType = "cli_uncaught" | "cli_command_error" | "cli_request_error"

  export interface Event {
    message?: string
    command?: string
    status_code?: number
    provider?: string
    model?: string
    context?: Record<string, unknown>
  }

  function baseUrl(): string {
    // Mirror the proxy's base resolution (provider.ts) so beacon + chat agree.
    return process.env.IRIS_API_URL ?? process.env.IRIS_LOCAL_URL ?? "https://freelabel.net"
  }

  function clip(s: string | undefined, n: number): string | undefined {
    if (s === undefined) return undefined
    return s.length > n ? s.slice(0, n) : s
  }

  /**
   * Send a telemetry event. Returns true if the POST was accepted, false otherwise.
   * Awaitable so callers on an exit path can flush before process.exit().
   */
  export async function report(eventType: EventType, event: Event = {}): Promise<boolean> {
    try {
      const auth = await Auth.get("iris")
      const key = (auth as { key?: string } | undefined)?.key
      if (!key) return false // no iris token → nothing to attribute, skip silently

      const res = await fetch(`${baseUrl()}/api/v6/telemetry/errors`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          source: "cli",
          event_type: eventType,
          message: clip(event.message, 2000),
          command: clip(event.command, 128),
          status_code: event.status_code,
          provider: event.provider,
          model: event.model,
          context: event.context,
        }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => null)

      return !!res?.ok
    } catch {
      return false // never throw — telemetry must not break the CLI
    }
  }
}
