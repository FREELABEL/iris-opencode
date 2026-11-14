/**
 * #193288 (second symptom) — `iris imessage send` printed "Resolved …" and then nothing while the
 * comms router waited on the bridge, with no cap on the wait. And a slow router that DID deliver
 * would have fallen through to a second, local send.
 *
 * A local HTTP server stands in for fl-api: slow, sent, and the daemon's real failure wording.
 * Nothing is sent anywhere.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"

let server: ReturnType<typeof Bun.serve>
let mode: "slow" | "sent" | "unconfirmed" | "failed" | "offline" = "sent"
let comms: typeof import("../src/cli/cmd/comms-send")

beforeAll(async () => {
  server = Bun.serve({
    port: 0,
    async fetch() {
      if (mode === "slow") {
        await Bun.sleep(2000)
        return Response.json({ data: { sent: true, channel: "imessage", comm_id: 1 } })
      }
      if (mode === "sent") return Response.json({ data: { sent: true, channel: "imessage", comm_id: 42 } })
      const error = {
        unconfirmed: "iMessage send failed: Message to +15550100123 is in Messages but not sent after 8s — it may still go out; check the conversation before retrying",
        failed: "iMessage send failed: Messages marked the message to +15550100123 NOT DELIVERED (error 22)",
        offline: "iMessage bridge not available — is the bridge running?",
      }[mode]
      return Response.json({ data: { sent: false, channel: "imessage", error } })
    },
  })
  process.env.IRIS_FL_API_URL = `http://localhost:${server.port}`
  process.env.IRIS_API_KEY = "test-key"
  comms = await import("../src/cli/cmd/comms-send")
})

afterAll(() => server.stop(true))

const send = (timeoutMs?: number) =>
  comms.routerSend({ toHandle: "+15550100123", channel: "imessage", message: "hi", timeoutMs })

describe("routerSend timeout", () => {
  test("a router slower than the cap returns timedOut instead of waiting forever", async () => {
    mode = "slow"
    const t0 = Date.now()
    const r = await send(300)
    expect(Date.now() - t0).toBeLessThan(1500)
    expect(r).toMatchObject({ ok: false, sent: false, timedOut: true })
    expect(comms.routerFailureKind(r)).toBe("unconfirmed")
  })

  test("a router inside the cap still succeeds", async () => {
    mode = "sent"
    expect(await send(2000)).toMatchObject({ ok: true, sent: true, commId: 42 })
  })
})

describe("routerFailureKind — when is a local fallback safe?", () => {
  test("daemon says it may still go out → unconfirmed (no second send)", async () => {
    mode = "unconfirmed"
    expect(comms.routerFailureKind(await send(2000))).toBe("unconfirmed")
  })

  test("daemon says NOT DELIVERED → failed (no local retry)", async () => {
    mode = "failed"
    expect(comms.routerFailureKind(await send(2000))).toBe("failed")
  })

  test("bridge offline (nothing attempted) → fallback", async () => {
    mode = "offline"
    expect(comms.routerFailureKind(await send(2000))).toBe("fallback")
  })

  test("API unreachable → fallback", () => {
    expect(comms.routerFailureKind({ ok: false, sent: false, error: "Could not reach the comms API: ECONNREFUSED" })).toBe("fallback")
  })

  test("every other daemon unconfirmed wording → unconfirmed", () => {
    for (const error of [
      "Handed to Messages for x but delivery could not be confirmed (r) — it may have been sent; check the conversation before retrying",
    ]) expect(comms.routerFailureKind({ ok: false, sent: false, error })).toBe("unconfirmed")
    expect(
      comms.routerFailureKind({ ok: false, sent: false, error: "Messages accepted the send but no message to x appeared in the conversation — NOT sent" }),
    ).toBe("failed")
  })
})
