import { describe, expect, test } from "bun:test"
import {
  addablePages,
  boardForPage,
  filterBySite,
  groupBySite,
  groupCount,
  movePage,
  ownerBoard,
  readGroup,
  siteChange,
  siteChangeLabel,
  siteChangeLine,
  siteNameOf,
  type SiteSummary,
} from "./iris-genesis-sites-model"

const STAFF: SiteSummary = { id: 14, name: "Staff portal", slug: "staff", status: "published", pagesCount: 9, requiresAuth: true }
const PUBLIC: SiteSummary = { id: 7, name: "Public site", slug: "public", status: "draft", pagesCount: 2, requiresAuth: false }
const SITES = [STAFF, PUBLIC]
const pages = [
  { id: 1, siteId: 7 },
  { id: 2 },
  { id: 3, siteId: 14 },
  { id: 4, siteId: 99 },
  { id: 5, siteId: 14 },
  { id: 6 },
]

describe("grouping pages under their site", () => {
  test("one group per site in the sites' order, then pages in no site", () => {
    const g = groupBySite(pages, SITES)
    expect(g.map((x) => x.key)).toEqual(["site-14", "site-7", "site-99", "none"])
    expect(g[0].pages.map((p) => p.id)).toEqual([3, 5])
    expect(g[3].pages.map((p) => p.id)).toEqual([2, 6])
  })

  test("a page in a site that is not listed is still in a site — never 'Not in a site'", () => {
    const g = groupBySite(pages, SITES).find((x) => x.key === "site-99")!
    expect(g.kind).toBe("site")
    expect(g.kind === "site" && g.known).toBe(false)
    expect(g.kind === "site" && g.site.name).toBe("Site #99")
  })

  test("a site with no page here has no group; no unassigned pages, no unassigned group", () => {
    expect(groupBySite([{ id: 3, siteId: 14 }], SITES).map((x) => x.key)).toEqual(["site-14"])
    expect(groupBySite([], SITES)).toEqual([])
  })

  test("the header says when the site holds more than this page of results shows", () => {
    expect(groupCount(2, 9)).toBe("2 of 9 pages here")
    expect(groupCount(1, 1)).toBe("1 page")
    expect(groupCount(3)).toBe("3 pages")
  })
})

describe("the site filter and the chip", () => {
  test("any keeps all, none keeps pages in no site, a site keeps its own", () => {
    expect(filterBySite(pages, "any")).toHaveLength(6)
    expect(filterBySite(pages, "none").map((p) => p.id)).toEqual([2, 6])
    expect(filterBySite(pages, 14).map((p) => p.id)).toEqual([3, 5])
  })

  test("the chip names the site, or its id when it is not listed, or nothing", () => {
    expect(siteNameOf({ siteId: 14 }, SITES)).toBe("Staff portal")
    expect(siteNameOf({ siteId: 99 }, SITES)).toBe("Site #99")
    expect(siteNameOf({}, SITES)).toBeUndefined()
  })
})

describe("what changes, in one plain line", () => {
  test("add, move, remove and no change", () => {
    const add = siteChange(undefined, STAFF)
    expect(add).toEqual({ kind: "add", to: "Staff portal" })
    expect(siteChangeLine(add)).toBe("This page will use the sidebar and sign-in rules of Staff portal.")
    expect(siteChangeLabel(add)).toBe("Add to site")

    const move = siteChange(PUBLIC, STAFF)
    expect(siteChangeLine(move)).toBe("This page will leave Public site and use the sidebar and sign-in rules of Staff portal instead.")
    expect(siteChangeLabel(move)).toBe("Move to site")

    const out = siteChange(STAFF, undefined)
    expect(siteChangeLine(out)).toContain("stop using the sidebar and sign-in rules of Staff portal")
    expect(siteChangeLabel(out)).toBe("Remove from site")

    expect(siteChange(STAFF, STAFF)).toEqual({ kind: "same" })
    expect(siteChangeLine({ kind: "same" })).toBeUndefined()
  })

  test("several pages at once are counted", () => {
    expect(siteChangeLine({ kind: "add", to: "Staff portal" }, 3)).toBe("These 3 pages will use the sidebar and sign-in rules of Staff portal.")
  })
})

describe("a site's pages", () => {
  test("only pages in no site can be added from the site", () => {
    expect(addablePages(pages).map((p) => p.id)).toEqual([2, 6])
  })

  test("moving up and down swaps neighbours and stops at the ends", () => {
    expect(movePage([1, 2, 3], 2, -1)).toEqual([2, 1, 3])
    expect(movePage([1, 2, 3], 2, 1)).toEqual([1, 3, 2])
    expect(movePage([1, 2, 3], 1, -1)).toEqual([1, 2, 3])
    expect(movePage([1, 2, 3], 3, 1)).toEqual([1, 2, 3])
    expect(movePage([1, 2, 3], 9, 1)).toEqual([1, 2, 3])
  })

  test("a page's sites come from the board that owns it, else the open board", () => {
    expect(boardForPage({ ownerType: "bloq", ownerId: 174 }, 5)).toBe(174)
    expect(boardForPage({ ownerType: "user", ownerId: 193 }, 5)).toBe(5)
    expect(boardForPage({}, undefined)).toBeUndefined()
    expect(ownerBoard("bloq 174")).toBe(174)
    expect(ownerBoard("user 193")).toBeUndefined()
  })

  test("grouping is on unless turned off", () => {
    expect(readGroup(null)).toBe(true)
    expect(readGroup("0")).toBe(false)
  })
})
