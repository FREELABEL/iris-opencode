import { describe, test, expect } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  NODE_PREFIX,
  nodeParticipantId,
  isNodeParticipant,
  nodeIdFromParticipant,
  participantPathSegment,
  isValidRole,
  localNodeId,
  resolveParticipant,
} from "./rooms-participants"

/**
 * Room membership for machines (S1 of #185277).
 *
 * Each case here encodes something measured against the live API on 2026-09-14, not a guess:
 * a node-shaped `agent_id` is accepted by `/api/threads/{id}/agents`, and removing it requires
 * the id URL-ENCODED because `node:` carries a colon into a URL path.
 */

describe("nodeParticipantId — the prefix keeps two id spaces apart", () => {
  test("prefixes a bare node id", () => {
    expect(nodeParticipantId("01a098bd-fcfe-70ad")).toBe("node:01a098bd-fcfe-70ad")
  })

  test("is idempotent — prefixing twice would create node:node:…", () => {
    const once = nodeParticipantId("abc")
    expect(nodeParticipantId(once)).toBe(once)
  })

  test("refuses an empty id rather than producing the bare prefix", () => {
    // "node:" alone would be a participant that matches nothing and deletes nothing.
    expect(() => nodeParticipantId("")).toThrow()
    expect(() => nodeParticipantId("   ")).toThrow()
  })

  test("a bloq agent id is NOT mistaken for a node", () => {
    // Real participant observed in a live room: agent_id "243", an int rendered as a string.
    expect(isNodeParticipant("243")).toBe(false)
    expect(isNodeParticipant(nodeParticipantId("243"))).toBe(true)
  })

  test("round-trips back to the bare node id", () => {
    expect(nodeIdFromParticipant(nodeParticipantId("abc-123"))).toBe("abc-123")
    expect(nodeIdFromParticipant("243")).toBe("243")
  })
})

describe("participantPathSegment — the colon must not reach the URL raw", () => {
  test("encodes the colon", () => {
    // Unencoded this is a different path, and the API answers in a way that reads as
    // "that participant was not in the room" rather than "your URL was wrong".
    expect(participantPathSegment("node:01a0-ffff")).toBe("node%3A01a0-ffff")
  })

  test("leaves a plain agent id usable", () => {
    expect(participantPathSegment("243")).toBe("243")
  })
})

describe("isValidRole", () => {
  test("accepts exactly what the API's enum accepts", () => {
    for (const r of ["primary", "support", "observer", "participant"]) expect(isValidRole(r)).toBe(true)
  })
  test("rejects anything else, so the error is ours and not a 422 blob", () => {
    for (const r of ["admin", "owner", "watcher", "Observer", ""]) expect(isValidRole(r)).toBe(false)
  })
})

describe("localNodeId", () => {
  test("reads node_id from the config", () => {
    const d = mkdtempSync(join(tmpdir(), "rp-"))
    const p = join(d, "config.json")
    writeFileSync(p, JSON.stringify({ node_id: "01a0-node", node_api_key: "secret-should-be-ignored" }))
    try {
      expect(localNodeId(p)).toBe("01a0-node")
    } finally { rmSync(d, { recursive: true, force: true }) }
  })

  test("a missing file, bad JSON, or absent node_id returns null rather than throwing", () => {
    const d = mkdtempSync(join(tmpdir(), "rp-"))
    try {
      expect(localNodeId(join(d, "nope.json"))).toBeNull()
      const bad = join(d, "bad.json"); writeFileSync(bad, "{not json")
      expect(localNodeId(bad)).toBeNull()
      const empty = join(d, "empty.json"); writeFileSync(empty, JSON.stringify({ node_api_key: "x" }))
      expect(localNodeId(empty)).toBeNull()
    } finally { rmSync(d, { recursive: true, force: true }) }
  })
})

describe("resolveParticipant — exactly one selector, or refuse", () => {
  test("--agent passes the id through untouched", () => {
    const r = resolveParticipant({ agent: "243" })
    expect("id" in r && r.id).toBe("243")
  })

  test("--node is prefixed", () => {
    const r = resolveParticipant({ node: "01a0-abc" })
    expect("id" in r && r.id).toBe("node:01a0-abc")
  })

  test("--this-node uses the local node id", () => {
    const r = resolveParticipant({ thisNode: true, localNode: () => "01a0-local" })
    expect("id" in r && r.id).toBe("node:01a0-local")
  })

  test("NO selector refuses and says what to pass", () => {
    const r = resolveParticipant({})
    expect("error" in r).toBe(true)
    if ("error" in r) expect(r.error).toContain("--this-node")
  })

  test("TWO selectors refuse rather than pick", () => {
    // The wrong machine silently joining a room and receiving its messages is not something a
    // person watching that room would notice, so guessing is worse than stopping.
    const r = resolveParticipant({ agent: "243", thisNode: true })
    expect("error" in r).toBe(true)
    if ("error" in r) { expect(r.error).toContain("--agent"); expect(r.error).toContain("--this-node") }
  })

  test("--this-node on an un-enrolled machine explains the fix", () => {
    const r = resolveParticipant({ thisNode: true, localNode: () => null })
    expect("error" in r && r.error).toContain("iris hive connect")
  })
})
