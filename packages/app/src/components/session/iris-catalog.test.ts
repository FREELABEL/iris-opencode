import { describe, expect, test } from "bun:test"
import { connectsBy, healthRead, metaLine, usageBars } from "./iris-catalog"

// #186542 — the registry experience. These guard the CLAIMS, not the pixels.

describe("healthRead", () => {
  test("unmeasured is never drawn as an outage", () => {
    for (const state of [undefined, "not_checked", "not_applicable", "something_new"]) {
      expect(healthRead(state).tone).toBe("unknown")
    }
    expect(healthRead("degraded").tone).toBe("down")
    expect(healthRead("operational").tone).toBe("up")
  })

  test("a healthy provider never claims YOUR connection works", () => {
    const read = healthRead("operational")
    expect(read.label).toContain("provider")
    expect(read.basis).toContain("does not mean your own connection works")
    expect(read.label).not.toContain("connected")
  })
})

describe("connectsBy", () => {
  test("each mode is a different job, said plainly", () => {
    expect(connectsBy("oauth", false)).toContain("Sign in")
    expect(connectsBy("brokered", false)).toContain("broker")
    expect(connectsBy("key", true)).toContain("API key")
    expect(connectsBy("bridge", false)).toContain("machine")
  })
  test("an unknown mode falls back to what the row itself says", () => {
    expect(connectsBy(undefined, true)).toContain("Sign in")
    expect(connectsBy(undefined, false)).toContain("API key")
  })
})

describe("metaLine", () => {
  test("only what is known, in reading order", () => {
    expect(metaLine({ category: "email", mode: "oauth", oauthRequired: true, functionsCount: 6, usageBand: "occasional" }))
      .toBe("email · Sign in — no key to paste · 6 commands · occasional")
  })
  test("zero commands is a fact; unknown is silence", () => {
    expect(metaLine({ mode: "key", oauthRequired: false, functionsCount: 0 })).toContain("0 commands")
    expect(metaLine({ mode: "key", oauthRequired: false })).not.toContain("command")
  })
  test("one command is not '1 commands'", () => {
    expect(metaLine({ mode: "key", oauthRequired: false, functionsCount: 1 })).toContain("1 command")
  })
})

describe("usageBars", () => {
  test("a flat series is 'not measured', not 'nobody uses it'", () => {
    expect(usageBars([{ v: 0 }, { v: 0 }]).measured).toBe(false)
    expect(usageBars(undefined)).toEqual({ heights: [], measured: false })
  })
  test("bars are relative heights, and a zero day still draws a stub", () => {
    const { heights, measured } = usageBars([{ v: 1 }, { v: 0.27 }, { v: 0 }])
    expect(heights).toEqual([100, 27, 4])
    expect(measured).toBe(true)
  })
})
