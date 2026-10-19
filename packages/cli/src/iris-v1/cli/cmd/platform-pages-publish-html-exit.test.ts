import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { getBySlug } from "./platform-pages"

/**
 * #189281 — `iris genesis publish-html` on a NEW slug printed "Published" and the URL, then
 * "Failed (exit 1)". The by-slug lookup 404s (the page does not exist yet), handleApiError set
 * process.exitCode = 1, and the create path never cleared it. Same bug as #183670 in `push`.
 */
const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  process.exitCode = 0
})

function respond404() {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ message: "Page not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch
}

describe("getBySlug on a page that does not exist", () => {
  test("quiet404: returns null and records no failure (the create path)", async () => {
    respond404()
    process.exitCode = 0
    expect(await getBySlug("brand-new-page", true, { quiet404: true })).toBeNull()
    expect(process.exitCode).toBe(0)
  })

  test("without quiet404 a 404 is still a failure (callers that need the page)", async () => {
    respond404()
    process.exitCode = 0
    expect(await getBySlug("brand-new-page", true)).toBeNull()
    expect(process.exitCode).toBe(1)
  })
})

describe("publish-html treats a missing page as CREATE", () => {
  const src = readFileSync(new URL("./platform-pages.ts", import.meta.url), "utf8")
  const start = src.indexOf('command: "publish-html <slug>"')
  const end = src.indexOf("command:", start + 10)
  const lookups = src.slice(start, end === -1 ? undefined : end).match(/getBySlug\([^)]*\)/g) ?? []

  test("the create-or-update lookup passes quiet404", () => {
    expect(start).toBeGreaterThan(-1)
    expect(lookups[0]).toContain("quiet404: true")
  })

  test("the read-back after saving does NOT — a 404 there means the save did not stick", () => {
    expect(lookups.length).toBeGreaterThan(1)
    expect(lookups[lookups.length - 1]).not.toContain("quiet404")
  })
})
