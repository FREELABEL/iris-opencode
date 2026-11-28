import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

// audience.v1 (#194610) is ONE definition copied byte for byte: the engine's (this folder), the
// Desktop editor's, and the CLI's on main (packages/opencode/src/cli/cmd/brand-audience.ts). The app
// cannot import from the engine, so the copy is checked here instead of trusted.
test("the Desktop's copy of audience.v1 is the engine's, byte for byte", () => {
  const engine = readFileSync(new URL("./brand-audience.ts", import.meta.url), "utf8")
  const desktop = readFileSync(new URL("../../../app/src/components/session/iris-brand-audience-schema.ts", import.meta.url), "utf8")
  expect(desktop).toBe(engine)
})
