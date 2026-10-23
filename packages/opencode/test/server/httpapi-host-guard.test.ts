import { afterEach, describe, expect, test } from "bun:test"
import { Server } from "../../src/server/server"
import {
  ALLOWED_HOSTS_ENV,
  allowedHosts,
  hostAllowed,
  pinAllowedHostsFromEnv,
  resetPinnedAllowedHosts,
} from "../../src/server/shared/host-guard"
import { resetDatabase } from "../fixture/db"
import { disposeAllInstances } from "../fixture/fixture"

// #190647 — IRIS Desktop's engine refuses requests whose Host is not one of its own loopback names,
// so a web page that rebinds its DNS name to 127.0.0.1 cannot reach it. Opt-in via the env var.

const previous = process.env[ALLOWED_HOSTS_ENV]
afterEach(async () => {
  resetPinnedAllowedHosts()
  if (previous === undefined) delete process.env[ALLOWED_HOSTS_ENV]
  else process.env[ALLOWED_HOSTS_ENV] = previous
  await disposeAllInstances()
  await resetDatabase()
})

const health = (host: string, init?: RequestInit) =>
  Server.Default().app.request("/global/health", { ...init, headers: { host, ...(init?.headers ?? {}) } })

describe("host allowlist", () => {
  test("parses a comma list, lowercased, ignoring blanks; empty means no guard", () => {
    expect(allowedHosts(undefined)).toBeUndefined()
    expect(allowedHosts(" , ")).toBeUndefined()
    expect([...allowedHosts("127.0.0.1:4096, LocalHost:4096,")!]).toEqual(["127.0.0.1:4096", "localhost:4096"])
  })

  test("matches the whole host:port, nothing looser", () => {
    const allowed = allowedHosts("127.0.0.1:4096,localhost:4096")
    expect(hostAllowed("127.0.0.1:4096", allowed)).toBe(true)
    expect(hostAllowed("LOCALHOST:4096", allowed)).toBe(true)
    expect(hostAllowed("127.0.0.1:4097", allowed)).toBe(false)
    expect(hostAllowed("evil.example:4096", allowed)).toBe(false)
    expect(hostAllowed("127.0.0.1", allowed)).toBe(false)
    expect(hostAllowed(undefined, allowed)).toBe(false)
    expect(hostAllowed("anything", undefined)).toBe(true)
  })
})

describe("host guard middleware", () => {
  test("unset: any Host is served, exactly as before", async () => {
    delete process.env[ALLOWED_HOSTS_ENV]
    const res = await health("rebound.example:4096")
    expect(res.status).toBe(200)
  })

  test("set: the engine's own names are served", async () => {
    process.env[ALLOWED_HOSTS_ENV] = "127.0.0.1:4096,localhost:4096"
    expect((await health("127.0.0.1:4096")).status).toBe(200)
    expect((await health("localhost:4096")).status).toBe(200)
  })

  test("set: a rebound name, or another port, is refused before anything else runs", async () => {
    process.env[ALLOWED_HOSTS_ENV] = "127.0.0.1:4096,localhost:4096"
    const rebound = await health("rebound.example:4096")
    expect(rebound.status).toBe(403)
    expect(await rebound.text()).toBe("Host not allowed")
    expect((await health("127.0.0.1:4097")).status).toBe(403)
    // A session route too, not only health.
    const sessions = await Server.Default().app.request("/session", { headers: { host: "rebound.example:4096" } })
    expect(sessions.status).toBe(403)
  })

  test("pinned at serve start: still enforced, but gone from the env children inherit", async () => {
    process.env[ALLOWED_HOSTS_ENV] = "127.0.0.1:4096,localhost:4096"
    pinAllowedHostsFromEnv()
    expect(process.env[ALLOWED_HOSTS_ENV]).toBeUndefined()
    expect((await health("127.0.0.1:4096")).status).toBe(200)
    expect((await health("rebound.example:4096")).status).toBe(403)
  })
})
