import { expect, test } from "bun:test"
import { shareStates, pickConnection, INFERENCE_SHARERS } from "../../src/cli/cmd/platform-hive-models"

// #192752 — sharing is directional: who shares is read per person, never assumed for both sides.
const ME = 7
const conns = [
  { id: "01a1b2c3-aaaa", status: "active", peer_user_id: 9, peer_name: "Robyn", permissions: { files: true, [INFERENCE_SHARERS]: [7] } },
  { id: "01a1ffff-bbbb", status: "active", peer_user_id: 12, peer_name: "Douglas", permissions: { [INFERENCE_SHARERS]: ["12"] } },
  { id: "02cc0000-cccc", status: "pending", peer_user_id: null, peer_name: null, permissions: null },
]

test("reads who shares on each connection, per person", () => {
  const s = shareStates(conns, ME)
  expect(s[0]).toMatchObject({ peer: "Robyn", iShare: true, theyShare: false, active: true })
  expect(s[1]).toMatchObject({ peer: "Douglas", iShare: false, theyShare: true, active: true })
  expect(s[2]).toMatchObject({ peer: "pending invite", iShare: false, theyShare: false, active: false })
})

test("a connection with no sharing list shares nothing", () => {
  expect(shareStates([{ id: "x", status: "active", peer_user_id: 9, permissions: { files: true } }], ME)[0]).toMatchObject({ iShare: false, theyShare: false })
})

test("picks a connection by id, unique id prefix, or peer name — and refuses an ambiguous one", () => {
  const s = shareStates(conns, ME)
  expect(pickConnection(s, "01a1b2c3-aaaa")).toMatchObject({ peer: "Robyn" })
  expect(pickConnection(s, "01a1b")).toMatchObject({ peer: "Robyn" })
  expect(pickConnection(s, "douglas")).toMatchObject({ peer: "Douglas" })
  expect(pickConnection(s, "01a1")).toMatchObject({ error: expect.stringContaining("matches 2") })
  expect(pickConnection(s, "nobody")).toMatchObject({ error: expect.stringContaining("no connection") })
})
