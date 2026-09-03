import { describe, expect, test, beforeEach, afterEach } from "bun:test"
import { mkdtemp, rm, readFile } from "fs/promises"
import { tmpdir } from "os"
import { join } from "path"
import { nameMatches, resolveSshTarget, rememberSshHost } from "./hive-tailscale"

/**
 * Resolving a Hive node to an ssh address (#182368).
 *
 * `iris hive fs ls AlexMaysnow1063 /tmp` failed against a node that was online and reachable:
 *
 *   No Tailscale peer matches Hive node "AlexMaysnow1063". Peers seen: Alex Mayo-Bisnow, ...
 *
 * The Hive registration name and the tailnet name were chosen independently, so they are two
 * different names for the same machine. Substring matching cannot bridge that.
 *
 * The module docblock claimed nameMatches was "exported because a fuzzy match is exactly the
 * kind of thing that should be pinned by tests rather than trusted." It had NO tests. That
 * claim could not be distinguished from the truth by reading the file, which is the same
 * defect shape as the bug itself.
 */
describe("nameMatches", () => {
  test("does NOT bridge two different names for the same machine", () => {
    // The real pair, measured 2026-08-25. This asserts the CURRENT behaviour on purpose:
    // it is correct, and it is what makes an identity binding necessary.
    expect(nameMatches("AlexMaysnow1063", "alex-mayo-bisnow")).toBe(false)
  })

  test("still matches the same name written differently", () => {
    expect(nameMatches("MacBookPro", "macbookpro")).toBe(true)
    expect(nameMatches("MacBookPro", "MacBook-Pro")).toBe(true)
    expect(nameMatches("macbookpro", "macbookpro.local")).toBe(true)
  })

  test("does not match an unrelated peer", () => {
    expect(nameMatches("AlexMaysnow1063", "ROBYN_LAPTOP")).toBe(false)
    expect(nameMatches("AlexMaysnow1063", "qb-host-vanguar")).toBe(false)
  })

  test("empty names never match — absence is not a match", () => {
    expect(nameMatches("", "anything")).toBe(false)
    expect(nameMatches("anything", "")).toBe(false)
  })

  /**
   * KNOWN HAZARD, pinned so it is visible rather than discovered. Substring matching means a
   * SHORT node name can match a longer unrelated peer. `hive fs push` writes files, and this
   * tailnet carries other people's machines, so a false positive here writes onto the wrong
   * laptop. The multi-match guard only refuses when 2+ peers match; a single wrong match
   * proceeds. Loosening this matcher any further is the wrong direction.
   */
  test("HAZARD: a short node name substring-matches a longer peer", () => {
    expect(nameMatches("alex", "alexs-macbook-pro-2")).toBe(true)
  })
})

describe("an operator-asserted --host is remembered", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hive-ssh-"))
    process.env.IRIS_HIVE_SSH_CACHE = join(dir, "hive-ssh.json")
  })
  afterEach(async () => {
    delete process.env.IRIS_HIVE_SSH_CACHE
    await rm(dir, { recursive: true, force: true })
  })

  test("--host is persisted, not used once and thrown away", async () => {
    const r = await resolveSshTarget("node-1", "AlexMaysnow1063", { host: "100.114.214.29" })
    expect("error" in r).toBe(false)

    const cache = JSON.parse(await readFile(process.env.IRIS_HIVE_SSH_CACHE!, "utf-8"))
    expect(cache["node-1"]?.host).toBe("100.114.214.29")
  })

  test("the next call resolves without --host, so the binding is one-time", async () => {
    await rememberSshHost("node-1", "100.114.214.29", "amayo")
    const r = await resolveSshTarget("node-1", "AlexMaysnow1063", {})
    expect(r).toMatchObject({ host: "100.114.214.29", user: "amayo", via: "cached" })
  })

  test("a later explicit --host overrides and re-binds", async () => {
    await rememberSshHost("node-1", "100.0.0.1", null)
    await resolveSshTarget("node-1", "AlexMaysnow1063", { host: "100.114.214.29" })
    const cache = JSON.parse(await readFile(process.env.IRIS_HIVE_SSH_CACHE!, "utf-8"))
    expect(cache["node-1"].host).toBe("100.114.214.29")
  })

  test("binding one node does not bind another", async () => {
    await rememberSshHost("node-1", "100.114.214.29", null)
    const r = await resolveSshTarget("node-2", "SomeOtherBox", {})
    // node-2 has no binding, so it must NOT inherit node-1's address.
    if (!("error" in r)) expect(r.host).not.toBe("100.114.214.29")
  })
})

/**
 * THE REAL FIX for #182368 — ask the machine, do not infer.
 *
 * Persisting --host (below) only removes repeat typing, and the codebase ALREADY did that: a
 * successful ssh probe caches {host,user}. Verified by running yesterday's binary against a
 * cleared cache — it persisted too. So the first cut of this fix was redundant, and the
 * "second call works without --host" demo would have passed without it. A test that passes
 * before and after the change measures nothing.
 *
 * The gap that actually bites is the FIRST call: it fails, and to get past it you must
 * already know the node's IP — which is the thing you asked the tool for.
 *
 * A node reports its own tailnet address in its heartbeat, so resolution can use a fact from
 * the machine instead of a guess about its name. Ordering is deliberately conservative:
 * explicit > cached > advertised > name-match. Advertised sits BELOW cache so no currently
 * working resolution changes behaviour; it only fills the case that used to be a dead end.
 */
describe("a node-advertised address resolves the first call", () => {
  let dir: string
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "hive-ssh-adv-"))
    process.env.IRIS_HIVE_SSH_CACHE = join(dir, "hive-ssh.json")
  })
  afterEach(async () => {
    delete process.env.IRIS_HIVE_SSH_CACHE
    await rm(dir, { recursive: true, force: true })
  })

  test("uses the advertised address when nothing is cached and no --host is given", async () => {
    const r = await resolveSshTarget("node-1", "AlexMaysnow1063", { advertised: "100.114.214.29" })
    expect(r).toMatchObject({ host: "100.114.214.29", via: "advertised" })
  })

  test("an explicit --host still wins over what the node advertised", async () => {
    const r = await resolveSshTarget("node-1", "AlexMaysnow1063", {
      host: "10.0.0.5",
      advertised: "100.114.214.29",
    })
    expect(r).toMatchObject({ host: "10.0.0.5", via: "explicit" })
  })

  test("a cached binding still wins, so no working setup changes behaviour", async () => {
    await rememberSshHost("node-1", "100.0.0.9", null)
    const r = await resolveSshTarget("node-1", "AlexMaysnow1063", { advertised: "100.114.214.29" })
    expect(r).toMatchObject({ host: "100.0.0.9", via: "cached" })
  })

  test("a blank advertised value is ignored rather than dialled", async () => {
    // An empty string is not an address. Treating it as one would turn "the node told us
    // nothing" into "connect to nowhere", which is the absence-vs-value confusion again.
    const r = await resolveSshTarget("node-1", "AlexMaysnow1063", { advertised: "   " })
    expect("error" in r || (r as any).via !== "advertised").toBe(true)
  })
})
