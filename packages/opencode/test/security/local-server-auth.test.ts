// #192113 in the Desktop lineage: a standalone `serve` has a token and refuses a forged Host by
// default. Desktop's own launch (explicit password and allowlist) is covered unchanged below.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { basic, childEnv, freePort, rawGet, spawnIris, tempHome, waitReady } from "./harness"

const home = tempHome()
let port = 0
let proc: ReturnType<typeof spawnIris>
let token = ""
const record = () => path.join(home.root, ".iris", "servers", `${port}.json`)
const url = (p: string) => `http://127.0.0.1:${port}${p}`

beforeAll(async () => {
  port = await freePort()
  proc = spawnIris(["serve", "--port", String(port), "--hostname", "127.0.0.1"], {
    cwd: home.project,
    env: childEnv(home.root),
  })
  await waitReady(port)
  try {
    token = JSON.parse(fs.readFileSync(record(), "utf8")).password
  } catch {
    token = ""
  }
}, 180_000)

afterAll(() => {
  proc?.kill()
  home.cleanup()
})

describe("no token", () => {
  for (const p of ["/session", "/config", "/provider", "/pty", "/global/health"]) {
    test(`${p} is 401`, async () => {
      expect((await fetch(url(p))).status).toBe(401)
    })
  }
})

describe("the token", () => {
  test("is random, and published owner-only", () => {
    expect(token.length).toBeGreaterThanOrEqual(32)
    if (process.platform !== "win32") {
      expect(fs.statSync(record()).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(record())).mode & 0o777).toBe(0o700)
    }
  })

  test("opens the API", async () => {
    const res = await fetch(url("/session"), {
      headers: { authorization: basic(token), "x-opencode-directory": home.project },
    })
    expect(res.status).toBe(200)
  })

  test("the auth_token form opens it too, for a browser and a websocket", async () => {
    const q = encodeURIComponent(Buffer.from(`opencode:${token}`).toString("base64"))
    expect((await fetch(url(`/session?auth_token=${q}`), { headers: { "x-opencode-directory": home.project } })).status).toBe(200)
  })
})

describe("Host", () => {
  test("a forged Host gets nothing, with or without the token", async () => {
    for (const auth of [{}, { Authorization: basic(token) }] as Record<string, string>[]) {
      for (const p of ["/session", "/config", "/global/health"]) {
        expect((await rawGet(port, p, { Host: "evil.example", ...auth })).status).toBe(403)
      }
    }
    expect((await rawGet(port, "/session", { Host: `evil.example:${port}`, Authorization: basic(token) })).status).toBe(403)
  })

  test("loopback names are served", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await rawGet(port, "/session", {
        Host: host,
        Authorization: basic(token),
        "x-opencode-directory": home.project,
      })
      expect(res.status).toBe(200)
    }
  })
})

describe("the way Desktop launches its engine", () => {
  test("its password and allowlist win, and it writes no second record", async () => {
    const h = tempHome()
    const p = await freePort()
    const child = spawnIris(["serve", `--port=${p}`], {
      cwd: h.project,
      env: childEnv(h.root, {
        OPENCODE_CLIENT: "desktop",
        OPENCODE_SERVER_PASSWORD: "fake-desktop-password",
        OPENCODE_SERVER_USERNAME: "opencode",
        OPENCODE_SERVER_ALLOWED_HOSTS: `127.0.0.1:${p},localhost:${p}`,
      }),
    })
    try {
      await waitReady(p)
      const authorization = basic("fake-desktop-password")
      const directory = { "x-opencode-directory": h.project }
      expect((await rawGet(p, "/session", { Host: `127.0.0.1:${p}`, Authorization: authorization, ...directory })).status).toBe(200)
      expect((await rawGet(p, "/session", { Host: `127.0.0.1:${p}`, ...directory })).status).toBe(401)
      expect((await rawGet(p, "/session", { Host: "box.example", Authorization: authorization })).status).toBe(403)
      expect(fs.existsSync(path.join(h.root, ".iris", "servers", `${p}.json`))).toBe(false)
    } finally {
      child.kill()
      h.cleanup()
    }
  }, 180_000)
})

describe("the dev loop", () => {
  test("OPENCODE_SERVER_AUTH=off opens loopback only, and Host is still checked", async () => {
    const h = tempHome()
    const p = await freePort()
    const child = spawnIris(["serve", "--port", String(p)], {
      cwd: h.project,
      env: childEnv(h.root, { OPENCODE_SERVER_AUTH: "off" }),
    })
    try {
      await waitReady(p)
      const directory = { "x-opencode-directory": h.project }
      expect((await rawGet(p, "/session", { Host: `127.0.0.1:${p}`, ...directory })).status).toBe(200)
      expect((await rawGet(p, "/session", { Host: "evil.example", ...directory })).status).toBe(403)
    } finally {
      child.kill()
      h.cleanup()
    }
  }, 180_000)

  test("OPENCODE_SERVER_AUTH=off refuses a routable bind", async () => {
    const { prepareListener } = await import("../../src/server/shared/local-auth")
    expect(() => prepareListener({ hostname: "0.0.0.0", env: { OPENCODE_SERVER_AUTH: "off" } })).toThrow("loopback")
    const { resetLocalAuth } = await import("../../src/server/shared/local-auth")
    resetLocalAuth()
  })
})

describe("clients", () => {
  async function iris(args: string[], root = home.root) {
    const child = spawnIris(args, { cwd: home.project, env: childEnv(root) })
    const killer = setTimeout(() => child.kill(), 60_000)
    const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
    const code = await child.exited
    clearTimeout(killer)
    return { output: stdout + stderr, code }
  }

  test("iris run --attach: wrong password is a clear failure", async () => {
    const out = await iris(["run", "--attach", url(""), "--password", "fake-wrong", "hello"])
    expect(out.code).toBe(1)
    expect(out.output).toContain("refused these credentials")
  }, 80_000)

  test("iris run --attach: no record, no password says what to do", async () => {
    const elsewhere = tempHome()
    try {
      const out = await iris(["run", "--attach", url(""), "hello"], elsewhere.root)
      expect(out.code).toBe(1)
      expect(out.output).toContain("requires a token")
    } finally {
      elsewhere.cleanup()
    }
  }, 80_000)

  test("iris attach: wrong password refuses before opening a screen", async () => {
    const out = await iris(["attach", url(""), "--password", "fake-wrong"])
    expect(out.code).toBe(1)
    expect(out.output).toContain("refused these credentials")
  }, 80_000)
})
