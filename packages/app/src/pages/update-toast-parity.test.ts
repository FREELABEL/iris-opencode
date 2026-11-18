import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Both layouts must show the "Update available" toast (#190253). It lived only in layout.tsx, so
// the new layout showed nothing but a small title-bar pill and a ready update sat uninstalled.
describe("update toast parity", () => {
  for (const file of ["layout.tsx", "layout-new.tsx"]) {
    test(`${file} renders UpdateAvailableToast`, () => {
      const src = readFileSync(join(import.meta.dir, file), "utf8")
      expect(src).toContain("<UpdateAvailableToast")
      expect(src).toContain("@/components/update-available-toast")
    })
  }
})
