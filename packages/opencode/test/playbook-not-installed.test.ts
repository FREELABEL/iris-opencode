import { afterEach, describe, expect, test } from "bun:test"
import { reportNotInstalled } from "../src/cli/cmd/platform-playbook"

/**
 * A published playbook answered `Skill "x" not found` to every client who had not installed
 * it. `run`, `show` and `test` read only the local disk — the message was true about the disk
 * and read by clients as "this playbook does not exist". Clients reported exactly that for
 * `resume-audit`, which was public and fetchable the whole time.
 *
 * These drive the real function against a stubbed registry and assert on what the client
 * reads, for each of the three answers the registry can give.
 */

const realFetch = globalThis.fetch
const realError = console.error

function registry(status: number, body: unknown = {}) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })) as any
}

async function said(name: string): Promise<string> {
  const lines: string[] = []
  console.error = (...a: unknown[]) => lines.push(a.map(String).join(" "))
  try {
    await reportNotInstalled(name)
  } finally {
    console.error = realError
  }
  // strip ANSI so assertions read the words, not the colours
  return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "")
}

afterEach(() => {
  globalThis.fetch = realFetch
  console.error = realError
})

describe("a playbook that is not installed on this machine", () => {
  test("published: says so, names the scope, and gives the install command", async () => {
    registry(200, { playbook: { name: "resume-audit", scope: "public" } })
    const out = await said("resume-audit")
    expect(out).toContain("is not installed on this machine")
    expect(out).toContain("published (public)")
    expect(out).toContain("iris playbook install resume-audit")
    // the old message, which clients read as "does not exist"
    expect(out).not.toMatch(/^Skill "resume-audit" not found$/m)
  })

  test("not published: says it is genuinely absent, and where to look", async () => {
    registry(404, { message: "not found" })
    const out = await said("no-such-playbook")
    expect(out).toContain("nothing by that name is published")
    expect(out).toContain("iris playbook available")
    expect(out).not.toContain("iris playbook install no-such-playbook")
  })

  test("registry unreachable: says it could NOT check, instead of claiming absence", async () => {
    registry(500)
    const out = await said("resume-audit")
    expect(out).toContain("could not be checked")
    expect(out).toContain("HTTP 500")
    expect(out).not.toContain("nothing by that name is published")
  })
})

describe("the three local-only commands use it", () => {
  const SRC = Bun.file(new URL("../src/cli/cmd/platform-playbook.ts", import.meta.url).pathname).text()

  test("no bare `Skill \"x\" not found` remains in run / show / test", async () => {
    const src = await SRC
    expect(src).not.toContain('console.error(`Skill "${args.name}" not found`)')
    expect(src.split("await reportNotInstalled(String(args.name))").length - 1).toBe(3)
  })

  test("it suggests install and never performs one", async () => {
    // Auto-installing would download shell steps from the network and run them without
    // the user choosing to install. The suggestion is the whole fix.
    const src = await SRC
    const start = src.indexOf("export async function reportNotInstalled")
    const body = src.slice(start, src.indexOf("\n}\n", start))
    expect(body).not.toContain("writeFileSync")
    expect(body).not.toContain("PlaybookSyncCommand")
    expect(body).not.toContain("handler(")
  })
})
