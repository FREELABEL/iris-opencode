import { describe, expect, mock, test } from "bun:test"

// 2026-10-09: `iris gmail read <id>` sent read_emails{message_id}, which the server ignores, so it
// returned the NEWEST message whatever id was asked for. It must ask get_email for THAT id.
const calls: any[] = []
mock.module("../../src/cli/cmd/iris-api", () => ({
  IRIS_API: "https://x",
  resolveUserId: async () => 7,
  irisFetch: async (_path: string, init: any) => {
    const body = JSON.parse(init.body)
    calls.push(body)
    const reply = body.action === "get_email"
      ? { success: true, email: { id: body.params.message_id, thread_id: "t9", from: "Rodney <r@x.com>", to: "me@x.com", subject: "Article",
          body: "The article text.", labels: ["INBOX", "UNREAD"], mailbox: "me@x.com", integration_id: 148,
          attachments: [{ filename: "draft.pdf", type: "pdf", size: 2048, attachment_id: "A1" }] } }
      : { success: true, data: { messages: [{ messageId: "NEWEST", subject: "wrong" }] } }
    return new Response(JSON.stringify(reply), { status: 200 })
  },
}))

describe("iris gmail read", () => {
  test("asks the server for the requested message, not the inbox", async () => {
    const { getMessageById } = await import("../../src/cli/lib/gmail")
    const m = await getMessageById("", "1a12134d0dfdad5f")
    expect(calls.at(-1)).toMatchObject({ integration: "gmail", action: "get_email", params: { message_id: "1a12134d0dfdad5f" } })
    expect(m?.id).toBe("1a12134d0dfdad5f")
    expect(m?.body_text).toBe("The article text.")
    expect(m?.is_unread).toBe(true)
    expect(m?.mailbox).toBe("me@x.com")
    expect(m?.attachments?.[0]).toMatchObject({ filename: "draft.pdf", attachment_id: "A1" })
  })

  test("--thread refuses rather than returning the newest inbox messages as 'the thread'", async () => {
    const { getThread } = await import("../../src/cli/lib/gmail")
    const before = calls.length
    expect(await getThread("", "t9")).toBeNull()
    expect(calls.length).toBe(before)
  })
})
