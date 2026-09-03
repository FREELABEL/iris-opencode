import { describe, expect, test, afterEach } from "bun:test"
import { clampProvider, resolveSttPolicy, SttPolicyError } from "../src/cli/lib/stt-policy"
import { transcribeAudio } from "../src/cli/lib/transcription"

// Epic #182784. The guarantee under test is NOT "a policy helper returns the right
// string" — it is "under sovereign policy there is no reachable path that uploads
// audio". So the integration tests below drive transcribeAudio(), the real router
// with the real fetch behind it, and assert it refuses BEFORE any network call.

// Restore ONLY the keys these tests touch. Reassigning process.env wholesale
// replaces Bun's env object for the whole process, which silently breaks every
// later test in the same run that reads an env var — the suite went +5 fail on
// exactly that mistake.
const TOUCHED = ["IRIS_TRANSCRIPTION_POLICY", "IRIS_TRANSCRIPTION_PROVIDER"] as const
const ORIGINAL = new Map(TOUCHED.map((k) => [k, process.env[k]]))
afterEach(() => {
  for (const k of TOUCHED) {
    const v = ORIGINAL.get(k)
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe("policy resolution fails closed", () => {
  test("defaults to sovereign when unset", () => {
    delete process.env.IRIS_TRANSCRIPTION_POLICY
    expect(resolveSttPolicy()).toBe("sovereign")
  })

  test("an unrecognised policy is treated as sovereign, not as permission", () => {
    // `soverign` (typo) must not read as "not sovereign" and open an egress.
    for (const v of ["soverign", "SOVERIGN", "yes", "true", "off", "  "]) {
      process.env.IRIS_TRANSCRIPTION_POLICY = v
      expect(resolveSttPolicy()).toBe("sovereign")
    }
  })

  test("standard is the one value that opens it, case-insensitively", () => {
    process.env.IRIS_TRANSCRIPTION_POLICY = "STANDARD"
    expect(resolveSttPolicy()).toBe("standard")
  })
})

describe("clamp distinguishes a typed flag from an inherited env var", () => {
  test("an EXPLICIT cloud provider under sovereign throws rather than silently downgrading", () => {
    expect(() => clampProvider("openai", { explicit: true, policy: "sovereign" })).toThrow(SttPolicyError)
  })

  test("an AMBIENT cloud provider under sovereign clamps to local and warns", () => {
    const warnings: string[] = []
    const got = clampProvider("openai", { explicit: false, policy: "sovereign", warn: (m) => warnings.push(m) })
    expect(got).toBe("whisper-local")
    expect(warnings.join()).toContain("sovereign")
  })

  test("local providers pass under every policy", () => {
    expect(clampProvider("whisper-local", { explicit: true, policy: "sovereign" })).toBe("whisper-local")
    expect(clampProvider("whisper-local", { explicit: false, policy: "standard" })).toBe("whisper-local")
  })

  test("standard policy lets a cloud provider through", () => {
    expect(clampProvider("openai", { explicit: true, policy: "standard" })).toBe("openai")
  })
})

describe("transcribeAudio — the actual egress path", () => {
  // The file must NOT exist: if the clamp works, we throw on policy before the
  // existsSync check, so a missing file proves refusal came FIRST. If the clamp
  // ever regresses, this test fails with "File not found" instead of the policy
  // error — a different message, so the test can tell the two apart.
  const NOWHERE = "/nonexistent/definitely-not-here.wav"

  test("sovereign refuses an explicitly requested cloud provider before touching the network", async () => {
    process.env.IRIS_TRANSCRIPTION_POLICY = "sovereign"
    await expect(transcribeAudio(NOWHERE, { provider: "openai" })).rejects.toThrow(SttPolicyError)
  })

  test("sovereign refuses even when the env var also asks for cloud", async () => {
    process.env.IRIS_TRANSCRIPTION_POLICY = "sovereign"
    process.env.IRIS_TRANSCRIPTION_PROVIDER = "deepgram"
    // Ambient, so it clamps to local — and then fails on the missing file, which
    // proves it took the LOCAL branch rather than the upload branch.
    await expect(transcribeAudio(NOWHERE)).rejects.toThrow(/File not found/)
  })

  test("standard policy reaches the cloud branch (fails on the missing file, not on policy)", async () => {
    process.env.IRIS_TRANSCRIPTION_POLICY = "standard"
    await expect(transcribeAudio(NOWHERE, { provider: "openai" })).rejects.toThrow(/File not found/)
  })
})

describe("static guard — every transcribe egress is policy-gated", () => {
  // This is the test that matters most in a year. The clamp in transcribeAudio() did
  // not cover transcribe.ts's transcribeViaServer(), which uploaded through irisFetch
  // directly AND was reached automatically when local whisper was missing. One clamp,
  // two egresses, and the uncovered one was on the default path.
  //
  // So rather than assert today's two call sites behave, assert the INVARIANT: any
  // file that POSTs to /api/v1/transcribe must also consult the policy. A third
  // upload path added later fails this test instead of silently shipping.
  test("every file POSTing to /api/v1/transcribe also references the policy", async () => {
    const { Glob } = await import("bun")
    const glob = new Glob("src/**/*.ts")
    const offenders: string[] = []

    for await (const file of glob.scan(".")) {
      const src = await Bun.file(file).text()
      if (!src.includes("/api/v1/transcribe")) continue
      // The glossary lookup is a GET of text, not an audio upload.
      const uploads = /["'`]\/api\/v1\/transcribe["'`]/.test(src) && /method:\s*["']POST["']/.test(src)
      if (!uploads) continue
      const gated = src.includes("resolveSttPolicy") || src.includes("clampProvider")
      if (!gated) offenders.push(file)
    }

    expect(offenders).toEqual([])
  })
})
