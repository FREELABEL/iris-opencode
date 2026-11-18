import { afterEach, describe, expect, test } from "bun:test"
import { addPageToSite, createSite, fetchSiteDetail, removePageFromSite, reorderSite, siteDetailOf, sitesDeps } from "./genesis-sites"

// The shape fl-api answers attach/detach/reorder/show with: `$site->fresh()->load('pages')` (#192672).
const SITE = {
  id: 14,
  name: "Staff &amp; Portal",
  slug: "staff-portal",
  status: "published",
  requires_auth: true,
  home_page_id: 801,
  pages: [
    { id: 803, title: "Schedule", slug: "staff-schedule", status: "published", sort_order: 2 },
    { id: 801, title: "Home", slug: "staff-home", status: "published", sort_order: "1" },
  ],
}

const real = { ...sitesDeps }
afterEach(() => Object.assign(sitesDeps, real))

type Call = { path: string; method: string; body?: any }
function fake(answer: (c: Call) => { status?: number; body?: any }) {
  const calls: Call[] = []
  sitesDeps.userId = async () => 193
  sitesDeps.fetch = async (path, init) => {
    const c = { path, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    const a = answer(c)
    return new Response(JSON.stringify(a.body ?? {}), { status: a.status ?? 200 })
  }
  return calls
}
const withPage = (id: number) => ({ data: { ...SITE, pages: [...SITE.pages, { id, title: "New", status: "draft", sort_order: 3 }] } })

describe("reading a site", () => {
  test("pages come back in the site's order, numbers as numbers, titles unescaped", () => {
    const s = siteDetailOf(SITE)
    expect(s.name).toBe("Staff & Portal")
    expect(s.pages.map((p) => p.id)).toEqual([801, 803])
    expect(s.pages[0].sortOrder).toBe(1)
    expect([s.requiresAuth, s.homePageId]).toEqual([true, 801])
  })

  test("not signed in is not measured, never an empty site", async () => {
    sitesDeps.userId = async () => undefined as any
    const r = await fetchSiteDetail(14)
    expect(r.measured).toBe(false)
    expect(r.reason).toContain("not signed in")
  })

  test("a 404 says the site is not on the account", async () => {
    fake(() => ({ status: 404 }))
    expect((await fetchSiteDetail(9)).reason).toBe("no such site on your account")
  })
})

describe("putting a page in a site", () => {
  test("a plain add is one POST to the site's page, and the read-back is returned", async () => {
    const calls = fake(() => ({ body: withPage(900) }))
    const r = await addPageToSite({ siteId: 14, pageId: 900 })
    expect(r.ok).toBe(true)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/v1/sites/14/pages/900"])
    expect(r.site?.pages.some((p) => p.id === 900)).toBe(true)
  })

  test("a move takes it out of the old site first, then adds it", async () => {
    const calls = fake(() => ({ body: withPage(900) }))
    expect((await addPageToSite({ siteId: 14, pageId: 900, fromSiteId: 7 })).ok).toBe(true)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(["DELETE /api/v1/sites/7/pages/900", "POST /api/v1/sites/14/pages/900"])
  })

  test("if taking it out of the old site fails, it is not added anywhere", async () => {
    const calls = fake((c) => (c.method === "DELETE" ? { status: 500, body: { message: "boom" } } : { body: withPage(900) }))
    const r = await addPageToSite({ siteId: 14, pageId: 900, fromSiteId: 7 })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe("boom")
    expect(calls).toHaveLength(1)
  })

  test("a 200 whose site does not hold the page is NOT success", async () => {
    fake(() => ({ body: { data: SITE } }))
    const r = await addPageToSite({ siteId: 14, pageId: 900 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain("not in the site")
  })

  test("nonsense is refused before any call", async () => {
    const calls = fake(() => ({}))
    expect((await addPageToSite({ siteId: 0, pageId: 5 })).ok).toBe(false)
    expect((await addPageToSite({ siteId: 14, pageId: 5, fromSiteId: 14 })).reason).toContain("already in this site")
    expect(calls).toHaveLength(0)
  })
})

describe("taking a page out", () => {
  test("DELETE, and the page must be gone from the read-back", async () => {
    const calls = fake(() => ({ body: { data: SITE } }))
    expect((await removePageFromSite({ siteId: 14, pageId: 900 })).ok).toBe(true)
    expect(calls[0]).toMatchObject({ method: "DELETE", path: "/api/v1/sites/14/pages/900" })
    expect((await removePageFromSite({ siteId: 14, pageId: 801 })).ok).toBe(false)
  })

  test("a 404 says the page is not in that site", async () => {
    fake(() => ({ status: 404 }))
    expect((await removePageFromSite({ siteId: 14, pageId: 5 })).reason).toBe("the page is not in this site")
  })
})

describe("ordering and making sites", () => {
  test("reorder sends page_ids in order and refuses duplicates", async () => {
    const calls = fake(() => ({ body: { data: SITE } }))
    expect((await reorderSite({ siteId: 14, pageIds: [803, 801] })).ok).toBe(true)
    expect(calls[0]).toMatchObject({ method: "PUT", path: "/api/v1/sites/14/reorder", body: { page_ids: [803, 801] } })
    expect((await reorderSite({ siteId: 14, pageIds: [803, 803] })).reason).toContain("twice")
    expect(calls).toHaveLength(1)
  })

  test("a new site is a draft owned by the board; a blank name is refused", async () => {
    const calls = fake(() => ({ status: 201, body: { data: { id: 22, name: "Staff", slug: "staff", status: "draft", pages: [] } } }))
    const r = await createSite({ name: "  Staff ", bloqId: 174 })
    expect(r.ok).toBe(true)
    expect(r.site?.id).toBe(22)
    expect(calls[0].body).toMatchObject({ name: "Staff", owner_type: "bloq", owner_id: 174, status: "draft" })
    expect((await createSite({ name: "  ", bloqId: 174 })).reason).toContain("needs a name")
    expect(calls).toHaveLength(1)
  })

  test("a validation error reads as its first message", async () => {
    fake(() => ({ status: 422, body: { message: "The given data was invalid.", errors: { slug: ["The slug has already been taken."] } } }))
    expect((await createSite({ name: "Staff", bloqId: 174 })).reason).toBe("The slug has already been taken.")
  })
})
