import { describe, test, expect } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { missingDaemonAdvice } from "./daemon-advice"

/**
 * #186038 / #185889 — `iris daemon …` on a machine with no daemon must say WHY, and name a fix
 * that works on that machine.
 *
 * Measured 2026-09-18 on a Pathways navigator's Windows machine: `iris daemon status` said
 * "offline", `iris daemon restart` said "Daemon not installed", and the only advice anywhere was
 * `iris daemon install` — which fetched https://heyiris.io/install-daemon (a 404) and piped it to
 * bash (absent on Windows). The real cause, printed once by the installer and never again, was
 * that Node.js was not installed.
 */

const SRC = readFileSync(join(import.meta.dir, "platform-daemon.ts"), "utf8")
const code = SRC.replace(/^\s*(\/\/|\*|\/\*\*).*$/gm, "")

describe("missingDaemonAdvice", () => {
  test("no Node.js: names Node.js, not the daemon, as the problem", () => {
    const [problem, fix] = missingDaemonAdvice(false, "win32")
    expect(problem).toContain("Node.js is not installed")
    expect(fix).toContain("nodejs.org")
    expect(fix).toContain("iris node install")
  })

  test("Windows is told a Windows command, never brew or bash", () => {
    const text = missingDaemonAdvice(false, "win32").join(" ")
    expect(text).toContain("winget")
    expect(text).not.toMatch(/brew|curl|\| bash/)
  })

  test("macOS gets brew, not winget", () => {
    const text = missingDaemonAdvice(false, "darwin").join(" ")
    expect(text).toContain("brew install node")
    expect(text).not.toContain("winget")
  })

  test("Node present: points at the installer that works on every OS", () => {
    for (const os of ["win32", "darwin", "linux"] as const) {
      const [problem, fix] = missingDaemonAdvice(true, os)
      expect(problem).not.toContain("Node.js")
      expect(fix).toBe("Install it: iris node install")
    }
  })
})

describe("every daemon command uses it", () => {
  test("no bare 'Daemon not installed' error is left", () => {
    expect(code).not.toContain('"Daemon not installed"')
    expect(code).not.toContain("Daemon not installed. Run:")
  })

  test("nothing fetches the dead /install-daemon URL or pipes to bash", () => {
    expect(code).not.toContain("heyiris.io/install-daemon")
    expect(code).not.toMatch(/\|\s*bash/)
  })

  test("`daemon install` delegates to `iris node install`", () => {
    const start = code.indexOf("const DaemonInstallCommand")
    const body = code.slice(start, code.indexOf("\n})", start))
    expect(body).toContain("NodeInstallCommand")
  })

  test("`daemon status` does not tell a never-installed machine to restart", () => {
    const start = code.indexOf("if (!daemonUp) {")
    const body = code.slice(start, code.indexOf('prompts.outro("Done")', start))
    const missing = body.indexOf("reportMissingDaemon()")
    const restart = body.indexOf("iris daemon restart")
    expect(missing).toBeGreaterThan(-1)
    expect(body).toContain("if (!getDaemonCtl())")
    expect(missing).toBeLessThan(restart)
  })
})
