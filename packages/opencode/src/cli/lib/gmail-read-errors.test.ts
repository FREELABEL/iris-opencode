import { describe, expect, mock, test } from "bun:test"

let reply: { status: number; body: any } = { status: 200, body: {} }
mock.module("../cmd/iris-api", () => ({
  IRIS_API: "http://x",
  resolveUserId: async () => 1,
  irisFetch: async () => new Response(JSON.stringify(reply.body), { status: reply.status }),
}))

const { getMessageById } = await import("./gmail")

// #189385 — every failure used to come back as null, which the command prints as "not found".
describe("getMessageById", () => {
  test("returns the message", async () => {
    reply = { status: 200, body: { success: true, data: { success: true, email: { id: "abc", subject: "Fax", labels: ["UNREAD"] } } } }
    const m = await getMessageById("", "abc")
    expect(m?.id).toBe("abc")
    expect(m?.is_unread).toBe(true)
  })

  test("a backend failure surfaces its reason instead of 'not found'", async () => {
    reply = { status: 500, body: { error: "Composio: connected account EXPIRED" } }
    await expect(getMessageById("", "abc")).rejects.toThrow(/EXPIRED/)
  })

  test("Gmail's own 404 still means not found", async () => {
    reply = { status: 200, body: { success: false, error: "Requested entity was not found." } }
    expect(await getMessageById("", "nope")).toBeNull()
  })
})

describe("getMessageById with the backend's empty id (#189389)", () => {
  test("a message with content but id:\"\" is the message that was asked for", async () => {
    reply = { status: 200, body: { success: true, data: { success: true, email: { id: "", thread_id: "abc", from: "RingCentral", subject: "[Fax]", labels: [] } } } }
    expect((await getMessageById("", "abc"))?.id).toBe("abc")
  })
  test("an empty object is still not found", async () => {
    reply = { status: 200, body: { success: true, data: { success: true, email: {} } } }
    expect(await getMessageById("", "abc")).toBeNull()
  })
})
