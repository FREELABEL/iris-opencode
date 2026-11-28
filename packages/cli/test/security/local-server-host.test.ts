// #192113 on the v2 server: it always had a token. A forged Host now gets nothing either, including
// the web shell, which is served before API auth.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { basic, childEnv, freePort, rawGet, spawnIris, tempHome, waitForPort } from "./harness"

const PASSWORD = "fake-password-for-test"
const home = tempHome()
let port = 0
let proc: ReturnType<typeof spawnIris>

beforeAll(async () => {
  port = await freePort()
  proc = spawnIris(["serve", "--port", String(port)], {
    cwd: home.project,
    env: childEnv(home.root, { OPENCODE_PASSWORD: PASSWORD, OPENCODE_SERVER_ALLOWED_HOSTS: "box.tailnet.example" }),
  })
  await waitForPort(port, 80_000)
}, 90_000)

afterAll(() => {
  proc?.kill()
  home.cleanup()
})

const get = (path: string, headers: Record<string, string>) => rawGet(port, path, headers)

describe("forged Host", () => {
  for (const path of ["/", "/session", "/config", "/api/session", "/api/info", "/openapi.json"]) {
    test(`${path} is refused with or without the password`, async () => {
      for (const auth of [{}, { Authorization: basic(PASSWORD) }] as Record<string, string>[]) {
        const res = await get(path, { Host: "evil.example", ...auth })
        expect(res.status).toBe(403)
        expect(res.body).not.toContain("<html")
      }
    })
  }

  test("a rebound name carrying our port is refused", async () => {
    expect((await get("/api/info", { Host: `evil.example:${port}`, Authorization: basic(PASSWORD) })).status).toBe(403)
  })
})

describe("its own names", () => {
  test("loopback names reach the API with the password, and 401 without", async () => {
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      expect((await get("/api/info", { Host: host, Authorization: basic(PASSWORD) })).status).toBe(200)
      expect((await get("/api/info", { Host: host })).status).toBe(401)
    }
  })

  test("a configured name is allowed, and still needs the password", async () => {
    expect((await get("/api/info", { Host: "box.tailnet.example", Authorization: basic(PASSWORD) })).status).toBe(200)
    expect((await get("/api/info", { Host: "box.tailnet.example" })).status).toBe(401)
  })

  test("the API without the password says nothing about sessions", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/session`)
    expect(res.status).toBe(401)
    expect(await res.text()).not.toContain("ses_")
  })
})
