/**
 * public-audit — every rule gets a fixture that MUST trip it and one that must not.
 *
 * Fixture names are synthetic on purpose (acme-client, globex-internal.example). This file
 * lives in a public repo: a real client name here would be the exact leak the tool exists to
 * stop. The real denylist is private and is never read by these tests.
 */
import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { run, parseDenylist, globMatch } from "./public-audit"

const HERE = dirname(fileURLToPath(import.meta.url))
const SCRIPT = join(HERE, "public-audit.ts")

const DENYLIST = `# synthetic fixture denylist
[strings]
acme-client
globex-internal.example

[paths]
SPEC_*
logs/
**/pages/*.json
routes.snapshot.json

[sentinels]
ZZ-SENTINEL-7f3a9c
`

let tmp: string
let denyFile: string

function sh(cwd: string, ...args: string[]) {
  const r = Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" })
  if (r.exitCode !== 0) throw new Error(`${args.join(" ")} failed: ${r.stderr.toString()}`)
  return r.stdout.toString()
}

/** A throwaway git repo with one commit holding `files`. */
function repo(files: Record<string, string | Uint8Array>): string {
  const dir = mkdtempSync(join(tmp, "repo-"))
  sh(dir, "git", "init", "-q", "-b", "main")
  sh(dir, "git", "config", "user.email", "audit@example.com")
  sh(dir, "git", "config", "user.name", "audit")
  sh(dir, "git", "config", "commit.gpgsign", "false")
  commit(dir, files, "init")
  return dir
}

function commit(dir: string, files: Record<string, string | Uint8Array>, msg: string) {
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true })
    writeFileSync(join(dir, p), body)
  }
  sh(dir, "git", "add", "-A")
  sh(dir, "git", "commit", "-q", "--allow-empty", "-m", msg)
}

function env(extra: Record<string, string | undefined> = {}) {
  return { PUBLIC_AUDIT_DENYLIST_FILE: denyFile, ...extra } as Record<string, string | undefined>
}

/** Build a .tar.gz whose contents are `files`. */
function tarball(files: Record<string, string | Uint8Array>): string {
  const src = mkdtempSync(join(tmp, "tar-src-"))
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(dirname(join(src, p)), { recursive: true })
    writeFileSync(join(src, p), body)
  }
  const out = join(mkdtempSync(join(tmp, "tar-out-")), "iris-linux-x64.tar.gz")
  sh(src, "tar", "-czf", out, ".")
  return out
}

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "public-audit-test-"))
  denyFile = join(tmp, "denylist.txt")
  writeFileSync(denyFile, DENYLIST)
})
afterEach(() => rmSync(tmp, { recursive: true, force: true }))

describe("denylist loading", () => {
  test("no denylist at all -> exit 2, never a silent pass", async () => {
    const dir = repo({ "README.md": "hello\n" })
    const r = await run([], { cwd: dir, env: {} })
    expect(r.code).toBe(2)
    expect(r.output).toContain("denylist not provided")
  })

  test("the real CLI exits 2 with no denylist (process exit code, not just the return value)", () => {
    const dir = repo({ "README.md": "hello\n" })
    const childEnv: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "" }
    const r = Bun.spawnSync([process.execPath, SCRIPT], { cwd: dir, env: childEnv, stdout: "pipe", stderr: "pipe" })
    expect(r.exitCode).toBe(2)
    expect(r.stderr.toString() + r.stdout.toString()).toContain("denylist not provided")
  })

  test("denylist file path that does not exist -> exit 2", async () => {
    const dir = repo({ "README.md": "hello\n" })
    const r = await run([], { cwd: dir, env: { PUBLIC_AUDIT_DENYLIST_FILE: join(tmp, "nope.txt") } })
    expect(r.code).toBe(2)
  })

  test("empty denylist -> exit 2 (nothing to check is not clean)", async () => {
    const dir = repo({ "README.md": "hello\n" })
    writeFileSync(denyFile, "# only comments\n[strings]\n")
    const r = await run([], { cwd: dir, env: env() })
    expect(r.code).toBe(2)
  })

  test("PUBLIC_AUDIT_DENYLIST_B64 works the same as the file", async () => {
    const dir = repo({ "src/a.ts": "const x = 'ACME-Client'\n" })
    const b64 = Buffer.from(DENYLIST).toString("base64")
    const r = await run([], { cwd: dir, env: { PUBLIC_AUDIT_DENYLIST_B64: b64 } })
    expect(r.code).toBe(1)
    expect(r.output).toContain("src/a.ts:1")
  })

  test("malformed denylist (entry outside a section, unknown section) -> exit 2", async () => {
    const dir = repo({ "README.md": "hello\n" })
    writeFileSync(denyFile, "acme-client\n")
    expect((await run([], { cwd: dir, env: env() })).code).toBe(2)
    writeFileSync(denyFile, "[secrets]\nacme-client\n")
    expect((await run([], { cwd: dir, env: env() })).code).toBe(2)
  })

  test("parseDenylist reads the three sections and keeps denylist line numbers", () => {
    const d = parseDenylist(DENYLIST)
    expect(d.strings.map((e) => e.value)).toEqual(["acme-client", "globex-internal.example"])
    expect(d.paths.map((e) => e.value)).toContain("SPEC_*")
    expect(d.sentinels[0]).toEqual({ value: "ZZ-SENTINEL-7f3a9c", line: 13 })
  })
})

describe("content check", () => {
  test("planted denylisted string -> exit 1 naming file:line", async () => {
    const dir = repo({
      "README.md": "hello\n",
      "src/config.ts": "line one\nline two\nconst host = 'https://GLOBEX-INTERNAL.example/api'\n",
    })
    const r = await run([], { cwd: dir, env: env() })
    expect(r.code).toBe(1)
    expect(r.output).toContain("src/config.ts:3")
  })

  test("findings never print the matched term or the surrounding line", async () => {
    const dir = repo({ "src/config.ts": "token=supersecretvalue acme-client tail\n" })
    const r = await run([], { cwd: dir, env: env() })
    expect(r.code).toBe(1)
    expect(r.output.toLowerCase()).not.toContain("acme-client")
    expect(r.output).not.toContain("supersecretvalue")
  })

  test("a sentinel in tracked source is a content finding too", async () => {
    const dir = repo({ "prompt.txt": "be helpful zz-sentinel-7F3A9C\n" })
    const r = await run(["--content"], { cwd: dir, env: env() })
    expect(r.code).toBe(1)
    expect(r.output).toContain("prompt.txt:1")
  })

  test("reads HEAD, not the working tree", async () => {
    const dir = repo({ "a.txt": "acme-client\n" })
    writeFileSync(join(dir, "a.txt"), "clean now but not committed\n")
    const r = await run(["--content"], { cwd: dir, env: env() })
    expect(r.code).toBe(1)
  })

  test("clean repo -> exit 0", async () => {
    const dir = repo({ "README.md": "hello\n", "src/index.ts": "export const x = 1\n" })
    const r = await run([], { cwd: dir, env: env() })
    expect(r.code).toBe(0)
  })

  test("--json gives machine-readable findings", async () => {
    const dir = repo({ "a.txt": "x\nacme-client\n" })
    const r = await run(["--json"], { cwd: dir, env: env() })
    expect(r.code).toBe(1)
    const j = JSON.parse(r.output)
    expect(j.exitCode).toBe(1)
    expect(j.counts.content).toBe(1)
    expect(j.findings[0]).toMatchObject({ check: "content", path: "a.txt", line: 2, rule: "strings@3" })
  })
})

describe("paths check", () => {
  test("planted SPEC_x.md -> exit 1", async () => {
    const dir = repo({ "README.md": "hello\n", "docs/SPEC_x.md": "# spec\n" })
    const r = await run(["--paths"], { cwd: dir, env: env() })
    expect(r.code).toBe(1)
    expect(r.output).toContain("docs/SPEC_x.md")
  })

  test("directory globs and ** globs", async () => {
    const dir = repo({ "logs/run.txt": "x\n", "pages/acme.json": "{}\n", "pkg/a/pages/b.json": "{}\n" })
    const r = await run(["--paths", "--json"], { cwd: dir, env: env() })
    const paths = JSON.parse(r.output).findings.map((f: any) => f.path).sort()
    expect(paths).toEqual(["logs/run.txt", "pages/acme.json", "pkg/a/pages/b.json"])
  })

  test("file added then deleted in history is caught only with --history", async () => {
    const dir = repo({ "README.md": "hello\n" })
    commit(dir, { "SPEC_old.md": "# old\n" }, "add spec")
    sh(dir, "git", "rm", "-q", "SPEC_old.md")
    sh(dir, "git", "commit", "-q", "-m", "remove spec")

    const plain = await run(["--paths"], { cwd: dir, env: env() })
    expect(plain.code).toBe(0)

    const hist = await run(["--history"], { cwd: dir, env: env() })
    expect(hist.code).toBe(1)
    expect(hist.output).toContain("SPEC_old.md")
  })

  test("--history sees other branches (git log --all)", async () => {
    const dir = repo({ "README.md": "hello\n" })
    sh(dir, "git", "checkout", "-q", "-b", "side")
    commit(dir, { "routes.snapshot.json": "{}\n" }, "side")
    sh(dir, "git", "checkout", "-q", "main")
    const r = await run(["--history"], { cwd: dir, env: env() })
    expect(r.code).toBe(1)
  })

  test("globMatch semantics", () => {
    expect(globMatch("SPEC_*", "a/b/SPEC_x.md")).toBe(true)
    expect(globMatch("SPEC_*", "a/MY_SPEC_x.md")).toBe(false)
    expect(globMatch("logs/", "logs/a.txt")).toBe(true)
    expect(globMatch("logs/", "pkg/logs/a.txt")).toBe(true)
    expect(globMatch("logs/", "catalogs/a.txt")).toBe(false)
    expect(globMatch("**/pages/*.json", "pages/a.json")).toBe(true)
    expect(globMatch("**/pages/*.json", "x/y/pages/a.json")).toBe(true)
    expect(globMatch("**/pages/*.json", "x/pages/sub/a.json")).toBe(false)
  })
})

describe("artifact check", () => {
  test("tarball containing index.js.map -> exit 1", async () => {
    const t = tarball({ "bin/iris": "binary\n", "index.js.map": '{"version":3}' })
    const r = await run(["--artifact", t], { env: env() })
    expect(r.code).toBe(1)
    expect(r.output).toContain("index.js.map")
  })

  test("sourcesContent anywhere -> exit 1", async () => {
    const t = tarball({ "dist/index.js": 'var m={"sourcesContent":["x"]}' })
    const r = await run(["--artifact", t], { env: env() })
    expect(r.code).toBe(1)
  })

  test("sentinel inside a binary-ish file -> exit 1", async () => {
    const bin = new Uint8Array(4096)
    for (let i = 0; i < bin.length; i++) bin[i] = (i * 31 + 7) % 256
    bin.set(new TextEncoder().encode("zz-SENTINEL-7f3a9c"), 2000)
    bin[1999] = 0
    const t = tarball({ "bin/iris": bin })
    const r = await run(["--artifact", t], { env: env() })
    expect(r.code).toBe(1)
    expect(r.output).toContain("bin/iris")
    expect(r.output).not.toContain("SENTINEL-7f3a9c")
  })

  test("clean tarball -> exit 0", async () => {
    const t = tarball({ "bin/iris": "binary\n", "README.md": "readme\n" })
    const r = await run(["--artifact", t], { env: env() })
    expect(r.code).toBe(0)
  })

  test("a directory of archives is scanned, including zips", async () => {
    const dir = mkdtempSync(join(tmp, "artifacts-"))
    const t = tarball({ "ok.txt": "fine\n" })
    sh(dir, "cp", t, join(dir, "iris-linux-x64.tar.gz"))
    const py = Bun.which("python3")
    if (py) {
      sh(
        dir,
        py,
        "-I",
        "-c",
        "import zipfile;z=zipfile.ZipFile('iris-darwin-arm64.zip','w');z.writestr('app/main.js.map','{}');z.close()",
      )
      const r = await run(["--artifact", dir, "--json"], { env: env() })
      expect(r.code).toBe(1)
      expect(JSON.parse(r.output).findings[0].path).toContain("main.js.map")
    } else {
      const r = await run(["--artifact", dir], { env: env() })
      expect(r.code).toBe(0)
    }
  })

  test("artifact that does not exist -> exit 2", async () => {
    const r = await run(["--artifact", join(tmp, "missing.tar.gz")], { env: env() })
    expect(r.code).toBe(2)
  })
})

describe("repos check", () => {
  function allow(lines: string[]) {
    const f = join(tmp, "allow.txt")
    writeFileSync(f, "# public repos we mean to have\n" + lines.join("\n") + "\n")
    return f
  }

  test("public repos equal the allowlist -> exit 0", async () => {
    const gh = async () => ["acme/one", "acme/two"]
    const r = await run(["--repos", allow(["acme/one", "acme/two"]), "--org", "acme"], { env: {}, gh })
    expect(r.code).toBe(0)
  })

  test("an unexpected public repo -> exit 1", async () => {
    let asked = ""
    const gh = async (org: string) => {
      asked = org
      return ["acme/one", "acme/two", "acme/oops-private-notes"]
    }
    const r = await run(["--repos", allow(["acme/one", "acme/two"]), "--org", "acme"], { env: {}, gh })
    expect(asked).toBe("acme")
    expect(r.code).toBe(1)
    expect(r.output).toContain("acme/oops-private-notes")
  })

  test("an allowlisted repo that is no longer public -> exit 1", async () => {
    const gh = async () => ["acme/one"]
    const r = await run(["--repos", allow(["acme/one", "two"]), "--org", "acme"], { env: {}, gh })
    expect(r.code).toBe(1)
    expect(r.output).toContain("acme/two")
  })

  test("gh failing is misconfiguration, not clean -> exit 2", async () => {
    const gh = async () => {
      throw new Error("gh: not logged in")
    }
    const r = await run(["--repos", allow(["acme/one"]), "--org", "acme"], { env: {}, gh })
    expect(r.code).toBe(2)
  })
})

describe("argument handling", () => {
  test("unknown flag -> exit 2", async () => {
    const r = await run(["--frobnicate"], { env: env() })
    expect(r.code).toBe(2)
  })
})
