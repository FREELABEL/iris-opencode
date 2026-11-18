import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  buildKeywordDmBody,
  sendBody,
  keywordDmTimeoutMs,
  postKeywordDm,
  fetchKeywordDmLedger,
  isInstagramPostUrl,
  InstagramKeywordDmCommand,
  DAEMON_TOO_OLD,
  KEYWORD_DM_MAX_CEILING,
} from "./platform-instagram"

/**
 * FL-CO-47 (#190735) — `iris instagram keyword-dm`. "Comment PIPELINE and I'll send it": DM everyone
 * who commented the keyword, through the daemon's POST /api/instagram/keyword-dm.
 *
 * What these pin is the safety contract on the CLI side: nothing is sent without --send; with --send
 * the CLI previews first and then sends ONLY to the handles it showed; no terminal + --send without
 * --yes is refused before any request; and an old daemon (404, no route) says the daemon needs
 * updating. The bridge is never reached — globalThis.fetch is replaced in every test.
 */

const POST = "https://www.instagram.com/p/ABC123/"
const realFetch = globalThis.fetch
let calls: { url: string; init: RequestInit; body: any }[]
let replies: Response[]
const savedEnv = { ni: process.env.IRIS_NON_INTERACTIVE, exit: process.exitCode }

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  calls = []
  replies = []
  process.env.IRIS_NON_INTERACTIVE = "1"
  process.exitCode = 0
  globalThis.fetch = (async (input: any, init: RequestInit = {}) => {
    const body = typeof init.body === "string" ? JSON.parse(init.body) : undefined
    calls.push({ url: String(input), init, body })
    const next = replies.shift()
    if (!next) throw new Error("test made an unexpected bridge call")
    return next
  }) as typeof fetch
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (savedEnv.ni === undefined) delete process.env.IRIS_NON_INTERACTIVE
  else process.env.IRIS_NON_INTERACTIVE = savedEnv.ni
  process.exitCode = savedEnv.exit
})

describe("argument validation", () => {
  test("accepts post and reel links, refuses profiles and other sites", () => {
    expect(isInstagramPostUrl(POST)).toBe(true)
    expect(isInstagramPostUrl("https://instagram.com/reel/XyZ_9-a/?igsh=1")).toBe(true)
    expect(isInstagramPostUrl("https://www.instagram.com/heyiris.io/")).toBe(false)
    expect(isInstagramPostUrl("https://example.com/p/ABC")).toBe(false)
  })

  test("a good call becomes a dry-run body with the default cap", () => {
    const r = buildKeywordDmBody({ url: POST, keyword: " PIPELINE , GUIDE ,", message: "here {handle}", account: "@heyiris.io" })
    expect(r).toEqual({ body: { postUrl: POST, keyword: "PIPELINE,GUIDE", message: "here {handle}", account: "heyiris.io", max: 10, send: false } })
  })

  test("--send never leaks into the preview body", () => {
    const r = buildKeywordDmBody({ url: POST, keyword: "a", message: "b", send: true } as any)
    expect("body" in r && r.body.send).toBe(false)
  })

  test("--max is clamped to the hard ceiling and must be a positive whole number", () => {
    const big = buildKeywordDmBody({ url: POST, keyword: "a", message: "b", max: 500 })
    expect("body" in big && big.body.max).toBe(KEYWORD_DM_MAX_CEILING)
    for (const max of [0, -1, 2.5, NaN]) {
      expect(buildKeywordDmBody({ url: POST, keyword: "a", message: "b", max })).toEqual({ error: "--max must be a whole number of at least 1" })
    }
  })

  test("missing or bad pieces are named", () => {
    expect((buildKeywordDmBody({ url: "https://www.instagram.com/heyiris.io/", keyword: "a", message: "b" }) as any).error).toMatch(/post-url/)
    expect((buildKeywordDmBody({ url: POST, keyword: " , ", message: "b" }) as any).error).toMatch(/--keyword/)
    expect((buildKeywordDmBody({ url: POST, keyword: "a", message: "  " }) as any).error).toMatch(/--message/)
    expect((buildKeywordDmBody({ url: POST, keyword: "a", message: "x".repeat(1001) }) as any).error).toMatch(/1000/)
    expect((buildKeywordDmBody({ url: POST, keyword: "a", message: "b", account: "not a handle" }) as any).error).toMatch(/--account/)
  })

  test("--ledger needs only the post URL", () => {
    expect("body" in buildKeywordDmBody({ url: POST, ledger: true })).toBe(true)
  })
})

describe("request shaping", () => {
  const preview = { postUrl: POST, keyword: "PIPELINE", message: "hi", max: 3, send: false }

  test("the send body is the preview, sending, limited to the confirmed handles", () => {
    expect(sendBody(preview, ["alice", "erin"])).toEqual({ ...preview, send: true, handles: ["alice", "erin"] })
    expect(preview.send).toBe(false)
  })

  test("a send gets room for the gaps between DMs; a dry run does not need it", () => {
    expect(keywordDmTimeoutMs(preview)).toBe(11 * 60_000)
    expect(keywordDmTimeoutMs({ ...preview, send: true, max: 3 })).toBe(13 * 60_000)
  })

  test("POSTs JSON to the daemon route", async () => {
    replies.push(json(200, { ok: true, targets: [] }))
    await postKeywordDm(preview)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toEndWith("/api/instagram/keyword-dm")
    expect(calls[0].init.method).toBe("POST")
    expect((calls[0].init.headers as Record<string, string>)["Content-Type"]).toBe("application/json")
    expect(calls[0].body).toEqual(preview)
  })

  test("a daemon without the route (Express 404 page) is told to update", async () => {
    replies.push(new Response("<pre>Cannot POST /api/instagram/keyword-dm</pre>", { status: 404 }))
    await expect(postKeywordDm(preview)).rejects.toThrow(DAEMON_TOO_OLD)
    replies.push(new Response("Cannot GET", { status: 404 }))
    await expect(fetchKeywordDmLedger(POST)).rejects.toThrow(DAEMON_TOO_OLD)
  })

  test("the route's own 404 (no saved session) is shown as-is, not as an old daemon", async () => {
    replies.push(json(404, { error: "No Instagram session found. Save one: iris hive credentials save-session --platform instagram" }))
    await expect(postKeywordDm(preview)).rejects.toThrow(/save-session/)
  })

  test("a run that stopped (502) still returns its summary; a busy daemon (409) is an error", async () => {
    replies.push(json(502, { ok: false, results: [{ handle: "a", status: "failed" }], stoppedReason: "session expired" }))
    expect((await postKeywordDm(preview)).stoppedReason).toBe("session expired")
    replies.push(json(409, { error: "a keyword DM run is already in progress" }))
    await expect(postKeywordDm(preview)).rejects.toThrow(/already in progress/)
  })

  test("the ledger is read for the encoded post URL", async () => {
    replies.push(json(200, { entries: [], sent: 0 }))
    await fetchKeywordDmLedger(POST)
    expect(calls[0].url).toEndWith(`/api/instagram/keyword-dm/ledger?postUrl=${encodeURIComponent(POST)}`)
  })
})

describe("the command", () => {
  const run = (extra: Record<string, unknown>) =>
    (InstagramKeywordDmCommand.handler as any)({ postUrl: POST, keyword: "PIPELINE", message: "hi {handle}", max: 10, json: true, ...extra })

  test("without --send: one dry-run call, nothing sent", async () => {
    replies.push(json(200, { ok: true, dry: true, targets: [{ handle: "alice" }] }))
    await run({ send: false })
    expect(calls).toHaveLength(1)
    expect(calls[0].body.send).toBe(false)
  })

  test("--send with no terminal and no --yes is refused before any request", async () => {
    await run({ send: true, yes: false })
    expect(calls).toHaveLength(0)
    expect(process.exitCode).toBe(1)
  })

  test("--send --yes previews, then sends to exactly the previewed handles", async () => {
    replies.push(json(200, { ok: true, dry: true, account: "heyiris.io", targets: [{ handle: "alice" }, { handle: "erin" }] }))
    replies.push(json(200, { ok: true, sent: 2, failed: 0, results: [] }))
    await run({ send: true, yes: true })
    expect(calls).toHaveLength(2)
    expect(calls[0].body.send).toBe(false)
    expect(calls[1].body).toMatchObject({ send: true, handles: ["alice", "erin"], keyword: "PIPELINE" })
  })

  test("--send with nobody to message makes no second call", async () => {
    replies.push(json(200, { ok: true, dry: true, targets: [] }))
    await run({ send: true, yes: true })
    expect(calls).toHaveLength(1)
  })

  test("a bad argument fails without touching the bridge", async () => {
    await run({ keyword: "" })
    expect(calls).toHaveLength(0)
    expect(process.exitCode).toBe(1)
  })
})
