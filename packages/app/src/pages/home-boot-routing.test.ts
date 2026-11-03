import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

// Clicking Home bounced back to the last tab whenever boot routing had not finished before the
// person left Home (#192442). Boot routing must end when Home unmounts, not only when it acts.
describe("home boot routing", () => {
  const src = readFileSync(join(import.meta.dir, "home.tsx"), "utf8")

  test("is guarded by a module-scope flag", () => {
    expect(src).toMatch(/^let bootRouted = false$/m)
  })

  test("leaving Home marks it done", () => {
    expect(src).toMatch(/onCleanup\(\(\) => \{\s*bootRouted = true\s*\}\)/)
  })
})
