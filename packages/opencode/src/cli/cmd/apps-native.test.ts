import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  buildLaunchdPlist,
  buildLauncherCmd,
  buildLauncherSh,
  buildSecretsFile,
  buildSystemdUnit,
  buildWindowsTaskXml,
  chooseRuntime,
  nativeLayout,
} from "./apps-native"
import type { AppManifest } from "./apps-serve"

const M: AppManifest = { name: "price-check", runtime: "python", entry: "app.py", run: "server", port: 8000, health: "/healthz", egress: [], secrets: ["STRIPE_KEY"], data_class: "internal", requires: [] }

describe("chooseRuntime", () => {
  test("auto prefers docker when present, native otherwise", () => {
    expect(chooseRuntime("auto", true, "internal")).toEqual({ runtime: "docker" })
    expect(chooseRuntime(undefined, false, "internal")).toEqual({ runtime: "native" })
  })
  test("patient data never goes native", () => {
    expect("error" in chooseRuntime("auto", false, "phi")).toBe(true)
    expect("error" in chooseRuntime("native", true, "phi")).toBe(true)
  })
  test("docker requested without docker says so", () => {
    expect(chooseRuntime("docker", false, "internal")).toMatchObject({ error: expect.stringMatching(/no Docker/) })
  })
})

describe("buildSecretsFile", () => {
  test("rejects names and values that could break a launcher", () => {
    const r = buildSecretsFile({ GOOD_KEY: "abc", lower: "x", NEWLINE: "a\nB=c" })
    expect(r.text).toBe("GOOD_KEY=abc\n")
    expect(r.errors.length).toBe(2)
  })
})

describe("POSIX launcher — run for real", () => {
  test("the app sees PORT, HOST and its declared secret — never the user's IRIS login", () => {
    const root = mkdtempSync(join(tmpdir(), "iris-native-"))
    const l = nativeLayout(root, "price-check", "linux")
    mkdirSync(l.src, { recursive: true })
    // A fake uv that just runs the command after `python`, so the test needs no Python download.
    const fakeUv = join(root, "uv")
    writeFileSync(fakeUv, `#!/bin/sh\nwhile [ "$1" != "python" ]; do shift; done; shift; exec /usr/bin/env sh "$@"\n`)
    chmodSync(fakeUv, 0o755)
    writeFileSync(join(l.src, "app.py"), `env | sort > "${join(root, "env.txt")}"\n`)
    writeFileSync(l.secretsFile, "STRIPE_KEY=sk_test_123\nNOT A LINE\n$(touch /tmp/pwned)=x\n")
    writeFileSync(l.launcher, buildLauncherSh(M, l, 18000, fakeUv))
    execFileSync("sh", [l.launcher], { env: { ...process.env, IRIS_API_KEY: "SHOULD-NOT-LEAK", GITHUB_TOKEN: "ghp_leak" } })
    const env = readFileSync(join(root, "env.txt"), "utf8")
    expect(env).toContain("PORT=18000")
    expect(env).toContain("HOST=127.0.0.1")
    expect(env).toContain("STRIPE_KEY=sk_test_123")
    expect(env).not.toContain("SHOULD-NOT-LEAK")
    expect(env).not.toContain("ghp_leak")
    expect(env).not.toContain("NOT A LINE")
  })
})

describe("Windows launcher", () => {
  const l = nativeLayout("C:\\Users\\Kristen Montero", "price-check", "win32")
  const cmd = buildLauncherCmd(M, l, 18000, "C:\\Users\\Kristen Montero\\.local\\bin\\uv.exe")
  test("clears credential variables and sets only what the app may have", () => {
    expect(cmd).toMatch(/for %%V in \(IRIS_API_KEY .*\) do set "%%V="/)
    expect(cmd).toContain('set "HOST=127.0.0.1"')
    expect(cmd).toContain('set "PORT=18000"')
  })
  test("restarts with backoff, capped at 5 minutes", () => {
    expect(cmd).toContain("goto loop")
    expect(cmd).toContain("if !WAIT! gtr 300 set WAIT=300")
  })
  test("paths with spaces are quoted", () => {
    expect(cmd).toContain('cd /d "C:\\Users\\Kristen Montero\\.iris\\apps\\price-check\\src"')
    expect(cmd.includes("\r\n")).toBe(true)
  })
  test("task runs at logon with least privilege and no time limit", () => {
    const xml = buildWindowsTaskXml(M, l, "DESKTOP\\Kristen Montero")
    expect(xml).toContain("<LogonTrigger>")
    expect(xml).toContain("<RunLevel>LeastPrivilege</RunLevel>")
    expect(xml).toContain("<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>")
    expect(xml).toContain("&quot;C:\\Users\\Kristen Montero\\.iris\\apps\\price-check\\run.cmd&quot;")
  })
})

describe("OS supervisors", () => {
  const l = nativeLayout("/home/u", "price-check", "linux")
  test("systemd: restart on failure, capped, no new privileges", () => {
    const u = buildSystemdUnit(M, l)
    for (const k of ["Restart=on-failure", "NoNewPrivileges=yes", "MemoryMax=512M", "TasksMax=256", "WantedBy=default.target"]) expect(u).toContain(k)
  })
  test("launchd: keeps it alive after a crash, starts at login", () => {
    const p = buildLaunchdPlist(M, nativeLayout("/Users/u", "price-check", "darwin"))
    expect(p).toContain("<key>RunAtLoad</key><true/>")
    expect(p).toContain("<key>SuccessfulExit</key><false/>")
    expect(p).toContain("io.heyiris.app.price-check")
  })
})
