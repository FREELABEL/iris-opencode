import { describe, expect, test } from "bun:test"
import { MAX_CODE_TRIES, codeTriesLeftLine, isWrongCodeFailure, loginCodeError } from "../../src/cli/cmd/login-code"

describe("iris auth login — the emailed code", () => {
  test("a code is exactly 6 digits; 5 digits is caught before it is sent", () => {
    expect(loginCodeError("730072")).toBeUndefined()
    expect(loginCodeError(" 730 072 ")).toBeUndefined()
    expect(loginCodeError("16677")).toBe("The code is 6 digits — check it and type it again")
    expect(loginCodeError("1234567")).toBe("The code is 6 digits — check it and type it again")
    expect(loginCodeError("")).toBe("Enter the 6-digit code from your email")
    expect(loginCodeError("abc123")).toBe("The code is only numbers — check it and type it again")
  })

  test("three tries at the same emailed code", () => {
    expect(MAX_CODE_TRIES).toBe(3)
    expect(codeTriesLeftLine(1)).toBe("That code didn't work. 2 tries left — type it again.")
    expect(codeTriesLeftLine(2)).toBe("That code didn't work. 1 try left — type it again.")
  })

  test("only a mistyped code is retried — the server's own answers", () => {
    expect(isWrongCodeFailure(400, { success: false, error: "Invalid login code" })).toBe(true)
    expect(isWrongCodeFailure(422, { success: false, error: "Invalid request data" })).toBe(true)
    expect(isWrongCodeFailure(400, { success: false, error: "Login code has expired" })).toBe(false)
    expect(isWrongCodeFailure(400, { success: false, error: "Login code expired or not found" })).toBe(false)
    expect(isWrongCodeFailure(429, { success: false, error: "Too many incorrect attempts. Please request a new code." })).toBe(false)
    expect(isWrongCodeFailure(404, { success: false, error: "User not found" })).toBe(false)
    expect(isWrongCodeFailure(500, { success: false })).toBe(false)
  })
})
