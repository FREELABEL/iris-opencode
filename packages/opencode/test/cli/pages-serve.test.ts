import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  launchdPlist,
  listServed,
  portFor,
  safeSlug,
  schtasksCreate,
  serveArgv,
  serviceSelf,
  serviceCwd,
  publicNameFor,
  swapSite,
  systemdService,
  windowsStartVbs,
  writeState,
} from "../../src/cli/cmd/edge/served"

// #194212 — `iris pages serve <slug>`: a published page running on this computer, still running
// after a reboot, on macOS (launchd), Windows (logon task) and Linux (systemd --user).
// What is written for each OS is pure, so all three are checked here on any OS.

const self = ["C:\\Users\\First Last\\AppData\\Local\\iris\\iris.exe"]
const site = "C:\\Users\\First Last\\.iris\\served\\my-page\\site"

describe("iris pages serve (#194212)", () => {
  test("the same page always gets the same port, and two pages do not share one", () => {
    expect(portFor("playbook-library")).toBe(portFor("playbook-library"))
    const p = portFor("playbook-library")
    expect(p).toBeGreaterThanOrEqual(7400)
    expect(p).toBeLessThan(7900)
    expect(portFor("playbook-library", new Set([p]))).not.toBe(p)
  })

  test("only real slugs reach a plist, a task name or a path", () => {
    expect(safeSlug("playbook-library")).toBe("playbook-library")
    for (const bad of ["../etc", "a b", "x\"; rm", "", "a/b", "list\n"]) expect(safeSlug(bad)).toBeNull()
  })

  test("the server command is the CLI's own serve-edge on the page's folder and port", () => {
    expect(serveArgv(["/usr/local/bin/iris"], "/h/.iris/served/x/site", 7411)).toEqual([
      "/usr/local/bin/iris", "pages", "serve-edge", "/h/.iris/served/x/site", "--port", "7411",
    ])
  })

  test("a compiled binary relaunches as itself; a source run keeps the condition it needs", () => {
    expect(serviceSelf(["/usr/local/bin/iris"])).toEqual(["/usr/local/bin/iris"])
    expect(serviceSelf(["/b/bun", "/r/src/index.ts"])).toEqual(["/b/bun", "run", "--conditions=browser", "/r/src/index.ts"])
    // bun reads bunfig.toml from the working directory: a source run starts in the package folder
    expect(serviceCwd(["/b/bun", "/r/pkg/src/index.ts"], "/home/x")).toBe("/r/pkg")
    expect(serviceCwd(["/usr/local/bin/iris"], "/home/x")).toBe("/home/x")
  })

  test("--public: the tunnel rides on the served process; no token is written into any unit file", () => {
    const argv = serveArgv(["/usr/local/bin/iris"], "/s", 7411, "playbook-library")
    expect(argv.slice(-2)).toEqual(["--public-name", "playbook-library"])
    for (const f of [launchdPlist("x", argv, "/l", "/h"), systemdService("x", argv, "/h"), windowsStartVbs(argv, "C:\\h")]) {
      expect(f).not.toMatch(/IRIS_API_KEY|Bearer|token/i)
    }
    expect(publicNameFor("My_Page--v2")).toBe("my-page-v2")
    expect(publicNameFor("x".repeat(80)).length).toBeLessThanOrEqual(63)
  })

  test("macOS: a launchd agent that starts at login and restarts if it dies", () => {
    const p = launchdPlist("my-page", ["/opt/iris", "pages", "serve-edge", "/Users/a & b/site", "--port", "7411"], "/tmp/l.log", "/Users/a")
    expect(p).toContain("<string>io.heyiris.page.my-page</string>")
    expect(p).toContain("<key>RunAtLoad</key><true/>")
    expect(p).toContain("<key>WorkingDirectory</key><string>/Users/a</string>")
    expect(p).toContain("<key>KeepAlive</key><true/>")
    expect(p).toContain("<string>/Users/a &amp; b/site</string>") // escaped, still valid XML
  })

  test("Windows: a logon task on a hidden-window script, with paths that contain spaces", () => {
    const vbs = windowsStartVbs(serveArgv(self, site, 7411), "C:\\Users\\First Last")
    // window style 0 = hidden: a console window someone can close is how a page dies
    expect(vbs).toContain(", 0, True") // waits on the server…
    expect(vbs).toMatch(/Do\r\n[\s\S]*WScript\.Sleep 3000\r\nLoop/) // …and starts it again if it exits
    expect(vbs).toContain('sh.CurrentDirectory = "C:\\Users\\First Last"')
    // each argument quoted on the command line; "" is a quote inside a VBScript string
    expect(vbs).toContain(`""C:\\Users\\First Last\\AppData\\Local\\iris\\iris.exe"" ""pages"" ""serve-edge"" ""${site}""`)
    const args = schtasksCreate("my-page", "C:\\Users\\First Last\\.iris\\served\\my-page\\start.vbs")
    expect(args).toContain("ONLOGON")
    expect(args).toContain("/F") // re-serving replaces, never stacks tasks
    expect(args[args.indexOf("/TR") + 1]).toBe('wscript.exe "C:\\Users\\First Last\\.iris\\served\\my-page\\start.vbs"')
    expect(args[args.indexOf("/TN") + 1]).toBe("IRIS Page my-page")
  })

  test("Linux: a systemd user unit that restarts and starts with the session", () => {
    const u = systemdService("my-page", ["/home/a b/iris", "pages", "serve-edge", "/s", "--port", "7411"], "/home/a b")
    expect(u).toContain('ExecStart="/home/a b/iris" pages serve-edge /s --port 7411')
    expect(u).toContain("Restart=always")
    expect(u).toContain('WorkingDirectory="/home/a b"')
    expect(u).toContain("WantedBy=default.target")
  })

  test("re-sync swaps the whole folder: no request sees half of each version", () => {
    const dir = mkdtempSync(join(tmpdir(), "served-"))
    mkdirSync(join(dir, "site"))
    writeFileSync(join(dir, "site", "index.html"), "old")
    mkdirSync(join(dir, "next", "site"), { recursive: true })
    writeFileSync(join(dir, "next", "site", "index.html"), "new")
    swapSite(dir, join(dir, "next", "site"))
    expect(readFileSync(join(dir, "site", "index.html"), "utf8")).toBe("new")
    expect(existsSync(join(dir, "site.old"))).toBe(false)
  })

  test("list reads what is served, ignoring folders without state", () => {
    const home = mkdtempSync(join(tmpdir(), "served-home-"))
    writeState({ slug: "b-page", port: 7401, origin: "https://heyiris.io", synced_at: "2026-11-25T00:00:00Z", keeper: "launchd" }, home)
    writeState({ slug: "a-page", port: 7402, origin: "https://heyiris.io", synced_at: "2026-11-25T00:00:00Z", keeper: "schtasks" }, home)
    mkdirSync(join(home, ".iris", "served", "junk"), { recursive: true })
    expect(listServed(home).map((s) => s.slug)).toEqual(["a-page", "b-page"])
  })
})
