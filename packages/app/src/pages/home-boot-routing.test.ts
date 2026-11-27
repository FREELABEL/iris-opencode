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
  // #194315 shares one handler between the New chat button and the pinned ask bar. What must hold
  // is unchanged: a new chat opens only from a control the person presses, never on its own.
  test("opens a new chat only when the person presses New chat or the ask bar", () => {
    const calls = src.match(/openProjectNewSession\(/g) ?? []
    expect(calls.length).toBe(1)
    expect(src).toMatch(/const newChat = \(\) => \{[^}]*openProjectNewSession\(/)
    // Handed to the two controls, and never called directly (a call would be the redirect again).
    expect(src.match(/\bnewChat\b/g)?.length).toBe(3)
    expect(src).toMatch(/onNewChat=\{newChat\}/)
    expect(src).toMatch(/onClick=\{newChat\}/)
    expect(src).not.toMatch(/\bnewChat\(\)/)
  })
})
