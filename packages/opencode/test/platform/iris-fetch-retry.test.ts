/**
 * fetchWithRetry — transient-network retry for the iris API layer (#178675)
 *
 * `iris hive nodes list` hard-failed with code "ConnectionRefused" while the endpoint was
 * demonstrably reachable (curl to the same URL returned 401 — DNS resolved, TCP connected,
 * TLS completed, the app answered), and a re-run ~60s later succeeded with 11 nodes.
 * irisFetch did a bare `await fetch(...)` with no retry, so one blip killed the command.
 * Transient failures are normal on the Hive rails (mesh VPN, remote nodes).
 *
 * The retry is deliberately narrow, and these tests pin BOTH halves of that narrowness.
 * The SAFETY half matters more than the resilience half: this helper backs every iris
 * command, including `bug report`, `bloqs add-item` and program checkout — silently
 * replaying a POST could file a duplicate bug, duplicate a bloq item, or open a second
 * Stripe checkout session.
 *
 * fetchWithRetry takes its fetch and sleep as parameters rather than relying on a patched
 * global. That also keeps the backoff schedule assertable without sleeping through it.
 */
import { describe, test, expect } from "bun:test"
import { fetchWithRetry } from "../../src/cli/cmd/iris-api"

/** Bun-shaped network error: note errno 0 ("no error") beside a ConnectionRefused label. */
function networkError(): Error {
  const err = new Error("Unable to connect. Is the computer able to access the url?") as Error & {
    code?: string
    errno?: number
  }
  err.code = "ConnectionRefused"
  err.errno = 0
  return err
}

/**
 * A fetch stub that throws `failures` times, then returns 200.
 *
 * NOTE: do NOT use `Object.assign(fn, { get calls() {...} })` here — Object.assign copies
 * the getter's VALUE at assign time (0), not the getter, so the counter reads 0 forever
 * and every assertion silently passes/fails on stale data. Mutate a field instead.
 */
function failingFetch(failures: number) {
  const state = { calls: 0 }
  const fn = async (): Promise<Response> => {
    state.calls++
    if (state.calls <= failures) throw networkError()
    return new Response(JSON.stringify({ ok: true }), { status: 200 })
  }
  fn.state = state
  return fn as typeof fn & { state: { calls: number } }
}

/** No real waiting — the backoff schedule is asserted, not slept through. */
function recordingSleep() {
  const waited: number[] = []
  const fn = async (ms: number) => {
    waited.push(ms)
  }
  return Object.assign(fn, { waited })
}

describe("fetchWithRetry (#178675)", () => {
  test("retries a GET through transient failures and succeeds", async () => {
    const stub = failingFetch(2)
    const sleep = recordingSleep()

    const res = await fetchWithRetry("https://example.test/api/v6/nodes/", { method: "GET" }, stub, sleep)

    expect(res.status).toBe(200)
    expect(stub.state.calls).toBe(3) // 2 failures + 1 success
    expect(sleep.waited).toEqual([400, 800]) // bounded, increasing backoff
  })

  test("a GET that never recovers gives up after 3 attempts with a network-failure message", async () => {
    const stub = failingFetch(99)
    const sleep = recordingSleep()

    let message = ""
    try {
      await fetchWithRetry("https://example.test/api/v6/nodes/", { method: "GET" }, stub, sleep)
    } catch (e) {
      message = e instanceof Error ? e.message : String(e)
    }

    expect(stub.state.calls).toBe(3) // bounded — does not loop forever

    // The framing is the fix. Previously the user saw only Bun's raw
    // "ConnectionRefused / Is the computer able to access the url?", which reads as
    // "the host is down" and sends you off checking DNS and firewalls. Now the message
    // LEADS with what actually happened — the request could not be completed, and it was
    // already retried — and keeps the raw driver text afterwards as debugging detail.
    expect(message.startsWith("Network request to https://example.test/api/v6/nodes/ failed after 3 attempts:")).toBe(
      true,
    )
    // The underlying detail is deliberately preserved, not scrubbed.
    expect(message).toContain("Unable to connect")
  })

  test("SAFETY: a POST is never retried — no duplicate writes", async () => {
    const stub = failingFetch(1) // would succeed on attempt 2 if it retried
    const sleep = recordingSleep()

    let threw = false
    try {
      await fetchWithRetry("https://example.test/api/v1/bugs", { method: "POST", body: "{}" }, stub, sleep)
    } catch {
      threw = true
    }

    expect(threw).toBe(true)
    // If this ever reads > 1, a failed `bug report` / `bloqs add-item` / checkout
    // could be silently duplicated.
    expect(stub.state.calls).toBe(1)
    expect(sleep.waited).toEqual([]) // never even backs off
  })

  test("SAFETY: PUT, PATCH and DELETE are not retried either", async () => {
    for (const method of ["PUT", "PATCH", "DELETE"]) {
      const stub = failingFetch(1)
      try {
        await fetchWithRetry("https://example.test/api/v1/thing/1", { method }, stub, recordingSleep())
      } catch {
        /* expected */
      }
      expect(stub.state.calls).toBe(1)
    }
  })

  test("SAFETY: an HTTP error status is returned, never retried", async () => {
    let calls = 0
    const stub = async (): Promise<Response> => {
      calls++
      return new Response(JSON.stringify({ message: "Unauthorized" }), { status: 401 })
    }

    const res = await fetchWithRetry("https://example.test/api/v6/nodes/", { method: "GET" }, stub, recordingSleep())

    expect(res.status).toBe(401)
    // 401 is a real answer from the server. Retrying would mask a genuine auth failure —
    // and 401 is exactly what the reachable endpoint returned during the incident.
    expect(calls).toBe(1)
  })

  test("defaults to GET semantics when no method is given", async () => {
    const stub = failingFetch(1)
    const res = await fetchWithRetry("https://example.test/api/v6/nodes/", {}, stub, recordingSleep())
    expect(res.status).toBe(200)
    expect(stub.state.calls).toBe(2)
  })
})
