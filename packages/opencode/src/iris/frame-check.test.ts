import { describe, expect, test } from "bun:test"
import { frameTarget, frameVerdict } from "./frame-check"

const h = (o: Record<string, string>) => new Headers(o)
// The real heyiris.io header, measured 2026-10-03.
const IRIS_CSP =
  "frame-ancestors 'self' tauri://localhost http://tauri.localhost https://tauri.localhost http://127.0.0.1:* http://localhost:*"
const PAGE = "https://heyiris.io/p/design-philosophy-and-page-audit"

describe("frameVerdict", () => {
  test("heyiris.io lets the desktop app frame it — macOS, Windows and the web preview", () => {
    for (const origin of [
      "tauri://localhost",
      "http://tauri.localhost",
      "http://localhost:4097",
      "http://127.0.0.1:9300",
    ])
      expect(frameVerdict(h({ "content-security-policy": IRIS_CSP }), PAGE, origin).embeddable).toBe(true)
  })

  test("heyiris.io does NOT let an arbitrary site frame it", () => {
    expect(frameVerdict(h({ "content-security-policy": IRIS_CSP }), PAGE, "https://evil.example").embeddable).toBe(
      false,
    )
  })

  test("google.com (SAMEORIGIN) and github.com (DENY) are refused, with a reason", () => {
    const g = frameVerdict(h({ "x-frame-options": "SAMEORIGIN" }), "https://www.google.com/", "tauri://localhost")
    const gh = frameVerdict(h({ "x-frame-options": "deny" }), "https://github.com/", "tauri://localhost")
    expect(g).toMatchObject({ embeddable: false })
    expect(gh).toMatchObject({ embeddable: false })
    if (!g.embeddable) expect(g.reason).toContain("SAMEORIGIN")
  })

  test("CSP frame-ancestors overrides X-Frame-Options, as browsers do", () => {
    const v = frameVerdict(
      h({ "x-frame-options": "DENY", "content-security-policy": "frame-ancestors *" }),
      "https://example.com/",
      "http://localhost:4097",
    )
    expect(v.embeddable).toBe(true)
  })

  test("no framing headers at all means it can be framed", () => {
    expect(frameVerdict(h({}), "https://example.com/", "tauri://localhost").embeddable).toBe(true)
  })

  test("'none', and a CSP whose other directives are irrelevant", () => {
    expect(
      frameVerdict(h({ "content-security-policy": "frame-ancestors 'none'" }), "https://a.com/", "tauri://localhost")
        .embeddable,
    ).toBe(false)
    expect(
      frameVerdict(
        h({ "content-security-policy": "default-src 'self'; img-src *" }),
        "https://a.com/",
        "tauri://localhost",
      ).embeddable,
    ).toBe(true)
  })

  test("two CSP headers: the stricter one decides", () => {
    const v = frameVerdict(
      h({ "content-security-policy": "frame-ancestors *, frame-ancestors 'self'" }),
      "https://a.com/",
      "http://localhost:4097",
    )
    expect(v.embeddable).toBe(false)
  })

  test("wildcard subdomains and ports", () => {
    const csp = h({ "content-security-policy": "frame-ancestors https://*.heyiris.io http://localhost:*" })
    expect(frameVerdict(csp, "https://a.com/", "https://app.heyiris.io").embeddable).toBe(true)
    expect(frameVerdict(csp, "https://a.com/", "https://heyiris.io").embeddable).toBe(false)
    expect(frameVerdict(csp, "https://a.com/", "http://localhost:1").embeddable).toBe(true)
  })
})

describe("frameTarget", () => {
  test("only http(s), never credentials or other schemes", () => {
    expect(frameTarget("https://heyiris.io/p/x")).toBe("https://heyiris.io/p/x")
    expect(frameTarget("file:///etc/passwd")).toBeUndefined()
    expect(frameTarget("javascript:alert(1)")).toBeUndefined()
    expect(frameTarget("https://u:p@a.com/")).toBeUndefined()
    expect(frameTarget("not a url")).toBeUndefined()
  })
})
