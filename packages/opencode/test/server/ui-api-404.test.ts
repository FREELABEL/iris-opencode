import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { isApiPath, serveEmbeddedUIEffect } from "../../src/server/shared/ui"

/**
 * An unimplemented API route must 404, not return the SPA (#185485/#185506).
 *
 * The UI handler is mounted as router.add("*", "/*"), so everything no API router claimed
 * lands on it and used to be answered with index.html — 200, text/html. A JSON caller then
 * ran JSON.parse on a web page and threw `SyntaxError: Unexpected token '<'`, which the
 * client's error boundary escalated from one dead section to the whole app.
 *
 * The tests that matter most here are the two that must KEEP working: a browser navigation
 * still gets the SPA, and a real asset is still served whatever the caller's Accept says.
 */

const html = new TextEncoder().encode("<!doctype html><title>spa</title>")
const fakeFs = { readFile: () => Effect.succeed(html) } as any
const bundle = { "index.html": "/dist/index.html", "assets/app.js": "/dist/assets/app.js" }

const run = (path: string, wantsJson: boolean) =>
  Effect.runSync(serveEmbeddedUIEffect(path, fakeFs, bundle, wantsJson))

describe("API paths never fall back to the SPA", () => {
  test("an API root is recognised whatever follows it", () => {
    expect(isApiPath("/iris/item/185442/share")).toBe(true)
    expect(isApiPath("/iris/bloqs")).toBe(true)
  })

  test("an app path is NOT an API path — the SPA owns its own routes", () => {
    expect(isApiPath("/session/ses_123")).toBe(false)
    expect(isApiPath("/")).toBe(false)
    // Near-misses: the prefix is "/iris/", so neither of these is API surface.
    expect(isApiPath("/irisology")).toBe(false)
    expect(isApiPath("/x/iris/y")).toBe(false)
  })

  test("a JSON caller asking for a path that does not exist gets 404, not a web page", () => {
    const res = run("/iris/item/1/share", true)
    expect(res.status).toBe(404)
  })

  /** MUST KEEP WORKING: a navigation to an unknown path boots the SPA, which owns that route. */
  test("a browser navigation still gets index.html", () => {
    const res = run("/session/ses_123", false)
    expect(res.status).toBe(200)
  })

  /** MUST KEEP WORKING: a real file is a real file, whatever the Accept header says. */
  test("an exact asset is served even when the caller asked for JSON", () => {
    const res = run("/assets/app.js", true)
    expect(res.status).toBe(200)
  })
})
