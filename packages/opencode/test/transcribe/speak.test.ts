import { afterAll, describe, expect, test } from "bun:test"
import { openSpeakSession, type SpeakEvent } from "../../src/transcribe/speak"
import { decodeSpeakFrame } from "../../src/server/routes/instance/httpapi/transcribe"

// A stand-in for the IRIS voice relay's /v1/tts/stream: answers each text.delta with one audio
// chunk whose bytes spell the text, text.done with audio.done, and "FAIL" with a relay.error.
type Seen = { auth: string | null; query: URLSearchParams; received: unknown[] }
const seen: Seen[] = []
const relay = Bun.serve<Seen>({
  port: 0,
  fetch(req, server) {
    const s: Seen = { auth: req.headers.get("authorization"), query: new URL(req.url).searchParams, received: [] }
    seen.push(s)
    return server.upgrade(req, { data: s }) ? undefined : new Response("no", { status: 400 })
  },
  websocket: {
    message(ws, message) {
      const m = JSON.parse(String(message))
      ws.data.received.push(m)
      if (m.type === "text.delta" && m.delta === "FAIL")
        ws.send(JSON.stringify({ type: "relay.error", code: "x", message: "Upstream said no." }))
      else if (m.type === "text.delta") ws.send(JSON.stringify({ type: "audio.delta", delta: Buffer.from(m.delta).toString("base64") }))
      if (m.type === "text.done") ws.send(JSON.stringify({ type: "audio.done" }))
    },
  },
})
afterAll(() => relay.stop(true))

const cfg = () => ({ relayUrl: `http://127.0.0.1:${relay.port}`, token: "tok", bloqId: "42" }) as never

function run(script: (s: ReturnType<typeof openSpeakSession>) => void, until: (events: SpeakEvent[]) => boolean) {
  return new Promise<{ audio: string[]; events: SpeakEvent[] }>((resolve) => {
    const audio: string[] = []
    const events: SpeakEvent[] = []
    const session = openSpeakSession(cfg(), {
      voice: "ara",
      onAudio: (pcm) => audio.push(new TextDecoder().decode(pcm)),
      onEvent: (e) => {
        events.push(e)
        if (until(events)) (session.close(), resolve({ audio, events }))
      },
    })
    script(session)
  })
}

describe("spoken replies: sidecar -> relay", () => {
  test("text queued before the socket opens is sent in order, with the IRIS token, board and voice", async () => {
    const result = await run(
      (s) => {
        s.text("Hello. ")
        s.text("World.")
        s.done()
      },
      (e) => e.some((x) => x.type === "done"),
    )
    const last = seen.at(-1)!
    expect(last.auth).toBe("Bearer tok")
    expect(last.query.get("bloq_id")).toBe("42")
    expect(last.query.get("voice")).toBe("ara")
    expect(last.received).toEqual([
      { type: "text.delta", delta: "Hello. " },
      { type: "text.delta", delta: "World." },
      { type: "text.done" },
    ])
    expect(result.audio).toEqual(["Hello. ", "World."])
  })

  test("a relay error becomes one unavailable event with its message", async () => {
    const result = await run((s) => s.text("FAIL"), (e) => e.length > 0)
    expect(result.events).toEqual([{ type: "unavailable", reason: "Upstream said no." }])
  })
})

describe("speak socket frames from the window", () => {
  test("accepts text.delta / text.done / text.clear as text or bytes, rejects anything else", () => {
    expect(decodeSpeakFrame(JSON.stringify({ type: "text.delta", delta: "Hi." }))).toEqual({ type: "text.delta", delta: "Hi." })
    expect(decodeSpeakFrame(new TextEncoder().encode(JSON.stringify({ type: "text.done" })))).toEqual({ type: "text.done" })
    expect(decodeSpeakFrame(JSON.stringify({ type: "text.clear", extra: 1 }))).toEqual({ type: "text.clear" })
    expect(decodeSpeakFrame(JSON.stringify({ type: "text.delta", delta: 5 }))).toBeUndefined()
    expect(decodeSpeakFrame(JSON.stringify({ type: "session.update" }))).toBeUndefined()
    expect(decodeSpeakFrame("not json")).toBeUndefined()
  })
})
