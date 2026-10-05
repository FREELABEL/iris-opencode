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
