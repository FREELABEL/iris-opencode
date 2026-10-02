import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { fetchDaemon, nodeVersion, PRESERVE, planAutostart, INSTALLER_LABEL, CLI_LABEL } from "./platform-node"

/**
 * `iris node install` exists to break the loop in #184597: when the daemon was
 * missing, `iris hive connect` pointed at the web installer — the same installer that
 * had just skipped it, and would skip it again. Nothing named the prerequisite.
 *
 * These hit real GitHub on purpose. The whole point of the change is that the fetch
 * works over plain HTTPS with no Git, and a mock cannot show that.
 */
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "iris-node-"))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))

describe("fetchDaemon — no Git anywhere in the path", () => {
  test("downloads and unpacks the daemon", () => {
    const d = join(tmp(), "bridge")
    const r = fetchDaemon(d)
    expect(r.ok).toBe(true)
    expect(existsSync(join(d, "daemon.js"))).toBe(true)
    expect(existsSync(join(d, "index.js"))).toBe(true)
  }, 180000)

  test("an update preserves what belongs to the MACHINE, not the repo", () => {
    const d = join(tmp(), "bridge")
    expect(fetchDaemon(d).ok).toBe(true)
    mkdirSync(join(d, "node_modules"), { recursive: true })
    writeFileSync(join(d, "node_modules", "marker"), "keep me")
    writeFileSync(join(d, "daemon.log"), "historic")
    mkdirSync(join(d, ".git"), { recursive: true }) // left by older clone-based installs
    writeFileSync(join(d, ".git", "HEAD"), "ref: refs/heads/main")
    writeFileSync(join(d, "stale-source.js"), "from an older release")

    expect(fetchDaemon(d).ok).toBe(true)
    expect(readFileSync(join(d, "node_modules", "marker"), "utf8")).toBe("keep me")
    expect(readFileSync(join(d, "daemon.log"), "utf8")).toBe("historic")
    expect(existsSync(join(d, ".git", "HEAD"))).toBe(true)
    // …while files the repo owns are cleaned up, so a removed file actually goes.
    expect(existsSync(join(d, "stale-source.js"))).toBe(false)
    expect(existsSync(join(d, "daemon.js"))).toBe(true)
  }, 180000)

  /**
   * The old shell path `rm -rf`'d the directory and re-cloned, so a network blip
   * destroyed node_modules and the logs. Staging means a failure changes nothing.
   */
  test("a failed download leaves an existing install untouched", () => {
    const d = join(tmp(), "bridge")
    expect(fetchDaemon(d).ok).toBe(true)
    writeFileSync(join(d, "daemon.log"), "must survive")

    const r = fetchDaemon(d, "https://github.com/FREELABEL/iris-daemon/archive/refs/heads/no-such-branch.tar.gz")
    expect(r.ok).toBe(false)
    expect(r.detail).toBeTruthy()
    expect(existsSync(join(d, "daemon.js"))).toBe(true)
    expect(readFileSync(join(d, "daemon.log"), "utf8")).toBe("must survive")
  }, 180000)

  /** A 200 that serves the wrong repo is still a 200. */
  test("a valid archive that is NOT the daemon is refused, not copied over", () => {
    const d = join(tmp(), "bridge")
    expect(fetchDaemon(d).ok).toBe(true)
    const r = fetchDaemon(d, "https://github.com/FREELABEL/iris-opencode/archive/refs/heads/main.tar.gz")
    expect(r.ok).toBe(false)
    expect(r.detail).toContain("daemon.js")
    expect(existsSync(join(d, "daemon.js"))).toBe(true)
  }, 180000)
})

describe("the preserve list is the machine's state, not the repo's", () => {
  test("covers deps, logs and a leftover clone", () => {
    for (const k of ["node_modules", "daemon.log", ".git", ".env"]) expect(PRESERVE).toContain(k)
  })
  test("does NOT preserve repo-owned source — a deleted file must actually go", () => {
    expect(PRESERVE).not.toContain("daemon.js")
    expect(PRESERVE).not.toContain("package.json")
  })
})

describe("nodeVersion — the prerequisite that cost two hours", () => {
  test("reports a version or null, never throws", () => {
    const v = nodeVersion()
    expect(v === null || /^v?\d+\./.test(v)).toBe(true)
  })
})

/**
 * Exactly one launch agent may start the daemon. This command used to add
 * io.heyiris.daemon.cli beside the installer's io.heyiris.daemon; the two replaced
 * each other on every start — 20 restarts in 15 minutes, tasks run twice (2026-10-02).
 */
describe("planAutostart — one launch agent, never two", () => {
  const agents = () => {
    const d = join(tmp(), "LaunchAgents")
    mkdirSync(d, { recursive: true })
    return d
  }

  test("nothing installed: write our own", () => {
    expect(planAutostart(agents())).toEqual({ label: CLI_LABEL, write: true, removeStale: null })
  })

  test("the installer's agent exists: use it, write nothing", () => {
    const d = agents()
    writeFileSync(join(d, `${INSTALLER_LABEL}.plist`), "<plist/>")
    expect(planAutostart(d)).toEqual({ label: INSTALLER_LABEL, write: false, removeStale: null })
  })

  test("both exist — the broken state: keep the installer's, retire ours", () => {
    const d = agents()
    writeFileSync(join(d, `${INSTALLER_LABEL}.plist`), "<plist/>")
    writeFileSync(join(d, `${CLI_LABEL}.plist`), "<plist/>")
    expect(planAutostart(d)).toEqual({ label: INSTALLER_LABEL, write: false, removeStale: CLI_LABEL })
  })

  test("only ours exists: a re-run rewrites it in place", () => {
    const d = agents()
    writeFileSync(join(d, `${CLI_LABEL}.plist`), "<plist/>")
    expect(planAutostart(d)).toEqual({ label: CLI_LABEL, write: true, removeStale: null })
  })
})
