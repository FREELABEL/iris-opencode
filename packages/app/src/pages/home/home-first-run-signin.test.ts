import { describe, expect, test } from "bun:test"
import { refusedClaim } from "./home-first-run-signin"

describe("a licence or trial refused at verification is said out loud (#191962)", () => {
  test("a refused licence names its reason", () => {
    expect(refusedClaim({ data: { license_claim: { granted: false, kind: "license", error: "That key is used up." } } })).toBe("That key is used up.")
  })
  test("a refused trial names its reason", () => {
    expect(refusedClaim({ data: { trial_claim: { granted: false, kind: "promo", error: "Promo expired." } } })).toBe("Promo expired.")
  })
  test("a refusal with no reason still says something", () => {
    expect(refusedClaim({ data: { trial_claim: { granted: false } } })).toBe("That code could not be applied.")
  })
  test("granted, or absent (nothing held, or a racing verify won): nothing to say", () => {
    expect(refusedClaim({ data: { license_claim: { granted: true }, trial_claim: { granted: true } } })).toBe("")
    expect(refusedClaim({ data: {} })).toBe("")
    expect(refusedClaim(undefined)).toBe("")
  })
})
