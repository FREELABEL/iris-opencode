/**
 * Regression tests: `iris mail` must not lie about the bridge (#184151)
 *
 * Measured 2026-09-08 on a working laptop. The bridge was up and serving:
 *
 *   $ curl -s localhost:3200/health
 *   {"status":"online","paused":false,"pause_reason":null,"node_id":"019ff510-…",
 *    "node_name":"Alexs-MacBook-Pro-11711.local","running_tasks":0,"uptime_s":1125}
 *   $ lsof -ti :3200
 *   32505
 *
 * …and every `iris mail` command printed:
 *
 *   IRIS Bridge not running on localhost:3200. Start with: iris bridge start
 *
 * The check was `data?.status === "ok"`. The daemon says "online". So the allowlist
 * could never match a healthy bridge, and the CLI stated as fact something it had just
 * disproved — then prescribed starting a daemon that was already running.
 *
 * Exactly the family the doctor tests guard (#178281 billing_active, #178282 Gmail):
 * a health allowlist missing the healthy value, rendered as a confident negative.
 *
 * The second defect was collapsing: timeout, HTTP 503, refused connection and paused
 * all became the same "not running" sentence, so three of the four sent the reader to
 * a fix that could not work.
 */
import { describe, test, expect } from "bun:test"
import { bridgeHealthFrom } from "../../src/cli/cmd/bridge-health"

const URL = "http://localhost:3200"

// The literal body observed from the live daemon.
const LIVE_BODY = {
  status: "online",
  paused: false,
  pause_reason: null,
  node_id: "019ff510-f4c6-7281-ac9a-63b9c0835124",
  node_name: "Alexs-MacBook-Pro-11711.local",
  running_tasks: 0,
  persistent_processes: 0,
  ingest_buffer: 0,
  uptime_s: 1125,
}

describe("bridge health (#184151)", () => {
  test("the REAL daemon body reports healthy", () => {
    // This is the whole regression: status "online", not "ok".
    const h = bridgeHealthFrom({ kind: "response", status: 200, body: LIVE_BODY }, URL)
    expect(h.ok).toBe(true)
    expect(h.state).toBe("healthy")
    expect(h.message).toBe("")
  })

  test("every serving synonym counts as healthy", () => {
    for (const status of ["ok", "online", "healthy", "ready", "up", "running"]) {
      expect(bridgeHealthFrom({ kind: "response", status: 200, body: { status } }, URL).ok).toBe(true)
    }
  })

  test("a healthy bridge is never told to start itself", () => {
    const h = bridgeHealthFrom({ kind: "response", status: 200, body: LIVE_BODY }, URL)
    expect(h.message).not.toContain("iris bridge start")
  })

  test("only a genuinely unreachable socket suggests `iris bridge start`", () => {
    const unreachable = bridgeHealthFrom({ kind: "network", error: "ECONNREFUSED" }, URL)
    expect(unreachable.ok).toBe(false)
    expect(unreachable.state).toBe("unreachable")
    expect(unreachable.message).toContain("iris bridge start")

    // …and the three states that are NOT a stopped daemon must not say it.
    for (const probe of [
      { kind: "timeout" as const },
      { kind: "response" as const, status: 503, body: {} },
      { kind: "response" as const, status: 200, body: { status: "online", paused: true, pause_reason: "manual" } },
    ]) {
      const h = bridgeHealthFrom(probe, URL)
      expect(h.ok).toBe(false)
      expect(h.message).not.toContain("iris bridge start")
    }
  })

  test("a timeout is not reported as a stopped daemon", () => {
    const h = bridgeHealthFrom({ kind: "timeout" }, URL)
    expect(h.state).toBe("unresponsive")
    expect(h.transient).toBe(true)
    expect(h.message).toContain("NOT proof it is stopped")
  })

  test("an HTTP fault says the bridge IS running", () => {
    const h = bridgeHealthFrom({ kind: "response", status: 503, body: {} }, URL)
    expect(h.state).toBe("http_error")
    expect(h.message).toContain("IS running")
  })

  test("paused is its own state and names the reason", () => {
    const h = bridgeHealthFrom(
      { kind: "response", status: 200, body: { status: "online", paused: true, pause_reason: "battery saver" } },
      URL,
    )
    expect(h.state).toBe("paused")
    expect(h.message).toContain("battery saver")
    expect(h.message).toContain("iris bridge resume")
  })

  test("an unrecognised status reports the value instead of guessing", () => {
    const h = bridgeHealthFrom({ kind: "response", status: 200, body: { status: "degraded" } }, URL)
    expect(h.state).toBe("unknown_status")
    expect(h.ok).toBe(false)
    expect(h.message).toContain("degraded")
    // It is reachable — saying it is stopped would be the original bug again.
    expect(h.message).not.toContain("not reachable")
  })

  test("the message names the CONFIGURED url, not a hardcoded localhost:3200", () => {
    // BRIDGE_URL / BRIDGE_PORT are configurable, but all four messages hardcoded
    // localhost:3200 — so a client on a custom port was told to check the wrong host.
    const custom = "http://127.0.0.1:9999"
    const h = bridgeHealthFrom({ kind: "network", error: "ECONNREFUSED" }, custom)
    expect(h.message).toContain(custom)
    expect(h.message).not.toContain("3200")
  })

  test("transient failures are marked retryable; verdicts are not", () => {
    expect(bridgeHealthFrom({ kind: "timeout" }, URL).transient).toBe(true)
    expect(bridgeHealthFrom({ kind: "network", error: "EAI_AGAIN" }, URL).transient).toBe(true)
    expect(bridgeHealthFrom({ kind: "response", status: 503, body: {} }, URL).transient).toBe(true)
    // A paused bridge is a decision, not a blip — retrying it just wastes time.
    expect(
      bridgeHealthFrom({ kind: "response", status: 200, body: { status: "online", paused: true } }, URL).transient,
    ).toBe(false)
  })
})

// ============================================================================
// The heal path, tested by INJECTING faults rather than asserting it works.
//
// `prove-it-heals`: "recovery happened" and "the heal path worked" are different
// claims, and a mechanism with no distinguishing signal should be treated as absent.
// So the retry carries `healed`, and these tests fail if it ever stops firing —
// or starts claiming success over a fault that never cleared.
// ============================================================================

import { probeWithHeal, type BridgeProbe } from "../../src/cli/cmd/bridge-health"

const LIVE = { kind: "response" as const, status: 200, body: LIVE_BODY }

/** A probe that fails `failFirst` times the way a waking laptop does, then serves. */
function flaky(failFirst: number, fault: BridgeProbe) {
  let calls = 0
  const fn = async (_timeoutMs: number): Promise<BridgeProbe> => {
    calls++
    return calls <= failFirst ? fault : LIVE
  }
  return { fn, calls: () => calls }
}

describe("bridge self-heal (#184151, prove-it-heals)", () => {
  const fast = { backoffMs: 1 }

  test("a transient 503 heals on retry, and SAYS it healed", async () => {
    const p = flaky(1, { kind: "response", status: 503, body: {} })
    const h = await probeWithHeal(p.fn, URL, fast)
    expect(h.ok).toBe(true)
    expect(h.attempts).toBe(2)
    expect(h.healed).toBe(true)
    expect(p.calls()).toBe(2)
  })

  test("a transient timeout heals on retry", async () => {
    const p = flaky(1, { kind: "timeout" })
    const h = await probeWithHeal(p.fn, URL, fast)
    expect(h.ok).toBe(true)
    expect(h.healed).toBe(true)
  })

  test("a transient network blip heals on retry — the DNS case", async () => {
    // getaddrinfo ENOTFOUND while the laptop wakes. Used to surface as a flat
    // "not running" and send people to restart a healthy daemon.
    const p = flaky(1, { kind: "network", error: "getaddrinfo ENOTFOUND" })
    const h = await probeWithHeal(p.fn, URL, fast)
    expect(h.ok).toBe(true)
    expect(h.healed).toBe(true)
  })

  test("FALSE HEAL GUARD — a persistent fault never reports success", async () => {
    // The metric that matters: recoveries that report green over a real fault.
    const p = flaky(99, { kind: "response", status: 503, body: {} })
    const h = await probeWithHeal(p.fn, URL, fast)
    expect(h.ok).toBe(false)
    expect(h.healed).toBe(false)
    expect(h.attempts).toBe(2)
  })

  test("a healthy bridge is not retried — the heal path stays quiet", async () => {
    const p = flaky(0, { kind: "timeout" })
    const h = await probeWithHeal(p.fn, URL, fast)
    expect(h.ok).toBe(true)
    expect(h.attempts).toBe(1)
    expect(h.healed).toBe(false)
    expect(p.calls()).toBe(1)
  })

  test("a NON-transient verdict is not retried — retrying a decision wastes time", async () => {
    const p = flaky(99, { kind: "response", status: 200, body: { status: "online", paused: true } })
    const h = await probeWithHeal(p.fn, URL, fast)
    expect(h.ok).toBe(false)
    expect(h.state).toBe("paused")
    expect(h.attempts).toBe(1)
    expect(p.calls()).toBe(1)
  })
})
