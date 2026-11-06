import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { isLight, logoFor, logoVariants, missingVariants } from "./iris-brand-logo"

// #192664's shared cases (fl-iris-api tests/Fixtures/brand-logo-cases.json), copied — so Desktop's copy
// of the resolver cannot drift from the server's and the CLI's without this failing.
// Read at run time, not imported: the app's tsconfig does not list JSON files.
const cases = JSON.parse(readFileSync(new URL("./iris-brand-logo.cases.json", import.meta.url), "utf8")) as any
const brands = cases.brands as Record<string, unknown>

describe("brand logo resolver — the #192664 fixture", () => {
  for (const c of cases.variants as any[]) test(`variants: ${c.brand}`, () => expect(logoVariants(brands[c.brand])).toEqual(c.expect as any))
  for (const c of cases.logoFor as any[])
    test(`logoFor: ${c.brand} on ${c.background}`, () => {
      const got = logoFor(brands[c.brand], c.background as string | null)
      if (c.expect === null) return expect(got).toBeNull()
      const { reason, ...rest } = got!
      expect(rest).toEqual(c.expect as any)
      expect(reason.length).toBeGreaterThan(0)
    })
  for (const [bg, want] of cases.isLight as [string | null, boolean | null][]) test(`isLight(${bg})`, () => expect(isLight(bg)).toBe(want))
  test("the IRIS kit names every variant", () => expect(missingVariants(brands.iris)).toEqual([]))
})
