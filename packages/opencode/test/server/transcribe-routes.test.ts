import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { request as httpRequest } from "node:http"
import { networkInterfaces, tmpdir } from "os"
import { join } from "path"
import { Flag } from "@opencode-ai/core/flag/flag"
import { Server } from "../../src/server/server"
import { isLoopbackAddress, isLoopbackHost } from "../../src/server/routes/instance/httpapi/transcribe"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

/**
 * The local voice routes: the readiness and level contract the composer is built against, the
 * engine chain behind them, and the lock that keeps a microphone off the network.
 */

// A stand-in for the IRIS platform: the reply is chosen per test.
let platformReply: () => Response = () => Response.json({ success: true, data: { text: "hello", provider: "xai" } })
const platform = Bun.serve({ port: 0, fetch: () => platformReply() })

const saved = { ...process.env }
const savedFlag = { password: Flag.OPENCODE_SERVER_PASSWORD, username: Flag.OPENCODE_SERVER_USERNAME }
let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "iris-routes-"))
  // A fake ffmpeg that streams one second of a 0.5 square wave and waits to be stopped.
  const pcm = new Uint8Array(32000)
  const view = new DataView(pcm.buffer)
  for (let i = 0; i < 16000; i++) view.setInt16(i * 2, (i % 2 ? -1 : 1) * 16383, true)
  writeFileSync(join(dir, "voice.pcm"), pcm)
  writeFileSync(join(dir, "ffmpeg"), `#!/bin/sh\ncase "$*" in *-devices*) echo " D  alsa  ALSA"; exit 0;; esac\ncat "${dir}/voice.pcm"\nexec sleep 30\n`)
  chmodSync(join(dir, "ffmpeg"), 0o755)
})
afterAll(() => {
  platform.stop(true)
  rmSync(dir, { recursive: true, force: true })
})
afterEach(async () => {
  for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]
  Object.assign(process.env, saved)
  Flag.OPENCODE_SERVER_PASSWORD = savedFlag.password
  Flag.OPENCODE_SERVER_USERNAME = savedFlag.username
  platformReply = () => Response.json({ success: true, data: { text: "hello", provider: "xai" } })
  await disposeAllInstances()
  await resetDatabase()
})

function configured() {
  process.env["IRIS_API_URL"] = `http://127.0.0.1:${platform.port}`
  process.env["IRIS_TRANSCRIBE_BLOQ_ID"] = "42"
  process.env["IRIS_FFMPEG"] = join(dir, "ffmpeg")
  delete process.env["IRIS_TRANSCRIBE_PROVIDERS"]
}

async function withServer(fn: (base: string) => Promise<void>, hostname = "127.0.0.1") {
  const listener = await Server.listen({ hostname, port: 0 })
  try {
    await fn(`http://127.0.0.1:${listener.port}`)
  } finally {
    await listener.stop(true)
  }
}

const wav = () => {
  const pcm = new Uint8Array(3200).fill(0x40)
  const out = new Uint8Array(44 + pcm.length)
  out.set(new TextEncoder().encode("RIFF"), 0)
  out.set(pcm, 44)
  return out
}

describe("GET /transcribe/health", () => {
  test("reports recorder, cloud, local and the effective engine order", async () => {
    configured()
    await withServer(async (base) => {
      const res = await fetch(`${base}/transcribe/health`)
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(typeof body.recorder.sidecar).toBe("boolean")
      expect(body.cloud).toEqual({ configured: true })
      expect(typeof body.local.whisper).toBe("boolean")
      expect(body.engines.slice(0, 3)).toEqual(["xai", "openrouter", "openai"])
      if (process.platform === "linux") expect(body.recorder).toEqual({ sidecar: true })
    })
  })

  test("not configured: a plain-English reason, and no cloud engines in the order", async () => {
    // Bun caches the home directory, so ~/.iris/config.json cannot be hidden from here; the
    // missing-field cases are unit-tested on describeRemoteConfig. This pins the route's wiring.
    process.env["IRIS_API_URL"] = ""
    process.env["IRIS_TRANSCRIBE_BLOQ_ID"] = ""
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/transcribe/health`)).json()
      if (body.cloud.configured) return
      expect(typeof body.cloud.reason).toBe("string")
      expect(body.engines).not.toContain("xai")
    })
  })

  test("no ffmpeg: the recorder is not ready and says why for this platform", async () => {
    configured()
    process.env["IRIS_FFMPEG"] = join(dir, "missing")
    process.env["PATH"] = dir // nothing named ffmpeg on it either
    await withServer(async (base) => {
      const body = await (await fetch(`${base}/transcribe/health`)).json()
      if (process.platform !== "linux") return
      expect(body.recorder.sidecar).toBe(false)
      expect(body.recorder.reason).toContain("apt install ffmpeg")
    })
  })
})

describe("GET /dictate/level and the sidecar recording", () => {
  const linuxOnly = process.platform === "linux" ? test : test.skip

  test("idle: level 0, seconds 0", async () => {
    await withServer(async (base) => {
      expect(await (await fetch(`${base}/dictate/level`)).json()).toEqual({ level: 0, seconds: 0 })
    })
  })

  linuxOnly("a live level while recording; stop answers {text, provider, attempts} from the engine that answered", async () => {
    configured()
    platformReply = () => Response.json({ success: true, data: { text: "hello there", provider: "openrouter" } })
    await withServer(async (base) => {
      expect((await fetch(`${base}/dictate/start`, { method: "POST" })).status).toBe(200)
      await Bun.sleep(300)
      const live = await (await fetch(`${base}/dictate/level`)).json()
      expect(live.level).toBeCloseTo(0.5, 2)
      expect(live.seconds).toBeGreaterThan(0)
      const stop = await (await fetch(`${base}/dictate/stop`, { method: "POST" })).json()
      expect(stop.text).toBe("hello there")
      expect(stop.provider).toBe("openrouter")
      expect(Array.isArray(stop.attempts)).toBe(true)
      expect(await (await fetch(`${base}/dictate/level`)).json()).toEqual({ level: 0, seconds: 0 })
    })
  })
})

describe("POST /transcribe over the platform's size limit", () => {
  test("413, names the limit, and does NOT hold the recording", async () => {
    configured()
    platformReply = () =>
      Response.json({ success: false, message: "The audio file may not be greater than 25600 kilobytes." }, { status: 413 })
    await withServer(async (base) => {
      const res = await fetch(`${base}/transcribe?filename=d.wav`, { method: "POST", body: wav() })
      expect(res.status).toBe(413)
      const body = await res.json()
      expect(body.error).toContain("25 MB")
      expect(body.held).toBeUndefined()
      expect((await (await fetch(`${base}/transcribe/held`)).json()).held).toEqual([])
    })
  })

  test("a retryable failure is still held", async () => {
    configured()
    platformReply = () => Response.json({ success: false, message: "bad key" }, { status: 401 })
    await withServer(async (base) => {
      const res = await fetch(`${base}/transcribe?filename=d.wav`, { method: "POST", body: wav() })
      expect(res.status).toBe(503)
      const id = (await res.json()).held.id
      expect(typeof id).toBe("string")
      await fetch(`${base}/transcribe/discard?id=${id}`, { method: "POST" })
    })
  })
})

describe("loopback only", () => {
  test("isLoopbackAddress", () => {
    for (const a of ["127.0.0.1", "127.8.9.1", "::1", "::ffff:127.0.0.1"]) expect(isLoopbackAddress(a)).toBe(true)
    for (const a of ["192.168.4.22", "10.0.0.1", "::ffff:192.168.1.2", "fe80::1", "0.0.0.0", ""])
      expect(isLoopbackAddress(a)).toBe(false)
  })

  test("isLoopbackHost — a DNS-rebinding page sends its own name as Host", () => {
    for (const h of ["127.0.0.1:4096", "localhost:4096", "localhost", "[::1]:4096", "127.0.0.1"])
      expect(isLoopbackHost(h)).toBe(true)
    for (const h of ["evil.example:4096", "192.168.4.22:4096", "127.0.0.1.evil.example", "localhost.evil.example"])
      expect(isLoopbackHost(h)).toBe(false)
  })

  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address
  const withLan = lan ? test : test.skip

  withLan("a request from another address is refused on every voice route", async () => {
    const listener = await Server.listen({ hostname: "0.0.0.0", port: 0 })
    try {
      const base = `http://${lan}:${listener.port}`
      for (const [method, path] of [
        ["GET", "/transcribe/health"],
        ["GET", "/transcribe/held"],
        ["POST", "/transcribe"],
        ["POST", "/transcribe/retry?id=x"],
        ["POST", "/transcribe/discard?id=x"],
        ["POST", "/dictate/start"],
        ["POST", "/dictate/stop"],
        ["POST", "/dictate/cancel"],
        ["GET", "/dictate/status"],
        ["GET", "/dictate/level"],
      ] as const) {
        const res = await fetch(`${base}${path}`, { method, body: method === "POST" ? wav() : undefined })
        expect({ path, status: res.status }).toEqual({ path, status: 403 })
        expect((await res.json()).error).toContain("loopback")
      }
      // The same server still answers the same route from loopback.
      const local = await fetch(`http://127.0.0.1:${listener.port}/dictate/status`)
      expect(local.status).toBe(200)
    } finally {
      await listener.stop(true)
    }
  })

  test("a loopback connection carrying a foreign Host is refused", async () => {
    await withServer(async (base) => {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${base}/dictate/status`, { headers: { host: "evil.example" } }, (res) => {
          res.resume()
          resolve(res.statusCode ?? 0)
        })
        req.on("error", reject)
        req.end()
      })
      expect(status).toBe(403)
    })
  })
})

describe("server password", () => {
  test("voice routes require it when set, and accept the same Basic header the SDK sends", async () => {
    Flag.OPENCODE_SERVER_PASSWORD = "s3cret"
    Flag.OPENCODE_SERVER_USERNAME = "opencode"
    process.env["OPENCODE_SERVER_PASSWORD"] = "s3cret"
    process.env["OPENCODE_SERVER_USERNAME"] = "opencode"
    await withServer(async (base) => {
      expect((await fetch(`${base}/dictate/level`)).status).toBe(401)
      const ok = await fetch(`${base}/dictate/level`, { headers: { authorization: `Basic ${btoa("opencode:s3cret")}` } })
      expect(ok.status).toBe(200)
    })
  })
})
