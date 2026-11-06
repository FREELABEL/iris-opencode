import { describe, expect, test } from "bun:test"
import {
  confirmFor,
  frameScale,
  isWidening,
  matchBrand,
  moveFocus,
  narrowedNote,
  previewAddress,
  rangeLine,
  readView,
  relativeTime,
  statusOf,
  thumbSources,
  visibilityOf,
  type BrandSummary,
  type GenesisPage,
} from "./iris-genesis-pages-model"

const PAGE: GenesisPage = {
  id: 1063,
  title: "Rivière Austin",
  slug: "riviere",
  status: "published",
  visibility: "public",
  requiresAuth: false,
  version: 4,
  url: "https://heyiris.io/p/riviere",
  ownerType: "bloq",
  ownerId: 889,
}
const NOW = Date.parse("2026-11-05T22:00:00Z")

describe("the pager says where you are", () => {
  test("a range of a known total, not a bare page number", () => {
    expect(rangeLine({ page: 1, perPage: 24, shown: 24, total: 48, totalIsExact: true })).toBe("1–24 of 48")
    expect(rangeLine({ page: 2, perPage: 24, shown: 24, total: 1038, totalIsExact: true })).toBe("25–48 of 1,038")
    expect(rangeLine({ page: 3, perPage: 24, shown: 1, total: 49, totalIsExact: true })).toBe("49 of 49")
  })
  test("a capped count is a floor, an unknown one is not invented, and empty is said in words", () => {
    expect(rangeLine({ page: 1, perPage: 24, shown: 24, total: 1500, totalIsExact: false })).toBe("1–24 of 1,500+")
    expect(rangeLine({ page: 1, perPage: 24, shown: 24, total: null, totalIsExact: false })).toBe("1–24")
    expect(rangeLine({ page: 1, perPage: 24, shown: 0, total: 0, totalIsExact: true })).toBe("No pages")
  })
})

describe("updated, in words", () => {
  const ago = (ms: number) => relativeTime(new Date(NOW - ms).toISOString(), NOW)
  test("minutes, hours, yesterday, days, weeks, months, years", () => {
    expect(ago(20_000)).toBe("just now")
    expect(ago(60_000)).toBe("1 minute ago")
    expect(ago(5 * 60_000)).toBe("5 minutes ago")
    expect(ago(3 * 3_600_000)).toBe("3 hours ago")
    expect(ago(26 * 3_600_000)).toBe("yesterday")
    expect(ago(3 * 86_400_000)).toBe("3 days ago")
    expect(ago(15 * 86_400_000)).toBe("2 weeks ago")
    expect(ago(120 * 86_400_000)).toBe("4 months ago")
    expect(ago(800 * 86_400_000)).toBe("2 years ago")
  })
  test("nothing to say is undefined, never 'NaN years ago'", () => {
    expect(relativeTime(undefined, NOW)).toBeUndefined()
    expect(relativeTime("not a date", NOW)).toBeUndefined()
    // A clock a little ahead of the server is not "in the future".
    expect(relativeTime(new Date(NOW + 30_000).toISOString(), NOW)).toBe("just now")
  })
})

describe("chips", () => {
  test("absent or odd visibility reads as public, the platform's own rule", () => {
    expect(visibilityOf({ visibility: undefined })).toBe("public")
    expect(visibilityOf({ visibility: "weird" })).toBe("public")
    expect(visibilityOf({ visibility: "unlisted" })).toBe("unlisted")
    expect(statusOf({ status: "published" }).label).toBe("Published")
    expect(statusOf({ status: "draft" }).label).toBe("Draft")
    expect(statusOf({ status: "archived" }).label).toBe("Archived")
  })
})

describe("what asks first, and what the confirm says", () => {
  test("publishing always asks, and says who will be able to read it", () => {
    const c = confirmFor({ ...PAGE, status: "draft" }, { kind: "publish" })!
    expect(c.title).toBe("Publish “Rivière Austin”?")
    expect(c.body[0]).toBe("Anyone with the link will be able to read this, at https://heyiris.io/p/riviere. Search engines may list it.")
    expect(confirmFor({ ...PAGE, status: "draft", visibility: "unlisted" }, { kind: "publish" })!.body[0]).toContain("private link")
    expect(confirmFor({ ...PAGE, status: "draft", visibility: "private" }, { kind: "publish" })!.body[0]).toContain("only share links")
    expect(confirmFor({ ...PAGE, status: "draft", requiresAuth: true }, { kind: "publish" })!.body).toContain("Visitors still have to sign in to read it.")
  })

  test("widening asks; narrowing and unpublishing never do", () => {
    expect(isWidening("private", "public")).toBe(true)
    expect(isWidening("public", "unlisted")).toBe(false)
    const priv = { ...PAGE, visibility: "private" }
    expect(confirmFor(priv, { kind: "visibility", to: "public" })!.body[0]).toBe(
      "Anyone will be able to find and read this at https://heyiris.io/p/riviere — it can be listed and indexed.",
    )
    expect(confirmFor(priv, { kind: "visibility", to: "unlisted" })!.confirmLabel).toBe("Make unlisted")
    expect(confirmFor(PAGE, { kind: "visibility", to: "private" })).toBeNull()
    expect(confirmFor(PAGE, { kind: "visibility", to: "unlisted" })).toBeNull()
    expect(confirmFor(PAGE, { kind: "visibility", to: "public" })).toBeNull()
    expect(confirmFor(PAGE, { kind: "unpublish" })).toBeNull()
  })

  test("widening a draft says when it starts", () => {
    const c = confirmFor({ ...PAGE, status: "draft", visibility: "unlisted" }, { kind: "visibility", to: "public" })!
    expect(c.body[0]).toContain("That starts when it is published — it is a draft now.")
  })

  test("a rollback names both versions and what visitors see", () => {
    const c = confirmFor(PAGE, { kind: "rollback", version: 2, when: "yesterday" })!
    expect(c.body[0]).toBe("Version 2 (yesterday) replaces what is on the page now (version 4).")
    expect(c.body[1]).toBe("The page is published, so visitors see it straight away.")
    expect(c.confirmLabel).toBe("Roll back to v2")
  })

  test("a narrowing says afterwards what stopped working", () => {
    expect(narrowedNote(PAGE, { kind: "unpublish" })).toBe("Back to draft. https://heyiris.io/p/riviere shows nothing until you publish it again.")
    expect(narrowedNote(PAGE, { kind: "visibility", to: "unlisted" })).toContain("Links to /p/riviere stop working")
    expect(narrowedNote(PAGE, { kind: "publish" })).toBeUndefined()
  })
})

describe("which brand a page belongs to", () => {
  const b = (id: number, slug: string, name: string, bloqId?: number): BrandSummary => ({ id, slug, name, status: "active", swatches: [], bloqId })
  const BRANDS = [b(8, "iris", "IRIS"), b(32, "iris-desktop", "IRIS Desktop"), b(26, "iris-atlas", "IRIS Atlas", 503), b(25, "iris-hive", "IRIS Hive", 503), b(24, "cottonwood-creek", "Cottonwood Creek Brewery", 314)]
  test("the brand the page's theme names wins", () => {
    expect(matchBrand({ ...PAGE, ownerId: 314 }, BRANDS, "IRIS Desktop")).toMatchObject({ brand: { id: 32 }, by: "page" })
  })
  test("else the owning board's brand; several on one board → the one the slug starts with", () => {
    expect(matchBrand({ ...PAGE, slug: "cwc-events", ownerId: 314 }, BRANDS)).toMatchObject({ brand: { id: 24 }, by: "board" })
    expect(matchBrand({ ...PAGE, slug: "iris-hive-ads", ownerId: 503 }, BRANDS)).toMatchObject({ brand: { id: 25 }, by: "board" })
  })
  test("else the longest brand slug that starts the page's slug, and nothing for a near miss", () => {
    expect(matchBrand({ ...PAGE, slug: "iris-desktop-launch", ownerId: 1 }, BRANDS)).toMatchObject({ brand: { id: 32 }, by: "slug" })
    expect(matchBrand({ ...PAGE, slug: "iris-launch", ownerId: 1 }, BRANDS)).toMatchObject({ brand: { id: 8 } })
    expect(matchBrand({ ...PAGE, slug: "irisx", ownerId: 1 }, BRANDS)).toBeUndefined()
    expect(matchBrand({ ...PAGE, slug: "riviere", ownerId: 889 }, BRANDS)).toBeUndefined()
  })
})

describe("thumbnails and the preview", () => {
  test("the platform's screenshot first, og:image next, a live frame only for a page anyone can open", () => {
    expect(thumbSources({ ...PAGE, thumbnailUrl: "https://x/t.png", ogImage: "https://x/og.png" }).map((s) => s.kind + ":" + s.url)).toEqual([
      "image:https://x/t.png",
      "image:https://x/og.png",
      "frame:https://heyiris.io/p/riviere",
    ])
    expect(thumbSources({ ...PAGE, status: "draft" })).toEqual([])
    expect(thumbSources({ ...PAGE, requiresAuth: true })).toEqual([])
    expect(thumbSources({ ...PAGE, visibility: "private" })).toEqual([])
    expect(thumbSources({ ...PAGE, visibility: "unlisted" }).map((s) => s.kind)).toEqual(["frame"])
    // A client's own domain may refuse a frame; only the platform's hosts are framed in a card.
    expect(thumbSources({ ...PAGE, url: "https://cottonwoodcreekbrewery.com/p/cwc-events" })).toEqual([])
    expect(thumbSources({ ...PAGE, url: "https://freelabel.net/p/x" }).map((s) => s.kind)).toEqual(["frame"])
    expect(thumbSources({ ...PAGE, url: "https://evilheyiris.io/p/x" })).toEqual([])
  })
  test("a draft previews through its tokenised address; a published page through its own", () => {
    expect(previewAddress(PAGE, "https://x?preview=true")).toBe(PAGE.url)
    expect(previewAddress({ ...PAGE, status: "draft" }, "https://x?preview=true")).toBe("https://x?preview=true")
    expect(previewAddress({ ...PAGE, status: "draft" })).toBeUndefined()
  })
  test("a device frame scales down into the room there is, never up", () => {
    expect(frameScale(1280, 640)).toBe(0.5)
    expect(frameScale(390, 800)).toBe(1)
    expect(frameScale(1280, 0)).toBe(1)
  })
})

describe("keyboard", () => {
  test("arrows move by one in a list and by a row in a grid, stopping at the ends", () => {
    expect(moveFocus(-1, "ArrowDown", 10, 1)).toBe(0)
    expect(moveFocus(-1, "ArrowUp", 10, 1)).toBe(9)
    expect(moveFocus(2, "ArrowDown", 10, 3)).toBe(5)
    expect(moveFocus(8, "ArrowDown", 10, 3)).toBe(9)
    expect(moveFocus(0, "ArrowLeft", 10, 3)).toBe(0)
    expect(moveFocus(0, "ArrowDown", 0, 3)).toBe(-1)
  })
  test("the view choice survives garbage", () => {
    expect(readView("list")).toBe("list")
    expect(readView("nonsense")).toBe("grid")
    expect(readView(null)).toBe("grid")
  })
})
