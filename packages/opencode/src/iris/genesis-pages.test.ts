import { describe, expect, test } from "bun:test"
import { infoOf, isRestricted, isWidening, pageRow, readPaginator, rollbackPage, setPagePublished, setPageVisibility, versionDocument, versionRows } from "./genesis-pages"
import { kitOf, normalizeTokens } from "./brand-kits"

// Shapes taken from the platform on 2026-11-05 (#192632): GET /api/v1/pages, /pages/{id}, /pages/{id}/versions.
const ROW = {
  id: 783,
  slug: "cwc-preview-events",
  title: "Preview — Events &amp; Specials",
  seo_description: "Live music &amp; trivia",
  status: "published",
  visibility: "public",
  requires_auth: false,
  current_version: 32,
  thumbnail_url: "https://apiv2.heyiris.io/storage/thumbnails/cwc-preview-events.png",
  og_image: null,
  owner_type: "bloq",
  owner_id: 314,
  site_id: 14,
  public_url: "https://cottonwoodcreekbrewery.com/p/cwc-preview-events",
  updated_at: "2026-11-05T20:05:20.000000Z",
}

describe("reading the page list", () => {
  test("a row keeps what a card draws and unescapes the platform's HTML entities", () => {
    const p = pageRow(ROW)
    expect(p.title).toBe("Preview — Events & Specials")
    expect(p.description).toBe("Live music & trivia")
    expect(p.thumbnailUrl).toBe(ROW.thumbnail_url)
    expect(p.ogImage).toBeUndefined()
    expect([p.ownerType, p.ownerId, p.siteId, p.version]).toEqual(["bloq", 314, 14, 32])
    // The stored brand (#192665) — absent until the platform returns one.
    expect(p.brandId).toBeUndefined()
    expect(pageRow({ ...ROW, brand_id: 24 }).brandId).toBe(24)
    expect(p.url).toBe(ROW.public_url)
  })

  test("the paginator's own total and last page are read, and a bare list counts itself", () => {
    expect(readPaginator({ data: { data: [ROW], total: 1038, last_page: 42 } })).toMatchObject({ total: 1038, lastPage: 42 })
    expect(readPaginator({ data: [ROW, ROW] })).toMatchObject({ total: 2, lastPage: 1 })
    expect(readPaginator(null).rows).toEqual([])
  })

  test("private means not openly public: unlisted, private or sign-in only", () => {
    expect(isRestricted({ visibility: "public", requiresAuth: false })).toBe(false)
    expect(isRestricted({ visibility: undefined })).toBe(false)
    expect(isRestricted({ visibility: "unlisted" })).toBe(true)
    expect(isRestricted({ visibility: "private" })).toBe(true)
    expect(isRestricted({ visibility: "public", requiresAuth: true })).toBe(true)
  })
})

describe("who can reach it", () => {
  test("widening is any move toward public; an absent visibility is public already", () => {
    expect(isWidening("private", "unlisted")).toBe(true)
    expect(isWidening("unlisted", "public")).toBe(true)
    expect(isWidening("public", "private")).toBe(false)
    expect(isWidening("unlisted", "unlisted")).toBe(false)
    expect(isWidening(undefined, "public")).toBe(false)
  })

  // These refuse before any network call: the confirm is the person's yes, and without it nothing moves.
  test("publish and rollback are refused without confirm; an unknown mode is refused", async () => {
    expect((await setPagePublished({ id: 1, publish: true })).reason).toContain("confirmation")
    expect((await rollbackPage({ id: 1, version: 3 })).reason).toContain("confirmation")
    expect((await setPageVisibility({ id: 1, mode: "everyone" })).reason).toContain("not public, unlisted or private")
  })
})

describe("versions", () => {
  test("string-typed numbers from the versions paginator are read as numbers", () => {
    const r = versionRows({
      data: {
        data: [
          { version_number: "4", changed_by: "5083", created_at: "2026-11-05T20:58:38.000000Z", change_summary: "Updated page content" },
          { version_number: "3", changed_by: "5083", created_at: "2026-11-05T20:58:31.000000Z" },
          { nonsense: true },
        ],
        total: 3,
        last_page: 1,
      },
    })
    expect(r.versions.map((v) => v.version)).toEqual([4, 3])
    expect(r.versions[0]).toMatchObject({ byId: 5083, summary: "Updated page content" })
    expect(r.total).toBe(3)
  })

  test("a bespoke HTML version is drawn as its own document, with a base for its relative assets", () => {
    const doc = versionDocument({ render_mode: "html", html: "<main>v3</main>", css: "main{color:red}" }, "https://heyiris.io")!
    expect(doc).toContain("<main>v3</main>")
    expect(doc).toContain("<style>main{color:red}</style>")
    expect(doc).toContain('<base href="https://heyiris.io/">')
    const whole = versionDocument({ render_mode: "html", html: "<html><head><title>x</title></head><body>y</body></html>" }, "https://heyiris.io")!
    expect(whole.indexOf("<base")).toBeLessThan(whole.indexOf("<title>"))
    expect(versionDocument({ components: [] }, "https://heyiris.io")).toBeUndefined()
  })
})

describe("one page's facts", () => {
  test("the brand the page names, its owner board and its people; never its document", () => {
    const i = infoOf({
      ...ROW,
      preview_url: "https://raichu.heyiris.io/p/x?preview=true&token=v2.1",
      json_content: { render_mode: "html", theme: { branding: { name: "Cottonwood Creek &amp; Co", primaryColor: "#D4A030" } } },
      owner: { id: 314, name: "Cottonwood Creek" },
      creator: { id: 5083, full_name: "Emily Glynn", email: "e@x" },
      updater: { id: 193, name: null, email: "a@x" },
    })
    expect(i.brandName).toBe("Cottonwood Creek & Co")
    expect(i.ownerName).toBe("Cottonwood Creek")
    expect(i.creator).toEqual({ id: 5083, name: "Emily Glynn" })
    expect(i.updater).toEqual({ id: 193, name: "a@x" })
    expect(i.previewUrl).toContain("preview=true")
    expect(JSON.stringify(i)).not.toContain("primaryColor")
  })
})

describe("brand kits as the platform stores them (#192632)", () => {
  // The IRIS kit (#8) keeps its marks at brand.logo as plain URLs.
  const IRIS = {
    brand: { name: "IRIS", logo: { icon: "https://freelabel.net/favicon.svg", primary: "https://freelabel.net/images/iris-logo-white-transparent.png" } },
    colors: { primary: "#34d399" },
    typography: { "font-family": "Inter, sans-serif" },
  }
  test("the IRIS kit's logo is found under brand.logo", () => {
    expect(normalizeTokens(IRIS).logos.primary.url).toBe(IRIS.brand.logo.primary)
    expect(normalizeTokens(IRIS).logos.icon.url).toBe(IRIS.brand.logo.icon)
    expect(kitOf({ id: 8, name: "IRIS", slug: "iris" }, IRIS).logoUrl).toBe(IRIS.brand.logo.primary)
  })
  test("font stacks filed under fonts/font are read when typography names none", () => {
    const kit = kitOf({ id: 32, name: "IRIS Desktop", slug: "iris-desktop" }, {
      typography: { size: { base: "14px" } },
      fonts: { mono: { DEFAULT: "ui-monospace, Menlo, monospace" }, sans: { DEFAULT: "ui-sans-serif, system-ui, sans-serif" } },
    })
    expect(kit.fonts.map((f) => f.role)).toEqual(["mono", "sans"])
    // Typography's own stacks win: the IRIS kit is not listed twice.
    expect(kitOf({ id: 8, name: "IRIS", slug: "iris" }, { ...IRIS, font: { body: "Georgia, serif" } }).fonts.map((f) => f.role)).toEqual(["font-family"])
  })
})
