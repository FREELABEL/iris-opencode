import { beforeEach, describe, expect, test } from "bun:test"
import {
  inviteCodeProblem,
  inviteSettled,
  normaliseInviteCode,
  pendingInviteCode,
  rememberInviteCode,
  settleInvite,
  signInInvite,
  withInviteCode,
} from "./invite-code"

beforeEach(() => localStorage.clear())

describe("invite_code on sign-in (#194525)", () => {
  test("added only when there is a code", () => {
    const body = { email: "a@b.test", login_code: "123456", generate_sdk_token: true }
    expect(withInviteCode(body, "abc123")).toEqual({ ...body, invite_code: "abc123" })
    expect(withInviteCode(body, null)).toEqual(body)
  })
})

describe("the invite code itself (#194575)", () => {
  test("normalised the way fl-api normalises it: trimmed, lowercased, 4–32 letters and digits", () => {
    expect(normaliseInviteCode("  FrIeNd42\n")).toBe("friend42")
    expect(normaliseInviteCode("abcd")).toBe("abcd")
    expect(normaliseInviteCode("x".repeat(32))).toBe("x".repeat(32))
    for (const bad of ["abc", "x".repeat(33), "friend-42", "friend_42", "fri end", "", "   ", null, undefined, 42])
      expect(normaliseInviteCode(bad)).toBeNull()
  })

  test("only a typed code that can't be one gets a hint; empty is fine", () => {
    expect(inviteCodeProblem("")).toBeNull()
    expect(inviteCodeProblem("  ")).toBeNull()
    expect(inviteCodeProblem(" Friend42 ")).toBeNull()
    expect(inviteCodeProblem("no!")).toBe("That code doesn't look right")
  })
})

describe("which invite rides on sign-in (#194575)", () => {
  test("the typed field, normalised", () => {
    expect(signInInvite({ open: true, typed: " FRIEND42 ", remembered: null })).toEqual({ code: "friend42", note: null })
  })

  test("the typed field wins over a remembered link", () => {
    expect(signInInvite({ open: true, typed: "typed1", remembered: "linked1" }).code).toBe("typed1")
  })

  test("a typed code that doesn't look right is dropped with a note — never blocks sign-in", () => {
    expect(signInInvite({ open: true, typed: "no!", remembered: "linked1" })).toEqual({
      code: null,
      note: "That code doesn't look right, so you'll sign in without it.",
    })
  })

  test("field closed or left empty: the remembered link's code, if it can be one", () => {
    expect(signInInvite({ open: false, typed: "ignored", remembered: "Linked1" }).code).toBe("linked1")
    expect(signInInvite({ open: true, typed: "  ", remembered: "linked1" }).code).toBe("linked1")
    expect(signInInvite({ open: false, typed: "", remembered: "a_b" })).toEqual({ code: null, note: null })
    expect(signInInvite({ open: false, typed: "", remembered: null })).toEqual({ code: null, note: null })
  })

  test("the typed code reaches login-with-code as invite_code", () => {
    const inv = signInInvite({ open: true, typed: " Friend42", remembered: null })
    const body = withInviteCode({ email: "a@b.test", login_code: "123456" }, inv.code)
    expect(body).toEqual({ email: "a@b.test", login_code: "123456", invite_code: "friend42" })
  })
})

describe("remembered on this machine", () => {
  test("a pending code and the settled flag survive in localStorage", () => {
    expect(pendingInviteCode()).toBeNull()
    rememberInviteCode("friend42")
    expect(pendingInviteCode()).toBe("friend42")
    expect(inviteSettled()).toBe(false)
    settleInvite()
    expect(inviteSettled()).toBe(true)
  })
})
