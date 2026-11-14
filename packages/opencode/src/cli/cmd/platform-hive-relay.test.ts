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

// #191176 — Node 18 crashed the relay runner on its first real request; the floor is now 20.
import { findNode, nodeMajor, RELAY_MIN_NODE } from "./platform-hive-relay"
import { join as pjoin } from "path"

describe("findNode — the relay runner never runs on Node 18", () => {
  const versions: Record<string, number> = { node: 18, "/usr/bin/node": 18, "/usr/local/bin/node": 22 }
  const probe = (bin: string) => versions[bin] ?? null

  test("skips an old node on PATH and takes a newer one", () => {
    expect(RELAY_MIN_NODE).toBeGreaterThanOrEqual(20)
    expect(findNode("/nonexistent", {}, probe)).toBe("/usr/local/bin/node")
  })

  test("IRIS_NODE wins when it is new enough, and is skipped when it is not", () => {
    expect(findNode("/nonexistent", { IRIS_NODE: "/opt/n22" }, (b) => (b === "/opt/n22" ? 22 : probe(b)))).toBe("/opt/n22")
    expect(findNode("/nonexistent", { IRIS_NODE: "/opt/n18" }, (b) => (b === "/opt/n18" ? 18 : probe(b)))).toBe("/usr/local/bin/node")
  })

  test("prefers the installer's ~/.iris/runtime node, newest first, over PATH", () => {
    const home = mkdtempSync(pjoin(tmpdir(), "relay-node-"))
    for (const v of ["node-v20.11.0", "node-v22.12.0"]) mkdirSync(pjoin(home, ".iris", "runtime", v, "bin"), { recursive: true })
    const want = pjoin(home, ".iris", "runtime", "node-v22.12.0", "bin", "node")
    const p = (b: string) => (b.includes(".iris/runtime/node-v22") ? 22 : b.includes(".iris/runtime/node-v20") ? 20 : probe(b))
    expect(findNode(home, {}, p)).toBe(want)
  })

  test("nodeMajor reads `node -p process.versions.node`", () => {
    expect(nodeMajor("20.11.1\n")).toBe(20)
    expect(nodeMajor("18.19.1")).toBe(18)
    expect(nodeMajor("v22.12.0")).toBe(22)
    expect(nodeMajor("")).toBeNull()
    expect(nodeMajor("not a version")).toBeNull()
  })

  test("~/.iris/node20 (iris-hive-001's layout) beats the installer runtime and a Node 18 on PATH (#192752)", () => {
    const home = mkdtempSync(pjoin(tmpdir(), "relay-node-"))
    for (const d of ["node20", "node18", pjoin("runtime", "node-v22.12.0")]) mkdirSync(pjoin(home, ".iris", d, "bin"), { recursive: true })
    const n20 = pjoin(home, ".iris", "node20", "bin", "node")
    const p = (b: string) => (b === n20 ? 20 : b.includes(".iris/node18") ? 18 : b.includes(".iris/runtime/node-v22") ? 22 : b === "node" ? 18 : null)
    expect(findNode(home, {}, p)).toBe(n20)
    // IRIS_NODE still wins when it is new enough
    expect(findNode(home, { IRIS_NODE: "/opt/n22" }, (b) => (b === "/opt/n22" ? 22 : p(b)))).toBe("/opt/n22")
    // ~/.iris/node18 is looked at and skipped, never used
    expect(findNode(home, {}, (b) => (b === n20 ? null : p(b)))).toBe(pjoin(home, ".iris", "runtime", "node-v22.12.0", "bin", "node"))
  })

  test("a newer ~/.iris/node* is preferred over an older one", () => {
    const home = mkdtempSync(pjoin(tmpdir(), "relay-node-"))
    for (const d of ["node20", "node22"]) mkdirSync(pjoin(home, ".iris", d, "bin"), { recursive: true })
    expect(findNode(home, {}, (b) => (b.includes(".iris/node22") ? 22 : b.includes(".iris/node20") ? 20 : null))).toBe(pjoin(home, ".iris", "node22", "bin", "node"))
  })

  test("only Node 18 anywhere → null, so the tunnel refuses instead of crashing later", () => {
    expect(findNode("/nonexistent", {}, (b) => (b in versions ? 18 : null))).toBeNull()
  })
})
