// #192113: every client that may talk to a local server still can, and one that may not is told why.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { deliverLive, fetchLiveSessions, findLiveServer } from "../../src/cli/cmd/session-live-delivery"
import { LocalAuth } from "../../src/server/local-auth"
import { basic, childEnv, freePort, localProjectConfig, spawnIris, stubModel, tempHome, waitForPort } from "./harness"

const home = tempHome()
const model = stubModel({ name: "no_such_tool", args: {} })
let port = 0
let proc: ReturnType<typeof spawnIris>
let base = ""

async function iris(args: string[], env: Record<string, string> = {}) {
  const child = spawnIris(args, { cwd: home.project, env: childEnv(home.root, env) })
  const killer = setTimeout(() => child.kill(), 50_000)
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  const code = await child.exited
  clearTimeout(killer)
  return { stdout, stderr, code }
}

beforeAll(async () => {
  localProjectConfig(home.project, model.url)
  port = await freePort()
  base = `http://127.0.0.1:${port}`
  proc = spawnIris(["serve", "--port", String(port)], { cwd: home.project, env: childEnv(home.root) })
  await waitForPort(port)
}, 90_000)

afterAll(() => {
  proc?.kill()
  model.server.stop(true)
  home.cleanup()
})

describe("iris run --attach", () => {
  test("finds the token in the server's record, and streams the answer", async () => {
    const out = await iris(["run", "--attach", base, "--format", "json", "say something"])
    expect(out.stdout).toContain("stub done")
    expect(out.code).toBe(0)
  }, 60_000)

  test("wrong password: a clear message and a failing exit", async () => {
    const out = await iris(["run", "--attach", base, "--password", "fake-wrong", "hello"])
    expect(out.code).toBe(1)
    expect(out.stderr + out.stdout).toContain("refused these credentials")
  }, 60_000)

  test("no record, no password: says what to do", async () => {
    const elsewhere = tempHome()
    try {
      const child = spawnIris(["run", "--attach", base, "hello"], { cwd: home.project, env: childEnv(elsewhere.root) })
      const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
      expect(await child.exited).toBe(1)
      expect(stderr + stdout).toContain("requires a token")
    } finally {
      elsewhere.cleanup()
    }
  }, 60_000)
})

describe("iris attach", () => {
  test("wrong password: refuses before opening a screen", async () => {
    const out = await iris(["attach", base, "--password", "fake-wrong"])
    expect(out.code).toBe(1)
    expect(out.stderr + out.stdout).toContain("refused these credentials")
  }, 60_000)
})

describe("an older client, sending nothing", () => {
  test("gets a 401 that says to upgrade, never an empty 200", async () => {
    const res = await fetch(`${base}/session`)
    expect(res.status).toBe(401)
    expect(JSON.stringify(await res.json())).toContain("iris upgrade")
  })
})

// In this process, as the owner of the temp HOME.
describe("iris sessions send", () => {
  const realHomedir = os.homedir
  const realPassword = process.env.OPENCODE_SERVER_PASSWORD
  beforeAll(() => {
    ;(os as any).homedir = () => home.root
    delete process.env.OPENCODE_SERVER_PASSWORD
  })
  afterAll(() => {
    ;(os as any).homedir = realHomedir
    if (realPassword !== undefined) process.env.OPENCODE_SERVER_PASSWORD = realPassword
  })

  test("finds a session, lists sessions and delivers a message with the record's token", async () => {
    const created = await fetch(`${base}/session`, {
      method: "POST",
      headers: {
        authorization: LocalAuth.headersFor(base)!.Authorization,
        "content-type": "application/json",
        "x-opencode-directory": home.project,
      },
      body: "{}",
    })
    expect(created.status).toBe(200)
    const { id } = (await created.json()) as { id: string }
    expect(await findLiveServer(id, [base], 15_000)).toBe(base)
    expect(await fetchLiveSessions(base, 15_000)).not.toBeNull()
    expect(await deliverLive(base, id, "a fake note", 15_000)).toBe(true)
  }, 45_000)
})

describe("where credentials come from", () => {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "iris-records-"))
  const realHomedir = os.homedir
  beforeAll(() => {
    ;(os as any).homedir = () => scratch
  })
  afterAll(() => {
    ;(os as any).homedir = realHomedir
    fs.rmSync(scratch, { recursive: true, force: true })
  })

  const credentials = { username: "opencode", password: "fake-record-password" }
  const env = {}

  test("a remote URL never gets a local secret", () => {
    LocalAuth.writeRecord({ port: 41234, hostname: "127.0.0.1", credentials })
    expect(LocalAuth.credentialsFor("http://127.0.0.1:41234", env)).toEqual(credentials)
    expect(LocalAuth.credentialsFor("http://evil.example:41234", env)).toBeUndefined()
    expect(LocalAuth.credentialsFor("http://127.0.0.1:41235", env)).toBeUndefined()
  })

  test("a record anyone else can read is ignored", () => {
    if (process.platform === "win32") return
    LocalAuth.writeRecord({ port: 41236, hostname: "127.0.0.1", credentials })
    fs.chmodSync(LocalAuth.recordPath(41236), 0o644)
    expect(LocalAuth.credentialsFor("http://127.0.0.1:41236", env)).toBeUndefined()
  })

  test("a dead server's record is ignored, and swept when the next one starts", () => {
    const file = LocalAuth.recordPath(41237)
    fs.writeFileSync(file, JSON.stringify({ version: 1, port: 41237, pid: 2 ** 22 + 7, ...credentials }), { mode: 0o600 })
    expect(LocalAuth.credentialsFor("http://127.0.0.1:41237", env)).toBeUndefined()
    LocalAuth.writeRecord({ port: 41238, hostname: "127.0.0.1", credentials })
    expect(fs.existsSync(file)).toBe(false)
  })

  test("Desktop's own record is read for Desktop's port", () => {
    fs.writeFileSync(
      path.join(scratch, ".iris", "desktop-engine.json"),
      JSON.stringify({ version: 1, port: 41239, username: "opencode", password: "fake-desktop", pid: process.pid }),
      { mode: 0o600 },
    )
    expect(LocalAuth.credentialsFor("http://localhost:41239", env)?.password).toBe("fake-desktop")
  })

  test("the environment wins, and an explicit password beats both", () => {
    expect(LocalAuth.credentialsFor("http://127.0.0.1:41234", { OPENCODE_SERVER_PASSWORD: "fake-env" })?.password).toBe("fake-env")
    expect(LocalAuth.headersFor("http://127.0.0.1:41234", { password: "fake-flag" }, {})?.Authorization).toBe(basic("fake-flag"))
  })
})
