import { describe, expect, test } from "bun:test"
import { irisPageSlug, pageSessionState, pageVerdict, pinnedPageUrl, signedFrameUrl } from "./iris-pinned-page-model"

describe("a pinned Genesis page (#192480)", () => {
  test("the slug becomes a heyiris.io/p/ address — IRIS never sends people to freelabel.net (#188508)", () => {
    expect(pinnedPageUrl("x-ads-board")).toBe("https://heyiris.io/p/x-ads-board")
    expect(pinnedPageUrl(" a b ")).toBe("https://heyiris.io/p/a%20b")
  })
  test("a page that is there and may be framed is shown", () => {
    expect(pageVerdict("x", { state: "embeddable", status: 200 }, "tauri://localhost")).toEqual({ show: true })
  })
  test("a 404 frames fine and fires load, so the status decides: not published", () => {
    const v = pageVerdict("nope", { state: "embeddable", status: 404 }, "tauri://localhost")
    expect(v).toMatchObject({ show: false, title: "This page isn't published" })
  })
  test("a server error, a refusal and an unreachable site each say so", () => {
    expect(pageVerdict("x", { state: "embeddable", status: 503 }, "tauri://localhost")).toMatchObject({ show: false, title: "heyiris.io answered 503" })
    expect(pageVerdict("x", { state: "refused", reason: "X-Frame-Options: DENY" }, "tauri://localhost")).toMatchObject({ show: false, detail: "X-Frame-Options: DENY" })
    expect(pageVerdict("x", { state: "unreachable", reason: "fetch failed" }, "tauri://localhost")).toMatchObject({ show: false, title: "Couldn't reach heyiris.io" })
  })
  test("a refusal that lists the app's own origins is a wrong origin guess: show the page", () => {
    // What 1.18.169 on macOS showed for lexicon-console on 2026-11-05.
    const reason =
      "frame-ancestors allows only 'self' tauri://localhost http://tauri.localhost https://tauri.localhost http://127.0.0.1:* http://localhost:*"
    expect(pageVerdict("lexicon-console", { state: "refused", reason, status: 200 }, "tauri://localhost")).toEqual({ show: true })
    expect(pageVerdict("lexicon-console", { state: "refused", reason, status: 200 }, "http://tauri.localhost")).toEqual({ show: true })
    // The status still decides a missing page.
    expect(pageVerdict("nope", { state: "refused", reason, status: 404 }, "tauri://localhost")).toMatchObject({ show: false, title: "This page isn't published" })
    // A site that really refuses the app is still refused.
    expect(pageVerdict("x", { state: "refused", reason: "frame-ancestors allows only 'self' https://example.com" }, "tauri://localhost")).toMatchObject({ show: false })
    expect(pageVerdict("x", { state: "refused", reason: "frame-ancestors 'none'" }, "tauri://localhost")).toMatchObject({ show: false })
  })
  test("IRIS in a BROWSER at another address: the refusal is real — say so, never a blank frame (2026-11-13)", () => {
    // Alex at http://100.79.222.57:3197 (a tailnet address) saw a grey box for /p/iris-terra: the
    // check said refused, and the app-origin workaround above overruled it.
    const reason =
      "frame-ancestors allows only 'self' tauri://localhost http://tauri.localhost https://tauri.localhost http://127.0.0.1:* http://localhost:*"
    for (const origin of ["http://100.79.222.57:3197", "https://iris.example.com", ""]) {
      expect(pageVerdict("iris-terra", { state: "refused", reason, status: 200 }, origin)).toMatchObject({
        show: false,
        title: "This page can't be shown inside IRIS",
      })
    }
  })
  test("an unanswered check says nothing about the page: show it, the load timeout guards", () => {
    expect(pageVerdict("x", undefined, "tauri://localhost")).toEqual({ show: true })
    expect(pageVerdict("x", {}, "tauri://localhost")).toEqual({ show: true })
    // An older sidecar answers without a status.
    expect(pageVerdict("x", { state: "embeddable" }, "tauri://localhost")).toEqual({ show: true })
  })
})

describe("a pinned page opened signed in (#192482)", () => {
  const CODE = "A".repeat(20) + "b_-" + "C".repeat(20)
  test("the sidecar's address for this page is framed as signed in", () => {
    const url = `https://heyiris.io/p/lexicon-console#atlas_code=${CODE}`
    expect(signedFrameUrl("lexicon-console", { measured: true, url, expiresIn: 90 })).toEqual({ url, signed: true })
  })
  test("no answer, a refusal, another page or another origin frame the plain page with its own gate", () => {
    const plain = "https://heyiris.io/p/lexicon-console"
    expect(signedFrameUrl("lexicon-console", undefined)).toMatchObject({ url: plain, signed: false })
    expect(signedFrameUrl("lexicon-console", { measured: false, reason: "not signed in to IRIS", url: null })).toEqual({
      url: plain,
      signed: false,
      reason: "not signed in to IRIS",
    })
    for (const url of [
      `https://heyiris.io/p/other-page#atlas_code=${CODE}`,
      `https://evil.example/p/lexicon-console#atlas_code=${CODE}`,
      `https://heyiris.io/p/lexicon-console?atlas_code=${CODE}`,
      `https://heyiris.io/p/lexicon-console#atlas_code=${CODE}&x=<script>`,
    ])
      expect(signedFrameUrl("lexicon-console", { measured: true, url })).toMatchObject({ url: plain, signed: false })
  })
  test("only this tab's frame, on the page's origin, may report its sign-in", () => {
    const frame = {}
    const msg = (o: Partial<{ origin: string; source: unknown; data: unknown }>) => ({
      origin: "https://heyiris.io",
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

import { memberFrameUrl, signedMemberUrl } from "./iris-pinned-page-model"

describe("the member's address (Marketing shows a member's own page whatever its status)", () => {
  const UUID = "ef0faee2-d239-451a-a74d-80fdd129b014"
  test("an unlisted page is framed at /p/<public_id>, not the slug that 404s for it", () => {
    expect(memberFrameUrl("freelabel-grid-plan", { measured: true, url: `https://heyiris.io/p/${UUID}`, kind: "unlisted" })).toBe(`https://heyiris.io/p/${UUID}`)
  })
  test("a draft is framed at the owner's preview link", () => {
    const u = "https://heyiris.io/p/freelabel-cover-preview?preview=true&token=MTE2NTpwYWdl"
    expect(memberFrameUrl("freelabel-cover-preview", { measured: true, url: u, kind: "preview" })).toBe(u)
  })
  test("no answer, an unmeasured one, or an address anywhere else falls back to the plain /p/<slug>", () => {
    const plain = "https://heyiris.io/p/x"
    expect(memberFrameUrl("x", undefined)).toBe(plain)
    expect(memberFrameUrl("x", { measured: false, url: `https://heyiris.io/p/${UUID}` })).toBe(plain)
    expect(memberFrameUrl("x", { measured: true, url: "https://evil.example/p/x" })).toBe(plain)
    expect(memberFrameUrl("x", { measured: true, url: "https://heyiris.io/admin" })).toBe(plain)
    expect(memberFrameUrl("x", { measured: true, url: "https://heyiris.io/p/x#atlas_code=abc" })).toBe(plain)
    expect(memberFrameUrl("x", { measured: true, url: "https://heyiris.io/p/x?redirect=https://evil.example" })).toBe(plain)
    expect(memberFrameUrl("x", { measured: true, url: "not a url" })).toBe(plain)
  })
  test("a sign-in moves its one-time code onto the member's address, in the fragment", () => {
    const code = "a".repeat(43)
    expect(signedMemberUrl(`https://heyiris.io/p/${UUID}`, { url: `https://heyiris.io/p/freelabel-grid-plan#atlas_code=${code}`, signed: true })).toBe(
      `https://heyiris.io/p/${UUID}#atlas_code=${code}`,
    )
    expect(signedMemberUrl("https://heyiris.io/p/x?preview=true&token=T0KEN123", { url: `https://heyiris.io/p/x#atlas_code=${code}`, signed: true })).toBe(
      `https://heyiris.io/p/x?preview=true&token=T0KEN123#atlas_code=${code}`,
    )
  })
  test("no sign-in leaves the member's address as it is", () => {
    expect(signedMemberUrl(`https://heyiris.io/p/${UUID}`, { url: "https://heyiris.io/p/x", signed: false })).toBe(`https://heyiris.io/p/${UUID}`)
  })
})

describe("the Browser tab opens your own IRIS pages signed in (#194350)", () => {
  test("only a plain IRIS page address, and only its slug", () => {
    expect(irisPageSlug("https://heyiris.io/p/my-command-center-yya5")).toBe("my-command-center-yya5")
    expect(irisPageSlug("https://heyiris.io/p/my-app/")).toBe("my-app")
    // Never another host, never http, never an address that carries more than the slug.
    expect(irisPageSlug("https://evil.example/p/my-app")).toBeNull()
    expect(irisPageSlug("http://heyiris.io/p/my-app")).toBeNull()
    expect(irisPageSlug("https://heyiris.io/p/my-app?preview=true")).toBeNull()
    expect(irisPageSlug("https://heyiris.io/p/my-app#atlas_code=x")).toBeNull()
    expect(irisPageSlug("https://heyiris.io/p/a/b")).toBeNull()
    expect(irisPageSlug("https://heyiris.io/atlas")).toBeNull()
    expect(irisPageSlug(undefined)).toBeNull()
  })
})
