import { describe, test, expect } from "bun:test"
import { hiveReason, remoteResult, dedupeInbox } from "./mail-transport"

// =============================================================================
// #189480 — `iris mail` only worked on the machine it ran on. On the cloud box it
// failed with "is Mail.app configured on this Mac?" — wrong (it is not a Mac) and a
// dead end, while an online Hive node had Apple Mail the whole time and the cloud's
// bridge-call rail could reach it in 1.6s (measured 2026-10-15).
// =============================================================================

describe("hiveReason — when to use the Hive node instead of this machine", () => {
  test("not a Mac → Hive, and the reason says so (not 'this Mac')", () => {
    const r = hiveReason({ platform: "linux", via: "auto" })
    expect(r).toMatch(/not a Mac/i)
    expect(r).not.toMatch(/\bthis Mac\b/i)
  })

  test("a Mac whose local bridge has no Mail index → Hive", () => {
    expect(hiveReason({ platform: "darwin", via: "auto", localError: '{"error":"Mail Envelope Index not found — is Mail.app configured on this Mac?"}' })).toBeTruthy()
  })

  test("the new daemon's macOS-only refusal → Hive", () => {
    expect(hiveReason({ platform: "darwin", via: "auto", localError: "Apple Mail is macOS-only — this machine is linux" })).toBeTruthy()
  })

  test("a Mac with working Mail stays local", () => {
    expect(hiveReason({ platform: "darwin", via: "auto" })).toBeNull()
  })

  test("a Full Disk Access refusal stays local — it is fixable HERE, and hiding it behind another machine would bury the fix", () => {
    expect(hiveReason({ platform: "darwin", via: "auto", localError: "Operation not permitted: Full Disk Access" })).toBeNull()
  })

  test("--via local never falls back; --via hive always goes", () => {
    expect(hiveReason({ platform: "linux", via: "local" })).toBeNull()
    expect(hiveReason({ platform: "darwin", via: "hive" })).toMatch(/--via hive/)
  })
})

describe("remoteResult — reading /api/v6/nodes/bridge-call", () => {
  test("success returns the node's data and names the node", () => {
    const r = remoteResult(200, { success: true, node_id: "n1", data: { emails: [{ sender: "a@b.c" }] } })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.data.emails).toHaveLength(1)
  })

  test("no Mac online is a named, actionable failure — never an empty inbox", () => {
    const r = remoteResult(503, { success: false, reason_code: "no_node_online", error: "No online node" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/iris hive nodes list/)
  })

  test("a node without the reply function says to update the daemon", () => {
    const r = remoteResult(422, { success: false, reason_code: "unknown_function", error: 'Unknown function "reply_email"' })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toMatch(/update/i)
  })

  test("a 200 without data is not success", () => {
    expect(remoteResult(200, { success: true }).ok).toBe(false)
  })

  test("the old daemon's JSON-in-a-string output is still read", () => {
    const r = remoteResult(200, { success: true, data: null, output: JSON.stringify({ emails: [] }) })
    expect(r.ok).toBe(true)
  })
})

describe("dedupeInbox — one message, one row", () => {
  test("Gmail's All Mail copy and the INBOX copy collapse to one row, keeping the INBOX one", () => {
    const rows = dedupeInbox([
      { id: 1, sender: "a@b.c", subject: "Hi", date: "2026-10-14T10:00:00Z", mailbox: "imap://X/%5BGmail%5D/All%20Mail" },
      { id: 2, sender: "a@b.c", subject: "Hi", date: "2026-10-14T10:00:00Z", mailbox: "imap://X/INBOX" },
      { id: 3, sender: "a@b.c", subject: "Hi again", date: "2026-10-14T11:00:00Z", mailbox: "imap://X/INBOX" },
    ])
    expect(rows.map((r) => r.id)).toEqual([2, 3])
  })
})
