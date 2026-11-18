import { describe, expect, test } from "bun:test"
import { parseRelayEvent } from "../../src/transcribe/live"
import { decodeLiveFrame } from "../../src/server/routes/instance/httpapi/transcribe"

describe("live dictation framing", () => {
  test("relay events map to partial / final / unavailable; anything else is ignored", () => {
    expect(parseRelayEvent(JSON.stringify({ type: "transcript.partial", text: "hey", is_final: false }))).toEqual({ type: "partial", text: "hey" })
    expect(parseRelayEvent(JSON.stringify({ type: "transcript.partial", text: "hey iris", is_final: true }))).toEqual({ type: "final", text: "hey iris" })
    expect(parseRelayEvent(JSON.stringify({ type: "relay.error", code: "idle", message: "stopped" }))).toEqual({ type: "unavailable", reason: "stopped" })
    expect(parseRelayEvent(JSON.stringify({ type: "transcript.created" }))).toBeUndefined()
    expect(parseRelayEvent("not json")).toBeUndefined()
  })

  test("client frames are told apart by their tag byte, not by text vs binary", () => {
    // Measured: the socket layer hands a text "audio.done" over as 21 bytes. Untagged, it was audio.
    expect(decodeLiveFrame(new Uint8Array([0x00, 1, 2, 3, 4]))).toEqual({ kind: "audio", pcm: new Uint8Array([1, 2, 3, 4]) })
    expect(decodeLiveFrame(new Uint8Array([0x01]))).toEqual({ kind: "finalize" })
    expect(decodeLiveFrame(new Uint8Array([0x02]))).toEqual({ kind: "done" })
    expect(decodeLiveFrame(new TextEncoder().encode(JSON.stringify({ type: "audio.done" })))).toBeUndefined()
    expect(decodeLiveFrame(new Uint8Array([0x00]))).toBeUndefined()
  })
})

describe("live dictation: a repeated final reaches the window once (#189546)", () => {
  test("a resend differing only in punctuation, case or spacing is dropped", async () => {
    const { openLiveSession } = await import("../../src/transcribe/live")
    const relay = Bun.serve({
      port: 0,
      fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no", { status: 400 })),
      websocket: {
        open(ws) {
          ws.send(JSON.stringify({ type: "transcript.partial", text: "I need to build a shopping list", is_final: false }))
          ws.send(JSON.stringify({ type: "transcript.partial", text: "I need to build a shopping list.", is_final: true }))
          ws.send(JSON.stringify({ type: "transcript.partial", text: " i need to build a shopping list", is_final: true }))
          ws.send(JSON.stringify({ type: "transcript.partial", text: "Eggs.", is_final: true }))
        },
        message() {},
      },
    })
    try {
      const finals = await new Promise<string[]>((resolve) => {
        const seen: string[] = []
        const session = openLiveSession({ relayUrl: `http://127.0.0.1:${relay.port}`, token: "t", bloqId: "1" } as never, {
          onEvent: (e) => {
            if (e.type === "final") seen.push(e.text)
            if (seen.at(-1) === "Eggs.") (session.close(), resolve(seen))
          },
        })
        setTimeout(() => resolve(seen), 3000)
      })
      expect(finals).toEqual(["I need to build a shopping list.", "Eggs."])
    } finally {
      relay.stop(true)
    }
  })
})
