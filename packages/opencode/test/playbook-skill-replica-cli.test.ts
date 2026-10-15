/**
 * Playbook → skill, end to end through the REAL CLI against a stub registry.
 *
 * The replica is what the IRIS app and Claude Code actually read, and every way it goes wrong is
 * silent: an empty description is never offered to the model, a capitalised name is refused by
 * Claude Code, a renamed or uninstalled playbook leaves its skill behind. So these run `install`,
 * `install --force`, `uninstall`, `sync` and `doctor` in a throwaway home and assert on the files.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createServer, type Server } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const CLI = join(import.meta.dir, "../src/index.ts")
// The CLI runs IN a throwaway folder, so bunfig.toml (the JSX preload) must be named explicitly —
// bun reads it from the cwd, and without it the TUI import fails before any command runs.
const BUNFIG = join(import.meta.dir, "../bunfig.toml")
const tmp = mkdtempSync(join(tmpdir(), "pb-skill-cli-"))
const HOME = join(tmp, "home")
const WORK = join(tmp, "work") // not a git repo → installs go global
mkdirSync(HOME, { recursive: true })
mkdirSync(WORK, { recursive: true })

const registry: Record<string, { content: string; version: string; description?: string; scope?: string }> = {}
let server: Server
let port = 0

beforeAll(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url ?? "/", "http://x")
    res.setHeader("content-type", "application/json")
    const m = u.pathname.match(/\/api\/v1\/playbooks\/([^/]+)$/)
    if (m) {
      const pb = registry[decodeURIComponent(m[1])]
      if (!pb) {
        res.statusCode = 404
        return res.end(JSON.stringify({ message: "not found" }))
      }
      return res.end(JSON.stringify({ playbook: { name: decodeURIComponent(m[1]), scope: "public", ...pb } }))
    }
    res.statusCode = 404
    res.end("{}")
  })
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  port = (server.address() as any).port
})
afterAll(() => {
  server?.close()
  rmSync(tmp, { recursive: true, force: true })
})

async function iris(args: string[], cwd = WORK) {
  const proc = Bun.spawn(["bun", `--config=${BUNFIG}`, "run", CLI, ...args], {
    cwd,
    env: {
      ...process.env,
      HOME,
      OPENCODE_TEST_HOME: HOME,
      XDG_DATA_HOME: join(HOME, ".local", "share"),
      XDG_CONFIG_HOME: join(HOME, ".config"),
      XDG_CACHE_HOME: join(HOME, ".cache"),
      XDG_STATE_HOME: join(HOME, ".local", "state"),
      IRIS_API_URL: `http://127.0.0.1:${port}`,
      IRIS_FL_API_URL: "http://127.0.0.1:1",
      IRIS_API_KEY: "test-key",
      IRIS_TELEMETRY_DISABLED: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()])
  const exitCode = await proc.exited
  const out = (stdout + stderr).replace(/\x1b\[[0-9;]*m/g, "")
  // The CLI prints a banner (and sometimes log lines) around its JSON: take the first "{" that
  // starts a line and parses through to the last "}".
  let json: any = null
  const end = stdout.lastIndexOf("}")
  for (const m of stdout.matchAll(/(^|\n)\{/g)) {
    try {
      json = JSON.parse(stdout.slice(m.index! + m[1].length, end + 1))
      break
    } catch {}
  }
  return { exitCode, out, json }
}

const SKILLS = join(HOME, ".claude", "skills")
const PLAYBOOKS = join(HOME, ".iris", "playbooks")
const fm = (file: string) => {
  const t = readFileSync(file, "utf8")
  const block = t.match(/^---\n([\s\S]*?)\n---/)![1]
  const get = (k: string) => {
    const l = block.split("\n").find((x) => x.startsWith(k + ":"))
    return l ? JSON.parse(l.slice(k.length + 1).trim()) : undefined
  }
  return { name: get("name"), description: get("description"), text: t }
}

describe("install → a skill every reader accepts", () => {
  test("fresh install writes a replica with id == folder and the registry description", async () => {
    registry["tiny-pb"] = { version: "1", content: "---\nname: tiny-pb\ndescription: Do the tiny thing: carefully\n---\n\n# Tiny\n\nStep one.\n" }
    const r = await iris(["playbook", "install", "tiny-pb", "--json"])
    if (r.exitCode !== 0) console.log("INSTALL OUTPUT:\n" + r.out)
    expect(r.exitCode).toBe(0)
    const s = fm(join(SKILLS, "tiny-pb", "SKILL.md"))
    expect(s.name).toBe("tiny-pb")
    expect(s.description).toBe("Do the tiny thing: carefully")
    // #189424 — the install says an open IRIS app will not see it until restarted
    expect(String(r.json?.session_note ?? "")).toContain("restart")
  })

  test("reinstall --force with a new body updates the replica", async () => {
    registry["tiny-pb"] = { version: "2", content: "---\nname: tiny-pb\ndescription: Do the tiny thing: carefully\n---\n\n# Tiny\n\nStep one, revised.\n" }
    const r = await iris(["playbook", "install", "tiny-pb", "--force", "--json"])
    expect(r.exitCode).toBe(0)
    expect(fm(join(SKILLS, "tiny-pb", "SKILL.md")).text).toContain("Step one, revised.")
  })

  test("a playbook with NO description still gets a non-empty one", async () => {
    registry["nodesc-pb"] = { version: "1", content: "---\nname: nodesc-pb\n---\n\n# Heading\n\nReconcile the ledger every Friday.\n" }
    const r = await iris(["playbook", "install", "nodesc-pb", "--json"])
    expect(r.exitCode).toBe(0)
    const s = fm(join(SKILLS, "nodesc-pb", "SKILL.md"))
    expect(s.description).toBe("Reconcile the ledger every Friday.")
    expect((r.json?.skill_repairs ?? []).join(" ")).toContain("no description")
  })

  test("a frontmatter name with capitals/spaces/underscores becomes a portable id (folder == name)", async () => {
    registry["caps-pb"] = { version: "1", content: "---\nname: Client Intake_v2\ndescription: Take a client in\n---\n\nBody.\n" }
    const r = await iris(["playbook", "install", "caps-pb", "--json"])
    expect(r.exitCode).toBe(0)
    expect(r.json?.skill_id).toBe("client-intake-v2")
    const s = fm(join(SKILLS, "client-intake-v2", "SKILL.md"))
    expect(s.name).toBe("client-intake-v2")
    expect(existsSync(join(SKILLS, "Client Intake_v2"))).toBe(false)
  })

  test("uninstall removes the playbook AND its generated skill, and leaves hand-written skills alone", async () => {
    mkdirSync(join(SKILLS, "hand-made"), { recursive: true })
    writeFileSync(join(SKILLS, "hand-made", "SKILL.md"), "---\nname: hand-made\ndescription: mine\n---\nx\n")
    const r = await iris(["playbook", "uninstall", "caps-pb", "--json"])
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(PLAYBOOKS, "caps-pb", "PLAYBOOK.md"))).toBe(false)
    expect(existsSync(join(SKILLS, "client-intake-v2"))).toBe(false)
    expect(existsSync(join(SKILLS, "hand-made", "SKILL.md"))).toBe(true)
    const again = await iris(["playbook", "uninstall", "caps-pb", "--json"])
    expect(again.exitCode).toBe(1)
  })
})

describe("sync prunes orphans; doctor reports what the app would drop", () => {
  test("a playbook removed by hand leaves an orphan that sync removes (and --no-prune keeps)", async () => {
    rmSync(join(PLAYBOOKS, "nodesc-pb"), { recursive: true, force: true })
    expect(existsSync(join(SKILLS, "nodesc-pb", "SKILL.md"))).toBe(true)

    const doc = await iris(["playbook", "doctor", "--json"])
    expect(doc.exitCode).toBe(1)
    expect(JSON.stringify(doc.json?.skills?.findings ?? [])).toContain("orphan")

    const keep = await iris(["playbook", "sync", "--no-prune", "--json"])
    expect(keep.exitCode).toBe(0)
    expect(existsSync(join(SKILLS, "nodesc-pb", "SKILL.md"))).toBe(true)

    const r = await iris(["playbook", "sync", "--json"])
    expect(r.exitCode).toBe(0)
    expect(existsSync(join(SKILLS, "nodesc-pb", "SKILL.md"))).toBe(false)
    expect(existsSync(join(SKILLS, "tiny-pb", "SKILL.md"))).toBe(true)
    expect(existsSync(join(SKILLS, "hand-made", "SKILL.md"))).toBe(true)
  })

  test("doctor fails on a skill the app drops (no name) and passes once it is fixed", async () => {
    mkdirSync(join(SKILLS, "broken"), { recursive: true })
    writeFileSync(join(SKILLS, "broken", "SKILL.md"), "---\ndescription: no name here\n---\nx\n")
    const bad = await iris(["playbook", "doctor", "--json"])
    expect(bad.exitCode).toBe(1)
    expect(JSON.stringify(bad.json?.skills?.findings ?? [])).toContain("no-name")
    rmSync(join(SKILLS, "broken"), { recursive: true, force: true })
    const good = await iris(["playbook", "doctor", "--json"])
    expect(JSON.stringify(good.json?.skills?.findings ?? [])).toBe("[]")
    expect(good.exitCode).toBe(0)
  })
})
