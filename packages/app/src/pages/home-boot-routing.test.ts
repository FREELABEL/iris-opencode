import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
// Home used to redirect on launch — to the last tab, or into a new chat — once the engine confirmed
// sign-in. On a slow machine that took ~10 s and pulled people out of Home mid-use (#192535). The
// redirect is gone: restored tabs are in the strip, and only the person navigates.
describe("home on launch", () => {
  const src = readFileSync(join(import.meta.dir, "home.tsx"), "utf8")
  test("has no boot redirect", () => {
    expect(src).not.toMatch(/bootRouted/)
    expect(src).not.toMatch(/toggleHome\(/)
  })
  test("opens a new chat only from the New chat button", () => {
    const calls = src.match(/openProjectNewSession\(/g) ?? []
    expect(calls.length).toBe(1)
    expect(src).toMatch(/onNewChat=\{\(\) => \{[^}]*openProjectNewSession\(/)
  })
})
