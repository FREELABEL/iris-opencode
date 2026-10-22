import { describe, expect, test } from "bun:test"
import { pickNode, type HiveNode } from "./platform-hive-nodes"

/**
 * #190299 — two nodes are named Alexs-MacBook-Pro-11711: the live MacBook, and a registration
 * of the same machine whose last heartbeat was 2026-09-13. Name lookup took whichever the API
 * listed first, so `iris hive run Alexs-MacBook-Pro-11711 …` could pick the dead one and refuse
 * with "is offline" while the machine sat online beside it.
 */
const node = (id: string, name: string, connection_status: string, last_heartbeat_at: string): HiveNode => ({
  id,
  name,
  status: "active",
  connection_status,
  last_heartbeat_at,
})

const DEAD = node("01a098bd-fcfe-70ad-a518-9329e933860b", "Alexs-MacBook-Pro-11711", "offline", "2026-09-13T23:48:37Z")
const LIVE = node("01a09d2c-2076-72e5-9292-7f69c00e8407", "Alexs-MacBook-Pro-11711", "online", "2026-10-21T21:55:08Z")
const HIVE = node("01a10379-0c9f-73c5-bf83-157496a21589", "iris-hive-001", "online", "2026-10-21T21:55:07Z")

describe("pickNode", () => {
  test("a shared name resolves to the online node even when the dead one is listed first", () => {
    const r = pickNode([DEAD, LIVE, HIVE], "Alexs-MacBook-Pro-11711")
    expect(r.node?.id).toBe(LIVE.id)
    expect(r.sameName).toBe(2)
  })

  test("with none online, the most recent heartbeat wins", () => {
    const older = node("a", "box", "offline", "2026-09-01T00:00:00Z")
    const newer = node("b", "box", "offline", "2026-10-01T00:00:00Z")
    expect(pickNode([older, newer], "box").node?.id).toBe("b")
  })

  test("an exact id is never second-guessed, even for an offline node", () => {
    expect(pickNode([DEAD, LIVE], DEAD.id).node?.id).toBe(DEAD.id)
    expect(pickNode([DEAD, LIVE], DEAD.id).sameName).toBe(1)
  })

  test("a unique name and an id prefix still resolve", () => {
    expect(pickNode([DEAD, LIVE, HIVE], "IRIS-HIVE-001").node?.id).toBe(HIVE.id)
    expect(pickNode([DEAD, LIVE, HIVE], "01a10379").node?.id).toBe(HIVE.id)
  })

  test("no match is null", () => {
    expect(pickNode([DEAD, LIVE, HIVE], "nope").node).toBeNull()
  })
})
