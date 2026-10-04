import { afterAll, describe, expect, test } from "bun:test"
import { transcribeRemote } from "../../src/transcribe/remote"
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
