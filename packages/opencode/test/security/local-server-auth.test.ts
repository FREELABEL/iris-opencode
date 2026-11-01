// #192113: the local server answers nobody without the token, and no Host but its own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { basic, childEnv, freePort, rawGet, spawnIris, tempHome, waitForPort } from "./harness"

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
  await waitForPort(port)
  try {
    token = JSON.parse(fs.readFileSync(record(), "utf8")).password
  } catch {
    token = ""
  }
}, 90_000)

afterAll(() => {
  proc?.kill()
  home.cleanup()
})

describe("no token", () => {
  for (const p of ["/session", "/config", "/iris", "/doc", "/", "/provider", "/pty"]) {
    test(`${p} is 401 and leaks nothing`, async () => {
      const res = await fetch(url(p), { redirect: "manual" })
      expect(res.status).toBe(401)
      const body = await res.text()
      expect(body).not.toContain(home.root)
      expect(body).not.toContain("slug")
    })
  }

  test("the 401 tells an older client what to do", async () => {
    const res = await fetch(url("/session"))
    expect(res.headers.get("www-authenticate")).toContain("Basic")
    expect(await res.text()).toContain("iris upgrade")
  })

  test("a wrong token is 401", async () => {
    const res = await fetch(url("/session"), { headers: { authorization: basic("wrong") } })
    expect(res.status).toBe(401)
  })

  test("health stays open and says only that it is healthy", async () => {
    for (const p of ["/health", "/global/health"]) {
      const res = await fetch(url(p))
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ healthy: true })
    }
  })

  test("a websocket upgrade gets no terminal", async () => {
    const res = await rawGet(port, "/pty/pty_fake/connect", {
      Host: `127.0.0.1:${port}`,
      Upgrade: "websocket",
      Connection: "Upgrade",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    })
    expect(res.status).toBe(401)
  })
})

describe("the token", () => {
  test("is random, and published owner-only", () => {
    expect(token.length).toBeGreaterThanOrEqual(32)
    if (process.platform !== "win32") {
      expect(fs.statSync(record()).mode & 0o777).toBe(0o600)
      expect(fs.statSync(path.dirname(record())).mode & 0o777).toBe(0o700)
    }
  })

  test("opens the API, and health then reports the version", async () => {
    const headers = { authorization: basic(token), "x-opencode-directory": home.project }
    expect((await fetch(url("/session"), { headers })).status).toBe(200)
    expect(((await (await fetch(url("/global/health"), { headers })).json()) as any).version).toBeString()
  })

  test("a browser exchanges auth_token for a same-origin cookie", async () => {
    const q = encodeURIComponent(Buffer.from(`opencode:${token}`).toString("base64"))
    const res = await fetch(url(`/iris?auth_token=${q}`), { redirect: "manual" })
    expect(res.status).toBeLessThan(400)
    const cookie = res.headers.get("set-cookie") ?? ""
    expect(cookie).toContain("HttpOnly")
    expect(cookie).toContain("SameSite=Strict")
    expect(cookie).not.toContain(token)
    const pair = cookie.split(";")[0]!
    const headers = { cookie: pair, "x-opencode-directory": home.project }
    expect((await fetch(url("/session"), { headers })).status).toBe(200)
    expect(
      (await fetch(url("/session"), { headers: { ...headers, origin: "http://localhost:9" } })).status,
    ).toBe(401)
  })
})

describe("Host and Origin", () => {
  test("a forged Host gets nothing, with or without the token", async () => {
    for (const authorization of [undefined, basic(token)]) {
      for (const p of ["/session", "/config", "/health", "/global/health"]) {
        const res = await rawGet(port, p, {
          Host: "evil.example",
          ...(authorization ? { Authorization: authorization } : {}),
        })
        expect(res.status).toBe(403)
        expect(res.body).not.toContain("slug")
      }
    }
  })

  test("a rebound name carrying our port is refused", async () => {
    const res = await rawGet(port, "/session", { Host: `evil.example:${port}`, Authorization: basic(token) })
    expect(res.status).toBe(403)
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

  test("an evil Origin is refused even holding the token", async () => {
    const res = await fetch(url("/session"), {
      headers: { authorization: basic(token), origin: "https://evil.example" },
    })
    expect(res.status).toBe(403)
  })

  test("an evil preflight gets no allow-origin", async () => {
    const res = await fetch(url("/session"), {
      method: "OPTIONS",
      headers: { origin: "https://evil.example", "access-control-request-method": "GET" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBeNull()
  })

  test("the app's own dev origin passes a preflight without credentials", async () => {
    const res = await fetch(url("/session"), {
      method: "OPTIONS",
      headers: { origin: "http://localhost:3000", "access-control-request-method": "GET" },
    })
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
  })
})

describe("an explicit password", () => {
  test("replaces the random token, and the configured host is allowed", async () => {
    const h = tempHome()
    const p = await freePort()
    const child = spawnIris(["serve", "--port", String(p)], {
      cwd: h.project,
      env: childEnv(h.root, {
        OPENCODE_SERVER_PASSWORD: "fake-password-for-test",
        OPENCODE_SERVER_ALLOWED_HOSTS: "box.tailnet.example",
      }),
    })
    try {
      await waitForPort(p)
      const authorization = basic("fake-password-for-test")
      const directory = { "x-opencode-directory": h.project }
      expect((await rawGet(p, "/session", { Host: "box.tailnet.example", Authorization: authorization, ...directory })).status).toBe(200)
      expect((await rawGet(p, "/session", { Host: `127.0.0.1:${p}`, ...directory })).status).toBe(401)
      expect((await rawGet(p, "/session", { Host: "evil.example", Authorization: authorization })).status).toBe(403)
    } finally {
      child.kill()
      h.cleanup()
    }
  }, 90_000)
})
