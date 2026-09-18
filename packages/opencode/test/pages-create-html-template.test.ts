import { describe, expect, test } from "bun:test"

/**
 * `iris pages create --template html` used to succeed and produce a COMPONENT page with
 * json_content.type = "html" — the label of a hand-written HTML page on a scaffold that is not
 * one. The playbooks even recommended it. It now refuses and names `publish-html`, the verb that
 * builds a real `render_mode: html` page.
 *
 * The refusal must happen before auth and before any network call: a command that is going to
 * refuse should not first make the author sign in, and must never create a page on the way.
 */
const SRC = await Bun.file(new URL("../src/cli/cmd/platform-pages.ts", import.meta.url).pathname).text()
const create = (() => {
  const start = SRC.indexOf("const CreateCmd = cmd({")
  expect(start).toBeGreaterThan(-1)
  return SRC.slice(start, SRC.indexOf("\n})\n", start))
})()

describe("pages create --template html", () => {
  const guard = create.indexOf('.toLowerCase() === "html"')

  test("is refused", () => {
    expect(guard).toBeGreaterThan(-1)
    const branch = create.slice(guard, create.indexOf("return", guard))
    expect(branch).toContain("process.exitCode = 1")
    expect(branch).toContain("publish-html")
  })

  test("the refusal comes before requireAuth", () => {
    expect(guard).toBeLessThan(create.indexOf("requireAuth("))
  })

  test("the refusal comes before any network call", () => {
    expect(guard).toBeLessThan(create.indexOf("pagesFetch("))
  })

  test("help says what create builds, and where the default lane is", () => {
    expect(create).toContain("COMPOSABLE (component JSON)")
    expect(create).toContain("there is no html template")
  })
})
