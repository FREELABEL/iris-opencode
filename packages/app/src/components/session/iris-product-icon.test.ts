import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { PRODUCT_ICONS } from "./iris-product-icon"

// Every product the panel can show has an icon, and the coloured ones carry the heyiris.io nav's
// colours. A product that silently loses its icon would sit in the strip as the only bare word.
const src = readFileSync(path.join(import.meta.dir, "session-iris-tab.tsx"), "utf8")
const start = src.indexOf("const SURFACES = [")
const surfaceIds = [...src.slice(start, src.indexOf("] as const", start)).matchAll(/\{ id: "([a-z]+)"/g)].map(
  (m) => m[1],
)

describe("IRIS product icons follow the heyiris.io nav", () => {
  test("every surface in the panel has one", () => {
    expect(surfaceIds.length).toBeGreaterThan(5)
    for (const id of surfaceIds) expect(PRODUCT_ICONS[id], id).toBeDefined()
  })
  test("Solutions products keep the site's colour", () => {
    expect(PRODUCT_ICONS.atlas.color).toBe("#f59e0b")
    expect(PRODUCT_ICONS.pages.color).toBe("#84cc16")
    expect(PRODUCT_ICONS.playbooks.color).toBe("#c084fc")
    expect(PRODUCT_ICONS.hive.color).toBe("#f59e0b")
    expect(PRODUCT_ICONS.leads.color).toBe("#10b981")
  })
})
