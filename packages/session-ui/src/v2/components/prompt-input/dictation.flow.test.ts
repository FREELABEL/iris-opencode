import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { LEVEL_HISTORY, levelFromRms } from "./dictate-visual"

/**
 * createDictation awaits several times before a recorder is running — the 400ms probe, the
 * sidecar's /dictate/start — and a stop can land inside any of those waits. These drive it with a
 * fake microphone, AudioContext and server to pin down what each of those stops leaves behind.
 */

type Call = { path: string; resolve?: () => void }

let calls: Call[]
let tracksStopped: number
let processor: { onaudioprocess?: (e: unknown) => void } | undefined
let holdStart: boolean
let sidecarLevel = 0
const realFetch = globalThis.fetch
const realInterval = globalThis.setInterval
const realUserAgent = navigator.userAgent

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true })
}

beforeEach(() => {
  calls = []
  tracksStopped = 0
  processor = undefined
  holdStart = false
  setUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit")
  ;(globalThis as any).window = globalThis
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getAudioTracks: () => [{}],
        getTracks: () => [{ stop: () => tracksStopped++ }],
      }),
    },
  })
  ;(globalThis as any).AudioContext = class {
    state = "running"
    sampleRate = 16000
    destination = {}
    createMediaStreamSource = () => ({ connect() {}, disconnect() {} })
    createGain = () => ({ gain: { value: 1 }, connect() {} })
    createScriptProcessor = () => {
      processor = { connect() {}, disconnect() {} } as any
      return processor
    }
    resume = async () => {}
    close = async () => {}
  }
  globalThis.fetch = (async (input: string) => {
    const path = new URL(input).pathname
    const call: Call = { path }
    calls.push(call)
    if (path === "/dictate/start" && holdStart) await new Promise<void>((r) => (call.resolve = r))
    const body =
      path === "/transcribe/held"
        ? { held: [] }
        : path === "/dictate/level"
          ? { level: sidecarLevel, seconds: 1 }
          : { text: "hello" }
    return new Response(JSON.stringify(body), { status: 200 })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  globalThis.setInterval = realInterval
  setUserAgent(realUserAgent)
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const posted = (path: string) => calls.filter((c) => c.path === path).length

/** A fresh module per test: the capture mode is cached at module level for the session. */
async function mount() {
  const { createDictation } = await import(`./dictation.ts?case=${Math.random()}`)
  return createRoot((dispose) => ({
    d: createDictation({ url: () => "http://127.0.0.1:4096", onTranscript: () => {} }),
    dispose,
  }))
}

describe("createDictation — a stop that lands before a recorder is running", () => {
  test("a silent probe left alone falls back to the sidecar", async () => {
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(500)
    expect(posted("/dictate/start")).toBe(1)
    expect(d.phase()).toBe("recording")
    dispose()
  })

  test("stopping during the probe releases the mic and never starts the sidecar", async () => {
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(50)
    d.toggle()
    await sleep(500)
    expect(posted("/dictate/start")).toBe(0)
    expect(d.phase()).toBe("idle")
    expect(tracksStopped).toBeGreaterThan(0)
    // Nothing was uploaded either: a sub-400ms take has no speech worth a transcription call.
    expect(posted("/transcribe")).toBe(0)
    dispose()
  })

  test("unmounting during the probe never starts the sidecar", async () => {
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(50)
    dispose()
    await sleep(500)
    expect(posted("/dictate/start")).toBe(0)
  })

  test("stopping while the sidecar is starting cancels it once it answers", async () => {
    holdStart = true
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(500)
    const start = calls.find((c) => c.path === "/dictate/start")
    expect(start).toBeDefined()
    d.toggle()
    start!.resolve!()
    await sleep(20)
    expect(posted("/dictate/cancel")).toBe(1)
    expect(d.phase()).toBe("idle")
    dispose()
  })
})

describe("createDictation — length cap", () => {
  test("a webview recording stops itself at five minutes and is transcribed", async () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0)") // webview only: no probe, no sidecar
    const ticks: Array<() => void> = []
    globalThis.setInterval = ((fn: () => void) => {
      ticks.push(fn)
      return 0 as any
    }) as any
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    expect(d.phase()).toBe("recording")
    processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } })
    const tick = ticks[0]!
    for (let i = 0; i < 299; i++) tick()
    expect(d.phase()).toBe("recording")
    tick()
    await sleep(20)
    expect(posted("/transcribe")).toBe(1)
    expect(d.phase()).toBe("idle")
    dispose()
  })
})

describe("createDictation — the shortcut: tap toggles, hold is push-to-talk", () => {
  const realNow = Date.now
  let now = 0
  beforeEach(() => {
    now = 1_000_000
    Date.now = () => now
    setUserAgent("Mozilla/5.0 (Windows NT 10.0)") // webview recorder: starts without a probe
  })
  afterEach(() => {
    Date.now = realNow
  })

  test("a tap starts recording and leaves it running", async () => {
    const { d, dispose } = await mount()
    d.press()
    await sleep(10)
    now += 120
    d.release()
    expect(d.phase()).toBe("recording")
    dispose()
  })

  test("the next press after a tap stops it", async () => {
    const { d, dispose } = await mount()
    d.press()
    await sleep(10)
    now += 120
    d.release()
    processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } })
    d.press()
    await sleep(20)
    expect(posted("/transcribe")).toBe(1)
    expect(d.phase()).toBe("idle")
    dispose()
  })

  test("a hold stops on release and transcribes what was said", async () => {
    const { d, dispose } = await mount()
    d.press()
    await sleep(10)
    processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } })
    now += 2_000
    d.release()
    await sleep(20)
    expect(posted("/transcribe")).toBe(1)
    expect(d.phase()).toBe("idle")
    dispose()
  })

  test("letting go of a hold before the sidecar is up abandons the start", async () => {
    setUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit")
    holdStart = true
    const { d, dispose } = await mount()
    d.toggle() // first dictation: probe finds silence, caches the sidecar
    await sleep(500)
    calls.find((c) => c.path === "/dictate/start")!.resolve!()
    await sleep(10)
    d.toggle()
    await sleep(20)
    // Second dictation goes straight to the sidecar, whose start we hold open.
    d.press()
    await sleep(10)
    now += 1_000
    d.release()
    calls.filter((c) => c.path === "/dictate/start")[1]!.resolve!()
    await sleep(20)
    expect(posted("/dictate/cancel")).toBeGreaterThanOrEqual(1)
    expect(d.phase()).toBe("idle")
    dispose()
  })

  test("a release with no press is ignored", async () => {
    const { d, dispose } = await mount()
    d.release()
    expect(d.phase()).toBe("idle")
    dispose()
  })
})

describe("createDictation — what the waveform draws", () => {
  const loud = { inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } }

  test("levels is a fixed-length history that starts silent", async () => {
    const { d, dispose } = await mount()
    expect(d.levels().length).toBe(LEVEL_HISTORY)
    expect(d.levels().every((v: number) => v === 0)).toBe(true)
    dispose()
  })

  test("the window recorder feeds levels from the audio it captures", async () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0)")
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    processor!.onaudioprocess!(loud)
    const levels = d.levels()
    expect(levels.length).toBe(LEVEL_HISTORY)
    expect(levels[levels.length - 1]).toBeCloseTo(levelFromRms(0.3))
    dispose()
  })

  test("the sidecar recorder's level is polled while it records, and polling stops after", async () => {
    sidecarLevel = 0.05
    const { d, dispose } = await mount()
    d.toggle() // probe hears silence → sidecar
    await sleep(700)
    expect(posted("/dictate/level")).toBeGreaterThan(0)
    expect(d.levels()[LEVEL_HISTORY - 1]).toBeCloseTo(levelFromRms(0.05))
    d.toggle()
    await sleep(50)
    const polls = posted("/dictate/level")
    await sleep(300)
    expect(posted("/dictate/level")).toBe(polls)
    expect(d.levels().every((v: number) => v === 0)).toBe(true)
    dispose()
  })

  test("holding is true only while the shortcut is down", async () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0)")
    const { d, dispose } = await mount()
    expect(d.holding()).toBe(false)
    d.press()
    expect(d.holding()).toBe(true)
    d.release()
    expect(d.holding()).toBe(false)
    dispose()
  })
})
