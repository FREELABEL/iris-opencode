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
/** GET /transcribe/health body; undefined = an older server that does not report readiness. */
let health: unknown
let holdHealth: (() => void) | undefined
let healthHeld = false
let stopFails = false
let gumCalls = 0
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
  health = undefined
  healthHeld = false
  holdHealth = undefined
  stopFails = false
  gumCalls = 0
  setUserAgent("Mozilla/5.0 (Macintosh) AppleWebKit")
  ;(globalThis as any).window = globalThis
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => (gumCalls++, {
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
    if (path === "/transcribe/health") {
      if (healthHeld) await new Promise<void>((r) => (holdHealth = r))
      if (health) return new Response(JSON.stringify(health), { status: 200 })
    }
    if (path === "/dictate/stop" && stopFails)
      return new Response(JSON.stringify({ error: "every engine failed", held: { id: "1700000000000-abcdef", seconds: 3 } }), {
        status: 503,
      })
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
async function mount(extra: Record<string, unknown> = {}) {
  const { createDictation } = await import(`./dictation.ts?case=${Math.random()}`)
  return createRoot((dispose) => ({
    d: createDictation({ url: () => "http://127.0.0.1:4096", onTranscript: () => {}, ...extra }),
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

describe("createDictation — cancel throws a take away without transcribing it", () => {
  test("a window recording is released and nothing is uploaded", async () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0)")
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } })
    d.cancel()
    await sleep(20)
    expect(d.phase()).toBe("idle")
    expect(tracksStopped).toBeGreaterThan(0)
    expect(posted("/transcribe")).toBe(0)
    dispose()
  })

  test("a sidecar recording is cancelled on the server, not stopped", async () => {
    const { d, dispose } = await mount()
    d.toggle() // silent probe → sidecar
    await sleep(600)
    d.cancel()
    await sleep(20)
    expect(posted("/dictate/cancel")).toBe(1)
    expect(posted("/dictate/stop")).toBe(0)
    expect(d.phase()).toBe("idle")
    dispose()
  })

  test("cancel when idle does nothing", async () => {
    const { d, dispose } = await mount()
    d.cancel()
    expect(posted("/dictate/cancel")).toBe(0)
    expect(d.phase()).toBe("idle")
    dispose()
  })
})

describe("createDictation — extend: Keep recording lifts a running take to the background cap", () => {
  test("a window take extended past 5:00 keeps recording", async () => {
    setUserAgent("Mozilla/5.0 (Windows NT 10.0)")
    const ticks: Array<() => void> = []
    globalThis.setInterval = ((fn: () => void) => {
      ticks.push(fn)
      return 0 as any
    }) as any
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    d.extend()
    for (let i = 0; i < 400; i++) ticks[0]!()
    expect(d.phase()).toBe("recording")
    dispose()
  })

  test("extend when idle does nothing", async () => {
    const { d, dispose } = await mount()
    d.extend()
    expect(d.phase()).toBe("idle")
    dispose()
  })
})

describe("createDictation — setup that would fail is reported before anyone speaks", () => {
  const notReady = {
    recorder: { sidecar: true },
    cloud: { configured: false, reason: "Sign in with `iris auth login` to dictate." },
    local: { whisper: false },
    engines: [],
  }

  test("no cloud engine and no on-device whisper: the take is refused and the mic never opens", async () => {
    health = notReady
    const errors: string[] = []
    const { d, dispose } = await mount({ onError: (m: string) => errors.push(m) })
    await sleep(20)
    d.toggle()
    await sleep(50)
    expect(errors).toEqual(["Sign in with `iris auth login` to dictate."])
    expect(d.phase()).toBe("idle")
    expect(gumCalls).toBe(0)
    expect(posted("/dictate/start")).toBe(0)
    dispose()
  })

  test("on-device whisper alone is enough to dictate", async () => {
    health = { ...notReady, local: { whisper: true } }
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(50)
    expect(gumCalls).toBe(1)
    dispose()
  })

  test("a hold released while readiness is still loading opens no microphone", async () => {
    healthHeld = true
    health = { ...notReady, cloud: { configured: true } }
    const { d, dispose } = await mount()
    d.press()
    await sleep(400)
    d.release()
    holdHealth!()
    await sleep(600)
    expect(gumCalls).toBe(0)
    expect(posted("/dictate/start")).toBe(0)
    expect(d.phase()).toBe("idle")
    dispose()
  })
})

describe("createDictation — background retries of held recordings", () => {
  async function failOneTake(extra: Record<string, unknown> = {}) {
    stopFails = true
    const { d, dispose } = await mount(extra)
    d.toggle()
    await sleep(500)
    d.toggle()
    await sleep(50)
    return { d, dispose }
  }

  test("by default a failed take is held and a retry is scheduled", async () => {
    const { d, dispose } = await failOneTake()
    expect(d.held().map((h: { id: string }) => h.id)).toEqual(["1700000000000-abcdef"])
    expect(d.nextRetryIn()).toBeGreaterThan(0)
    dispose()
  })

  test("autoRetry: false holds the recording but never retries it in the background", async () => {
    const { d, dispose } = await failOneTake({ autoRetry: false })
    expect(d.held().map((h: { id: string }) => h.id)).toEqual(["1700000000000-abcdef"])
    expect(d.nextRetryIn()).toBeUndefined()
    dispose()
  })
})
