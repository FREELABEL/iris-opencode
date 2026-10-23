import { describe, expect, test } from "bun:test"
import type { SpawnSyncReturns } from "child_process"
import { fetchWithYtDlp, isDirectMediaUrl, isStaleSignatureError, ytDlpAgeDays, type FetchOptions } from "./media-fetch"
import { ensureYtDlp } from "./download"
import { findYtDlp } from "./transcribe"

type Call = { bin: string; args: string[] }

/** A fake yt-dlp: `answer` decides each run's exit status, stdout and stderr from its argv. */
function fake(answer: (args: string[], n: number) => Partial<SpawnSyncReturns<string>>) {
  const calls: Call[] = []
  const run: FetchOptions["run"] = (bin, args) => {
    calls.push({ bin, args })
    return { pid: 0, output: [], stdout: "", stderr: "", status: 1, signal: null, ...answer(args, calls.length) } as SpawnSyncReturns<string>
  }
  return { run, calls }
}
const cookieOf = (args: string[]) => (args.includes("--cookies-from-browser") ? args[args.indexOf("--cookies-from-browser") + 1] : null)
const formatOf = (args: string[]) => (args[0] === "-f" ? args[1] : null)

describe("#190460 — one ladder for every download", () => {
  test("stops at the first attempt that leaves the file behind", () => {
    const { run, calls } = fake(() => ({ status: 0 }))
    const r = fetchWithYtDlp("yt-dlp", "https://y/1", { args: ["-o", "/o.mp4"], expect: "/o.mp4", run, exists: (p) => p === "/o.mp4", verbose: false })
    expect(r.ok).toBe(true)
    expect(r.path).toBe("/o.mp4")
    expect(calls).toHaveLength(1)
    expect(cookieOf(calls[0].args)).toBe("chrome")
    expect(calls[0].args.at(-1)).toBe("https://y/1")
  })

  test("walks every format × every cookie source, cookies first, in order", () => {
    const { run, calls } = fake(() => ({ status: 1, stderr: "ERROR: Unsupported URL" }))
    const r = fetchWithYtDlp("yt-dlp", "u", { formats: ["a", null], args: [], expect: "/x", run, exists: () => false, verbose: false })
    expect(r.ok).toBe(false)
    expect(calls.map((c) => [formatOf(c.args), cookieOf(c.args)])).toEqual([
      ["a", "chrome"], ["a", "firefox"], ["a", "safari"], ["a", null],
      [null, "chrome"], [null, "firefox"], [null, "safari"], [null, null],
    ])
    expect(r.error).toBe("ERROR: Unsupported URL")
    expect(r.updated).toBe(false)
    expect(r.attempts).toHaveLength(8)
  })

  test("exit 0 without the expected file is not success", () => {
    const { run } = fake(() => ({ status: 0 }))
    const r = fetchWithYtDlp("yt-dlp", "u", { args: [], expect: "/missing", cookies: "none", run, exists: () => false, verbose: false })
    expect(r.ok).toBe(false)
  })

  test("#152290 — a stale-player failure self-updates once and runs the ladder again", () => {
    let updated = false
    const { run, calls } = fake((args) => {
      if (args[0] === "-U") { updated = true; return { status: 0 } }
      return updated ? { status: 0 } : { status: 1, stderr: "ERROR: nsig extraction failed" }
    })
    const r = fetchWithYtDlp("yt-dlp", "u", { args: [], expect: "/f", cookies: "none", run, exists: () => updated, verbose: false })
    expect(r.ok).toBe(true)
    expect(r.updated).toBe(true)
    expect(calls.filter((c) => c.args[0] === "-U")).toHaveLength(1)
  })

  test("no self-update when the failure is not about the player, or when asked not to", () => {
    const plain = fake(() => ({ status: 1, stderr: "ERROR: Private video" }))
    fetchWithYtDlp("yt-dlp", "u", { args: [], expect: "/f", cookies: "none", run: plain.run, exists: () => false, verbose: false })
    expect(plain.calls.some((c) => c.args[0] === "-U")).toBe(false)

    const off = fake(() => ({ status: 1, stderr: "Requested format is not available" }))
    fetchWithYtDlp("yt-dlp", "u", { args: [], expect: "/f", cookies: "none", selfUpdate: false, run: off.run, exists: () => false, verbose: false })
    expect(off.calls.some((c) => c.args[0] === "-U")).toBe(false)
  })

  test("a run that printed results is not stale — partial output is kept, no update", () => {
    const { run, calls } = fake(() => ({ status: 1, stdout: "id1\nid2\n", stderr: "ERROR: [youtube] x: Requested format is not available" }))
    const r = fetchWithYtDlp("yt-dlp", "u", { args: ["--print", "%(id)s"], cookies: "none", run, verbose: false })
    expect(r.ok).toBe(false)
    expect(r.stdout).toBe("id1\nid2\n")
    expect(calls.some((c) => c.args[0] === "-U")).toBe(false)
  })

  test("without `expect`, success is exit 0 with something on stdout", () => {
    const { run } = fake(() => ({ status: 0, stdout: '{"title":"t"}' }))
    const r = fetchWithYtDlp("yt-dlp", "u", { args: ["--dump-json"], cookies: "none", run, verbose: false })
    expect(r.ok).toBe(true)
    expect(JSON.parse(r.stdout!).title).toBe("t")
  })

  test("a timeout says so, and names the partial file left behind", () => {
    const { run } = fake(() => ({ status: null, signal: "SIGTERM" as NodeJS.Signals }))
    const r = fetchWithYtDlp("yt-dlp", "u", { args: [], expect: "/v.mp4", cookies: "none", timeoutMs: 60_000, run, exists: (p) => p === "/v.mp4.part", verbose: false })
    expect(r.timedOut).toBe(true)
    expect(r.error).toBe("yt-dlp timed out after 60s (incomplete /v.mp4.part left in place)")
  })

  test("the full stderr is kept, not only the last line", () => {
    const { run } = fake(() => ({ status: 1, stderr: "WARNING: [youtube] nsig failed\nERROR: Only images are available" }))
    const r = fetchWithYtDlp("yt-dlp", "u", { args: [], expect: "/f", cookies: "none", selfUpdate: false, run, exists: () => false, verbose: false })
    expect(r.error).toBe("ERROR: Only images are available")
    expect(r.stderr).toContain("nsig failed")
  })
})

describe("#190460 — helpers", () => {
  test("stale-signature detection", () => {
    expect(isStaleSignatureError("ERROR: Requested format is not available")).toBe(true)
    expect(isStaleSignatureError("WARNING: nsig extraction failed")).toBe(true)
    expect(isStaleSignatureError("ERROR: Private video")).toBe(false)
  })
  test("yt-dlp age from its date-stamped version", () => {
    const now = Date.UTC(2026, 9, 23)
    expect(ytDlpAgeDays("2026.10.13", now)).toBe(10)
    expect(ytDlpAgeDays("2026.07.01.123456", now)).toBe(114)
    expect(ytDlpAgeDays("nightly", now)).toBeNull()
  })
  test("direct media links skip yt-dlp; pages do not", () => {
    expect(isDirectMediaUrl("https://cdn.heyiris.io/cloud-files/1791159041_Again.mp3")).toBe(true)
    expect(isDirectMediaUrl("https://cdn.example.com/a%20b.WAV")).toBe(true)
    expect(isDirectMediaUrl("https://www.youtube.com/watch?v=zNlbLeU_HgQ")).toBe(false)
    expect(isDirectMediaUrl("ftp://x/a.mp3")).toBe(false)
    expect(isDirectMediaUrl("not a url")).toBe(false)
  })
  test("the old import paths still work", () => {
    expect(typeof ensureYtDlp).toBe("function")
    expect(typeof findYtDlp).toBe("function")
  })
})
