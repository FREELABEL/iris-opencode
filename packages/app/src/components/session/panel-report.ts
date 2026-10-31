/**
 * Getting a panel report BACK to the engine (#191506). use-panel-control.ts decides what to say;
 * this decides how it gets there.
 *
 * The first version fired one POST and dropped it on any failure (`.catch(() => {})`, no look at
 * the status). An answer the engine never received read, on the agent's side, as "the user is
 * not looking at this session" while they were. Now an answer is CONFIRMED: a non-2xx or a
 * network failure is retried, and a request that has not completed in `attemptMs` is abandoned
 * and sent again — to the engine's OTHER loopback name (127.0.0.1 <-> localhost).
 *
 * WHY THE OTHER NAME. A webview keeps at most a handful of HTTP/1.1 connections per host (six in
 * WebKit and Chromium) and queues every further request to that host until one frees. The panel
 * holds several to the engine open for as long as it is up — the event stream, /iris/me/live,
 * /iris/atlas/:id/live — next to board reads that wait on fl-api for seconds. A report queued
 * behind them reaches the engine after its wait has ended. Both names reach the same engine (the
 * desktop allows both hosts, and its fetch wrapper adds the credential to both), but they are two
 * hosts to the connection pool, so the second try does not wait behind the first's queue.
 */

export const ATTEMPT_MS = 2_000
export const MAX_ATTEMPTS = 3

/** The engine's other loopback spelling, or undefined when `base` is not a loopback address. */
export function alternateLoopback(base: string): string | undefined {
  let u: URL
  try {
    u = new URL(base)
  } catch {
    return undefined
  }
  if (u.hostname === "127.0.0.1") u.hostname = "localhost"
  else if (u.hostname === "localhost") u.hostname = "127.0.0.1"
  else return undefined
  return u.toString().replace(/\/$/, "")
}

/**
 * POST `body` to `${base}/iris/panel/state` until the engine says 2xx. Returns whether it did.
 * Attempts alternate between `base` and its other loopback name.
 */
export async function deliverReport(
  doFetch: typeof globalThis.fetch,
  base: string,
  body: unknown,
  opts: { attemptMs?: number; attempts?: number } = {},
): Promise<boolean> {
  const primary = base.replace(/\/$/, "")
  const bases = [primary, alternateLoopback(primary)].filter((x): x is string => !!x)
  const attempts = opts.attempts ?? MAX_ATTEMPTS
  const json = JSON.stringify(body)
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), opts.attemptMs ?? ATTEMPT_MS)
    try {
      const res = await doFetch(`${bases[i % bases.length]}/iris/panel/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: json,
        signal: ctrl.signal,
      })
      if (res.ok) return true
    } catch {
      // Aborted (queued too long) or refused: the next attempt goes the other way.
    } finally {
      clearTimeout(timer)
    }
  }
  return false
}
