import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { CloseCommand, CommentCommand, fetchBugComments } from "./platform-bug"

/**
 * #191888: `bug close <id> --solution` with no --commit, run by anything without a terminal, wrote
 * nothing and exited 0 under the word "Done". `bug comment` appended to the description.
 */

const realFetch = globalThis.fetch
const realWrite = process.stdout.write
const realIsTty = process.stdin.isTTY
let requests: { url: string; method: string; body: any }[] = []
let stdout = ""

function respondWith(status: number, body: unknown) {
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    requests.push({ url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined })
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  }) as any
}

const done = { success: true, data: { status: "done", fix_commit: null } }

beforeEach(() => {
  requests = []
  stdout = ""
  process.exitCode = 0
  process.env.IRIS_API_KEY = "tok_test"
  process.env.IRIS_USER_ID = "193"
  ;(process.stdin as any).isTTY = false
  process.stdout.write = ((chunk: any, ...rest: any[]) => {
    stdout += String(chunk)
    rest.find((r) => typeof r === "function")?.()
    return true
  }) as any
})

afterEach(() => {
  globalThis.fetch = realFetch
  process.stdout.write = realWrite
  ;(process.stdin as any).isTTY = realIsTty
  process.exitCode = 0
  delete process.env.IRIS_API_KEY
  delete process.env.IRIS_USER_ID
})

const close = (args: Record<string, unknown>) => (CloseCommand as any).handler({ json: true, ...args })

describe("bug close", () => {
  test("no --commit and no terminal: the bug closes, with the solution and no guessed commit", async () => {
    respondWith(200, done)
    await close({ id: [191888], solution: "fixed", json: false })
    const posts = requests.filter((r) => r.url.includes("/resolve"))
    expect(posts.length).toBe(1)
    expect(posts[0].body.solution).toBe("fixed")
    expect(posts[0].body.fix_commit).toBeUndefined()
    expect(process.exitCode).toBe(0)
  })

  test("a batch with no --commit closes each bug and stamps none", async () => {
    respondWith(200, done)
    await close({ id: [1, 2, 3], solution: "fixed", json: false })
    const posts = requests.filter((r) => r.url.includes("/resolve"))
    expect(posts.length).toBe(3)
    expect(posts.every((p) => p.body.fix_commit === undefined)).toBe(true)
  })

  test("--commit is recorded when it is given", async () => {
    respondWith(200, done)
    await close({ id: [1], solution: "fixed", commit: "abc1234" })
    expect(requests[0].body.fix_commit).toBe("abc1234")
  })

  test("a 200 that does not say done is not reported as resolved", async () => {
    respondWith(200, { success: true, data: { status: "todo" } })
    const realExit = process.exit
    let code: number | undefined
    process.exit = ((c?: number) => {
      code = c
      throw new Error("exit")
    }) as any
    try {
      await close({ id: [1], solution: "fixed", commit: "abc1234" }).catch(() => {})
    } finally {
      process.exit = realExit
    }
    expect(code).toBe(1)
    const out = JSON.parse(stdout)
    expect(out.ok).toBe(0)
    expect(out.failed).toBe(1)
    expect(out.results[0].error).toContain("did not mark it done")
  })
})

describe("bug comment", () => {
  const comment = (args: Record<string, unknown>) => (CommentCommand as any).handler({ id: 42, text: ["hello", "there"], ...args })

  test("goes to the card's comment trail and never to the bug's description", async () => {
    respondWith(200, { success: true, data: { id: 9 } })
    await comment({})
    expect(requests.length).toBe(1)
    expect(requests[0].url).toContain("/api/v1/user/193/bloqs/list/item/42/comments")
    expect(requests[0].method).toBe("POST")
    expect(requests[0].body).toEqual({ body: "hello there" })
    expect(requests.some((r) => r.url.includes("/bug-report/"))).toBe(false)
    expect(process.exitCode).toBe(0)
  })

  test("no write access: a failure, with nothing quietly appended to the report", async () => {
    respondWith(404, { success: false, error: "Item not found" })
    await comment({ json: true })
    expect(process.exitCode).toBe(1)
    expect(requests.some((r) => r.url.includes("/bug-report/"))).toBe(false)
  })

  test("bug show reads comments oldest first, with who and when, and only comments", async () => {
    respondWith(200, {
      data: {
        activity: [
          { type: "comment", content: "second", actor: "B", created_at: "2026-10-31T02:00:00Z" },
          { type: "assign", content: "assigned", actor: "C", created_at: "2026-10-31T01:30:00Z" },
          { type: "comment", content: "first", actor: "A", created_at: "2026-10-31T01:00:00Z" },
        ],
      },
    })
    expect(await fetchBugComments(42)).toEqual([
      { who: "A", when: "2026-10-31T01:00:00Z", text: "first" },
      { who: "B", when: "2026-10-31T02:00:00Z", text: "second" },
    ])
  })
})
