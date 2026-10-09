import { describe, test, expect } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { defaultTunnelName, validTunnelName, parseRunnerLine, findRunner, explainTunnelApiError, runningPid } from "./platform-hive-relay"

describe("defaultTunnelName", () => {
  test("a Mac hostname becomes a stable, valid label with the port", () => {
    const n = defaultTunnelName("Alexs-MacBook-Pro-11711.local", 3000)
    expect(n).toBe("alexs-macbook-pro-11711-3000")
    expect(validTunnelName(n)).toBe(true)
  })
  test("the same machine and port give the same name — so the certificate is reused, not re-issued", () => {
    expect(defaultTunnelName("iris-hive-001", 8080)).toBe(defaultTunnelName("iris-hive-001", 8080))
  })
  test("odd and very long hostnames still give a valid label", () => {
    for (const h of ["", "___", "A".repeat(200), "host.with.dots.example.com", "-lead-"]) {
      expect(validTunnelName(defaultTunnelName(h, 65535))).toBe(true)
    }
  })
})

describe("validTunnelName", () => {
  test("only DNS labels", () => {
    for (const ok of ["demo", "a", "my-app-3000", "x".repeat(63)]) expect(validTunnelName(ok)).toBe(true)
    for (const bad of ["", "-x", "x-", "UPPER", "a.b", "a_b", "x".repeat(64), "demo.t.heyiris.io"]) expect(validTunnelName(bad)).toBe(false)
  })
})

describe("parseRunnerLine", () => {
  test("reads the runner's JSON events (shapes from relay/tunnel.js)", () => {
    expect(parseRunnerLine('{"event":"ready","url":"https://demo.t.heyiris.io","certificate":"requesting","at":"x"}')).toMatchObject({ event: "ready", certificate: "requesting" })
    expect(parseRunnerLine('{"event":"cert","notAfter":"2027-01-06T23:12:29.000Z","issuer":"letsencrypt"}')).toMatchObject({ event: "cert" })
    expect(parseRunnerLine('{"event":"error","message":"name taken","final":true}')).toMatchObject({ event: "error", final: true })
  })
  test("noise, partial lines and JSON without an event are not events", () => {
    for (const l of ["", "warning: something", "{not json", '{"no":"event"}', "[1,2]"]) expect(parseRunnerLine(l)).toBeNull()
  })
})

describe("findRunner", () => {
  test("finds the bridge's relay/tunnel.js; a bridge that predates tunnels is null", () => {
    const home = mkdtempSync(join(tmpdir(), "relayhome-"))
    expect(findRunner(home, {})).toBeNull()
    mkdirSync(join(home, ".iris", "bridge", "relay"), { recursive: true })
    writeFileSync(join(home, ".iris", "bridge", "relay", "tunnel.js"), "")
    expect(findRunner(home, {})).toBeNull() // half an install (no acme.js) is not a runner
    writeFileSync(join(home, ".iris", "bridge", "relay", "acme.js"), "")
    expect(findRunner(home, {})).toBe(join(home, ".iris", "bridge", "relay", "tunnel.js"))
  })
  test("HIVE_RELAY_DIR wins when it has a runner", () => {
    const home = mkdtempSync(join(tmpdir(), "relayhome-"))
    const dev = mkdtempSync(join(tmpdir(), "relaydev-"))
    mkdirSync(join(dev, "relay"))
    writeFileSync(join(dev, "relay", "tunnel.js"), "")
    writeFileSync(join(dev, "relay", "acme.js"), "")
    expect(findRunner(home, { HIVE_RELAY_DIR: dev })).toBe(join(dev, "relay", "tunnel.js"))
  })
})

describe("explainTunnelApiError", () => {
  test("401 says how to sign in; otherwise the server's own words", () => {
    expect(explainTunnelApiError(401, {})).toContain("iris auth login")
    expect(explainTunnelApiError(409, { error: 'The name "demo" is taken. Pick another.' })).toContain("taken")
    expect(explainTunnelApiError(503, {})).toContain("not switched on")
  })
})

describe("runningPid", () => {
  test("a stale pid file is not a running tunnel", () => {
    const home = mkdtempSync(join(tmpdir(), "relayhome-"))
    mkdirSync(join(home, ".iris", "tunnels", "x"), { recursive: true })
    writeFileSync(join(home, ".iris", "tunnels", "x", "tunnel.pid"), "999999")
    expect(runningPid(home, "x")).toBeNull()
    writeFileSync(join(home, ".iris", "tunnels", "x", "tunnel.pid"), String(process.pid))
    expect(runningPid(home, "x")).toBe(process.pid)
  })
})
