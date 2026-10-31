import { describe, expect, mock, test } from "bun:test"

// 2026-10-09: `iris gmail unread` showed 10, every listing was capped at 100, and the page token was
// thrown away — an agent could not see past the first page. The server pages Composio itself and
// returns nextPageToken; the CLI must ask for more and follow the token.
const calls: any[] = []
mock.module("../../src/cli/cmd/iris-api", () => ({
  IRIS_API: "https://x",
  resolveUserId: async () => 7,
  irisFetch: async (_p: string, init: any) => {
    const body = JSON.parse(init.body)
    calls.push(body.params)
    const page = Number(String(body.params.page_token ?? "0").replace("T", "")) || 0
    const n = Math.min(body.params.max_results, 3)          // a 9-message mailbox, 3 per server page
    const msgs = Array.from({ length: n }, (_, i) => ({ messageId: `m${page * 3 + i}`, subject: "s" }))
    const next = page < 2 ? `T${page + 1}` : null
    return new Response(JSON.stringify({ success: true, data: { messages: msgs, nextPageToken: next } }), { status: 200 })
  },
}))

describe("iris gmail listings", () => {
  test("asks for as many as requested (no 100 cap) and reports there is more", async () => {
    const { listMessages, nextPageToken } = await import("../../src/cli/lib/gmail")
    calls.length = 0
    const m = await listMessages("", "is:unread", 2)
    expect(calls[0]).toMatchObject({ query: "is:unread", max_results: 2 })
    expect(m).toHaveLength(2)
    expect(nextPageToken()).toBe("T1")

    calls.length = 0
    await listMessages("", "in:inbox", 450)
    expect(calls[0].max_results).toBe(450)
  })

  test("--all follows the token until the mailbox runs out; a token is sent as a string", async () => {
    const { listMessages, nextPageToken } = await import("../../src/cli/lib/gmail")
    calls.length = 0
    const all = await listMessages("", "subject:fax", 50, { all: true })
    expect(all.map((x) => x.id)).toEqual(["m0", "m1", "m2", "m3", "m4", "m5", "m6", "m7", "m8"])
    expect(calls.map((c) => c.page_token ?? null)).toEqual([null, "T1", "T2"])
    expect(nextPageToken()).toBeNull()

    calls.length = 0
    await listMessages("", "x", 3, { pageToken: 12345 as any })
    expect(calls[0].page_token).toBe("12345")
  })
})
