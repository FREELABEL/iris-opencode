import { describe, expect, test, beforeAll, afterAll, afterEach } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { spawnSync } from "child_process"
import { createServer } from "net"
import { finishUpdate, MANIFEST_NAME, readManifest, runUpdate, updatePaths, type UpdatePaths } from "./daemon-update"

// #191614 — the whole update, end to end, against a FAKE HOME. Nothing here touches ~/.iris:
//   - the "GitHub" is a local HTTP server serving `git archive` tarballs of a synthetic repo
//     (git archive writes the same pax `comment=<sha>` header codeload does, so verification is real);
//   - daemonctl is a fake (IRIS_DAEMONCTL) whose `restart` starts a stub /health server that
//     reports whatever commit the bridge's manifest says — unless the tree carries BREAK_HEALTH,
//     which makes it report nothing (the "new code is broken" case).

const root = mkdtempSync(join(tmpdir(), "du-int-"))
const repo = join(root, "repo")
const git = (...args: string[]) => {
  const r = spawnSync("git", args, { cwd: repo, stdio: "pipe", env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } })
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`)
  return r.stdout.toString().trim()
}
const put = (dir: string, rel: string, body: string) => {
  mkdirSync(join(dir, rel, ".."), { recursive: true })
  writeFileSync(join(dir, rel), body)
}
const commit = (msg: string) => {
  git("add", "-A")
  git("commit", "-q", "-m", msg)
  return git("rev-parse", "HEAD")
}

let OLD = "", NEW = "", BROKEN_REQUIRE = "", BROKEN_HEALTH = "", NEW_DEPS = ""
let server: ReturnType<typeof Bun.serve>
let healthPort = 0
let mainSha = ""
let serveOverride: Record<string, string> = {} // sha → serve this other sha's tarball instead

async function freePort(): Promise<number> {
  return new Promise((res) => {
    const s = createServer()
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as any).port
      s.close(() => res(p))
    })
  })
}

const STUB = `
const http = require('http'), fs = require('fs'), path = require('path')
const [bridge, port] = process.argv.slice(2)
let commit = null
try { if (!fs.existsSync(path.join(bridge, 'BREAK_HEALTH'))) commit = JSON.parse(fs.readFileSync(path.join(bridge, '${MANIFEST_NAME}'), 'utf8')).commit } catch {}
http.createServer((q, r) => { r.setHeader('content-type', 'application/json'); r.end(JSON.stringify(commit ? { status: 'ok', daemon_commit: commit } : { status: 'ok' })) }).listen(Number(port), '127.0.0.1')
`

beforeAll(async () => {
  mkdirSync(repo)
  git("init", "-q", "-b", "main")
  // The real daemon .gitignore lists the manifest (so a git checkout does not see it as untracked).
  put(repo, ".gitignore", "node_modules/\n.env\n*.log\nsom/instagram-auth-*.json\n.iris-daemon-version.json\n.iris-commit\n")
  put(repo, "package.json", '{"name":"iris-daemon","version":"2.0.0"}\n')
  put(repo, "package-lock.json", '{"lockfileVersion":3,"v":1}\n')
  put(repo, "daemon.js", "require('./daemon/index')\n")
  put(repo, "index.js", "module.exports = {}\n")
  put(repo, "daemon/index.js", "require('../lib/a')\n")
  put(repo, "lib/a.js", "module.exports = 'old'\n")
  put(repo, "som/som.js", "module.exports = 1\n")
  put(repo, "lib/version-manifest.js", "module.exports = {}\n")
  put(repo, "daemonctl", "#!/usr/bin/env bash\necho real daemonctl must never run in tests; exit 99\n")
  OLD = commit("old")
  put(repo, "lib/a.js", "module.exports = 'new'\n")
  put(repo, "lib/b.js", "module.exports = 'b'\n")
  put(repo, "daemon/index.js", "require('../lib/a')\nrequire('../lib/b')\n")
  NEW = commit("new")
  // The MacBook case: daemon/index.js requires a lib file the tree does not have.
  put(repo, "daemon/index.js", "require('../lib/a')\nrequire('../lib/b')\nrequire('../lib/mail-compose')\n")
  BROKEN_REQUIRE = commit("requires a missing file")
  git("checkout", "-q", NEW)
  put(repo, "BREAK_HEALTH", "this tree's daemon never reports its commit\n")
  put(repo, "lib/a.js", "module.exports = 'broken-at-runtime'\n")
  BROKEN_HEALTH = commit("comes up wrong")
  git("checkout", "-q", NEW)
  put(repo, "package-lock.json", '{"lockfileVersion":3,"v":2}\n')
  NEW_DEPS = commit("deps changed")
  git("checkout", "-q", "main")
  mainSha = NEW

  server = Bun.serve({
    port: 0,
    fetch(req) {
      const u = new URL(req.url)
      let m = /^\/tar\.gz\/([0-9a-f]{40})$/.exec(u.pathname)
      if (m) {
        const sha = serveOverride[m[1]] ?? m[1]
        const r = spawnSync("git", ["archive", "--format=tar.gz", `--prefix=iris-daemon-${sha}/`, sha], { cwd: repo })
        return r.status === 0 ? new Response(new Uint8Array(r.stdout)) : new Response("not found", { status: 404 })
      }
      m = /^\/commits\/(.+)$/.exec(u.pathname)
      if (m) return Response.json({ sha: m[1] === "main" ? mainSha : m[1] })
      return new Response("no", { status: 404 })
    },
  })
  healthPort = await freePort()
})

afterAll(() => {
  server?.stop(true)
  rmSync(root, { recursive: true, force: true })
})

let home: string
let p: UpdatePaths
const logs: string[] = []

function stopStub() {
  try {
    const pid = Number(readFileSync(join(home, "stub.pid"), "utf8"))
    if (pid) process.kill(pid)
  } catch {}
}
afterEach(() => stopStub())

/** A fresh fake home whose bridge is the OLD commit, installed by a previous update (manifest). */
function fakeHome(kind: "manifest" | "plain" = "manifest"): void {
  home = mkdtempSync(join(root, "home-"))
  p = updatePaths(join(home, ".iris"))
  mkdirSync(p.iris, { recursive: true })
  const tgz = join(home, "old.tgz")
  writeFileSync(tgz, spawnSync("git", ["archive", "--format=tar.gz", "--prefix=b/", OLD], { cwd: repo }).stdout)
  spawnSync("tar", ["-xzf", tgz, "-C", home])
  spawnSync("mv", [join(home, "b"), p.bridge])
  if (kind === "manifest") {
    const { hashTree } = require("./daemon-update")
    writeFileSync(join(p.bridge, MANIFEST_NAME), JSON.stringify({ schema: 1, commit: OLD, files: hashTree(p.bridge) }))
  }
  // node_modules and this machine's runtime files.
  put(p.bridge, "node_modules/dep/index.js", "module.exports = 'dep'\n")
  put(p.bridge, ".env", "NODE_SECRET=1\n")
  put(p.bridge, "daemon.log", "old log\n")
  put(p.bridge, "som/instagram-auth-heyiris.io.json", '{"cookies":[]}\n')
  put(p.bridge, "r1-frames.jsonl", "{}\n")

  // The fake supervisor: record every call, (re)start the stub /health for the CURRENT bridge.
  const ctl = join(home, "fake-daemonctl")
  writeFileSync(join(home, "stub.js"), STUB)
  writeFileSync(
    ctl,
    `#!/usr/bin/env bash
echo "$1" >> "${home}/ctl-calls"
[ -f "${home}/stub.pid" ] && kill "$(cat "${home}/stub.pid")" 2>/dev/null
sleep 0.3
nohup node "${home}/stub.js" "${p.bridge}" ${healthPort} >/dev/null 2>&1 &
echo $! > "${home}/stub.pid"
`,
  )
  chmodSync(ctl, 0o755)
  // Not under systemd unless a test says so — never inherit this machine's own session cgroup.
  writeFileSync(join(home, "cgroup"), "0::/user.slice/user-1000.slice/session-2.scope\n")
  process.env.IRIS_PROC_CGROUP = join(home, "cgroup")
  delete process.env.INVOCATION_ID
  process.env.IRIS_DAEMONCTL = ctl
  process.env.IRIS_DAEMON_HEALTH_URL = `http://127.0.0.1:${healthPort}/health`
  process.env.IRIS_DAEMON_API_BASE = `http://127.0.0.1:${server.port}`
  process.env.IRIS_DAEMON_CODELOAD_BASE = `http://127.0.0.1:${server.port}/tar.gz`
  // Start the "old daemon".
  spawnSync(ctl, ["start"])
  logs.length = 0
}
const ctlCalls = () => (existsSync(join(home, "ctl-calls")) ? readFileSync(join(home, "ctl-calls"), "utf8").trim().split("\n").filter((l) => l !== "start") : [])
const health = async () => ((await (await fetch(process.env.IRIS_DAEMON_HEALTH_URL!)).json()) as any).daemon_commit
const run = (o: Record<string, unknown>) => runUpdate({ paths: p, healthTimeoutSec: 6, log: (s: string) => logs.push(s), ref: "main", ...o } as any)

describe("iris daemon update — against a fake home", () => {
  test("success: verified download, carried runtime files, reused deps, swap, the running daemon reports the NEW commit", async () => {
    fakeHome()
    const nmInode = statSync(join(p.bridge, "node_modules/dep/index.js")).ino
    const r = await run({})
    expect(r.status).toBe("updated")
    expect(r.from).toBe(OLD)
    expect(r.to).toBe(NEW)
    expect(await health()).toBe(NEW)
    expect(readManifest(p.bridge)?.commit).toBe(NEW)
    expect(readFileSync(join(p.bridge, "lib/a.js"), "utf8")).toContain("new")
    expect(readFileSync(join(p.bridge, ".iris-commit"), "utf8").trim()).toBe(NEW)
    // this machine's files came along
    expect(readFileSync(join(p.bridge, ".env"), "utf8")).toBe("NODE_SECRET=1\n")
    expect(existsSync(join(p.bridge, "daemon.log"))).toBe(true)
    expect(existsSync(join(p.bridge, "som/instagram-auth-heyiris.io.json"))).toBe(true)
    expect(existsSync(join(p.bridge, "r1-frames.jsonl"))).toBe(true)
    // deps reused by hard link, not reinstalled
    expect(statSync(join(p.bridge, "node_modules/dep/index.js")).ino).toBe(nmInode)
    // one previous version kept, nothing left half-done
    expect(readManifest(p.prev)?.commit).toBe(OLD)
    expect(existsSync(p.next)).toBe(false)
    expect(ctlCalls()).toEqual(["restart"])
    expect(JSON.parse(readFileSync(join(p.stateDir, "last.json"), "utf8")).status).toBe("updated")
    // the new manifest describes the commit only: no runtime files, no deps
    const files = Object.keys(readManifest(p.bridge)!.files)
    expect(files).toContain("lib/b.js")
    expect(files.some((f) => f.startsWith("node_modules") || f === ".env" || f === "daemon.log")).toBe(false)
  }, 60000)

  test("local changes are refused and listed — nothing moves, nothing restarts", async () => {
    fakeHome()
    put(p.bridge, "lib/a.js", "module.exports = 'hand edit'\n")
    put(p.bridge, "lib/hand-copied-fix.js", "x\n")
    const r = await run({})
    expect(r.status).toBe("blocked")
    expect(r.plan!.current.modified).toEqual(["lib/a.js"])
    expect(r.plan!.current.untracked).toEqual(["lib/hand-copied-fix.js"])
    expect(logs.join("\n")).toContain("lib/hand-copied-fix.js")
    expect(readFileSync(join(p.bridge, "lib/a.js"), "utf8")).toContain("hand edit")
    expect(existsSync(p.next)).toBe(false)
    expect(existsSync(p.prev)).toBe(false)
    expect(ctlCalls()).toEqual([])
    // --force replaces it and keeps the edits in bridge.prev
    const f = await run({ force: true })
    expect(f.status).toBe("updated")
    expect(readFileSync(join(p.prev, "lib/hand-copied-fix.js"), "utf8")).toBe("x\n")
  }, 60000)

  test("a plain copy with no manifest (iris-hive-001 today) needs --force", async () => {
    fakeHome("plain")
    const r = await run({})
    expect(r.status).toBe("blocked")
    expect(r.detail).toContain("no install manifest")
    expect((await run({ force: true })).status).toBe("updated")
  }, 60000)

  test("new code that fails its health check is rolled back, and the OLD commit is verified running", async () => {
    fakeHome()
    const r = await run({ ref: BROKEN_HEALTH })
    expect(r.status).toBe("rolled-back")
    expect(r.ok).toBe(false)
    expect(await health()).toBe(OLD)
    expect(readManifest(p.bridge)?.commit).toBe(OLD)
    expect(readManifest(p.failed)?.commit).toBe(BROKEN_HEALTH)
    expect(readFileSync(join(p.bridge, ".env"), "utf8")).toBe("NODE_SECRET=1\n")
    expect(ctlCalls()).toEqual(["restart", "restart"])
  }, 60000)

  test("the MacBook case: a missing require is caught in pre-flight, before the live install is touched", async () => {
    fakeHome()
    const r = await run({ ref: BROKEN_REQUIRE })
    expect(r.status).toBe("preflight-failed")
    expect(r.detail).toContain("daemon/index.js → require('../lib/mail-compose')")
    expect(readManifest(p.bridge)?.commit).toBe(OLD)
    expect(existsSync(p.next)).toBe(false)
    expect(ctlCalls()).toEqual([])
    expect(await health()).toBe(OLD)
  }, 60000)

  test("a commit whose daemon cannot report its commit is refused in pre-flight (it could never verify)", async () => {
    fakeHome()
    git("checkout", "-q", NEW)
    git("rm", "-q", "lib/version-manifest.js")
    const PRE = commit("no version reporter")
    git("checkout", "-q", "main")
    const r = await run({ ref: PRE })
    expect(r.status).toBe("preflight-failed")
    expect(r.detail).toContain("predates lib/version-manifest.js")
    expect(ctlCalls()).toEqual([])
  }, 60000)

  test("--dry-run prints the plan and changes nothing", async () => {
    fakeHome()
    const before = readFileSync(join(p.bridge, MANIFEST_NAME), "utf8")
    const r = await run({ dryRun: true })
    expect(r.status).toBe("dry-run")
    const out = logs.join("\n")
    expect(out).toContain(`current:  ${OLD.slice(0, 7)}`)
    expect(out).toContain(`target:   ${NEW.slice(0, 7)}`)
    expect(out).toContain("M lib/a.js")
    expect(out).toContain("A lib/b.js")
    expect(out).toContain("deps:     no")
    expect(out).toContain("local changes: none")
    expect(readFileSync(join(p.bridge, MANIFEST_NAME), "utf8")).toBe(before)
    expect(existsSync(p.next) || existsSync(p.prev) || existsSync(p.stateDir)).toBe(false)
    expect(ctlCalls()).toEqual([])
  }, 60000)

  test("a changed package-lock.json installs deps (npm ci --omit=dev) instead of reusing them", async () => {
    fakeHome()
    const npm = join(home, "fake-npm")
    writeFileSync(npm, `#!/usr/bin/env bash\necho "$@" > "${home}/npm-args"\nmkdir -p node_modules/fresh && touch node_modules/fresh/index.js\n`)
    chmodSync(npm, 0o755)
    process.env.IRIS_NPM = npm
    try {
      const r = await run({ ref: NEW_DEPS })
      expect(r.status).toBe("updated")
      expect(readFileSync(join(home, "npm-args"), "utf8")).toContain("ci --omit=dev")
      expect(existsSync(join(p.bridge, "node_modules/fresh/index.js"))).toBe(true)
      expect(existsSync(join(p.bridge, "node_modules/dep"))).toBe(false)
    } finally {
      delete process.env.IRIS_NPM
    }
  }, 60000)

  test("a download that is not the requested commit is refused", async () => {
    fakeHome()
    serveOverride[NEW] = OLD
    try {
      await expect(run({ ref: NEW })).rejects.toThrow(/not .*refusing/)
      expect(readManifest(p.bridge)?.commit).toBe(OLD)
      expect(ctlCalls()).toEqual([])
    } finally {
      delete serveOverride[NEW]
    }
  }, 60000)

  test("--detach-restart (inside a Hive task): returns before restarting; a detached process finishes the job", async () => {
    fakeHome()
    const runner = join(home, "runner.ts")
    // Stands in for the compiled `iris`: argv = daemon update --finish <file> --finish-delay N
    writeFileSync(
      runner,
      `import { finishUpdate } from ${JSON.stringify(join(import.meta.dir, "daemon-update.ts"))}\nconst a = process.argv.slice(2)\nawait finishUpdate(a[a.indexOf("--finish") + 1], console.log, Number(a[a.indexOf("--finish-delay") + 1]))\n`,
    )
    process.env.IRIS_SELF_CMD = JSON.stringify([process.execPath, runner])
    try {
      const r = await run({ detachRestart: true, restartDelaySec: 1 })
      expect(r.status).toBe("restart-scheduled")
      expect(ctlCalls()).toEqual([]) // nothing restarted while the "task" was still running
      expect(readManifest(p.bridge)?.commit).toBe(OLD)
      const deadline = Date.now() + 30000
      while (Date.now() < deadline) {
        try {
          if (JSON.parse(readFileSync(join(p.stateDir, "last.json"), "utf8")).status === "updated") break
        } catch {}
        await Bun.sleep(250)
      }
      expect(JSON.parse(readFileSync(join(p.stateDir, "last.json"), "utf8")).status).toBe("updated")
      expect(await health()).toBe(NEW)
      expect(ctlCalls()).toEqual(["restart"])
    } finally {
      delete process.env.IRIS_SELF_CMD
    }
  }, 60000)

  test("finish refuses when the install changed between preparing and swapping", async () => {
    fakeHome()
    process.env.IRIS_SELF_CMD = JSON.stringify(["true"]) // the scheduled helper does nothing here
    const r = await run({ detachRestart: true, restartDelaySec: 1 })
    delete process.env.IRIS_SELF_CMD
    expect(r.status).toBe("restart-scheduled")
    put(p.bridge, "lib/a.js", "edited after prepare\n")
    const f = await finishUpdate(join(p.stateDir, "pending.json"), () => {})
    expect(f.status).toBe("blocked")
    expect(readFileSync(join(p.bridge, "lib/a.js"), "utf8")).toBe("edited after prepare\n")
    expect(ctlCalls()).toEqual([])
    // the delayed helper from run() would find no pending file
    expect(existsSync(join(p.stateDir, "pending.json"))).toBe(false)
  }, 60000)

  describe("under systemd: the helper must outlive the service's cgroup", () => {
    // Fakes on PATH for systemd-run and sudo, so the real ones never run. Each logs its argv, then
    // (when it "works") strips its own options and execs the command it was given.
    function fakes(o: { userScope: boolean; sudoScope: boolean }) {
      const bin = join(home, "bin")
      mkdirSync(bin, { recursive: true })
      const strip = `while [ $# -gt 0 ] && [ "\${1#--}" != "$1" ] || [ "$1" = "-n" ]; do shift; done`
      writeFileSync(
        join(bin, "systemd-run"),
        `#!/usr/bin/env bash\necho "systemd-run $*" >> "${home}/launch.log"\ncase " $* " in *" --user "*) ${o.userScope ? ":" : "exit 1"} ;; *) ${o.sudoScope ? ":" : "exit 1"} ;; esac\n${strip}\nexec "$@"\n`,
      )
      writeFileSync(join(bin, "sudo"), `#!/usr/bin/env bash\necho "sudo $*" >> "${home}/launch.log"\n${o.sudoScope ? "" : "exit 1\n"}${strip}\nexec "$@"\n`)
      chmodSync(join(bin, "systemd-run"), 0o755)
      chmodSync(join(bin, "sudo"), 0o755)
      process.env.PATH = `${bin}:${process.env.PATH}`
      writeFileSync(join(home, "cgroup"), "0::/system.slice/iris-daemon.service\n")
      const runner = join(home, "runner.ts")
      writeFileSync(
        runner,
        `import { finishUpdate } from ${JSON.stringify(join(import.meta.dir, "daemon-update.ts"))}\nconst a = process.argv.slice(2)\nawait finishUpdate(a[a.indexOf("--finish") + 1], console.log, Number(a[a.indexOf("--finish-delay") + 1]))\n`,
      )
      process.env.IRIS_SELF_CMD = JSON.stringify([process.execPath, runner])
      return bin
    }
    const savedPath = process.env.PATH
    afterEach(() => {
      process.env.PATH = savedPath
      delete process.env.IRIS_SELF_CMD
    })
    const lastStatus = () => {
      try {
        return JSON.parse(readFileSync(join(p.stateDir, "last.json"), "utf8")).status
      } catch {
        return null
      }
    }
    async function until(status: string) {
      const deadline = Date.now() + 30000
      while (Date.now() < deadline && lastStatus() !== status) await Bun.sleep(250)
      return lastStatus()
    }

    test("inside iris-daemon.service the update detaches by itself and the helper is launched through systemd-run --user --scope", async () => {
      fakeHome()
      fakes({ userScope: true, sudoScope: false })
      const r = await run({ restartDelaySec: 1 }) // no --detach-restart: the cgroup alone forces it
      expect(r.status).toBe("restart-scheduled")
      expect(await until("updated")).toBe("updated")
      const launched = readFileSync(join(home, "launch.log"), "utf8")
      expect(launched).toMatch(/systemd-run --user --scope --collect --quiet --unit=iris-daemon-update-\d+ .*daemon update --finish/)
      expect(launched).not.toContain("sudo")
      expect(await health()).toBe(NEW)
    }, 60000)

    test("no user manager: falls back to sudo -n systemd-run --scope as this uid", async () => {
      fakeHome()
      fakes({ userScope: false, sudoScope: true })
      const r = await run({ restartDelaySec: 1, detachRestart: true })
      expect(r.status).toBe("restart-scheduled")
      expect(await until("updated")).toBe("updated")
      expect(readFileSync(join(home, "launch.log"), "utf8")).toMatch(new RegExp(`sudo -n --preserve-env systemd-run --scope --collect --quiet --unit=iris-daemon-update-\\d+ --uid=${process.getuid!()} .*--finish`))
    }, 60000)

    test("no scope possible: REFUSED before anything is downloaded, swapped or restarted", async () => {
      fakeHome()
      fakes({ userScope: false, sudoScope: false })
      const r = await run({ restartDelaySec: 1, detachRestart: true })
      expect(r.status).toBe("refused")
      expect(r.detail).toContain("nothing to verify or roll back")
      expect(existsSync(p.next) || existsSync(p.prev)).toBe(false)
      expect(readManifest(p.bridge)?.commit).toBe(OLD)
      expect(ctlCalls()).toEqual([])
      expect(lastStatus()).toBe("refused")
    }, 60000)
  })
})
