import { describe, expect, test } from "bun:test"
import {
  serverTranscriptVerdict,
  transcriptFileName,
  treatmentWarning,
  isStructuredTreatment,
} from "./transcribe-outcome"

/**
 * These exist because `iris transcribe` could not fail. Measured 2026-09-05 on CLI 1.3.242:
 * a YouTube URL returned exit 0, wrote no file, and printed no error (#183797), and a
 * treatment the server rejected wrote the untreated transcript and still said "Saved" (#183796).
 *
 * Every case below is one of those measured runs turned into an assertion. The module is
 * deliberately import-free so these run without a network, a model, or a filesystem.
 */

describe("serverTranscriptVerdict — a 200 is not a transcript", () => {
  test("text present is the only success", () => {
    expect(serverTranscriptVerdict({ ok: true, data: { text: "hello there" } })).toEqual({
      kind: "finish",
      text: "hello there",
    })
  })

  // The measured #183797 case: tool.ok === true, data.text === "". The old code took this
  // branch as success, printed nothing, wrote nothing, and returned exit 0.
  test("ok with an EMPTY text is a fallback, never a finish", () => {
    expect(serverTranscriptVerdict({ ok: true, data: { text: "" } }).kind).toBe("fallback")
  })

  test("ok with whitespace-only text is a fallback", () => {
    expect(serverTranscriptVerdict({ ok: true, data: { text: "   \n\t " } }).kind).toBe("fallback")
  })

  test("ok with no data at all is a fallback", () => {
    expect(serverTranscriptVerdict({ ok: true, data: null }).kind).toBe("fallback")
  })

  test("ok with data but no text key is a fallback", () => {
    expect(serverTranscriptVerdict({ ok: true, data: {} }).kind).toBe("fallback")
  })

  test("not ok is a fallback", () => {
    expect(serverTranscriptVerdict({ ok: false }).kind).toBe("fallback")
  })

  test("every fallback carries a reason a human can act on", () => {
    for (const t of [
      { ok: true, data: { text: "" } },
      { ok: true, data: null },
      { ok: false },
    ] as const) {
      const v = serverTranscriptVerdict(t)
      expect(v.kind).toBe("fallback")
      if (v.kind === "fallback") expect(v.reason.length).toBeGreaterThan(0)
    }
  })
})

describe("transcriptFileName — a URL has no basename, and -o was silently dropped", () => {
  test("a youtube watch URL keeps the video id, so two videos do not collide", () => {
    const a = transcriptFileName("https://www.youtube.com/watch?v=jNQXAC9IVRw")
    const b = transcriptFileName("https://www.youtube.com/watch?v=aqz-KE-bpKQ")
    expect(a).toContain("jNQXAC9IVRw")
    expect(a).not.toBe(b)
  })

  test("a youtu.be short link keeps the id too", () => {
    expect(transcriptFileName("https://youtu.be/jNQXAC9IVRw")).toContain("jNQXAC9IVRw")
  })

  test("an instagram reel keeps its shortcode", () => {
    expect(transcriptFileName("https://www.instagram.com/reel/Dc1teXQSV43/")).toContain("Dc1teXQSV43")
  })

  test("a tracking query string does not end up in the filename", () => {
    const n = transcriptFileName("https://www.instagram.com/reel/Dc1teXQSV43/?stkn=MXV4ZW1jNTQ0dWJzYQ==")
    expect(n).toContain("Dc1teXQSV43")
    expect(n).not.toContain("stkn")
    expect(n).not.toContain("=")
  })

  test("a local path uses its basename without the extension", () => {
    expect(transcriptFileName("/tmp/some dir/onboarding call.m4a")).toContain("onboarding")
  })

  // This name gets join()ed onto a user-supplied output directory. A separator or a .. in it
  // is a write outside that directory.
  test("never contains a path separator or a parent reference", () => {
    for (const u of [
      "https://evil.test/../../etc/passwd",
      "https://evil.test/a/b/c/d",
      "/tmp/../../../etc/passwd.m4a",
      "https://x.com/..%2F..%2Fetc",
    ]) {
      const n = transcriptFileName(u)
      expect(n).not.toContain("/")
      expect(n).not.toContain("\\")
      expect(n).not.toContain("..")
    }
  })

  test("always produces a usable .txt name, even for junk input", () => {
    for (const u of ["", "   ", "https://", "????", "https://x.com/"]) {
      const n = transcriptFileName(u)
      expect(n.endsWith("-transcript.txt")).toBe(true)
      expect(n.length).toBeGreaterThan("-transcript.txt".length)
    }
  })
})

describe("treatmentWarning — the treatment that quietly did not run", () => {
  // The measured #183796 case: --treatment playbook, server 422s, raw text written, "Saved".
  test("an explicit treatment that did not change the text warns, and names it", () => {
    const w = treatmentWarning("playbook", false)
    expect(w).not.toBeNull()
    expect(w).toContain("playbook")
  })

  test("a treatment that ran says nothing", () => {
    expect(treatmentWarning("meeting", true)).toBeNull()
  })

  test("raw is not a treatment and never warns", () => {
    expect(treatmentWarning("raw", false)).toBeNull()
  })

  test("no treatment requested never warns", () => {
    expect(treatmentWarning(undefined, false)).toBeNull()
    expect(treatmentWarning("", false)).toBeNull()
  })
})

describe("isStructuredTreatment — sop and playbook go to a different endpoint", () => {
  // These three were the only treatments that 422'd. sop and playbook 422 because /walkthrough/treat
  // is the wrong endpoint for them: /walkthrough/structure produces exactly these two and works
  // (verified 2026-09-05 via `iris playbook draft`, HTTP 200, real playbook out).
  test("sop and playbook are structured", () => {
    expect(isStructuredTreatment("sop")).toBe(true)
    expect(isStructuredTreatment("playbook")).toBe(true)
  })

  // article also 422s but has NO structure endpoint, so it must NOT be routed there — it would
  // trade a visible failure for a confusing one.
  test("article is not structured — there is no endpoint that produces it", () => {
    expect(isStructuredTreatment("article")).toBe(false)
  })

  test("ordinary treatments are not structured", () => {
    for (const t of ["clean", "notes", "meeting", "standup", "captions", "idea", "bugreport"]) {
      expect(isStructuredTreatment(t)).toBe(false)
    }
  })

  test("raw, empty and undefined are not structured", () => {
    expect(isStructuredTreatment("raw")).toBe(false)
    expect(isStructuredTreatment("")).toBe(false)
    expect(isStructuredTreatment(undefined)).toBe(false)
  })
})
