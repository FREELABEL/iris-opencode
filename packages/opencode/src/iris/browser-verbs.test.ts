import { describe, expect, test } from "bun:test"
import { VERBS, clampPageText, findInPage, refuseUrlReason, refuseNavigationReason } from "./browser-verbs"

describe("VERBS", () => {
  test("slice 1 is read-only — no verb here can change a page", () => {
    // click/type land in S3 behind the same-origin rule. A read-only slice proves the driver,
    // the guards and the artifact join with nothing to undo.
    expect(VERBS).toEqual(["open", "read", "find", "screenshot", "close"])
  })
})

describe("findInPage", () => {
  const page = ["intro line", "kimi-k3 67 67 67 0", "middle", "another kimi-k3 row", "end"].join("\n")

  test("returns the matching lines with their line numbers", () => {
    // The verb this epic exists for. Measured 2026-09-21 on a 12,617-character page: shown the
    // first 3,000 characters, a model answered "not found" 0/3; given a way to SEARCH, 4/4.
    const r = findInPage(page, "kimi-k3")
    expect(r.matches).toBe(2)
    expect(r.text).toContain("line 2")
    expect(r.text).toContain("67 67 67")
  })

  test("says how many lines it searched when there is no match — never an empty string", () => {
    const r = findInPage(page, "minimax")
    expect(r.matches).toBe(0)
    expect(r.text).toContain("No match")
    expect(r.text).toContain("5 lines")
  })

  test("caps the hits and says how many it left out", () => {
    const many = Array.from({ length: 30 }, (_, i) => `row ${i} needle`).join("\n")
    const r = findInPage(many, "needle", { max: 8 })
    expect(r.matches).toBe(30)
    expect(r.text).toContain("22 more")
  })

  test("an empty query is a caller error, not a search of everything", () => {
    expect(() => findInPage(page, "   ")).toThrow()
  })
})

describe("clampPageText", () => {
  test("keeps a short page whole", () => {
    expect(clampPageText("short", 100)).toBe("short")
  })

  test("says the page was cut AND how big it was, so the agent knows to search instead", () => {
    // The bug this prevents: a truncated excerpt that does not announce itself reads as the
    // whole page, and a fact below the cut gets a confident "not found".
    const out = clampPageText("x".repeat(500), 100)
    expect(out.length).toBeLessThan(300)
    expect(out).toContain("truncated")
    expect(out).toContain("500")
    expect(out).toContain("find")
  })
})

describe("refuseUrlReason", () => {
  test("allows an ordinary public page", () => {
    expect(refuseUrlReason("https://heyiris.io/p/agent-model-benchmark")).toBeNull()
  })

  test("refuses credentials in the URL", () => {
    expect(refuseUrlReason("https://user:pw@example.com/")).toContain("credential")
  })

  for (const host of [
    "http://127.0.0.1:8080/",
    "http://localhost:3000/",
    "http://10.1.2.3/",
    "http://192.168.1.10/",
    "http://172.16.4.5/",
    "http://[::1]:9222/",
    "http://printer.local/",
  ]) {
    test(`refuses the private host ${host}`, () => {
      expect(refuseUrlReason(host)).toContain("private")
    })
  }

  test("refuses the cloud metadata address by name", () => {
    // 169.254.169.254 hands out cloud credentials to anything that asks. It is link-local, so
    // a range check catches it — but it is named so the refusal says what it protected.
    expect(refuseUrlReason("http://169.254.169.254/latest/meta-data/")).toContain("metadata")
  })

  for (const url of ["file:///etc/passwd", "data:text/html,<b>x", "javascript:alert(1)", "chrome://settings"]) {
    test(`refuses the non-web scheme ${url.slice(0, 12)}`, () => {
      expect(refuseUrlReason(url)).toContain("http")
    })
  }

  test("refuses a private host even when it is reached by a public-looking name", () => {
    expect(refuseUrlReason("http://0.0.0.0/")).toContain("private")
  })
})

describe("refuseNavigationReason", () => {
  test("allows a link inside the page the agent opened", () => {
    expect(refuseNavigationReason("https://heyiris.io/p/a", "https://heyiris.io/p/b")).toBeNull()
  })

  test("refuses a jump to another origin — the page does not get to choose where we go", () => {
    // Page text is untrusted input. Without this, a visited page can walk the agent anywhere.
    expect(refuseNavigationReason("https://heyiris.io/p/a", "https://evil.example/x")).toContain("origin")
  })

  test("refuses a private host even from a page that is allowed", () => {
    expect(refuseNavigationReason("https://heyiris.io/p/a", "http://127.0.0.1/")).toContain("private")
  })
})
