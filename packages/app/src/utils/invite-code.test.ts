import { describe, expect, test } from "bun:test"
import { withInviteCode } from "./invite-code"

describe("invite_code on sign-in (#194525)", () => {
  test("added only when there is a code", () => {
    const body = { email: "a@b.test", login_code: "123456", generate_sdk_token: true }
    expect(withInviteCode(body, "abc123")).toEqual({ ...body, invite_code: "abc123" })
    expect(withInviteCode(body, null)).toEqual(body)
  })
})
