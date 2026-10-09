import { describe, test, expect } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  parseRepo,
  parseLabels,
  validateRunnerName,
  defaultRunnerName,
  runnerFolder,
  nodeOs,
  pickNode,
  buildInstallScript,
  buildRemoveScript,
  parseScriptOutput,
  parseRunners,
  githubErrorHint,
  upsertRecord,
  dropRecord,
  readRegistry,
  shq,
} from "./platform-hive-runner"

const TOKEN = "AABBCCTOKEN123SECRET"
const base = { owner: "acme", repo: "web.site", name: "iris-box", labels: ["iris-hive", "gpu"], version: "2.338.0", token: TOKEN }

describe("repo / label / name validation", () => {
  test("accepts owner/repo and github URLs", () => {
    expect(parseRepo("acme/web.site")).toEqual({ ok: true, owner: "acme", repo: "web.site" })
    expect(parseRepo("https://github.com/acme/app.git")).toEqual({ ok: true, owner: "acme", repo: "app" })
  })
  test("refuses anything that could reach the shell or a path", () => {
    for (const bad of ["acme", "acme/", "a/b/c", "acme/$(id)", "acme/x;rm -rf ~", "ac'me/x", "../x", "acme/..", "acme/a b", undefined])
      expect(parseRepo(bad).ok).toBe(false)
  })
  test("labels always start with iris-hive and are deduped", () => {
    expect(parseLabels(undefined)).toEqual({ ok: true, labels: ["iris-hive"] })
    expect(parseLabels("gpu, macos,iris-hive,gpu")).toEqual({ ok: false, error: expect.any(String) })
    expect(parseLabels("gpu,macos,iris-hive,gpu")).toEqual({ ok: true, labels: ["iris-hive", "gpu", "macos"] })
  })
  test("labels and names refuse quotes, spaces and shell characters", () => {
    for (const bad of ["a'b", "a b", "a;b", "$(x)", "a`b`"]) {
      expect(parseLabels(bad).ok).toBe(false)
      expect(validateRunnerName(bad).ok).toBe(false)
    }
    expect(validateRunnerName("a,b").ok).toBe(false)
    expect(validateRunnerName("x".repeat(65)).ok).toBe(false)
    expect(validateRunnerName("build-mac_1.2")).toEqual({ ok: true, name: "build-mac_1.2" })
  })
  test("default name is iris-<node>, made safe", () => {
    expect(defaultRunnerName("iris-hive-001")).toBe("iris-hive-001")
    expect(defaultRunnerName("box")).toBe("iris-box")
    expect(defaultRunnerName("Alex's MacBook Pro")).toBe("iris-Alex-s-MacBook-Pro")
    expect(validateRunnerName(defaultRunnerName("Alex's MacBook Pro")).ok).toBe(true)
    expect(runnerFolder("acme", "app", "iris-x")).toBe(".iris/runners/acme-app-iris-x")
  })
})

describe("node selection", () => {
  const n = (id: string, name: string, connection_status: string, platform?: string) =>
    ({ id, name, connection_status, status: "active", hardware_profile: platform ? { os: { platform } } : null }) as any
  test("among duplicate names the online one wins", () => {
    const nodes = [n("1", "Mac", "offline"), n("2", "Mac", "online")]
    expect(pickNode(nodes, "mac")?.id).toBe("2")
    expect(pickNode(nodes, "1")?.id).toBe("1")
    expect(pickNode(nodes, "nope")).toBeNull()
  })
  test("platform from the hardware profile", () => {
    expect(nodeOs(n("1", "a", "online", "win32"))).toBe("win32")
    expect(nodeOs(n("1", "a", "online", "darwin"))).toBe("darwin")
    expect(nodeOs(n("1", "a", "online"))).toBe("unknown")
  })
})

describe("install script", () => {
  const s = buildInstallScript(base)

  test("token appears exactly once, in a single-quoted assignment, and is unset after config", () => {
    expect(s.split(TOKEN).length - 1).toBe(1)
    expect(s).toContain(`RUNNER_TOKEN='${TOKEN}'`)
    expect(s.indexOf("unset RUNNER_TOKEN")).toBeGreaterThan(s.indexOf("./config.sh --unattended"))
  })
  test("no line that prints output mentions the token or its variable", () => {
    for (const line of s.split("\n"))
      if (/\b(echo|printf)\b/.test(line)) {
        expect(line).not.toContain(TOKEN)
        expect(line).not.toContain("RUNNER_TOKEN")
      }
    expect(s).not.toMatch(/set -x/)
  })
  test("every interpolated value is single-quoted", () => {
    expect(s).toContain("OWNER='acme'")
    expect(s).toContain("REPO='web.site'")
    expect(s).toContain("NAME='iris-box'")
    expect(s).toContain("LABELS='iris-hive,gpu'")
    expect(s).toContain("VERSION='2.338.0'")
    expect(shq("it's")).toBe(`'it'\\''s'`)
  })
  test("a hostile token cannot break out of its quotes", () => {
    const evil = buildInstallScript({ ...base, token: "x'; touch /tmp/pwned; echo '" })
    expect(evil).toContain(`RUNNER_TOKEN='x'\\''; touch /tmp/pwned; echo '\\'''`)
  })
  test("OS branches: macOS LaunchAgent, Linux sudo service or nohup fallback, others refused", () => {
    expect(s).toContain("Darwin) OS=osx")
    expect(s).toContain("Linux) OS=linux")
    expect(s).toContain("support macOS and Linux for now")
    expect(s).toMatch(/\.\/svc\.sh install >svc\.log 2>&1 && \.\/svc\.sh start/)
    expect(s).toContain('sudo -n ./svc.sh install "$(id -un)"')
    expect(s).toContain("nohup ./run.sh")
    expect(s).toContain("It will NOT come back after a reboot")
    expect(s).toContain("hw.optional.arm64")
    expect(s).toContain("--labels \"$LABELS\" --replace")
  })
  test("asset URL is built from os/arch/version", () => {
    expect(s).toContain('actions-runner-$OS-$ARCH-$VERSION.tar.gz')
    expect(s).toContain('DIR="$HOME/.iris/runners/$OWNER-$REPO-$NAME"')
  })
  test("is valid bash", () => {
    const f = path.join(os.tmpdir(), `runner-${process.pid}.sh`)
    fs.writeFileSync(f, s)
    fs.writeFileSync(f + ".rm", buildRemoveScript(base))
    expect(spawnSync("bash", ["-n", f]).status).toBe(0)
    expect(spawnSync("bash", ["-n", f + ".rm"]).status).toBe(0)
    fs.rmSync(f); fs.rmSync(f + ".rm")
  })
})

describe("remove script", () => {
  const s = buildRemoveScript(base)
  test("deregisters with the token, never echoes it, deletes only its folder", () => {
    expect(s.split(TOKEN).length - 1).toBe(1)
    expect(s).toContain('./config.sh remove --token "$RUNNER_TOKEN"')
    for (const line of s.split("\n")) if (/\becho\b/.test(line)) expect(line).not.toContain("RUNNER_TOKEN")
    const rm = s.split("\n").filter((l) => l.includes("rm -rf"))
    expect(rm).toEqual(['cd "$HOME" && rm -rf "$DIR"'])
  })
  test("running it where the folder does not exist is a clean no-op", () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "runner-home-"))
    const r = spawnSync("bash", ["-c", s], { env: { ...process.env, HOME: home }, encoding: "utf8" })
    expect(r.status).toBe(0)
    expect(parseScriptOutput(r.stdout).fields.removed).toBe("absent")
    expect(r.stdout).not.toContain(TOKEN)
    fs.rmSync(home, { recursive: true })
  })
})

describe("parsing", () => {
  test("script result and error markers", () => {
    const ok = parseScriptOutput("Downloading\nIRIS_RUNNER_RESULT mode=service os=linux arch=x64 dir=/h/.iris/runners/a\n")
    expect(ok).toEqual({ ok: true, fields: { mode: "service", os: "linux", arch: "x64", dir: "/h/.iris/runners/a" }, log: "Downloading" })
    const bad = parseScriptOutput("tail\nIRIS_RUNNER_ERROR config.sh exited 1\n")
    expect(bad.ok).toBe(false)
    expect(bad.error).toBe("config.sh exited 1")
    expect(parseScriptOutput("").ok).toBe(false)
  })
  test("GitHub runner list", () => {
    const body = {
      total_count: 2,
      runners: [
        { id: 7, name: "iris-hive-001", os: "Linux", status: "online", busy: true, labels: [{ id: 1, name: "self-hosted", type: "read-only" }, { id: 2, name: "iris-hive", type: "custom" }] },
        { id: 8, name: "other", os: "macOS", status: "offline", busy: false, labels: [] },
      ],
    }
    expect(parseRunners(body)).toEqual([
      { id: 7, name: "iris-hive-001", status: "online", busy: true, labels: ["self-hosted", "iris-hive"], os: "Linux" },
      { id: 8, name: "other", status: "offline", busy: false, labels: [], os: "macOS" },
    ])
    expect(parseRunners({ message: "Not Found" })).toEqual([])
    expect(parseRunners(null)).toEqual([])
  })
  test("GitHub errors name the fix", () => {
    expect(githubErrorHint(401, "x")).toContain("gh auth login")
    expect(githubErrorHint(403, "x")).toContain("admin on that repo")
    expect(githubErrorHint(404, "x")).toContain("admin on that repo")
  })
})

describe("runners.json", () => {
  const rec = (repo: string, name: string, node = "n") => ({ repo, name, node, node_id: "1", labels: ["iris-hive"], added_at: "t" })
  test("upsert replaces the same repo+name, drop removes it", () => {
    let l = upsertRecord([], rec("a/b", "x"))
    l = upsertRecord(l, rec("A/b", "x", "m"))
    expect(l).toHaveLength(1)
    expect(l[0].node).toBe("m")
    l = upsertRecord(l, rec("a/b", "y"))
    expect(dropRecord(l, "a/B", "x").map((r) => r.name)).toEqual(["y"])
  })
  test("missing or corrupt file reads as empty", () => {
    expect(readRegistry("/nonexistent/runners.json")).toEqual([])
    const f = path.join(os.tmpdir(), `runners-${process.pid}.json`)
    fs.writeFileSync(f, "{not json")
    expect(readRegistry(f)).toEqual([])
    fs.rmSync(f)
  })
})

describe("which node a runner lives on", () => {
  const { nodeForRunner } = require("./platform-hive-runner")
  test("the record wins, else the node whose default name matches", () => {
    const reg = [{ repo: "a/b", name: "custom", node: "box1", node_id: "1", labels: [], added_at: "t" }]
    expect(nodeForRunner("custom", "A/b", reg, [])).toBe("box1")
    expect(nodeForRunner("iris-hive-001", "a/b", reg, ["iris-hive-001", "Mac"])).toBe("iris-hive-001")
    expect(nodeForRunner("iris-Mac", "a/b", reg, ["iris-hive-001", "Mac"])).toBe("Mac")
    expect(nodeForRunner("someone-else", "a/b", reg, ["Mac"])).toBeNull()
  })
})
