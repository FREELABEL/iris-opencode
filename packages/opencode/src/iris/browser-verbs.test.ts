import { describe, expect, test } from "bun:test"
import { VERBS, clampPageText, findInPage, refuseUrlReason, refuseNavigationReason, windowOfLines } from "./browser-verbs"

describe("VERBS", () => {
  test("slice 1 is read-only — no verb here can change a page", () => {
    // click/type land in S3 behind the same-origin rule. A read-only slice proves the driver,
    // the guards and the artifact join with nothing to undo.
    expect(VERBS).toEqual(["open", "read", "find", "window", "screenshot", "close"])
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

describe("findInPage inside a table", () => {
  // Measured in the app on 2026-09-24, first real use: eleven browser calls to answer one
  // question, then a fallback to webfetch. `find` returned the row — `kimi-k3 67 67 67 0` —
  // with no column headers, so the agent could not tell WHICH 67 was the Mean and spent the
  // next six calls hunting for the header row. A matched table row now carries its header.
  const table = [
    "Some prose above the table",
    "MODEL\tFLOOR\tMEAN\tPEAK\tSPREAD",
    "hy3\t64\t81\t100\t36",
    "kimi-k3\t67\t67\t67\t0",
  ].join("\n")

  test("returns the header row with a match inside a table", () => {
    const r = findInPage(table, "kimi-k3")
    expect(r.text).toContain("MEAN")
    expect(r.text).toContain("header")
  })

  test("does not invent a header for ordinary prose", () => {
    const r = findInPage("one\ntwo needle\nthree", "needle")
    expect(r.text).not.toContain("header")
  })

  test("takes the nearest header above the match, not the first in the page", () => {
    const two = [
      "A\tB",
      "1\t2",
      "prose between",
      "MODEL\tMEAN",
      "kimi-k3\t67",
    ].join("\n")
    const r = findInPage(two, "kimi-k3")
    expect(r.text).toContain("MODEL")
    expect(r.text).not.toContain("header: A")
  })
})

describe("windowOfLines", () => {
  const doc = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n")

  test("reads a window around a line number, so a hit can be zoomed into", () => {
    // The other half of the eleven calls: find returns line numbers, and there was no way to
    // say "show me around line 140" — so the agent re-read the whole page with a bigger budget.
    const r = windowOfLines(doc, 140, 3)
    expect(r).toContain("line 137")
    expect(r).toContain("line 143")
    expect(r).not.toContain("line 120")
  })

  test("clamps at the top and bottom instead of failing", () => {
    expect(windowOfLines(doc, 1, 5)).toContain("line 1")
    expect(windowOfLines(doc, 200, 5)).toContain("line 200")
  })

  test("refuses a line number the page does not have", () => {
    expect(() => windowOfLines(doc, 9999, 3)).toThrow()
  })
})
