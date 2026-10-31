/**
 * #190878 — with --json, an error must be a JSON object on stdout, not prose.
 * #190274 — a playbook whose header does not parse is named (file + YAML error), not "not found",
 *           and `list` / `doctor` say so instead of dropping it.
 *
 * These spawn the REAL CLI: the failures live in yargs' .fail() and the top-level catch in
 * src/index.ts, which no in-process test reaches.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test"
import { join } from "path"
import fs from "fs/promises"
import os from "os"

const CLI = join(import.meta.dir, "../../src/index.ts")
let root = ""
let home = ""

beforeAll(async () => {
  root = await fs.mkdtemp(join(os.tmpdir(), "pb-json-errors-"))
  home = join(root, "home")
  const pb = (name: string, body: string) => Bun.write(join(home, ".iris", "playbooks", name, "PLAYBOOK.md"), body)
  await pb(
    "zz-enum",
    `---
name: zz-enum
description: enum probe
version: 2
args:
  colour:
    type: string
    required: true
    enum: [red, green]
---
# zz-enum

### step:say Say it

\`\`\`yaml
mode: shell
\`\`\`

\`\`\`bash
echo {{colour}}
\`\`\`
`,
  )
  await pb("zz-probe", `---\nname: zz-probe\ndescription: stress test (safe: echo only)\n---\n# probe\n`)
})

afterAll(async () => {
  if (root) await fs.rm(root, { recursive: true, force: true })
})

async function iris(args: string[]) {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    // Run from the package so bun resolves its tsconfig/jsx; discovery reads HOME for these playbooks.
    cwd: join(import.meta.dir, "../.."),
    env: {
      ...process.env,
      HOME: home,
      OPENCODE_TEST_HOME: home,
      // Dead port: nothing here may depend on the network.
      IRIS_API_URL: "http://127.0.0.1:1",
      IRIS_FL_API_URL: "http://127.0.0.1:1",
      IRIS_API_KEY: "test-key",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  const clean = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "")
  return { exitCode, stdout: clean(stdout), stderr: clean(stderr) }
}

function parseJson(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    throw new Error(`stdout is not JSON:\n${s}`)
  }
}

describe("--json errors are JSON (#190878)", () => {
  test("search with no query", async () => {
    const r = await iris(["playbook", "search", "--json"])
    expect(r.exitCode).not.toBe(0)
    const j = parseJson(r.stdout)
    expect(j.success).toBe(false)
    expect(j.error).toContain("Give a query")
  }, 60_000)

  test("run with a missing required argument", async () => {
    const r = await iris(["playbook", "run", "zz-enum", "--json"])
    expect(r.exitCode).not.toBe(0)
    const j = parseJson(r.stdout)
    expect(j.success).toBe(false)
    expect(j.error).toContain("Missing required argument: colour")
  }, 60_000)

  test("run with an enum violation", async () => {
    const r = await iris(["playbook", "run", "zz-enum", "--json", "colour=blue"])
    expect(r.exitCode).not.toBe(0)
    const j = parseJson(r.stdout)
    expect(j.success).toBe(false)
    expect(j.error).toContain("Must be one of: red, green")
  }, 60_000)

  test("a yargs validation failure (missing positional)", async () => {
    const r = await iris(["playbook", "show", "--json"])
    expect(r.exitCode).not.toBe(0)
    const j = parseJson(r.stdout)
    expect(j.success).toBe(false)
    expect(j.error).toContain("Not enough non-option arguments")
  }, 60_000)

  test("without --json the same failures stay human text", async () => {
    const r = await iris(["playbook", "search"])
    expect(r.exitCode).not.toBe(0)
    expect(r.stdout + r.stderr).toContain("Give a query")
    expect(r.stdout.trim().startsWith("{")).toBe(false)
    const y = await iris(["playbook", "show"])
    expect(y.exitCode).not.toBe(0)
    expect(y.stdout + y.stderr).toContain("Not enough non-option arguments")
    expect((y.stdout + y.stderr).trim().startsWith("{")).toBe(false)
  }, 60_000)
})

describe("a playbook that does not parse is named, not lost (#190274)", () => {
  test("test --json names the file and the YAML line", async () => {
    const r = await iris(["playbook", "test", "zz-probe", "--json"])
    expect(r.exitCode).not.toBe(0)
    const j = parseJson(r.stdout)
    expect(j.success).toBe(false)
    expect(j.path).toContain(join("zz-probe", "PLAYBOOK.md"))
// The YAML line ("line 3") is asserted in test/skill/skill.test.ts and in the compiled binary.
    // Under `bun run src/index.ts` js-yaml's exception loses its text ("First argument must be an
    // Error object"), so here only the parse failure itself is asserted.
    expect(j.error).toContain("Failed to parse YAML frontmatter")
    expect(j.error).not.toContain("not found")
  }, 60_000)

  test("list shows the broken file instead of dropping it", async () => {
    const r = await iris(["playbook", "list"])
    expect(r.stdout + r.stderr).toContain(join("zz-probe", "PLAYBOOK.md"))
    // --json keeps stdout a valid array (callers iterate it) and says so on stderr.
    const j = await iris(["playbook", "list", "--json"])
    expect(Array.isArray(parseJson(j.stdout))).toBe(true)
    expect(j.stderr).toContain(join("zz-probe", "PLAYBOOK.md"))
  }, 60_000)

  test("doctor reports the broken file as an error", async () => {
    const r = await iris(["playbook", "doctor", "--json"])
    expect(r.exitCode).not.toBe(0)
    const j = parseJson(r.stdout)
    const rep = j.reports.find((x: any) => String(x.location).includes(join("zz-probe", "PLAYBOOK.md")))
    expect(rep).toBeDefined()
    expect(rep.problems[0].level).toBe("error")
    expect(rep.problems[0].message).toContain("Header does not parse")
  }, 60_000)
})
