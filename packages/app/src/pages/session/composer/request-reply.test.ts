import { describe, expect, test } from "bun:test"
import { requestGone, settleReply, withoutRequest } from "./request-reply"

// #191772: answering a request the server no longer had (answered in another column, a double
// click, a replied event that never arrived) showed "Request failed · Permission request not
// found: per_…" and left the card on screen to fail again.
describe("requestGone", () => {
  test("recognises the server's not-found answers in the shapes the clients throw", () => {
    expect(requestGone({ _tag: "PermissionNotFoundError", requestID: "per_1", message: "x" })).toBe(true)
    expect(requestGone({ _tag: "QuestionNotFoundError", requestID: "que_1", message: "x" })).toBe(true)
    expect(requestGone(new Error("Permission request not found: per_1"))).toBe(true)
    expect(requestGone({ data: { message: "Question request not found: que_1" } })).toBe(true)
    expect(requestGone({ error: { name: "PermissionNotFoundError" } })).toBe(true)
  })

  test("does not swallow real failures", () => {
    expect(requestGone(new Error("Failed to fetch"))).toBe(false)
    expect(requestGone({ _tag: "SessionBusyError", message: "busy" })).toBe(false)
    expect(requestGone({ message: "Session not found: ses_1" })).toBe(false)
    expect(requestGone(undefined)).toBe(false)
  })
})

describe("settleReply", () => {
  test("drops the card as soon as the server answers, without waiting for the event", async () => {
    let dropped = 0
    await settleReply(async () => true, () => dropped++)
    expect(dropped).toBe(1)
  })

  test("an already-answered request is dropped quietly, not reported as a failure", async () => {
    let dropped = 0
    await settleReply(
      async () => {
        throw { _tag: "PermissionNotFoundError", requestID: "per_1", message: "Permission request not found: per_1" }
      },
      () => dropped++,
    )
    expect(dropped).toBe(1)
  })

  test("any other failure is reported and the card stays to retry", async () => {
    let dropped = 0
    const failure = new Error("Failed to fetch")
    await expect(
      settleReply(
        async () => {
          throw failure
        },
        () => dropped++,
      ),
    ).rejects.toBe(failure)
    expect(dropped).toBe(0)
  })
})

describe("withoutRequest", () => {
  test("removes only the answered request", () => {
    const list = [{ id: "a" }, { id: "b" }]
    expect(withoutRequest(list, "a")).toEqual([{ id: "b" }])
    expect(withoutRequest(list, "zzz")).toBe(list)
    expect(withoutRequest(undefined, "a")).toBeUndefined()
  })
})
