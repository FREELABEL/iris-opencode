import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { CRASH_EVENT, MAX_FRAMES, PROPS_MAX_BYTES, crashProps, macosVersion, scrub } from "../../src/iris/crash-report"
import { track, trackDeps } from "../../src/iris/onboarding"

// #191430 — the crash screen reports itself, through the engine. The engine is the trust
// boundary: it keeps only the crash keys, scrubs again, adds the machine facts and fits the bag.

const mac = { platform: "darwin", release: "22.6.0", arch: "x64" }

const raw = {
  app_version: "1.18.152",
  os: "macos",
  webview: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)",
  error_name: "TypeError",
  message: "undefined is not an object (evaluating 'e.groups().length')",
  route: "/:id/session/:id",
  boundary: "app",
  stack: ["when@tauri://localhost/assets/index-_65iBCH7.js:1464:19425", "map@[native code]"],
}

describe("crashProps", () => {
  test("keeps the crash fields and adds OS release, macOS version and arch", () => {
    const p = crashProps(raw, mac)
    expect(p).toMatchObject({ ...raw, os_release: "22.6.0", os_version: "13", arch: "x64" })
    expect(Object.keys(p).length).toBeLessThanOrEqual(20) // fl-iris-api keeps 20 keys
  })

  test("drops keys that are not on the crash list — prompts, emails, anything else", () => {
    const p = crashProps({ ...raw, prompt: "my secret plan", email: "a@b.co", cwd: "/Users/alex/x" }, mac) as Record<string, unknown>
    expect(p.prompt).toBeUndefined()
    expect(p.email).toBeUndefined()
    expect(p.cwd).toBeUndefined()
  })

  test("scrubs paths and emails out of the message and the frames, keeps bundle URLs", () => {
    const p = crashProps(
      {
        ...raw,
        message: "ENOENT: open '/Users/alex/Clients/acme/notes.md' for alex@freelabel.net",
        stack: [
          "at x (file:///Users/alex/app/index.js:1:2)",
          "at y (C:\\Users\\alex\\iris\\a.js:3:4)",
          "at z (http://127.0.0.1:4096/assets/a.js?auth_token=SECRET:5:6)",
          "when@tauri://localhost/assets/index-_65iBCH7.js:1464:19425",
        ],
      },
      mac,
    )
    const all = JSON.stringify(p)
    expect(all).not.toContain("/Users/alex")
    expect(all).not.toContain("alex@freelabel.net")
    expect(all).not.toContain("SECRET")
    expect(all).not.toContain("C:\\\\Users")
    expect(p.stack[2]).toBe("at z (http://127.0.0.1:4096/assets/a.js:5:6)")
    expect(p.stack[3]).toBe("when@tauri://localhost/assets/index-_65iBCH7.js:1464:19425")
  })

  test("at most 20 frames, and the whole bag fits fl-iris-api's 2000-byte props column", () => {
    const stack = Array.from({ length: 60 }, (_, i) => `frame${i}@tauri://localhost/assets/index-${"x".repeat(150)}.js:${i}:1`)
    const p = crashProps({ ...raw, stack, message: "m".repeat(5000), webview: "u".repeat(5000) }, mac)
    expect(p.stack.length).toBeLessThanOrEqual(MAX_FRAMES)
    expect(p.stack[0]).toStartWith("frame0@") // the top of the stack is what survives
    expect(JSON.stringify(p).length).toBeLessThanOrEqual(PROPS_MAX_BYTES)
  })

  test("garbage in is an empty report, not a throw", () => {
    expect(() => crashProps(null, mac)).not.toThrow()
    expect(crashProps({ stack: "not an array", message: 42 }, mac).stack).toEqual([])
  })

  test("Darwin release to macOS version", () => {
    expect(macosVersion("22.6.0")).toBe("13")
    expect(macosVersion("24.1.0")).toBe("15")
    expect(macosVersion("19.6.0")).toBe("10.15")
    expect(macosVersion("garbage")).toBeUndefined()
    expect(crashProps(raw, { platform: "linux", release: "6.8.0", arch: "x64" }).os_version).toBeUndefined()
  })

  test("scrub leaves an ordinary message alone", () => {
    expect(scrub("undefined is not an object (evaluating 'e.groups().length')")).toBe(
      "undefined is not an object (evaluating 'e.groups().length')",
    )
  })
})

describe("track(app.crash_screen) — what the engine forwards", () => {
  const saved = { ...trackDeps }
  let sent: { body: Record<string, unknown>; anonymous: boolean }[]
  let home: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    sent = []
    home = mkdtempSync(path.join(tmpdir(), "iris-crash-"))
    env = {}
    trackDeps.env = () => env
    trackDeps.home = () => home
    trackDeps.send = async (body, opts) => {
      sent.push({ body, anonymous: opts.anonymous })
    }
  })
  afterEach(() => Object.assign(trackDeps, saved))

  const withInstallId = (id = "0f8fad5b-d9cb-469f-a165-70867728950e") => {
    mkdirSync(path.join(home, ".iris"), { recursive: true })
    writeFileSync(path.join(home, ".iris", "install-id"), id + "\n")
    return id
  }

  test("one event, anonymous, with install id, version as variant and message as label", async () => {
    const id = withInstallId()
    await track(CRASH_EVENT, undefined, raw)
    expect(sent.length).toBe(1)
    const { body, anonymous } = sent[0]
    expect(anonymous).toBe(true) // never the person's token
    expect(body.event).toBe("app.crash_screen")
    expect(body.visitor_id).toBe(id)
    expect(body.variant).toBe("1.18.152")
    expect(body.label).toBe("TypeError: undefined is not an object (evaluating 'e.groups().length')")
    expect(body.path).toBe("desktop")
    expect((body.props as Record<string, unknown>).stack).toEqual(raw.stack)
  })

  test("no install id yet: still reported (a launch crash may come before the shell wrote one)", async () => {
    await track(CRASH_EVENT, undefined, raw)
    expect(sent.length).toBe(1)
    expect(sent[0].body.visitor_id).toBeUndefined()
  })

  test("telemetry off sends nothing — every switch", async () => {
    withInstallId()
    for (const e of [{ IRIS_NO_TELEMETRY: "1" }, { IRIS_TELEMETRY: "0" }, { DO_NOT_TRACK: "1" }]) {
      env = e
      await track(CRASH_EVENT, undefined, raw)
    }
    env = {}
    writeFileSync(path.join(home, ".iris", "telemetry.json"), JSON.stringify({ enabled: false }))
    await track(CRASH_EVENT, undefined, raw)
    expect(sent.length).toBe(0)
  })

  test("a network failure is swallowed", async () => {
    trackDeps.send = async () => {
      throw new Error("offline")
    }
    await expect(track(CRASH_EVENT, undefined, raw)).resolves.toBeUndefined()
  })

  test("other events are unchanged: props are not forwarded, the token is", async () => {
    withInstallId()
    await track("upgrade.opened", "pill", { message: "should not travel" })
    expect(sent.length).toBe(1)
    expect(sent[0].anonymous).toBe(false)
    expect(sent[0].body.props).toBeUndefined()
    expect(sent[0].body.label).toBe("pill")
  })
})
