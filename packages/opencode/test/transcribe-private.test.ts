import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { enterPrivateRun, privateRunRefusal, runLocalWhisper } from "../src/cli/cmd/transcribe"

// #188318 / epic #188696 outcome O5: "audio marked private never hits a cloud STT".
// The test that matters is the second one: with the on-device engine BROKEN, a private run
// must fail rather than take the upload fallback that `--local` takes.

const ORIGINAL_POLICY = process.env.IRIS_TRANSCRIPTION_POLICY
const ORIGINAL_PATH = process.env.PATH
const realFetch = globalThis.fetch
afterEach(() => {
  if (ORIGINAL_POLICY === undefined) delete process.env.IRIS_TRANSCRIPTION_POLICY
  else process.env.IRIS_TRANSCRIPTION_POLICY = ORIGINAL_POLICY
  process.env.PATH = ORIGINAL_PATH
  globalThis.fetch = realFetch
})

describe("--private refuses the flags that send content off the machine", () => {
  test("--remote is refused", () => {
    expect(privateRunRefusal({ remote: true })).toContain("Nothing was sent")
  })
  test("a treatment is refused — it ships the text to a cloud model", () => {
    expect(privateRunRefusal({ treatment: "meeting" })).toContain("--treatment meeting")
  })
  test("raw and no treatment are allowed", () => {
    expect(privateRunRefusal({})).toBeNull()
    expect(privateRunRefusal({ treatment: "raw" })).toBeNull()
  })
})

describe("--private with the on-device engine broken", () => {
  test("fails non-zero and makes no network call at all", async () => {
    // Not audio: whisper/ffmpeg cannot decode it, so transcribeLocal throws and the run reaches
    // the exact fallback that uploads under the default (standard) policy.
    const dir = mkdtempSync(join(tmpdir(), "iris-private-"))
    const file = join(dir, "take.wav")
    writeFileSync(file, "this is not a wav file\n".repeat(64))

    // Strip every engine off PATH so the failure is guaranteed whatever this machine has.
    process.env.PATH = "/nonexistent"
    delete process.env.IRIS_TRANSCRIPTION_POLICY // the default — cloud-first — is what we must beat

    const posts: string[] = []
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url
      posts.push(String(url)) // ANY call — a private run has no reason to touch the network
      return new Response(JSON.stringify({ data: { text: "UPLOADED" } }), { status: 200 })
    }) as typeof fetch

    enterPrivateRun()
    const prevExit = process.exitCode
    const ok = await runLocalWhisper(file, undefined, true)
    const exit = process.exitCode
    process.exitCode = prevExit

    expect(ok).toBe(false)
    expect(exit).toBe(1)
    expect(posts).toEqual([])
  })

  test("control: WITHOUT --private the same broken run does upload (so the test above can fail)", async () => {
    // If this ever stops uploading, the test above proves nothing — it would pass vacuously.
    const dir = mkdtempSync(join(tmpdir(), "iris-private-ctl-"))
    const file = join(dir, "take.wav")
    writeFileSync(file, "this is not a wav file\n".repeat(64))
    process.env.PATH = "/nonexistent"
    process.env.IRIS_TRANSCRIPTION_POLICY = "standard"

    const posts: string[] = []
    globalThis.fetch = (async (input: any, init?: any) => {
      const url = typeof input === "string" ? input : input?.url
      if ((init?.method ?? "GET").toUpperCase() !== "GET") posts.push(String(url))
      return new Response(JSON.stringify({ data: { text: "UPLOADED" } }), { status: 200 })
    }) as typeof fetch

    const { transcribeViaServerForTest } = await import("../src/cli/cmd/transcribe")
    const text = await transcribeViaServerForTest(file)
    expect(text).toBe("UPLOADED")
    expect(posts.some((u) => u.includes("/api/v1/transcribe"))).toBe(true)
  })
})
