import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import {
  isPersonToken,
  livePreviewLine,
  parseRelayEvent,
  resolveLiveConfig,
  startLivePreview,
  type LiveConfig,
} from "../../src/cli/lib/live-dictation"
import { captureArgs, spawnCapture } from "../../src/cli/lib/mic"

/**
 * Live dictation (epic #188304, S2). The preview is only worth anything if words ARRIVE while
 * you speak, and it is only safe if it can never cost the recording or slip past the STT policy.
 * So these run against a real WebSocket relay stand-in, and the "recording unaffected" case runs
 * a real ffmpeg with the tap attached.
 */

const TOKEN = "iris_" + "a".repeat(24)

type Seen = { auth: string | null; url: string; audioBytes: number; texts: string[] }
const connections: Seen[] = []

/** Speaks the relay protocol: once audio arrives, plays back a scripted run of partials. */
let relay: ReturnType<typeof Bun.serve>
let relayUrl = ""

const SCRIPT = [
  { type: "transcript.created" },
  { type: "transcript.partial", text: "hey", is_final: false },
  { type: "transcript.partial", text: "hey ir", is_final: false },
  { type: "transcript.partial", text: "hey iris", is_final: false },
  { type: "transcript.partial", text: "hey iris", is_final: true },
  // xAI has been seen repeating a final. Rendered twice, the preview would read "hey iris hey iris".
  { type: "transcript.partial", text: "hey iris", is_final: true },
  { type: "transcript.partial", text: "open the", is_final: false },
]

beforeAll(() => {
  relay = Bun.serve({
    port: 0,
    fetch(req, server) {
      const seen: Seen = { auth: req.headers.get("authorization"), url: req.url, audioBytes: 0, texts: [] }
      connections.push(seen)
      if (server.upgrade(req, { data: seen })) return
      return new Response("upgrade required", { status: 426 })
    },
    websocket: {
      message(ws, message) {
        const seen = ws.data as Seen
        if (typeof message === "string") {
          seen.texts.push(message)
          if (message.includes("audio.done")) ws.close(1000, "done")
          return
        }
        const first = seen.audioBytes === 0
        seen.audioBytes += message.byteLength
        // Partials are a RESPONSE to audio. If the PCM never reaches the relay, nothing comes back
        // and the assertions below time out — which is the failure this test exists to catch.
        if (first) for (const frame of SCRIPT) ws.send(JSON.stringify(frame))
      },
    },
  })
  relayUrl = `http://127.0.0.1:${relay.port}`
})

afterAll(() => {
  relay?.stop(true)
})

const config = (url = relayUrl): LiveConfig => ({ relayUrl: url, token: TOKEN, bloqId: "571" })

async function until(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await Bun.sleep(10)
  }
  return check()
}

/** 100 ms of 16 kHz mono PCM16. */
const pcm = (ms = 100) => new Uint8Array((16000 * 2 * ms) / 1000).fill(1)

describe("live preview against a relay", () => {
  test("cumulative partials render as the LATEST, and a repeated final is dropped", async () => {
    const before = connections.length
    const shown: string[] = []
    const preview = startLivePreview({ resolve: async () => ({ config: config() }), onText: (t) => shown.push(t) })
    // Audio pushed once the socket is up — the steady state while someone talks. (Audio pushed
    // BEFORE the session exists takes a different path, covered by the next test.)
    expect(await until(() => connections.length > before)).toBe(true)
    preview.push(pcm())

    const arrived = await until(() => preview.text() === "hey iris open the")
    expect(arrived).toBe(true)
    expect(preview.state()).toBe("live")

    // Cumulative: each partial REPLACES the utterance so far rather than appending to it.
    expect(shown.slice(0, 3)).toEqual(["hey", "hey ir", "hey iris"])
    // Final locked once; its duplicate produced no update and no second copy.
    expect(shown).toEqual(["hey", "hey ir", "hey iris", "hey iris", "hey iris open the"])
    expect(preview.text().match(/hey iris/g)?.length).toBe(1)

    // What the relay saw: the person's token, the board, and the audio itself.
    const seen = connections[before]!
    expect(seen.auth).toBe(`Bearer ${TOKEN}`)
    const url = new URL(seen.url)
    expect(url.pathname).toBe("/v1/stt/stream")
    expect(url.searchParams.get("bloq_id")).toBe("571")
    expect(seen.audioBytes).toBe(pcm().byteLength)

    preview.stop()
    expect(await until(() => seen.texts.some((t) => t.includes("audio.done")))).toBe(true)
  })

  test("PCM pushed while the session is still being configured is delivered, sample-aligned", async () => {
    const before = connections.length
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const preview = startLivePreview({
      resolve: async () => {
        await gate
        return { config: config() }
      },
    })
    // An odd-length chunk: a pipe can split a sample. The odd byte must wait for its partner.
    preview.push(new Uint8Array(3).fill(1))
    preview.push(new Uint8Array(1).fill(1))
    release()
    expect(await until(() => preview.text().length > 0)).toBe(true)
    expect(connections[before]!.audioBytes).toBe(4)
    preview.stop()
  })

  test("relay unreachable -> unavailable, pushes keep being accepted, nothing throws", async () => {
    // A port with nothing listening on it.
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") })
    const deadUrl = `http://127.0.0.1:${dead.port}`
    dead.stop(true)

    const reasons: Array<[string, string]> = []
    const preview = startLivePreview({
      resolve: async () => ({ config: config(deadUrl) }),
      onUnavailable: (reason, phase) => reasons.push([reason, phase]),
    })
    for (let i = 0; i < 50; i++) preview.push(pcm(20))
    expect(await until(() => preview.state() === "unavailable")).toBe(true)
    for (let i = 0; i < 50; i++) expect(() => preview.push(pcm(20))).not.toThrow()
    expect(() => preview.stop()).not.toThrow()
    expect(reasons.length).toBe(1)
    expect(reasons[0]![1]).toBe("stream")
    expect(preview.text()).toBe("")
  })

  test("a relay that refuses the upgrade (e.g. 401) is unavailable, not an error", async () => {
    const refusing = Bun.serve({ port: 0, fetch: () => new Response("no", { status: 401 }) })
    const preview = startLivePreview({ resolve: async () => ({ config: config(`http://127.0.0.1:${refusing.port}`) }) })
    preview.push(pcm())
    expect(await until(() => preview.state() === "unavailable")).toBe(true)
    refusing.stop(true)
  })
})

describe("the STT policy is the ceiling", () => {
  const dir = mkdtempSync(join(tmpdir(), "iris-live-"))
  const configPath = join(dir, "config.json")
  writeFileSync(configPath, JSON.stringify({ default_bloq_id: 571 }))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  test("policy local-only (sovereign) -> no socket is opened, no token is even read", async () => {
    const before = connections.length
    let tokenReads = 0
    const reasons: Array<[string, string]> = []
    const preview = startLivePreview({
      resolve: () =>
        resolveLiveConfig({
          env: { IRIS_STT_RELAY_URL: relayUrl },
          policy: "sovereign",
          configPath,
          token: async () => {
            tokenReads++
            return TOKEN
          },
        }),
      onUnavailable: (reason, phase) => reasons.push([reason, phase]),
    })
    for (let i = 0; i < 10; i++) preview.push(pcm())
    expect(await until(() => preview.state() === "unavailable")).toBe(true)
    await Bun.sleep(100)
    expect(connections.length).toBe(before)
    expect(tokenReads).toBe(0)
    expect(reasons).toEqual([[expect.stringContaining("sovereign"), "setup"]])
  })

  test("no policy set at all is standard, so live is ON by default — as on Desktop (#187808)", async () => {
    const saved = process.env.IRIS_TRANSCRIPTION_POLICY
    delete process.env.IRIS_TRANSCRIPTION_POLICY
    try {
      // The fixture config names board 571, and a configured board wins over the platform's pick.
      const r = await resolveLiveConfig({ env: { IRIS_STT_RELAY_URL: "http://relay.test" }, configPath, token: async () => TOKEN, board: async () => "77" })
      expect("config" in r && r.config.bloqId).toBe("571")
    } finally {
      if (saved !== undefined) process.env.IRIS_TRANSCRIPTION_POLICY = saved
    }
  })

  test("no board configured: asks the platform for the person's own board, as Desktop does", async () => {
    const asked: string[] = []
    const r = await resolveLiveConfig({
      env: { IRIS_STT_RELAY_URL: "http://relay.test" },
      policy: "standard",
      configPath: "/nonexistent/config.json",
      token: async () => TOKEN,
      board: async (t) => (asked.push(t), "4242"),
    })
    expect(asked).toEqual([TOKEN])
    expect("config" in r && r.config.bloqId).toBe("4242")
  })

  test("no board configured and the platform cannot name one -> unavailable, not unscoped", async () => {
    const r = await resolveLiveConfig({
      env: { IRIS_STT_RELAY_URL: "http://relay.test" },
      policy: "standard",
      configPath: "/nonexistent/config.json",
      token: async () => TOKEN,
      board: async () => undefined,
    })
    expect("reason" in r).toBe(true)
  })

  test("standard policy + person token + board -> configured", async () => {
    const r = await resolveLiveConfig({
      env: { IRIS_STT_RELAY_URL: relayUrl + "/" },
      policy: "standard",
      configPath,
      token: async () => TOKEN,
    })
    expect(r).toEqual({ config: { relayUrl, token: TOKEN, bloqId: "571" } })
  })

  test("either switch turns it off, even under standard", async () => {
    for (const env of [{ IRIS_STT_RELAY_URL: "off" }, { IRIS_LIVE_DICTATION: "0" }, { IRIS_LIVE_DICTATION: "false" }]) {
      const r = await resolveLiveConfig({ env, policy: "standard", configPath, token: async () => TOKEN })
      expect("reason" in r).toBe(true)
    }
  })

  test("a node_api_key is never sent as a person; a missing board is refused", async () => {
    expect(isPersonToken("nk_" + "x".repeat(20))).toBe(false)
    expect(isPersonToken(TOKEN)).toBe(true)
    const node = await resolveLiveConfig({ env: {}, policy: "standard", configPath, token: async () => "node-key-123" })
    expect("reason" in node).toBe(true)
    const noBoard = await resolveLiveConfig({
      env: {},
      policy: "standard",
      configPath: join(dir, "missing.json"),
      token: async () => TOKEN,
    })
    expect("reason" in noBoard).toBe(true)
  })
})

describe("relay framing and rendering", () => {
  test("relay events map to partial / final / unavailable; anything else is ignored", () => {
    expect(parseRelayEvent(JSON.stringify({ type: "transcript.partial", text: "hey", is_final: false }))).toEqual({
      type: "partial",
      text: "hey",
    })
    expect(parseRelayEvent(JSON.stringify({ type: "transcript.partial", text: "hey", is_final: true }))).toEqual({
      type: "final",
      text: "hey",
    })
    expect(parseRelayEvent(JSON.stringify({ type: "relay.error", message: "stopped" }))).toEqual({
      type: "unavailable",
      reason: "stopped",
    })
    expect(parseRelayEvent(JSON.stringify({ type: "transcript.created" }))).toBeUndefined()
    expect(parseRelayEvent("null")).toBeUndefined()
    expect(parseRelayEvent("not json")).toBeUndefined()
  })

  test("the preview line keeps the newest words when it has to cut", () => {
    expect(livePreviewLine("hello   there", 40)).toBe("hello there")
    const cut = livePreviewLine("one two three four five", 10)
    expect(cut.length).toBe(10)
    expect(cut.endsWith("four five")).toBe(true)
  })
})

describe("the PCM tap does not change the recording", () => {
  test("tapping only APPENDS a second output after the wav path", () => {
    const input = ["-f", "avfoundation", "-i", ":1"]
    for (const seconds of [undefined, 5]) {
      const plain = captureArgs(input, "/tmp/x.wav", { seconds })
      const tapped = captureArgs(input, "/tmp/x.wav", { seconds, tapPcm: true })
      expect(tapped.slice(0, plain.length)).toEqual(plain)
      expect(tapped.at(-1)).toBe("pipe:3")
      expect(tapped.slice(plain.length)).toContain("s16le")
    }
  })

  const ffmpeg = spawnSync("ffmpeg", ["-version"]).status === 0
  test.skipIf(!ffmpeg)(
    "real ffmpeg: the wav is identical with the tap on and a dead relay behind it",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "iris-tap-"))
      try {
        const tone = ["-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000"]
        const device = { index: 0, name: "test tone" }

        const plainPath = join(dir, "plain.wav")
        // Let -t end each run on its own. stop() sends `q`, and a `q` that lands before the first
        // packet leaves an empty file — so stopping immediately would test nothing.
        const plain = spawnCapture(tone, plainPath, device, { seconds: 1 })
        await Bun.sleep(1500)
        const plainResult = await plain.stop()

        const dead = Bun.serve({ port: 0, fetch: () => new Response("") })
        const deadUrl = `http://127.0.0.1:${dead.port}`
        dead.stop(true)
        const preview = startLivePreview({ resolve: async () => ({ config: config(deadUrl) }) })

        let tapped = 0
        const tappedPath = join(dir, "tapped.wav")
        const rec = spawnCapture(tone, tappedPath, device, {
          seconds: 1,
          onPcm: (chunk) => {
            tapped += chunk.byteLength
            preview.push(chunk)
            // A preview callback that throws must not reach ffmpeg.
            if (tapped > 8000) throw new Error("preview exploded")
          },
        })
        await Bun.sleep(1500)
        const result = await rec.stop()
        preview.stop()

        expect(plainResult.ok).toBe(true)
        expect(result.ok).toBe(true)
        expect(existsSync(tappedPath)).toBe(true)
        // Same tone, same duration, same argv up to the wav path: same file size.
        expect(statSync(tappedPath).size).toBe(statSync(plainPath).size)
        // And the tap really carried the audio: one second of 16 kHz mono PCM16.
        expect(tapped).toBe(32000)
        expect(rec.peakSeen()).toBeGreaterThan(0.06)
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    20_000,
  )
})
