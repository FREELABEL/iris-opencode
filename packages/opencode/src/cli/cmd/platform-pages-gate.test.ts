import { describe, expect, test } from "bun:test"
import { normaliseSetPath, pageGateFlags } from "./platform-pages"

/**
 * #181940 — the OTP gate, and why lifting it looked impossible.
 *
 * The ticket was filed as "the clone is PERMANENTLY gated, there is no route back". It was
 * not. The documented fix was right and the CLI quietly did not perform half of it:
 *
 *   iris pages set <slug> json_content.requireOtp false
 *
 * `pages set` writes into json_content, so that path addressed
 * json_content.json_content.requireOtp — a dead key nothing reads. The write returned 200,
 * and the read-back verifier resolved the SAME dead path, found the value it had just
 * written, and printed success. The check could not distinguish "applied" from "written
 * somewhere nobody looks", which is the failure family this repo keeps producing.
 */
describe("normaliseSetPath", () => {
  test("strips the redundant prefix — the bug that made the gate look unliftable", () => {
    expect(normaliseSetPath("json_content.requireOtp")).toEqual({ path: "requireOtp", stripped: true })
  })

  test("strips it on a deep path too", () => {
    expect(normaliseSetPath("json_content.theme.mode")).toEqual({ path: "theme.mode", stripped: true })
  })

  test("leaves an ordinary path alone", () => {
    expect(normaliseSetPath("theme.mode")).toEqual({ path: "theme.mode", stripped: false })
  })

  test("leaves the bare key alone — `json_content` itself is a legitimate whole-document set", () => {
    expect(normaliseSetPath("json_content")).toEqual({ path: "json_content", stripped: false })
  })

  test("does not strip a key that merely starts with the same letters", () => {
    expect(normaliseSetPath("json_contentX.foo")).toEqual({ path: "json_contentX.foo", stripped: false })
  })
})

/**
 * The gate is TWO flags with different names in two different places, and fl-api re-derives
 * the column from the json key on write. Anything that asks "is this gated" by reading one
 * of them is right only by luck.
 */
describe("pageGateFlags", () => {
  test("an ungated page — the control", () => {
    const g = pageGateFlags({ requires_auth: false, json_content: { requireOtp: false } })
    expect(g.gated).toBe(false)
    expect(g.which).toBe("")
  })

  test("the column alone gates", () => {
    const g = pageGateFlags({ requires_auth: true, json_content: {} })
    expect(g.gated).toBe(true)
    expect(g.which).toBe("requires_auth")
  })

  test("the json key alone gates — the half a column-only check misses", () => {
    const g = pageGateFlags({ requires_auth: false, json_content: { requireOtp: true } })
    expect(g.gated).toBe(true)
    expect(g.which).toBe("json_content.requireOtp")
  })

  test("both are named, so a refusal says which to clear", () => {
    const g = pageGateFlags({ requires_auth: true, json_content: { requireOtp: true } })
    expect(g.which).toBe("requires_auth + json_content.requireOtp")
  })

  test("a missing json_content is not a gate, and does not throw", () => {
    expect(pageGateFlags({ requires_auth: false }).gated).toBe(false)
    expect(pageGateFlags(null).gated).toBe(false)
    expect(pageGateFlags(undefined).gated).toBe(false)
  })

  test("the dead nested key is NOT read as the gate — it never was the gate", () => {
    // What the old CLI actually wrote. Treating it as authoritative would report a page
    // ungated while the real flag was still true.
    const g = pageGateFlags({ requires_auth: true, json_content: { requireOtp: true, json_content: { requireOtp: false } } })
    expect(g.gated).toBe(true)
    expect(g.requireOtp).toBe(true)
  })
})
