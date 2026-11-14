import { describe, expect, test } from "bun:test"
import { pageBrandLine, pairLines, parseLinkArg } from "./brand-links"

describe("brand links (#192665 #192666)", () => {
  test("a link argument is an id, or a word that clears it", () => {
    expect(parseLinkArg("680")).toBe(680)
    expect(parseLinkArg(38)).toBe(38)
    for (const clear of ["none", "NULL", "0", ""]) expect(parseLinkArg(clear)).toBeNull()
    for (const bad of ["iris", "-1", "3.5", "38,818"]) expect(parseLinkArg(bad)).toBe("invalid")
  })

  test("show names the pair from both ends", () => {
    expect(pairLines({ design_brand_id: 8, design_brand: { id: 8, slug: "iris", status: "active" } })).toEqual([
      ["Design kit", "#8 iris — tokens are read from there"],
    ])
    expect(pairLines({ posting_brands: [{ id: 15, slug: "heyiris" }] })).toEqual([["Read by", "#15 heyiris — they wear this kit"]])
    expect(pairLines({})).toEqual([])
    expect(pairLines({ design_brand_id: 8, design_brand: { id: 8, slug: "iris", status: "archived" } })[0][1]).toContain(
      "it is archived",
    )
  })

  test("a page's stored brand, or that there is none", () => {
    expect(pageBrandLine(null)).toBe("none stored")
    expect(pageBrandLine(8, { id: 8, slug: "iris", name: "IRIS" })).toBe("#8 iris (IRIS)")
    expect(pageBrandLine(8)).toBe("#8")
  })
})
