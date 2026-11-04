import { describe, expect, test } from "bun:test"
import { pageVerdict, pinnedPageUrl } from "./iris-pinned-page-model"

describe("a pinned Genesis page (#192480)", () => {
  test("the slug becomes a freelabel.net/p/ address", () => {
    expect(pinnedPageUrl("x-ads-board")).toBe("https://freelabel.net/p/x-ads-board")
    expect(pinnedPageUrl(" a b ")).toBe("https://freelabel.net/p/a%20b")
  })
  test("a page that is there and may be framed is shown", () => {
    expect(pageVerdict("x", { state: "embeddable", status: 200 })).toEqual({ show: true })
  })
  test("a 404 frames fine and fires load, so the status decides: not published", () => {
    const v = pageVerdict("nope", { state: "embeddable", status: 404 })
    expect(v).toMatchObject({ show: false, title: "This page isn't published" })
  })
  test("a server error, a refusal and an unreachable site each say so", () => {
    expect(pageVerdict("x", { state: "embeddable", status: 503 })).toMatchObject({ show: false, title: "freelabel.net answered 503" })
    expect(pageVerdict("x", { state: "refused", reason: "X-Frame-Options: DENY" })).toMatchObject({ show: false, detail: "X-Frame-Options: DENY" })
    expect(pageVerdict("x", { state: "unreachable", reason: "fetch failed" })).toMatchObject({ show: false, title: "Couldn't reach freelabel.net" })
  })
  test("an unanswered check says nothing about the page: show it, the load timeout guards", () => {
    expect(pageVerdict("x", undefined)).toEqual({ show: true })
    expect(pageVerdict("x", {})).toEqual({ show: true })
    // An older sidecar answers without a status.
    expect(pageVerdict("x", { state: "embeddable" })).toEqual({ show: true })
  })
})
