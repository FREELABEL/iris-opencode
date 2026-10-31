import { afterEach, describe, expect, test } from "bun:test"
import { fixFor, githubToken, parseResult, readiness } from "./platform-hive-proof"

const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" })
const fail = () => ({ status: 1, stdout: "", stderr: "nope" })
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("iris hive proof (#188292)", () => {
  test("the GitHub token comes from the environment first, then the user's own gh login", () => {
    expect(githubToken({ GITHUB_TOKEN: " t1 " }, () => ok("t2"))).toEqual({ token: "t1", source: "GITHUB_TOKEN in your environment" })
    expect(githubToken({}, () => ok("t2\n"))).toEqual({ token: "t2", source: "your gh login" })
    expect(githubToken({}, fail)).toEqual({ token: null, source: null })
  })

  test("every failure the recorder reports maps to a command the person can run", () => {
    expect(fixFor("no GitHub token: set GITHUB_TOKEN (or GH_TOKEN), or sign in with `gh auth login`")).toContain("gh auth login")
    expect(fixFor("GitHub 401 — the token is missing, expired or revoked")).toContain("gh auth login")
    expect(fixFor("upload produced no CDN URL: Not authenticated")).toContain("iris login")
    expect(fixFor("browserType.launch: Executable doesn't exist at /x/chromium")).toContain("iris node install")
    expect(fixFor("page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000")).toContain("app running")
    expect(fixFor("something nobody anticipated")).toBeUndefined()
  })

  test("the result is the last JSON line; progress noise before it is ignored", () => {
    expect(parseResult('Recording…\n{"partial": \n{"ok":true,"pr":"a/b#1"}\n')).toEqual({ ok: true, pr: "a/b#1" })
    expect(parseResult("crashed with no json")).toBeNull()
  })

  test("a stale gh login is reported as expired, not as connected — gh still prints the old token", async () => {
    globalThis.fetch = (async () => new Response("{}", { status: 401 })) as any
    const checks = await readiness({ env: {}, run: (c) => (c === "gh" ? ok("stale") : ok()), scriptExists: true, irisSignedIn: true })
    const gh = checks.find((c) => c.name === "GitHub")!
    expect(gh.ok).toBe(false)
    expect(gh.detail).toContain("expired")
    expect(gh.fix).toContain("gh auth login")
  })

  test("a machine that is not a Hive node is told to install, and nothing else is pretended ready", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ login: "dana" }), { status: 200 })) as any
    const checks = await readiness({ env: { GH_TOKEN: "t" }, run: () => ok(), scriptExists: false, irisSignedIn: false })
    expect(checks.find((c) => c.name === "Recorder")).toMatchObject({ ok: false, fix: "run `iris node install`" })
    expect(checks.find((c) => c.name === "Browser")).toBeUndefined()
    expect(checks.find((c) => c.name === "GitHub")).toMatchObject({ ok: true })
    expect(checks.find((c) => c.name === "IRIS")).toMatchObject({ ok: false, fix: "run `iris login`" })
  })

  test("missing ffmpeg is a note, not a blocker — the video still posts as WebM", async () => {
    globalThis.fetch = (async () => new Response(JSON.stringify({ login: "dana" }), { status: 200 })) as any
    const checks = await readiness({ env: { GH_TOKEN: "t" }, run: (c) => (c === "ffmpeg" ? fail() : ok()), scriptExists: true, irisSignedIn: true })
    expect(checks.every((c) => c.ok)).toBe(true)
    expect(checks.find((c) => c.name === "Video")!.detail).toContain("WebM")
  })
})
