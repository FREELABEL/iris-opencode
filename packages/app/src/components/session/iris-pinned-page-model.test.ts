import { describe, expect, test } from "bun:test"
import { pageSessionState, pageVerdict, pinnedPageUrl, signedFrameUrl } from "./iris-pinned-page-model"

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
  test("a refusal that lists the app's own origins is a wrong origin guess: show the page", () => {
    // What 1.18.169 on macOS showed for lexicon-console on 2026-11-05.
    const reason =
      "frame-ancestors allows only 'self' tauri://localhost http://tauri.localhost https://tauri.localhost http://127.0.0.1:* http://localhost:*"
    expect(pageVerdict("lexicon-console", { state: "refused", reason, status: 200 })).toEqual({ show: true })
    // The status still decides a missing page.
    expect(pageVerdict("nope", { state: "refused", reason, status: 404 })).toMatchObject({ show: false, title: "This page isn't published" })
    // A site that really refuses the app is still refused.
    expect(pageVerdict("x", { state: "refused", reason: "frame-ancestors allows only 'self' https://example.com" })).toMatchObject({ show: false })
    expect(pageVerdict("x", { state: "refused", reason: "frame-ancestors 'none'" })).toMatchObject({ show: false })
  })
  test("an unanswered check says nothing about the page: show it, the load timeout guards", () => {
    expect(pageVerdict("x", undefined)).toEqual({ show: true })
    expect(pageVerdict("x", {})).toEqual({ show: true })
    // An older sidecar answers without a status.
    expect(pageVerdict("x", { state: "embeddable" })).toEqual({ show: true })
  })
})

describe("a pinned page opened signed in (#192482)", () => {
  const CODE = "A".repeat(20) + "b_-" + "C".repeat(20)
  test("the sidecar's address for this page is framed as signed in", () => {
    const url = `https://freelabel.net/p/lexicon-console#atlas_code=${CODE}`
    expect(signedFrameUrl("lexicon-console", { measured: true, url, expiresIn: 90 })).toEqual({ url, signed: true })
  })
  test("no answer, a refusal, another page or another origin frame the plain page with its own gate", () => {
    const plain = "https://freelabel.net/p/lexicon-console"
    expect(signedFrameUrl("lexicon-console", undefined)).toMatchObject({ url: plain, signed: false })
    expect(signedFrameUrl("lexicon-console", { measured: false, reason: "not signed in to IRIS", url: null })).toEqual({
      url: plain,
      signed: false,
      reason: "not signed in to IRIS",
    })
    for (const url of [
      `https://freelabel.net/p/other-page#atlas_code=${CODE}`,
      `https://evil.example/p/lexicon-console#atlas_code=${CODE}`,
      `https://freelabel.net/p/lexicon-console?atlas_code=${CODE}`,
      `https://freelabel.net/p/lexicon-console#atlas_code=${CODE}&x=<script>`,
    ])
      expect(signedFrameUrl("lexicon-console", { measured: true, url })).toMatchObject({ url: plain, signed: false })
  })
  test("only this tab's frame, on the page's origin, may report its sign-in", () => {
    const frame = {}
    const msg = (o: Partial<{ origin: string; source: unknown; data: unknown }>) => ({
      origin: "https://freelabel.net",
      source: frame,
      data: { type: "iris:page-session", state: "refused", slug: "lexicon-console" },
      ...o,
    })
    expect(pageSessionState(msg({}), frame, "lexicon-console")).toBe("refused")
    expect(pageSessionState(msg({ origin: "https://evil.example" }), frame, "lexicon-console")).toBeNull()
    expect(pageSessionState(msg({ source: {} }), frame, "lexicon-console")).toBeNull()
    expect(pageSessionState(msg({ data: { type: "iris:page-session", state: "refused", slug: "x-ads-board" } }), frame, "lexicon-console")).toBeNull()
    expect(pageSessionState(msg({ data: { type: "other", state: "refused", slug: "lexicon-console" } }), frame, "lexicon-console")).toBeNull()
    expect(pageSessionState(msg({}), undefined, "lexicon-console")).toBeNull()
  })
})
