import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { detectShadowPagesDir } from "./platform-pages"

/**
 * #181601 — `iris pages push` read ./pages from the CWD, so a persisted `cd` into
 * fl-iris-api (which carries its own stale six-file pages/) shipped an Aug-17 shadow of
 * /p/docs over the live page and printed "Done". The output named no path, so a push from
 * the right directory and a push from the wrong one were indistinguishable.
 */
describe("detectShadowPagesDir", () => {
  function workspace() {
    const root = mkdtempSync(join(tmpdir(), "ws-"))
    mkdirSync(join(root, "pages"))
    mkdirSync(join(root, "daily-diary"))
    const sub = join(root, "fl-docker-dev", "fl-iris-api")
    mkdirSync(sub, { recursive: true })
    mkdirSync(join(sub, "pages"))
    return { root, sub }
  }

  test("flags a nested repo's pages/ as a shadow of the workspace one", () => {
    const { root, sub } = workspace()

    // Standing in the nested repo, about to read ITS pages/ — the reported incident.
    const hit = detectShadowPagesDir(join(sub, "pages"), sub)

    expect(hit).not.toBeNull()
    expect(hit!.canonical).toBe(join(root, "pages"))
  })

  test("does not flag the canonical directory", () => {
    const { root } = workspace()

    // Standing at the workspace root reading its own pages/ — the normal case must stay silent.
    expect(detectShadowPagesDir(join(root, "pages"), root)).toBeNull()
  })

  test("stays silent outside a workspace rather than inventing a failure", () => {
    // No daily-diary/ anywhere above: we cannot tell, so we must not block the push.
    const lone = mkdtempSync(join(tmpdir(), "lone-"))
    mkdirSync(join(lone, "pages"))

    expect(detectShadowPagesDir(join(lone, "pages"), lone)).toBeNull()
  })
})
