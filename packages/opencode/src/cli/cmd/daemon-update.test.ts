import { describe, expect, test, afterAll } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  blockReason,
  carryOverList,
  computePlan,
  detectLocalState,
  guardedRequire,
  hashTree,
  manifestChanges,
  MANIFEST_NAME,
  parseDaemonVersion,
  parseGitStatus,
  relativeRequires,
  rollbackVerified,
  runtimeMatcher,
  unresolvedRequires,
  updateSucceeded,
  decideLaunch,
  describeLast,
  insideDaemonService,
  systemdServiceOf,
  type LocalState,
} from "./daemon-update"
import { describeNodeCommit, remoteUpdateScript, waitForNodeCommit } from "./daemon-update-fleet"

// #191614 — the pure parts of `iris daemon update`. The full update runs against a fake home in
// daemon-update.integration.test.ts.

const A = "a".repeat(40)
const B = "b".repeat(40)
const dirs: string[] = []
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "du-unit-"))
  dirs.push(d)
  return d
}
afterAll(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })))
const write = (root: string, rel: string, body = "x") => {
  mkdirSync(join(root, rel, ".."), { recursive: true })
  writeFileSync(join(root, rel), body)
}
const clean = (kind: LocalState["kind"], commit: string | null = A): LocalState => ({ kind, commit, modified: [], untracked: [], missing: [] })

describe("the version a node reports through the hub", () => {
  test("commit and drift ride in daemon_version as build metadata", () => {
    expect(parseDaemonVersion(`2.0.0+${A}`)).toEqual({ commit: A, drift: false })
    expect(parseDaemonVersion(`2.0.0+${A}.drift`)).toEqual({ commit: A, drift: true })
  })
  test("a plain version or nothing is an old daemon: no commit, never a guess", () => {
    expect(parseDaemonVersion("2.0.0")).toBeNull()
    expect(parseDaemonVersion(null)).toBeNull()
    expect(parseDaemonVersion("2.0.0+abc1234")).toBeNull()
  })
  test("nodes list says behind / current / unknown", () => {
    expect(describeNodeCommit(`2.0.0+${A}`, A).behind).toBe(false)
    const b = describeNodeCommit(`2.0.0+${A}`, B, 47)
    expect(b.behind).toBe(true)
    expect(b.text).toContain("47 commit(s) behind main")
    expect(describeNodeCommit("2.0.0", B).text).toContain("commit unknown")
    expect(describeNodeCommit(`2.0.0+${A}.drift`, A).text).toContain("LOCAL EDITS")
    expect(describeNodeCommit(`2.0.0+${A}`, null).behind).toBeNull()
  })
})

describe("local-change detector", () => {
  test("git: modified, deleted, renamed and untracked are all local", () => {
    const z = [" M daemon/index.js", "?? lib/mail-compose-draft.js", " D lib/old.js", "R  lib/new.js", "lib/was.js", "A  lib/added.js"].join("\0") + "\0"
    expect(parseGitStatus(z)).toEqual({
      modified: ["daemon/index.js", "lib/new.js", "lib/added.js"],
      untracked: ["lib/mail-compose-draft.js"],
      missing: ["lib/old.js"],
    })
  })
  test("manifest: changed and vanished shipped files, plus non-runtime files it never shipped", () => {
    const isRuntime = runtimeMatcher("*.log\n.env\n")
    const r = manifestChanges(
      { "daemon.js": "1", "lib/a.js": "2", "lib/gone.js": "3" },
      { "daemon.js": "1", "lib/a.js": "EDITED", "lib/hand-copied.js": "9", "daemon.log": "z", ".env": "k" },
      isRuntime,
    )
    expect(r).toEqual({ modified: ["lib/a.js"], untracked: ["lib/hand-copied.js"], missing: ["lib/gone.js"] })
  })
  test("detectLocalState reads a manifest install from disk", () => {
    const d = tmp()
    write(d, "daemon.js", "1")
    write(d, "lib/a.js", "2")
    write(d, ".gitignore", "*.log\n")
    writeFileSync(join(d, MANIFEST_NAME), JSON.stringify({ commit: A, files: hashTree(d) }))
    write(d, "daemon.log", "runtime")
    expect(detectLocalState(d)).toEqual(clean("manifest"))
    write(d, "lib/a.js", "edited")
    expect(detectLocalState(d).modified).toEqual(["lib/a.js"])
  })
  test("no manifest, no git: unknown, and only --force replaces it", () => {
    const d = tmp()
    write(d, "daemon.js")
    const s = detectLocalState(d)
    expect(s.kind).toBe("unknown")
    expect(blockReason(s, false)).toContain("--force")
    expect(blockReason(s, true)).toBeNull()
  })
  test("any local change blocks without --force; a clean install does not", () => {
    expect(blockReason(clean("manifest"), false)).toBeNull()
    expect(blockReason({ ...clean("git"), untracked: ["x.js"] }, false)).toContain("local changes")
    expect(blockReason({ ...clean("manifest"), missing: ["x.js"] }, false)).toContain("local changes")
    expect(blockReason({ ...clean("git"), modified: ["x.js"] }, true)).toBeNull()
  })
  test("a git checkout git cannot read is not assumed clean", () => {
    const d = tmp()
    write(d, "daemon.js")
    mkdirSync(join(d, ".git"))
    const s = detectLocalState(d, () => ({ ok: false, out: "" }))
    expect(blockReason(s, false)).not.toBeNull()
  })
})

describe("require resolver (pre-flight)", () => {
  test("finds relative requires, not packages, not commented ones", () => {
    const src = `const a = require('./a')\nconst b = require("../lib/b.js")\nconst e = require('express')\n// require('./commented')\n/* require('./block') */\nconst url = 'https://heyiris.io/x'; require('./after-url') // trailing require('./c')`
    expect(relativeRequires(src)).toEqual(["./a", "../lib/b.js", "./after-url"])
  })
  test("the MacBook case: daemon/index.js requires a lib file that is missing", () => {
    const d = tmp()
    write(d, "daemon.js", "require('./daemon/index')")
    write(d, "daemon/index.js", "require('../lib/mail-compose')\nrequire('./sub')")
    write(d, "daemon/sub/index.js", "")
    expect(unresolvedRequires(d)).toEqual(["daemon/index.js → require('../lib/mail-compose')"])
    write(d, "lib/mail-compose.js", "")
    expect(unresolvedRequires(d)).toEqual([])
  })
  test("an existsSync-guarded optional sibling is not a failure; tests are not scanned", () => {
    const src = "const D = fs.existsSync(path.join(__dirname, 'x-core.js')) ? require('./x-core.js') : require('../daemon/x')"
    expect(guardedRequire(src, "./x-core.js")).toBe(true)
    expect(guardedRequire(src, "../daemon/x")).toBe(false)
    const d = tmp()
    write(d, "scripts/x.js", src)
    write(d, "daemon/x.js", "")
    write(d, "tests/t.test.js", "assert.match(src, \"require('./nope')\")")
    expect(unresolvedRequires(d)).toEqual([])
  })
})

describe("carry-over list", () => {
  const isRuntime = runtimeMatcher("node_modules/\n.env\n*.log\nyoutube-auth.json\nsom/.som-campaigns-cache.json\n")
  test("runtime files from the code and .gitignore go; code, deps, VCS and the manifest do not", () => {
    const current = [
      ".env",
      "daemon.log",
      "daemon.js",
      "som/instagram-auth-heyiris.io.json",
      "som/.som-campaigns-cache.json",
      "som/som.js",
      "r1-devices.json",
      "ollama-sessions/s1.json",
      "r1-frames.jsonl",
      "test-results/.last-run.json",
      MANIFEST_NAME,
      ".iris-commit",
      "lib/hand-copied.js",
    ]
    expect(carryOverList(current, new Set(["daemon.js", "som/som.js"]), isRuntime)).toEqual([
      ".env",
      "daemon.log",
      "som/instagram-auth-heyiris.io.json",
      "som/.som-campaigns-cache.json",
      "r1-devices.json",
      "ollama-sessions/s1.json",
      "r1-frames.jsonl",
      "test-results/.last-run.json",
    ])
  })
  test("the old install's manifest and .iris-commit are never carried, even when .gitignore lists them", () => {
    const m = runtimeMatcher(`${MANIFEST_NAME}\n.iris-commit\n.env\n`)
    expect(carryOverList([MANIFEST_NAME, ".iris-commit", ".env"], new Set(), m)).toEqual([".env"])
  })
  test("a path the target commit ships is the commit's, never carried", () => {
    expect(carryOverList(["daemon.log"], new Set(["daemon.log"]), isRuntime)).toEqual([])
  })
})

describe("plan", () => {
  const base = {
    current: clean("manifest"),
    target: B,
    currentFiles: { "daemon.js": "1", "lib/a.js": "2", "package-lock.json": "L1" },
    targetFiles: { "daemon.js": "1", "lib/a.js": "3", "lib/new.js": "4", "package-lock.json": "L1" },
    currentAll: ["daemon.js", "lib/a.js", "package-lock.json", ".env"],
    isRuntime: runtimeMatcher(".env\n"),
    hasNodeModules: true,
    force: false,
  }
  test("files changed, deps reused when the lockfile is the same", () => {
    const p = computePlan(base)
    expect(p.filesChanged).toEqual({ added: ["lib/new.js"], removed: ["package-lock.json"].filter(() => false), modified: ["lib/a.js"] })
    expect(p.depsChanged).toBe(false)
    expect(p.carryOver).toEqual([".env"])
    expect(p.blocked).toBeNull()
    expect(p.upToDate).toBe(false)
  })
  test("deps reinstall when the lockfile changed or node_modules is absent", () => {
    expect(computePlan({ ...base, targetFiles: { ...base.targetFiles, "package-lock.json": "L2" } }).depsChanged).toBe(true)
    expect(computePlan({ ...base, hasNodeModules: false }).depsChanged).toBe(true)
  })
  test("same commit, same files, no local changes = up to date", () => {
    expect(computePlan({ ...base, target: A, targetFiles: base.currentFiles }).upToDate).toBe(true)
  })
})

describe("rollback decision", () => {
  test("only the exact new commit on /health is success", () => {
    expect(updateSucceeded({ answered: true, commit: B }, B)).toBe(true)
    expect(updateSucceeded({ answered: true, commit: A }, B)).toBe(false)
    expect(updateSucceeded({ answered: true, commit: null }, B)).toBe(false)
    expect(updateSucceeded({ answered: false, commit: null }, B)).toBe(false)
  })
  test("rollback is verified by the old commit, or — when it had none — by a live daemon that is not the failed one", () => {
    expect(rollbackVerified({ answered: true, commit: A }, A, B)).toBe(true)
    expect(rollbackVerified({ answered: true, commit: null }, A, B)).toBe(false)
    expect(rollbackVerified({ answered: true, commit: null }, null, B)).toBe(true)
    expect(rollbackVerified({ answered: true, commit: B }, null, B)).toBe(false)
    expect(rollbackVerified({ answered: false, commit: null }, null, B)).toBe(false)
  })
})

describe("fleet", () => {
  test("the node runs its own CLI with a detached, delayed restart, and refuses a CLI without the command", () => {
    const s = remoteUpdateScript(B, { delaySec: 15 })
    expect(s).toContain(`daemon update --ref ${B} --detach-restart --restart-delay 15`)
    expect(s).toContain("grep -q -- \"--detach-restart\"")
    expect(remoteUpdateScript(B, { dryRun: true })).not.toContain("--detach-restart --restart")
    expect(() => remoteUpdateScript("main")).toThrow()
  })
  test("waits for the heartbeat to report the exact commit", async () => {
    let t = 0
    const seq = ["2.0.0", `2.0.0+${A}`, `2.0.0+${B}`]
    const r = await waitForNodeCommit(async () => seq.shift() ?? `2.0.0+${B}`, B, { timeoutMs: 100, intervalMs: 10, sleep: async (ms) => void (t += ms), now: () => t })
    expect(r).toEqual({ ok: true, seen: B })
    t = 0
    const r2 = await waitForNodeCommit(async () => `2.0.0+${A}`, B, { timeoutMs: 50, intervalMs: 10, sleep: async (ms) => void (t += ms), now: () => t })
    expect(r2.ok).toBe(false)
  })
})

describe("where the detached restart helper runs", () => {
  const base = { platform: "linux", cgroup: "0::/user.slice/user-1000.slice/session-2.scope", unit: "iris-daemon-update-1", uid: 1000, gid: 1000, userScopeWorks: () => true, sudoScopeWorks: () => true }
  test("macOS (launchd) and plain Linux (nohup): setsid", () => {
    expect(decideLaunch({ ...base, platform: "darwin", cgroup: "" }).kind).toBe("setsid")
    expect(decideLaunch(base).kind).toBe("setsid")
  })
  test("system unit (iris-hive-001): its own user scope, outside the service's cgroup", () => {
    const l = decideLaunch({ ...base, cgroup: "0::/system.slice/iris-daemon.service\n" })
    expect(l.kind).toBe("systemd-user-scope")
    expect(l.prefix).toEqual(["systemd-run", "--user", "--scope", "--collect", "--quiet", "--unit=iris-daemon-update-1"])
  })
  test("a --user unit (#191615) counts; the user manager alone does not", () => {
    expect(systemdServiceOf("0::/user.slice/user-1000.slice/user@1000.service/app.slice/iris-daemon.service")).toBe("iris-daemon.service")
    expect(systemdServiceOf("0::/user.slice/user-1000.slice/user@1000.service/init.scope")).toBeNull()
    expect(decideLaunch({ ...base, invocationId: "abc" }).kind).toBe("systemd-user-scope")
  })
  test("no user manager → sudo -n system scope as this uid; neither → refuse", () => {
    const svc = { ...base, cgroup: "0::/system.slice/iris-daemon.service", userScopeWorks: () => false }
    const s = decideLaunch(svc)
    expect(s.kind).toBe("systemd-sudo-scope")
    expect(s.prefix).toContain("--uid=1000")
    expect(s.prefix.slice(0, 2)).toEqual(["sudo", "-n"])
    const r = decideLaunch({ ...svc, sudoScopeWorks: () => false })
    expect(r.kind).toBe("refuse")
    expect(r.reason).toContain("roll back")
  })
  test("inside the daemon's own service is recognised (system or user unit), a login session is not", () => {
    expect(insideDaemonService("0::/system.slice/iris-daemon.service")).toBe(true)
    expect(insideDaemonService("0::/user.slice/user-1000.slice/user@1000.service/app.slice/iris-daemon.service")).toBe(true)
    expect(insideDaemonService("0::/user.slice/user-1000.slice/session-2.scope")).toBe(false)
  })
  test("last.json tells rolled-back from helper-died", () => {
    const now = Date.parse("2026-10-28T12:00:00Z")
    expect(describeLast({ status: "rolled-back", detail: "x" }, now)).toEqual({ final: true, text: "rolled-back — x" })
    expect(describeLast({ status: "restarting-new", at: "2026-10-28T11:50:00Z", deadline_s: 330 }, now).text).toContain("HELPER DIED during \"restarting-new\"")
    expect(describeLast({ status: "restart-scheduled", at: "2026-10-28T11:59:50Z", deadline_s: 70 }, now).final).toBe(false)
    expect(describeLast(null, now).final).toBe(false)
  })
})
