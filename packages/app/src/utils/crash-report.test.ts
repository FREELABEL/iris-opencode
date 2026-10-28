import { describe, expect, test } from "bun:test"
import {
  CRASH_EVENT,
  SENT_KEY,
  TRACK_PATH,
  buildCrashReport,
  crashKey,
  reportCrashOnce,
  routePattern,
  stackFrames,
} from "./crash-report"

// #191430 — the crash screen reports itself, once, through the engine.

// The #191428 crash as Safari 16.6 reported it.
const safariError = Object.assign(new TypeError("undefined is not an object (evaluating 'e.groups().length')"), {
  stack: [
    "when@tauri://localhost/assets/index-_65iBCH7.js:1464:19425",
    "retainHomeSessions@tauri://localhost/assets/index-_65iBCH7.js:1464:20011",
    "map@[native code]",
  ].join("\n"),
})
const ua = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)"
const ctx = { version: "1.18.152", os: "macos", userAgent: ua, pathname: "/L1VzZXJzL2FsZXgvd29yaw/session/ses_abc123" }

function memoryStorage() {
  const m = new Map<string, string>()
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m }
}

function recorder(status = 200) {
  const calls: { url: string; body: any; signal?: AbortSignal | null }[] = []
  const fetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init?.body)), signal: init?.signal })
    return new Response(JSON.stringify({ ok: true }), { status })
  }) as unknown as typeof globalThis.fetch
  return { calls, fetch }
}

describe("buildCrashReport", () => {
  test("carries version, OS, webview, error, frames and the route — nothing else", () => {
    const r = buildCrashReport(safariError, ctx)
    expect(r.event).toBe(CRASH_EVENT)
    expect(r.props).toEqual({
      app_version: "1.18.152",
      os: "macos",
      webview: ua,
      error_name: "TypeError",
      message: "undefined is not an object (evaluating 'e.groups().length')",
      stack: [
        "when@tauri://localhost/assets/index-_65iBCH7.js:1464:19425",
        "retainHomeSessions@tauri://localhost/assets/index-_65iBCH7.js:1464:20011",
        "map@[native code]",
      ],
      route: "/:id/session/:id",
      boundary: "app",
    })
  })

  test("the route is a pattern: a directory route is a base64 path, so it never travels", () => {
    expect(routePattern("/L1VzZXJzL2FsZXgvd29yaw/session/ses_abc")).toBe("/:id/session/:id")
    expect(routePattern("/server/sidecar/session/ses_1")).toBe("/server/:id/session/:id")
    expect(routePattern("/new-session?dir=/Users/alex")).toBe("/new-session")
    expect(routePattern("/")).toBe("/")
    expect(routePattern(undefined)).toBe("/")
  })

  test("no file paths, emails or URL queries, in the message or the frames", () => {
    const e = new Error("ENOENT: '/Users/alex/Clients/acme.md' (alex@freelabel.net)")
    e.stack = [
      "Error: ENOENT",
      "    at read (file:///Users/alex/iris/index.js:1:2)",
      "    at go (C:\\Users\\alex\\iris\\a.js:3:4)",
      "    at z (http://127.0.0.1:4096/assets/a.js?auth_token=SECRET:5:6)",
      "    at y (tauri://localhost/assets/index-x.js:7:8)",
    ].join("\n")
    const all = JSON.stringify(buildCrashReport(e, ctx))
    for (const leak of ["/Users/alex", "alex@freelabel.net", "SECRET", "C:\\\\Users", "L1VzZXJz"]) expect(all).not.toContain(leak)
    expect(all).toContain("tauri://localhost/assets/index-x.js:7:8")
  })

  test("at most 20 frames, and the message line is not a frame", () => {
    const stack = ["TypeError: x", ...Array.from({ length: 40 }, (_, i) => `f${i}@tauri://localhost/assets/a.js:${i}:1`)].join("\n")
    const frames = stackFrames(stack)
    expect(frames.length).toBe(20)
    expect(frames[0]).toBe("f0@tauri://localhost/assets/a.js:0:1")
  })

  test("an InitError sends its name, never its data (config paths, provider bodies)", () => {
    const r = buildCrashReport({ name: "ConfigJsonError", data: { path: "/Users/alex/.config/iris.json" } }, ctx)
    expect(r.props.error_name).toBe("ConfigJsonError")
    expect(JSON.stringify(r)).not.toContain(".config")
  })
})

describe("reportCrashOnce", () => {
  test("posts one report to the engine's onboarding pipe", async () => {
    const { calls, fetch } = recorder()
    const storage = memoryStorage()
    const result = await reportCrashOnce(safariError, { ...ctx, engineUrl: "http://127.0.0.1:4096/", fetch, storage })
    expect(result).toBe("sent")
    expect(calls.length).toBe(1)
    expect(calls[0].url).toBe(`http://127.0.0.1:4096${TRACK_PATH}`)
    expect(calls[0].body.event).toBe("app.crash_screen")
    expect(calls[0].body.props.app_version).toBe("1.18.152")
    expect(calls[0].signal).toBeDefined() // bounded by a timeout
  })

  test("once per version + message per install; a new version or a new error reports again", async () => {
    const { calls, fetch } = recorder()
    const storage = memoryStorage()
    const opts = { ...ctx, engineUrl: "http://127.0.0.1:4096", fetch, storage }
    expect(await reportCrashOnce(safariError, opts)).toBe("sent")
    expect(await reportCrashOnce(safariError, opts)).toBe("duplicate")
    expect(await reportCrashOnce(safariError, { ...opts, version: "1.18.153" })).toBe("sent")
    expect(await reportCrashOnce(new Error("something else"), opts)).toBe("sent")
    expect(calls.length).toBe(3)
    expect(storage.m.get(SENT_KEY)).not.toContain("groups") // keys, not message text
    expect(crashKey("1", "a")).not.toBe(crashKey("2", "a"))
  })

  test("never throws: a network failure, a rejecting fetch, a throwing fetch, broken storage", async () => {
    const opts = { ...ctx, engineUrl: "http://127.0.0.1:4096" }
    const rejecting = (() => Promise.reject(new TypeError("Load failed"))) as unknown as typeof globalThis.fetch
    const throwing = (() => {
      throw new Error("sync")
    }) as unknown as typeof globalThis.fetch
    const broken = {
      getItem: () => {
        throw new Error("SecurityError")
      },
      setItem: () => {},
    }
    expect(await reportCrashOnce(safariError, { ...opts, fetch: rejecting })).toBe("failed")
    expect(await reportCrashOnce(safariError, { ...opts, fetch: throwing })).toBe("failed")
    expect(await reportCrashOnce(safariError, { ...opts, fetch: recorder(500).fetch })).toBe("failed")
    expect(await reportCrashOnce(safariError, { ...opts, fetch: recorder().fetch, storage: broken })).toBe("sent")
  })

  test("a hung engine does not hold it open: the timeout aborts", async () => {
    const hung = ((_: string, init?: RequestInit) =>
      new Promise((_r, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))))) as unknown as typeof globalThis.fetch
    const started = Date.now()
    expect(await reportCrashOnce(safariError, { ...ctx, engineUrl: "http://127.0.0.1:4096", fetch: hung, timeoutMs: 50 })).toBe("failed")
    expect(Date.now() - started).toBeLessThan(1000)
  })

  test("no engine (the web app), nothing is sent", async () => {
    const { calls, fetch } = recorder()
    expect(await reportCrashOnce(safariError, { ...ctx, fetch })).toBe("no-engine")
    expect(calls.length).toBe(0)
  })
})
