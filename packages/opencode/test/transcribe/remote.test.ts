import { afterAll, describe, expect, test } from "bun:test"
import { describeRemoteConfig, parseRetryAfter, transcribeRemote } from "../../src/transcribe/remote"
import { TranscribeError } from "../../src/transcribe/local"

// A stand-in for the IRIS platform's /api/v1/genesis/transcribe. It records what it received so
// the test can assert on the request the desktop actually sends.
const received: { auth: string | null; fields: Record<string, string> }[] = []
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const form = await req.formData()
    received.push({
      auth: req.headers.get("authorization"),
      fields: Object.fromEntries([...form.entries()].flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : []))),
    })
    if (form.get("bloq_id") === "phi")
      return Response.json({ success: false, message: "This board is marked PHI." }, { status: 403 })
    if (form.get("bloq_id") === "html") return new Response("<html>gateway</html>", { status: 502 })
    return Response.json({ success: true, data: { text: "  hello from grok  ", provider: "xai" } })
  },
})
afterAll(() => server.stop(true))

const apiUrl = `http://127.0.0.1:${server.port}`
const audio = new Uint8Array([1, 2, 3, 4])

describe("transcribeRemote", () => {
  test("sends the scope, asks for Grok, and trims the transcript", async () => {
    const result = await transcribeRemote(audio, { apiUrl, bloqId: "42" }, { language: "es" })
    expect(result.text).toBe("hello from grok")
    expect(result.provider).toBe("xai")
    const last = received.at(-1)
    expect(last?.fields).toEqual({ bloq_id: "42", provider: "xai", language: "es" })
    expect(last?.auth).toBeNull()
  })

  test("omits language when none is given and sends a usable token as a bearer", async () => {
    await transcribeRemote(audio, { apiUrl, bloqId: "42", token: "iris_abc" })
    const last = received.at(-1)
    expect(last?.fields.language).toBeUndefined()
    expect(last?.auth).toBe("Bearer iris_abc")
  })

  test("surfaces the platform's own refusal message", async () => {
    const err = await transcribeRemote(audio, { apiUrl, bloqId: "phi" }).catch((e) => e)
    expect(err).toBeInstanceOf(TranscribeError)
    expect(err.message).toBe("This board is marked PHI.")
  })

  test("names the HTTP status when the platform returns no JSON", async () => {
    const err = await transcribeRemote(audio, { apiUrl, bloqId: "html" }).catch((e) => e)
    expect(err).toBeInstanceOf(TranscribeError)
    expect(err.message).toBe("Remote transcription failed (HTTP 502)")
  })

  test("says which host it could not reach", async () => {
    const err = await transcribeRemote(audio, { apiUrl: "http://127.0.0.1:1", bloqId: "42" }).catch((e) => e)
    expect(err).toBeInstanceOf(TranscribeError)
    expect(err.message).toContain("Could not reach http://127.0.0.1:1")
  })
})

describe("describeRemoteConfig — what /transcribe/health says about the cloud", () => {
  const { mkdtempSync, writeFileSync } = require("fs") as typeof import("fs")
  const { join } = require("path") as typeof import("path")
  const { tmpdir } = require("os") as typeof import("os")
  const dir = mkdtempSync(join(tmpdir(), "iris-cfg-"))
  const write = (cfg: object) => {
    const p = join(dir, `${Math.random()}.json`)
    writeFileSync(p, JSON.stringify(cfg))
    return p
  }
  const env = { url: process.env["IRIS_API_URL"], bloq: process.env["IRIS_TRANSCRIBE_BLOQ_ID"] }
  const clear = () => {
    delete process.env["IRIS_API_URL"]
    delete process.env["IRIS_TRANSCRIBE_BLOQ_ID"]
  }
  const restore = () => {
    if (env.url !== undefined) process.env["IRIS_API_URL"] = env.url
    if (env.bloq !== undefined) process.env["IRIS_TRANSCRIBE_BLOQ_ID"] = env.bloq
  }

  test("not signed in says to sign in", () => {
    clear()
    try {
      const r = describeRemoteConfig(join(dir, "absent.json"))
      expect(r.config).toBeNull()
      expect(r.reason).toContain("iris auth login")
    } finally {
      restore()
    }
  })

  test("signed in with no board says to choose one", () => {
    clear()
    try {
      const r = describeRemoteConfig(write({ api_url: "https://x" }))
      // A board is no longer required (#188013): the platform files the take under the person's own.
      // Without a credential the reason is about signing in, never about a config file.
      expect(r.config).toBeNull()
      expect(r.reason).not.toContain("default_bloq_id")
    } finally {
      restore()
    }
  })

  test("configured has no reason", () => {
    clear()
    const key = process.env["IRIS_API_KEY"]
    process.env["IRIS_API_KEY"] = "k".repeat(64)
    try {
      expect(describeRemoteConfig(write({ api_url: "https://x/", default_bloq_id: 7 }))).toEqual({
        config: { apiUrl: "https://x", token: "k".repeat(64), bloqId: "7" },
      })
    } finally {
      if (key === undefined) delete process.env["IRIS_API_KEY"]
      else process.env["IRIS_API_KEY"] = key
      restore()
    }
  })
})

describe("parseRetryAfter", () => {
  test("seconds and HTTP dates; junk is ignored", () => {
    expect(parseRetryAfter("3")).toBe(3000)
    expect(parseRetryAfter(new Date(10_000).toUTCString(), 4_000)).toBe(6000)
    expect(parseRetryAfter("soon")).toBeUndefined()
    expect(parseRetryAfter(null)).toBeUndefined()
  })
})

describe("describeRemoteConfig — the platform now requires a person's credential", () => {
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs")
  const { tmpdir } = require("node:os") as typeof import("node:os")
  const { join } = require("node:path") as typeof import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "iris-remote-"))
  const cfg = (o: object) => {
    const p = join(dir, `c-${Math.random()}.json`)
    writeFileSync(p, JSON.stringify(o))
    return p
  }
  const withKey = <T>(key: string | undefined, fn: () => T): T => {
    const prev = process.env["IRIS_API_KEY"]
    const url = process.env["IRIS_API_URL"]
    const bloq = process.env["IRIS_TRANSCRIBE_BLOQ_ID"]
    delete process.env["IRIS_API_URL"]
    delete process.env["IRIS_TRANSCRIBE_BLOQ_ID"]
    if (key === undefined) delete process.env["IRIS_API_KEY"]
    else process.env["IRIS_API_KEY"] = key
    try {
      return fn()
    } finally {
      if (prev === undefined) delete process.env["IRIS_API_KEY"]
      else process.env["IRIS_API_KEY"] = prev
      if (url !== undefined) process.env["IRIS_API_URL"] = url
      if (bloq !== undefined) process.env["IRIS_TRANSCRIBE_BLOQ_ID"] = bloq
    }
  }
  const base = { api_url: "https://x", default_bloq_id: 7 }
  const sdk = "a".repeat(40) + "B9".repeat(12)

  test("the 64-character SDK token the desktop is launched with is sent", () => {
    const r = withKey(sdk, () => describeRemoteConfig(cfg(base)))
    expect(r.config?.token).toBe(sdk)
  })

  test("a Passport JWT is sent", () => {
    const jwt = "eyJhbGciOi.eyJzdWIiOjE5M30.c2lnbmF0dXJl"
    expect(withKey(jwt, () => describeRemoteConfig(cfg(base))).config?.token).toBe(jwt)
  })

  test("the node_api_key is never sent — the platform rejects it as a caller", () => {
    const r = withKey(undefined, () => describeRemoteConfig(cfg({ ...base, node_api_key: "node_live_abc123" })))
    expect(r.config).toBeNull()
    expect(r.reason).toMatch(/sign/i)
  })

  test("no usable credential means cloud dictation is not ready, and says how to fix it", () => {
    const r = withKey(undefined, () => describeRemoteConfig(cfg(base)))
    expect(r.config).toBeNull()
    expect(r.reason).toMatch(/iris auth login/)
  })

  test("a short or malformed token is not mistaken for one", () => {
    expect(withKey("abc123", () => describeRemoteConfig(cfg(base))).config).toBeNull()
    expect(withKey("eyNotAJwt", () => describeRemoteConfig(cfg(base))).config).toBeNull()
  })
})
