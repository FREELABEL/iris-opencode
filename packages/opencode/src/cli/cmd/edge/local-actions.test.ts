import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { appVersion, describe as powersOf, LocalActions, notifyCommand, parseDecl, type LocalDecl } from "./local-actions"
import { LivePage, liveHooks } from "./live"
import { startStaticServer } from "./serve"

/**
 * #194354 — what an app served on this computer may do here. The page declares, the person
 * approves (outside the page, once per version), this process enforces, and every call is logged.
 */

let dir: string
let ran: { file: string; args: string[] }[]
let asked: string[][]
let answer: boolean
let decl: LocalDecl | null
let doc: string

const make = () =>
  new LocalActions(
    "my-app",
    dir,
    async () => decl,
    async () => doc,
    async (file, args) => (ran.push({ file, args }), { code: 0, out: "done" }),
    async (powers) => (asked.push(powers), answer),
    ["iris"],
  )
const log = () => fs.readFileSync(path.join(dir, "local-actions.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l))

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "local-"))
  ran = []
  asked = []
  answer = true
  decl = { notify: true, agents: ["pause"], files: ["~/Reports"], commands: { backup: ["rsync", "-a", "~/Docs", "/Volumes/B"] } }
  doc = "<html>v1</html>"
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe("the declaration", () => {
  test("keeps only what the bridge knows; anything else is dropped, not honoured", () => {
    expect(parseDecl({ notify: true, shell: "rm -rf /", agents: ["pause", "delete", "trigger"], files: ["~/a", 3], commands: { "bad name!": ["x"], ok: ["ls"], empty: [] } })).toEqual({
      notify: true,
      agents: ["pause"],
      files: ["~/a"],
      commands: { ok: ["ls"] },
    })
    expect(parseDecl(null)).toBeNull()
    expect(parseDecl({ shell: true })).toBeNull()
  })

  test("the person is shown every power, with the exact files and commands", () => {
    expect(powersOf(decl!)).toEqual(["Show notifications", "Pause your agents", "Open ~/Reports", 'Run "backup": rsync -a ~/Docs /Volumes/B'])
  })

  test("the version changes when the powers OR the page changes", () => {
    const v = appVersion(decl!, doc)
    expect(appVersion(decl!, doc)).toBe(v)
    expect(appVersion({ ...decl!, notify: false }, doc)).not.toBe(v)
    expect(appVersion(decl!, "<html>v2</html>")).not.toBe(v)
  })
})

describe("calling", () => {
  test("asks once per version, then runs; a new version asks again", async () => {
    const a = make()
    expect((await a.call("agents.pause", { id: 42 })).status).toBe(200)
    expect(ran.at(-1)).toEqual({ file: "iris", args: ["agents", "pause", "42"] })
    await a.call("agents.pause", { id: 43 })
    expect(asked.length).toBe(1)
    doc = "<html>v2</html>"
    await a.call("agents.pause", { id: 44 })
    expect(asked.length).toBe(2)
  })

  test("a refusal runs nothing", async () => {
    answer = false
    const r = await make().call("notify", { title: "t", body: "b" })
    expect(r.status).toBe(403)
    expect(r.body.reason).toBe("not_approved")
    expect(ran).toEqual([])
  })

  test("anything undeclared is refused WITHOUT asking, so a page cannot spam prompts", async () => {
    const a = make()
    for (const [action, args] of [
      ["agents.resume", { id: 1 }],
      ["shell", { cmd: "rm -rf ~" }],
      ["command.wipe", {}],
      ["open", { path: "~/.ssh/id_rsa" }],
      ["agents.pause", { id: "1; rm -rf /" }],
    ] as const) {
      const r = await a.call(action, args as any)
      expect(r.status).toBeGreaterThanOrEqual(400)
    }
    expect(asked).toEqual([])
    expect(ran).toEqual([])
  })

  test("a command runs exactly as listed — the page cannot add arguments", async () => {
    await make().call("command.backup", { args: ["--delete", "/"] } as any)
    expect(ran[0]!.file).toBe("rsync")
    expect(ran[0]!.args).toEqual(["-a", path.join(os.homedir(), "Docs"), "/Volumes/B"])
  })

  test("a listed file is opened, never read back into the page", async () => {
    const r = await make().call("open", { path: "~/Reports" })
    expect(r.status).toBe(200)
    expect(ran[0]!.args).toEqual([path.join(os.homedir(), "Reports")])
    expect(JSON.stringify(r.body)).not.toContain("Reports/")
  })

  test("every call is logged, refused ones included", async () => {
    const a = make()
    await a.call("agents.pause", { id: 7 })
    await a.call("shell", {})
    const l = log()
    expect(l.some((e) => e.event === "approved")).toBe(true)
    expect(l.some((e) => e.action === "agents.pause 7" && e.result === "ok")).toBe(true)
    expect(l.some((e) => e.action === "shell" && e.result === "refused")).toBe(true)
  })

  test("notification text cannot break out of the script it is put in", () => {
    const [, mac] = notifyCommand('x" & do shell script "rm -rf ~', "b", "darwin")
    expect(mac[1]).toContain('\\"')
    const [, win] = notifyCommand("it's", "b", "win32")
    expect(win[2]).toContain("'it''s'")
  })
})

describe("over HTTP, through the live server", () => {
  test("the app can call it; another site and another host cannot", async () => {
    const live = new LivePage({ slug: "my-app", origin: "http://127.0.0.1:9", bindings: [], token: async () => null, cacheDir: path.join(dir, "live") })
    fs.mkdirSync(path.join(dir, "site"))
    fs.writeFileSync(path.join(dir, "site", "index.html"), "<html></html>")
    let port = 0
    const srv = await startStaticServer(path.join(dir, "site"), 0, liveHooks(live, "my-app", () => port, make()))
    port = srv.port
    try {
      const call = (headers: Record<string, string>) =>
        fetch(`http://localhost:${port}/__iris/local/run`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify({ action: "agents.pause", args: { id: 5 } }) })
      expect((await call({ "Sec-Fetch-Site": "same-origin" })).status).toBe(200)
      expect((await call({ "Sec-Fetch-Site": "cross-site" })).status).toBe(403)
      expect((await call({})).status).toBe(403)
      const st = await (await fetch(`http://localhost:${port}/__iris/local/status`, { headers: { "Sec-Fetch-Site": "same-origin" } })).json()
      expect(st).toEqual({ available: true, approved: true, powers: powersOf(decl!) })
      expect(ran.length).toBe(1)
    } finally {
      await srv.stop()
    }
  })
})
