import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import yargs from "yargs"
import { PullCmd } from "./platform-pages"

/**
 * #190838 — `iris genesis pull <slug> --force` exited 1, and `pull --force && edit && push`
 * skipped the edit, then push republished the unchanged page. pull had no --force option, so
 * yargs rejected it and exited 1 BEFORE writing; a file from an earlier pull made that look like
 * success. The other half: a pull that genuinely failed exited 0, so the same chain would edit
 * and push a stale file. These drive the real command through strict yargs, as the CLI does.
 */
const realFetch = globalThis.fetch
const realKey = process.env.IRIS_API_KEY
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pull-exit-"))
  process.env.IRIS_API_KEY = "test-key"
  process.exitCode = 0
})

afterEach(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.IRIS_API_KEY
  else process.env.IRIS_API_KEY = realKey
  process.exitCode = 0
  rmSync(dir, { recursive: true, force: true })
})

function servePage() {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({
        data: { id: 7, slug: "demo-page", title: "Demo", status: "published", json_content: { components: [{ type: "Hero" }] } },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    )) as unknown as typeof fetch
}

async function run(argv: string[]) {
  let parseError: unknown = null
  await yargs(argv)
    .command(PullCmd)
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

describe("pull exit code", () => {
  test("--force is accepted, the file is written, and it exits 0", async () => {
    servePage()
    const out = join(dir, "pages")
    const err = await run(["pull", "demo-page", "--force", "--dir", out])
    expect(err).toBeNull()
    const file = join(out, "demo-page.json")
    expect(existsSync(file)).toBe(true)
    expect(JSON.parse(readFileSync(file, "utf8")).json_content.components).toHaveLength(1)
    expect(process.exitCode).toBe(0)
  })

  test("a pull that cannot write the file exits 1", async () => {
    servePage()
    // --dir names a FILE, so mkdir/write fails inside the handler.
    const blocker = join(dir, "not-a-dir")
    writeFileSync(blocker, "x")
    await run(["pull", "demo-page", "--dir", join(blocker, "pages")])
    expect(process.exitCode).toBe(1)
  })

  test("a page that does not exist exits 1", async () => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ message: "Page not found" }), {
        status: 404,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch
    await run(["pull", "no-such-page", "--dir", join(dir, "pages")])
    expect(process.exitCode).toBe(1)
  })
})
