import { describe, expect, test } from "bun:test"
import cases from "./brand-logo.cases.json"
import { checkLogoUrls, isLight, logoFor, logoVariants, missingVariants } from "./brand-logo"

// #192664 — the same cases fl-iris-api's resolver (PHP + TS) is tested against.
const brands = cases.brands as Record<string, unknown>

describe("brand logo resolver (#192664)", () => {
  for (const c of cases.variants) {
    test(`variants: ${c.brand}`, () => expect(logoVariants(brands[c.brand])).toEqual(c.expect as any))
  }
  for (const c of cases.logoFor) {
    test(`logoFor: ${c.brand} on ${c.background}`, () => {
      const got = logoFor(brands[c.brand], c.background as string | null)
      if (c.expect === null) return expect(got).toBeNull()
      const { reason, ...rest } = got!
      expect(rest).toEqual(c.expect as any)
      expect(reason.length).toBeGreaterThan(0)
    })
  }
  for (const [bg, want] of cases.isLight as [string | null, boolean | null][]) {
    test(`isLight(${bg})`, () => expect(isLight(bg)).toBe(want))
  }
})

describe("missingVariants", () => {
  test("the IRIS kit is complete", () => expect(missingVariants(brands.iris)).toEqual([]))
  test("FREELABEL lacks the ground variants and social", () => {
    const m = missingVariants(brands.freelabel).map((s) => s.split(" ")[0])
    expect(m).toEqual(["on_light", "on_dark", "social"])
  })
})

describe("checkLogoUrls — every URL must answer 200 with an image", () => {
  const fake = (table: Record<string, { status: number; type?: string; head?: number }>) =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const row = table[String(url)]
      if (!row) throw new Error("ENOTFOUND")
      const status = init?.method === "HEAD" && row.head ? row.head : row.status
      return new Response(null, { status, headers: row.type ? { "content-type": row.type } : {} })
    }) as typeof fetch

  test("200 images pass; a 404, an HTML page and an unreachable host each fail with why", async () => {
    const tokens = { brand: { logo: {
      primary: "https://a.test/ok.png", on_dark: "https://a.test/404.png", on_light: "https://a.test/page", icon: "https://down.test/i.svg",
    } } }
    const got = await checkLogoUrls(tokens, fake({
      "https://a.test/ok.png": { status: 200, type: "image/png" },
      "https://a.test/404.png": { status: 404, type: "text/html" },
      "https://a.test/page": { status: 200, type: "text/html; charset=utf-8" },
    }))
    const by = Object.fromEntries(got.map((c) => [c.variant, c]))
    expect(by.primary.ok).toBe(true)
    expect(by.on_dark.problem).toContain("404")
    expect(by.on_light.problem).toContain("text/html")
    expect(by.icon.problem).toContain("could not be fetched")
  })

  test("a host that refuses HEAD is asked with GET", async () => {
    const got = await checkLogoUrls({ logo: "https://a.test/svg" }, fake({ "https://a.test/svg": { status: 200, head: 405, type: "image/svg+xml" } }))
    expect(got[0].ok).toBe(true)
  })

  test("a site-relative path fails: emails and renders cannot load it", async () => {
    const got = await checkLogoUrls({ logo: "/images/logo.png" }, fake({}))
    expect(got[0].ok).toBe(false)
    expect(got[0].problem).toContain("absolute")
  })
})
