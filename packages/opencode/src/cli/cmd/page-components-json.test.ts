import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import yargs from "yargs"
import { ComponentsCmd } from "./platform-pages"
import { buildPageComponentsJson } from "./page-components-json"

/**
 * #191847 — `iris pages components <slug> --json` was rejected by yargs ("Unknown argument:
 * json"), so an agent could only scrape the human listing. These hold the JSON shape (same
 * { data, meta } envelope as `pages list --json`) and drive the real command through strict
 * yargs, as the CLI does — including a failure, which must also be JSON on stdout.
 */

const PAGE = {
  id: 7,
  slug: "demo-page",
  title: "Demo",
  status: "published",
  json_content: {
    components: [
      { id: "hero-1", type: "Hero", props: { title: "Welcome" } },
      { type: "CustomHtml", props: { content: "<p>x</p>" } },
      { id: 3, type: "Spacer", props: {} },
    ],
  },
}

describe("buildPageComponentsJson", () => {
  test("rows carry index, the get/set path, id, type and preview", () => {
    const out = buildPageComponentsJson(PAGE, "demo-page")
    expect(out.page).toEqual({ id: 7, slug: "demo-page", title: "Demo", status: "published" })
    expect(out.data).toEqual([
      { index: 0, path: "components.0", id: "hero-1", type: "Hero", preview: "Welcome" },
      { index: 1, path: "components.1", id: null, type: "CustomHtml", preview: "<p>x</p>" },
      { index: 2, path: "components.2", id: "3", type: "Spacer", preview: null },
    ])
    expect(out.meta).toEqual({ returned: 3, total: 3, truncated: false })
  })

  test("a page with no components is an empty list, not an error", () => {
    const out = buildPageComponentsJson({ id: 1, slug: "e", json_content: {} }, "e")
    expect(out.data).toEqual([])
    expect(out.meta).toEqual({ returned: 0, total: 0, truncated: false })
    expect(out.page.title).toBeNull()
  })
})

const realFetch = globalThis.fetch
const realKey = process.env.IRIS_API_KEY
const realArgv = process.argv
const realWrite = process.stdout.write.bind(process.stdout)
let stdout = ""

beforeEach(() => {
  process.env.IRIS_API_KEY = "test-key"
  process.exitCode = 0
  stdout = ""
  ;(process.stdout as any).write = (chunk: any, ...rest: any[]) => {
    stdout += String(chunk)
    const cb = rest.find((r) => typeof r === "function")
    if (cb) cb()
    return true
  }
})

afterEach(() => {
  ;(process.stdout as any).write = realWrite
  globalThis.fetch = realFetch
  process.argv = realArgv
  if (realKey === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = realKey
  process.exitCode = 0
})

function serve(status: number, body: unknown) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as unknown as typeof fetch
}

async function run(argv: string[]) {
  // isJsonMode() reads the real argv, as it does in the CLI.
  process.argv = ["bun", "iris", "pages", ...argv]
  let parseError: unknown = null
  await yargs(argv)
    .command(ComponentsCmd)
    .strict()
    .exitProcess(false)
    .fail((msg, err) => {
      parseError = err ?? new Error(msg)
    })
    .parseAsync()
    .catch((e) => {
      parseError = e
    })
  return parseError
}

describe("pages components --json", () => {
  test("is accepted and prints the envelope on stdout", async () => {
    serve(200, { data: PAGE })
    const err = await run(["components", "demo-page", "--json"])
    expect(err).toBeNull()
    const out = JSON.parse(stdout)
    expect(out.page.slug).toBe("demo-page")
    expect(out.data.map((r: any) => r.type)).toEqual(["Hero", "CustomHtml", "Spacer"])
    expect(out.meta.truncated).toBe(false)
    expect(process.exitCode).toBe(0)
  })

  test("a missing page is JSON on stdout too, and exits 1", async () => {
    serve(404, { message: "Page not found" })
    const err = await run(["components", "definitely-no-page", "--json"])
    expect(err).toBeNull()
    const out = JSON.parse(stdout.trim())
    expect(out.success).toBe(false)
    expect(out.status).toBe(404)
    expect(process.exitCode).toBe(1)
  })

  test("an unreadable response is JSON on stdout too, and exits 1", async () => {
    globalThis.fetch = (async () =>
      new Response("<html>not json</html>", { status: 200, headers: { "content-type": "text/html" } })) as unknown as typeof fetch
    const err = await run(["components", "demo-page", "--json"])
    expect(err).toBeNull()
    const out = JSON.parse(stdout.trim())
    expect(out.success).toBe(false)
    expect(out.action).toBe("Components demo-page")
    expect(process.exitCode).toBe(1)
  })
})
