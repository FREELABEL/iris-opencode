import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fs from "fs"
import * as os from "os"
import * as pathNode from "path"
import {
  pullProblem,
  pullSessionPath,
  pullSessions,
  pushSessions,
  pushProblem,
  sessionProblem,
  writeSessionFile,
} from "../../src/cli/cmd/platform-som-sessions"

// #191640 — @thediscoverpage_ and @freelabelnet both run on board 80. The cloud kept one login per
// board, so push/pull wrote one account's login under the other's name. Every session here is FAKE.
const fake = (igUserId: string, stamp?: { handle: string; userId?: string }) => ({
  cookies: [
    { name: "ds_user_id", value: igUserId, domain: ".instagram.com" },
    { name: "sessionid", value: `fake-${igUserId}`, domain: ".instagram.com" },
  ],
  origins: [],
  ...(stamp ? { iris_verified: { handle: stamp.handle, userId: stamp.userId ?? igUserId, verifiedAt: "2026-10-28T20:00:00Z" } } : {}),
})

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(pathNode.join(os.tmpdir(), "som-191640-")) })
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("two handles, one board", () => {
  test("pull asks for the handle, not just the board", () => {
    const a = new URL(pullSessionPath("@TheDiscoverPage_", 80, 193), "http://x")
    const b = new URL(pullSessionPath("freelabelnet", 80, 193), "http://x")
    expect(a.searchParams.get("account_handle")).toBe("thediscoverpage_")
    expect(b.searchParams.get("account_handle")).toBe("freelabelnet")
    expect(a.toString()).not.toBe(b.toString())
  })

  test("a board-keyed answer carrying the OTHER account's login is refused, not written", () => {
    // What an old API returns for board 80: the board's newest row — @freelabelnet's.
    const body = { credentials: fake("222", { handle: "freelabelnet" }) }
    expect(pullProblem([dir], "thediscoverpage_", body)).toContain("@freelabelnet's login")
    expect(pullProblem([dir], "freelabelnet", body)).toBe("")
  })

  test("an answer labelled for a different handle is refused", () => {
    const body = { account_handle: "freelabelnet", credentials: fake("111", { handle: "thediscoverpage_" }) }
    expect(pullProblem([dir], "thediscoverpage_", body)).toContain("answered with @freelabelnet")
  })

  test("pull refuses a login another local account file already holds", () => {
    writeSessionFile(dir, "freelabelnet", fake("222", { handle: "freelabelnet" }))
    const body = { account_handle: "thediscoverpage_", credentials: fake("222", { handle: "thediscoverpage_" }) }
    expect(pullProblem([dir], "thediscoverpage_", body)).toContain("instagram-auth-freelabelnet.json holds the same")
  })

  test("each handle's own proven session is accepted", () => {
    writeSessionFile(dir, "freelabelnet", fake("222", { handle: "freelabelnet" }))
    const body = { account_handle: "thediscoverpage_", credentials: fake("111", { handle: "thediscoverpage_" }) }
    expect(pullProblem([dir], "thediscoverpage_", body)).toBe("")
  })
})

describe("push refuses a session that is not the handle", () => {
  test("unstamped", () => {
    expect(pushProblem([dir], "thediscoverpage_", fake("111"))).toContain("never verified")
  })
  test("stamped as someone else", () => {
    expect(pushProblem([dir], "thediscoverpage_", fake("222", { handle: "freelabelnet" }))).toContain("@freelabelnet's login")
  })
  test("login changed since the stamp", () => {
    expect(pushProblem([dir], "thediscoverpage_", fake("222", { handle: "thediscoverpage_", userId: "111" }))).toContain("no longer holds")
  })
  test("logged out", () => {
    expect(sessionProblem("thediscoverpage_", { cookies: [] })).toContain("not logged in")
  })
  test("byte-identical copy under two names (the #191635 state) is refused for both", () => {
    const s = fake("222", { handle: "freelabelnet" })
    writeSessionFile(dir, "freelabelnet", s)
    writeSessionFile(dir, "thediscoverpage_", s)
    expect(pushProblem([dir], "thediscoverpage_", s)).not.toBe("")
    expect(pushProblem([dir], "freelabelnet", s)).toContain("instagram-auth-thediscoverpage_.json holds the same")
  })
  test("a proven, distinct session may be pushed", () => {
    writeSessionFile(dir, "freelabelnet", fake("222", { handle: "freelabelnet" }))
    expect(pushProblem([dir], "thediscoverpage_", fake("111", { handle: "thediscoverpage_" }))).toBe("")
  })
})

test("writeSessionFile is owner-only and keeps the stamp", () => {
  const f = writeSessionFile(dir, "@FreeLabelNet", fake("222", { handle: "freelabelnet" }))
  expect(pathNode.basename(f)).toBe("instagram-auth-freelabelnet.json")
  expect(fs.statSync(f).mode & 0o777).toBe(0o600)
  expect(JSON.parse(fs.readFileSync(f, "utf8")).iris_verified.handle).toBe("freelabelnet")
})

// ── The loops the commands run, against a fake API ────────────────────────────
const board80 = [
  { id: "c1", boardId: "80", igAccount: "thediscoverpage_" },
  { id: "c2", boardId: "80", igAccount: "freelabelnet" },
]
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
const fileUser = (d: string, h: string) => {
  const f = pathNode.join(d, `instagram-auth-${h}.json`)
  if (!fs.existsSync(f)) return null
  return JSON.parse(fs.readFileSync(f, "utf8")).cookies.find((c: any) => c.name === "ds_user_id").value
}

describe("pull-sessions, two handles on board 80", () => {
  test("against a board-keyed API (one login per board) it never writes one account's login under the other's name", async () => {
    // The old store: whatever is newest on board 80, whoever asks — @freelabelnet's login.
    const oldApi = async (p: string) => {
      const q = new URL(p, "http://x").searchParams
      return q.get("bloq_id") === "80" ? json(200, { credentials: fake("222", { handle: "freelabelnet" }) }) : json(404, {})
    }
    const results = await pullSessions(board80, 193, [dir], oldApi)
    expect(fileUser(dir, "thediscoverpage_")).toBeNull()
    expect(fileUser(dir, "freelabelnet")).toBe("222")
    expect(results.find((r) => r.account === "thediscoverpage_")!.status).toContain("refused")
  })

  test("against the per-handle API each account gets its own login", async () => {
    const store: Record<string, unknown> = {
      thediscoverpage_: fake("111", { handle: "thediscoverpage_" }),
      freelabelnet: fake("222", { handle: "freelabelnet" }),
    }
    const api = async (p: string) => {
      const h = new URL(p, "http://x").searchParams.get("account_handle")!
      return store[h] ? json(200, { account_handle: h, credentials: store[h] }) : json(404, {})
    }
    const results = await pullSessions(board80, 193, [dir], api)
    expect(results.map((r) => r.status)).toEqual(["pulled", "pulled"])
    expect(fileUser(dir, "thediscoverpage_")).toBe("111")
    expect(fileUser(dir, "freelabelnet")).toBe("222")
  })

  test("an API refusal is reported, nothing written", async () => {
    const api = async () => json(409, { error: "ambiguous_board_session", message: "Board 80 holds Instagram sessions for @a and @b" })
    const results = await pullSessions(board80.slice(0, 1), 193, [dir], api)
    expect(results[0].status).toContain("refused (409)")
    expect(fileUser(dir, "thediscoverpage_")).toBeNull()
  })
})

describe("push-sessions, two handles on board 80", () => {
  test("uploads each proven session under its own handle and refuses the unproven one", async () => {
    writeSessionFile(dir, "freelabelnet", fake("222", { handle: "freelabelnet" }))
    writeSessionFile(dir, "thediscoverpage_", fake("111")) // never verified
    const posted: any[] = []
    const api = async (_p: string, init?: RequestInit) => { posted.push(JSON.parse(String(init!.body))); return json(201, {}) }
    const results = await pushSessions(board80, 193, [dir], api)
    expect(posted.map((b) => b.account_handle)).toEqual(["freelabelnet"])
    expect(posted[0].bloq_id).toBe(80)
    expect(results.find((r) => r.account === "thediscoverpage_")!.status).toContain("never verified")
  })

  test("the #191635 state — one login copied under both names — uploads neither", async () => {
    const s = fake("222", { handle: "freelabelnet" })
    writeSessionFile(dir, "freelabelnet", s)
    writeSessionFile(dir, "thediscoverpage_", s)
    const posted: any[] = []
    const api = async (_p: string, init?: RequestInit) => { posted.push(init); return json(201, {}) }
    await pushSessions(board80, 193, [dir], api)
    expect(posted).toHaveLength(0)
  })
})
