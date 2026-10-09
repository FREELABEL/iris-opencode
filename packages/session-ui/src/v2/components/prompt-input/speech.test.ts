import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { setDictationAuth } from "./dictation"
import { createSpeechPlayer, fromPcm16 } from "./speech"

// Minimal stand-ins: a WebSocket that records what it was sent, and an AudioContext whose sources
// record when they were scheduled and end on demand.
class FakeSocket extends EventTarget {
  static all: FakeSocket[] = []
  static OPEN = 1
  static CONNECTING = 0
  readyState = 0
  binaryType = "blob"
  sent: string[] = []
  closed?: number
  onmessage: ((m: { data: unknown }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  constructor(public url: URL) {
    super()
    FakeSocket.all.push(this)
  }
  send(text: string) {
    this.sent.push(text)
  }
  close(code?: number) {
    this.closed = code ?? 1005
    this.readyState = 3
    this.onclose?.()
  }
  open() {
    this.readyState = 1
    this.dispatchEvent(new Event("open"))
  }
  receive(data: unknown) {
    this.onmessage?.({ data })
  }
}

class FakeSource {
  static all: FakeSource[] = []
  buffer?: { duration: number }
  at?: number
  stopped = false
  onended: (() => void) | null = null
  constructor() {
    FakeSource.all.push(this)
  }
  connect() {}
  start(at: number) {
    this.at = at
  }
  stop() {
    this.stopped = true
  }
}

class FakeAudioContext {
  currentTime = 10
  state = "running"
  destination = {}
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length)
    return { duration: length / rate, getChannelData: () => data }
  }
  createBufferSource() {
    return new FakeSource()
  }
  resume() {}
  close() {}
}

const g = globalThis as Record<string, unknown>
const saved = { WebSocket: g.WebSocket, AudioContext: g.AudioContext }
beforeEach(() => {
  FakeSocket.all = []
  FakeSource.all = []
  g.WebSocket = FakeSocket
  g.AudioContext = FakeAudioContext
})
afterEach(() => {
  g.WebSocket = saved.WebSocket
  g.AudioContext = saved.AudioContext
  setDictationAuth(undefined)
})

/** n samples of PCM16 (a 24 kHz chunk of n/24000 seconds). */
const pcm = (n: number) => new Uint8Array(n * 2).buffer

describe("speech player", () => {
  test("opens /voice/speak on the local server with the voice and the Basic token as auth_token", () => {
    setDictationAuth(() => ({ Authorization: "Basic c2VjcmV0" }))
    const player = createSpeechPlayer({ base: () => "http://127.0.0.1:4096/", voice: () => "ara" })
    player.speak("Hello.")
    const url = FakeSocket.all[0]!.url
    expect(url.protocol).toBe("ws:")
    expect(url.pathname).toBe("/voice/speak")
    expect(url.searchParams.get("voice")).toBe("ara")
    expect(url.searchParams.get("auth_token")).toBe("c2VjcmV0")
  })

  test("text sent before the socket opens is delivered in order once it does", () => {
    const player = createSpeechPlayer({ base: () => "http://127.0.0.1:4096" })
    player.speak("First.")
    player.speak("Second.")
    player.finish()
    const ws = FakeSocket.all[0]!
    expect(ws.sent).toEqual([])
    ws.open()
    expect(ws.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "text.delta", delta: "First. " },
      { type: "text.delta", delta: "Second. " },
      { type: "text.done" },
    ])
    expect(FakeSocket.all).toHaveLength(1)
  })

  test("audio chunks are scheduled back to back, and the player is idle only after the last one ends", () => {
    const states: string[] = []
    const player = createSpeechPlayer({ base: () => "http://h", onState: (s) => states.push(s) })
    player.speak("Hi.")
    const ws = FakeSocket.all[0]!
    ws.open()
    ws.receive(pcm(2400)) // 0.1 s
    ws.receive(pcm(4800)) // 0.2 s
    expect(FakeSource.all.map((s) => s.at)).toEqual([10, 10.1])
    ws.receive(JSON.stringify({ type: "done" }))
    expect(player.state()).toBe("speaking")
    FakeSource.all[0]!.onended?.()
    expect(player.state()).toBe("speaking")
    FakeSource.all[1]!.onended?.()
    expect(states).toEqual(["speaking", "idle"])
  })

  test("stop() silences playing audio and drops the socket so late audio cannot play", () => {
    const player = createSpeechPlayer({ base: () => "http://h" })
    player.speak("A long reply.")
    const ws = FakeSocket.all[0]!
    ws.open()
    ws.receive(pcm(2400))
    player.stop()
    expect(FakeSource.all[0]!.stopped).toBe(true)
    expect(ws.closed).toBe(1000)
    ws.receive(pcm(2400)) // in flight from the old reply
    expect(FakeSource.all).toHaveLength(1)
    expect(player.state()).toBe("idle")
    // The next reply gets a fresh socket.
    player.speak("Next.")
    expect(FakeSocket.all).toHaveLength(2)
  })

  test("an unavailable event is reported with its reason, and the next speak() tries again", () => {
    const seen: [string, string | undefined][] = []
    const player = createSpeechPlayer({ base: () => "http://h", onState: (s, r) => seen.push([s, r]) })
    player.speak("Hi.")
    FakeSocket.all[0]!.open()
    FakeSocket.all[0]!.receive(JSON.stringify({ type: "unavailable", reason: "Sign in to IRIS." }))
    expect(seen).toEqual([["unavailable", "Sign in to IRIS."]])
    player.speak("Again.")
    expect(FakeSocket.all).toHaveLength(2)
  })
})

test("fromPcm16 decodes little-endian samples", () => {
  const bytes = new Uint8Array([0x00, 0x40, 0x00, 0xc0, 0xff])
  expect(Array.from(fromPcm16(bytes))).toEqual([0.5, -0.5])
})
