/**
 * Bridge health verdicts — a pure module, deliberately free of imports so it can be
 * unit-tested without booting the CLI. See bridge-health-truthfulness.test.ts (#184151).
 */

/** What a single probe of the bridge produced. Kept separate from the verdict so the
 *  verdict is a pure function and can be tested without a socket. */
export type BridgeProbe =
  | { kind: "response"; status: number; body?: any }
  | { kind: "timeout" }
  | { kind: "network"; error: string }

export type BridgeState =
  | "healthy"
  | "paused"
  | "unresponsive"
  | "unreachable"
  | "http_error"
  | "unknown_status"

export interface BridgeHealth {
  ok: boolean
  state: BridgeState
  message: string
  /** True when another attempt could plausibly succeed — a blip, not a verdict. */
  transient: boolean
  /** How many probes it took. 1 = answered first time. */
  attempts?: number
  /**
   * A retry rescued this call: probe 1 failed transiently, probe 2 succeeded.
   *
   * This field exists because a heal with no signal is indistinguishable from a heal that
   * silently stopped working — `prove-it-heals` treats such a mechanism as ABSENT, and it
   * is right to. Without this the retry would look exactly like "it just worked", so we
   * could never tell a recovering bridge from a healthy one, nor notice the day the retry
   * regressed.
   */
  healed?: boolean
}

/**
 * The bridge's own health vocabulary. This check used to be `status === "ok"`, and the
 * daemon has never said "ok" — a live bridge reports {"status":"online"}. So every mail
 * command on every machine printed "IRIS Bridge not running on localhost:3200" over a
 * bridge that was running, and told the user to start something already started (#184151).
 *
 * Same family as #178281/#178282: a health check whose allowlist did not include the
 * healthy value, reported as a confident fact about the user's machine.
 */
const SERVING_STATUS = new Set(["ok", "online", "healthy", "ready", "up", "running"])

/**
 * Turn one probe into a verdict. Never collapses distinct failures into "not running":
 * a timeout, a 503 and a refused connection are three different problems with three
 * different fixes, and only the last one is fixed by `iris bridge start`.
 */
export function bridgeHealthFrom(probe: BridgeProbe, url: string): BridgeHealth {
  if (probe.kind === "timeout") {
    return {
      ok: false,
      state: "unresponsive",
      transient: true,
      message: `IRIS Bridge at ${url} did not answer /health in time. It may be starting up or busy — this is NOT proof it is stopped, so check with: iris bridge status`,
    }
  }

  if (probe.kind === "network") {
    return {
      ok: false,
      state: "unreachable",
      // DNS/refused can both be a blip (laptop waking, VPN flapping) — worth one retry
      // before telling someone their daemon is down.
      transient: true,
      message: `IRIS Bridge is not reachable at ${url} (${probe.error}). Start it with: iris bridge start`,
    }
  }

  if (probe.status < 200 || probe.status >= 300) {
    return {
      ok: false,
      state: "http_error",
      transient: probe.status >= 500,
      message: `IRIS Bridge answered ${url}/health with HTTP ${probe.status}. It IS running — this is a bridge fault, not a stopped daemon. Check: iris bridge status`,
    }
  }

  const status = String(probe.body?.status ?? "").toLowerCase()

  if (probe.body?.paused === true) {
    const why = probe.body?.pause_reason ? ` (${probe.body.pause_reason})` : ""
    return {
      ok: false,
      state: "paused",
      transient: false,
      message: `IRIS Bridge at ${url} is running but PAUSED${why}. Resume it with: iris bridge resume`,
    }
  }

  if (SERVING_STATUS.has(status)) {
    return { ok: true, state: "healthy", transient: false, message: "" }
  }

  // Reachable, 200, but a status we do not recognise. Report what it actually said
  // rather than guessing — an unknown value is not evidence the daemon is stopped.
  return {
    ok: false,
    state: "unknown_status",
    transient: false,
    message: `IRIS Bridge at ${url} answered /health with an unrecognised status ${JSON.stringify(probe.body?.status ?? null)}. The daemon is reachable; this CLI may be older than the bridge. Check: iris bridge status`,
  }
}


/**
 * The heal path itself, kept pure so it can be tested against injected faults rather than
 * asserted. `probe` is the only IO; everything else is decision.
 *
 * One retry, only on a transient verdict. `prove-it-heals`: the mechanism must emit a
 * distinguishing signal when it fires (`healed`), and must NOT report success when the
 * fault persists.
 */
export async function probeWithHeal(
  probe: (timeoutMs: number) => Promise<BridgeProbe>,
  url: string,
  opts: { firstTimeoutMs?: number; retryTimeoutMs?: number; backoffMs?: number } = {},
): Promise<BridgeHealth> {
  const { firstTimeoutMs = 3000, retryTimeoutMs = 6000, backoffMs = 400 } = opts

  const first = bridgeHealthFrom(await probe(firstTimeoutMs), url)
  if (first.ok || !first.transient) return { ...first, attempts: 1, healed: false }

  await new Promise((r) => setTimeout(r, backoffMs))
  const second = bridgeHealthFrom(await probe(retryTimeoutMs), url)
  return { ...second, attempts: 2, healed: second.ok }
}
