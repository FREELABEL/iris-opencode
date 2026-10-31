import { describe, expect, test } from "bun:test"
import { execFileSync } from "child_process"
import { join } from "path"
import { archiveCommit } from "./platform-node"
import { accountMismatch, healthNodeId } from "./platform-hive-enroll"
import { duplicateNames, looksAlive } from "./platform-hive-nodes"

// Joining machines to the Hive: the fixes from the new-iMac session (#191476–#191481).

describe("archiveCommit — the exact commit a daemon archive was made from (#191480)", () => {
  test("reads comment=<sha> from a real git archive, which is how GitHub builds them", () => {
    const repo = join(import.meta.dir, "..", "..", "..")
    const sha = execFileSync("git", ["-C", repo, "rev-parse", "HEAD"]).toString().trim()
    const tgz = execFileSync("git", ["-C", repo, "archive", "--format=tar.gz", "HEAD", "--", "package.json"], { maxBuffer: 1 << 26 })
    expect(archiveCommit(tgz)).toBe(sha)
  })
  test("anything else is null, never a guess", () => {
    expect(archiveCommit(Buffer.from("not gzip"))).toBeNull()
  })
})

describe("accountMismatch — enrolling must not silently replace a login (#191477)", () => {
  test("a different account is named; the same account, none or 0 is fine", () => {
    expect(accountMismatch("2945", 193)).toContain("account 2945")
    expect(accountMismatch("2945", 193)).toContain("account 193")
    expect(accountMismatch("193", 193)).toBeNull()
    expect(accountMismatch(null, 193)).toBeNull()
    expect(accountMismatch("0", 193)).toBeNull()
  })
})

describe("healthNodeId — success is the daemon saying it enrolled (#191476)", () => {
  test("the node id from a real /health body", () => {
    const body = '{"status":"ok","daemon":{"status":"running","node_id":"01a1801e-8eb0-7191-bf97-32dbb3c50f93"},"node_id":"01a1801e-8eb0-7191-bf97-32dbb3c50f93"}'
    expect(healthNodeId(body)).toBe("01a1801e-8eb0-7191-bf97-32dbb3c50f93")
  })
  test("nothing listening, or not enrolled yet, is null", () => {
    expect(healthNodeId("")).toBeNull()
    expect(healthNodeId('{"status":"ok","daemon":{"status":"stopped"}}')).toBeNull()
  })
})

describe("duplicate node names (#191481)", () => {
  const now = Date.now()
  const node = (id: string, name: string, status: string, agoMin: number) =>
    ({ id, name, connection_status: status, last_heartbeat_at: new Date(now - agoMin * 60_000).toISOString() }) as any
  test("names the stale copy, never the one the name resolves to", () => {
    const nodes = [node("live", "Mac", "online", 0), node("old", "Mac", "offline", 44 * 24 * 60), node("solo", "Box", "online", 0)]
    expect(duplicateNames(nodes)).toEqual([{ name: "Mac", count: 2, staleIds: ["old"] }])
  })
  test("a node seen in the last 10 minutes still counts as alive, even if marked offline", () => {
    expect(looksAlive(node("a", "x", "offline", 3), now)).toBe(true)
    expect(looksAlive(node("a", "x", "offline", 30), now)).toBe(false)
    expect(looksAlive(node("a", "x", "online", 999), now)).toBe(true)
  })
})
