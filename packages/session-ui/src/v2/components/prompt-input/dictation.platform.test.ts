import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"

/**
 * The platform edges of createDictation: what the server says it can do (GET /transcribe/health),
 * whether Windows may fall back to the sidecar, the server password, and server limits.
 * Same fake microphone / AudioContext / server approach as dictation.flow.test.ts.
 */

type Call = { path: string; method: string; headers: Record<string, string> }
type Reply = { status?: number; body?: unknown; headers?: Record<string, string> }

let calls: Call[]
let replies: Record<string, Reply>
let micError: DOMException | undefined
let processor: { onaudioprocess?: (e: unknown) => void } | undefined
const realFetch = globalThis.fetch
const realUserAgent = navigator.userAgent

const HEALTH_READY = {
  recorder: { sidecar: true },
  cloud: { configured: true },
  local: { whisper: false },
  engines: ["xai", "openrouter", "openai"],
}
const HEALTH_NO_FFMPEG = {
  recorder: {
    sidecar: false,
    reason: "The backup recorder needs ffmpeg, which is not installed. Install it with: winget install Gyan.FFmpeg — then restart IRIS.",
  },
  cloud: { configured: true },
  local: { whisper: false },
  engines: ["xai", "openrouter", "openai"],
}

function setUserAgent(value: string) {
  Object.defineProperty(navigator, "userAgent", { value, configurable: true })
}

beforeEach(() => {
  calls = []
  replies = {}
  micError = undefined
  processor = undefined
  setUserAgent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Edg/129.0")
  ;(globalThis as any).window = globalThis
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => {
        if (micError) throw micError
        return { getAudioTracks: () => [{}], getTracks: () => [{ stop: () => {} }] }
      },
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
  globalThis.fetch = (async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname
    calls.push({
      path,
      method: init?.method ?? "GET",
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
    })
    const reply = replies[path] ?? (path === "/transcribe/held" ? { body: { held: [] } } : { body: { text: "hello" } })
    return new Response(JSON.stringify(reply.body), { status: reply.status ?? 200, headers: reply.headers })
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  setUserAgent(realUserAgent)
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const posted = (path: string) => calls.filter((c) => c.path === path).length
const speak = () =>
  processor!.onaudioprocess!({ inputBuffer: { getChannelData: () => new Float32Array(4096).fill(0.3) } })

/** A fresh module per test: the capture mode and auth are module-level for the session. */
async function mount() {
  const mod = await import(`./dictation.ts?case=${Math.random()}`)
  const errors: string[] = []
  const root = createRoot((dispose) => ({
    d: mod.createDictation({
      url: () => "http://127.0.0.1:4096",
      onTranscript: () => {},
      onError: (m: string) => errors.push(m),
    }),
    dispose,
  }))
  return { ...root, errors, mod }
}

describe("readiness — GET /transcribe/health", () => {
  test("is exposed as the server reported it", async () => {
    replies["/transcribe/health"] = { body: HEALTH_READY }
    const { d, dispose } = await mount()
    await sleep(10)
    expect(d.readiness()).toEqual(HEALTH_READY)
    dispose()
  })

  test("an older server that answers with something else leaves it undefined", async () => {
    replies["/transcribe/health"] = { body: "<html>app</html>" }
    const { d, dispose } = await mount()
    await sleep(10)
    expect(d.readiness()).toBeUndefined()
    dispose()
  })
})

describe("Windows — the webview first, the sidecar only when the server says it can record", () => {
  test("the webview opens: it records, and the sidecar is never asked", async () => {
    replies["/transcribe/health"] = { body: HEALTH_READY }
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    expect(d.phase()).toBe("recording")
    expect(posted("/dictate/start")).toBe(0)
    dispose()
  })

  test("the webview is denied and the sidecar can record: falls back to it", async () => {
    replies["/transcribe/health"] = { body: HEALTH_READY }
    micError = new DOMException("Permission denied", "NotAllowedError")
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(20)
    expect(posted("/dictate/start")).toBe(1)
    expect(d.phase()).toBe("recording")
    dispose()
  })

  test("the first press may land before readiness arrives: it waits for it", async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const inner = globalThis.fetch
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
      if (new URL(input).pathname === "/transcribe/health") await gate
      return inner(input, init)
    }) as typeof fetch
    replies["/transcribe/health"] = { body: HEALTH_READY }
    micError = new DOMException("Permission denied", "NotAllowedError")
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    expect(posted("/dictate/start")).toBe(0)
    release()
    await sleep(20)
    expect(posted("/dictate/start")).toBe(1)
    dispose()
  })

  test("the webview is denied and the sidecar cannot record: the WINDOWS reason, no ffmpeg advice", async () => {
    replies["/transcribe/health"] = { body: HEALTH_NO_FFMPEG }
    micError = new DOMException("Permission denied", "NotAllowedError")
    const { d, dispose, errors } = await mount()
    d.toggle()
    await sleep(20)
    expect(posted("/dictate/start")).toBe(0)
    expect(d.phase()).toBe("idle")
    expect(errors.at(-1)).toContain("Windows Settings")
    expect(errors.join(" ")).not.toMatch(/ffmpeg|brew|winget/i)
    dispose()
  })

  test("an older server with no health route: no sidecar, the Windows reason", async () => {
    replies["/transcribe/health"] = { status: 404, body: { error: "not found" } }
    micError = new DOMException("Permission denied", "NotAllowedError")
    const { d, dispose, errors } = await mount()
    d.toggle()
    await sleep(20)
    expect(posted("/dictate/start")).toBe(0)
    expect(errors.at(-1)).toContain("Windows Settings")
    dispose()
  })
})

describe("server password — every request carries the SDK's credentials", () => {
  test("setDictationAuth headers go on health, held, start, stop and cancel", async () => {
    replies["/transcribe/health"] = { body: HEALTH_READY }
    micError = new DOMException("Permission denied", "NotAllowedError")
    const mod = await import(`./dictation.ts?case=${Math.random()}`)
    mod.setDictationAuth((url: string) =>
      url.startsWith("http://127.0.0.1:4096") ? { Authorization: "Basic b3BlbmNvZGU6czNjcmV0" } : undefined,
    )
    const { d, dispose } = createRoot((dispose) => ({
      d: mod.createDictation({ url: () => "http://127.0.0.1:4096", onTranscript: () => {} }),
      dispose,
    }))
    d.toggle()
    await sleep(20)
    d.toggle()
    await sleep(20)
    const paths = calls.map((c) => c.path)
    expect(paths).toEqual(expect.arrayContaining(["/transcribe/health", "/transcribe/held", "/dictate/start", "/dictate/stop"]))
    for (const c of calls) expect({ path: c.path, auth: c.headers["authorization"] }).toEqual({
      path: c.path,
      auth: "Basic b3BlbmNvZGU6czNjcmV0",
    })
    dispose()
  })

  test("without auth configured, no Authorization header is sent", async () => {
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    for (const c of calls) expect(c.headers["authorization"]).toBeUndefined()
    dispose()
  })
})

describe("server limits", () => {
  test("413: the server's message, nothing held, no retry scheduled", async () => {
    replies["/transcribe"] = {
      status: 413,
      body: { error: "That recording is too long to transcribe: the platform accepts up to 25 MB of audio (about 13 minutes)." },
    }
    const { d, dispose, errors } = await mount()
    d.toggle()
    await sleep(10)
    speak()
    d.toggle()
    await sleep(20)
    expect(errors.at(-1)).toContain("25 MB")
    expect(d.held()).toEqual([])
    expect(d.nextRetryIn()).toBeUndefined()
    dispose()
  })

  test("a held failure with Retry-After waits at least that long before the automatic retry", async () => {
    replies["/transcribe"] = {
      status: 503,
      headers: { "retry-after": "30" },
      body: { error: "Every transcription engine failed (xai: rate limited)", held: { id: "1700000000000-abcdef", seconds: 3 } },
    }
    const { d, dispose } = await mount()
    d.toggle()
    await sleep(10)
    speak()
    d.toggle()
    await sleep(20)
    expect(d.held()).toHaveLength(1)
    expect(d.nextRetryIn()).toBeGreaterThanOrEqual(30)
    dispose()
  })

  test("a held recording the server now refuses as too large is dropped, not retried forever", async () => {
    replies["/transcribe/held"] = { body: { held: [{ id: "1700000000000-abcdef", seconds: 900 }] } }
    replies["/transcribe/retry"] = { status: 413, body: { error: "That recording is too long to transcribe." } }
    const { d, dispose, errors } = await mount()
    await sleep(10)
    expect(d.held()).toHaveLength(1)
    await d.retryHeld()
    expect(d.held()).toEqual([])
    expect(d.nextRetryIn()).toBeUndefined()
    expect(errors.at(-1)).toContain("too long")
    dispose()
  })
})
