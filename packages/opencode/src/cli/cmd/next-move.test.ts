import { describe, expect, test } from "bun:test"
import { recommendNext, normalizeSiteUrl, brandContextFromExtraction, contextHasBrand, type AccountState } from "./next-move"

// #187930: `iris next` always answers with exactly one move, in onboarding order.
const fresh: AccountState = { bloqs: 0, firstBloqId: null, hasBrand: null, website: null, integrations: 0, pages: 0 }
const set = (o: Partial<AccountState>): AccountState => ({ ...fresh, bloqs: 1, firstBloqId: 7, hasBrand: true, website: "https://acme.com/", integrations: 1, pages: 1, ...o })

describe("recommendNext", () => {
  test("a fresh account is offered the paste-your-site path, with a runnable command", () => {
    const m = recommendNext(fresh)
    expect(m.id).toBe("create-workspace")
    expect(m.command).toStartWith("iris next --site ")
    expect(m.minutes).toBeGreaterThan(0)
    expect(m.who.length).toBeGreaterThan(0)
  })

  test("onboarding order: brand, then integration, then first page, then intent", () => {
    expect(recommendNext(set({ hasBrand: false })).id).toBe("brand-from-site")
    expect(recommendNext(set({ integrations: 0 })).id).toBe("connect-integration")
    const page = recommendNext(set({ pages: 0 }))
    expect(page.id).toBe("first-page")
    expect(page.command).toContain("https://acme.com/")
    expect(recommendNext(set({})).id).toBe("say-what-you-want")
  })

  test("an unknown signal never fires its rule", () => {
    // bloq list failed to load: don't tell an existing customer to create a workspace
    expect(recommendNext(set({ bloqs: null, hasBrand: null, integrations: null, pages: null })).id).toBe("say-what-you-want")
    // no website known → no page-from-site recommendation
    expect(recommendNext(set({ pages: 0, website: null })).id).toBe("say-what-you-want")
  })

  test("every move carries a command (the jq contract: length==1 and .[0].command)", () => {
    const states = [fresh, set({ hasBrand: false }), set({ integrations: 0 }), set({ pages: 0 }), set({})]
    for (const s of states) {
      const out = JSON.parse(JSON.stringify([recommendNext(s)]))
      expect(out.length).toBe(1)
      expect(typeof out[0].command).toBe("string")
      expect(out[0].command.length).toBeGreaterThan(0)
    }
  })
})

describe("site URL + brand context", () => {
  test("normalizeSiteUrl accepts bare domains, rejects junk and the placeholder", () => {
    expect(normalizeSiteUrl("acme.com")).toBe("https://acme.com/")
    expect(normalizeSiteUrl(" http://acme.com/about ")).toBe("http://acme.com/about")
    expect(normalizeSiteUrl("")).toBeNull()
    expect(normalizeSiteUrl("not a url")).toBeNull()
    expect(normalizeSiteUrl("localhost")).toBeNull()
    expect(normalizeSiteUrl("https://your-site.com")).toBeNull()
  })

  test("brandContextFromExtraction keeps the brand and where it came from", () => {
    const ctx = brandContextFromExtraction(
      { brand: { brand_name: "Acme", colors: { primary: "#f00" }, logo_urls: [{ src: "https://acme.com/l.png" }] }, page_description: "We make anvils" },
      "https://acme.com/",
    )
    expect(ctx.name).toBe("Acme")
    expect(ctx.source_url).toBe("https://acme.com/")
    expect(ctx.logo).toBe("https://acme.com/l.png")
    expect(ctx.description).toBe("We make anvils")
    expect(brandContextFromExtraction({}, "https://x.io/").name).toBe("x.io")
  })

  test("contextHasBrand", () => {
    expect(contextHasBrand({})).toBe(false)
    expect(contextHasBrand(null)).toBe(false)
    expect(contextHasBrand({ brand: {} })).toBe(false)
    expect(contextHasBrand({ brand: { name: "Acme" } })).toBe(true)
    expect(contextHasBrand({ website: "https://acme.com" })).toBe(true)
  })
})
