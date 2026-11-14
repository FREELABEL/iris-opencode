/**
 * #193288 — `iris imessage send` said "Sent" when the message never reached the conversation.
 *
 * osascript returning cleanly only means Messages accepted the command. These pin the rule that
 * "sent" is decided by chat.db (Messages' own is_sent / error columns), and that every other
 * outcome — failed, missing, stuck, unreadable — is reported as NOT sent.
 * Fixture DB only; no real Messages data is read and nothing is sent.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as im from "../src/cli/lib/imessage"

const EPOCH = 978307200
const toNs = (unix: number) => Math.floor((unix - EPOCH) * 1e9)

function fixture(rows: { handle: string; text: string | null; fromMe?: number; at: number; sent?: number; delivered?: number; error?: number }[]) {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE chat (rowid INTEGER PRIMARY KEY, chat_identifier TEXT)")
  db.exec("CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)")
  db.exec("CREATE TABLE handle (rowid INTEGER PRIMARY KEY, id TEXT)")
  db.exec(`CREATE TABLE message (rowid INTEGER PRIMARY KEY, text TEXT, is_from_me INTEGER, date INTEGER,
           handle_id INTEGER, is_sent INTEGER, is_delivered INTEGER, error INTEGER)`)
  const handles = new Map<string, number>()
  rows.forEach((r, i) => {
    if (!handles.has(r.handle)) {
      const id = handles.size + 1
      handles.set(r.handle, id)
      db.query("INSERT INTO handle VALUES (?,?)").run(id, r.handle)
      db.query("INSERT INTO chat VALUES (?,?)").run(id, r.handle)
    }
    const hid = handles.get(r.handle)!
    db.query("INSERT INTO message VALUES (?,?,?,?,?,?,?,?)").run(
      i + 1, r.text, r.fromMe ?? 1, toNs(r.at), hid, r.sent ?? 0, r.delivered ?? 0, r.error ?? 0,
    )
    db.query("INSERT INTO chat_message_join VALUES (?,?)").run(hid, i + 1)
  })
  im.setQueryForTests((sql) => (db.query(sql).values() as unknown[][]).map((r) => r.map((v) => (v == null ? "" : String(v))).join("|")).join("\n"))
  return db
}

const fast = { timeoutMs: 50, intervalMs: 10 }
const now = Date.now() / 1000

afterEach(() => im.setQueryForTests(null))

describe("confirmOutgoing (#193288)", () => {
  test("sent only when Messages marks the row sent", async () => {
    fixture([{ handle: "+15550100123", text: "hi mom", at: now, sent: 1 }])
    expect(await im.confirmOutgoing("+15550100123", "hi mom", now - 1, fast)).toMatchObject({ state: "sent", delivered: false })
  })

  test("a phone handle matches regardless of formatting", async () => {
    fixture([{ handle: "+15550100123", text: "hi", at: now, sent: 1, delivered: 1 }])
    expect(await im.confirmOutgoing("(555) 010-0123", "hi", now - 1, fast)).toMatchObject({ state: "sent", delivered: true })
  })

  test("Messages' Not Delivered row is a failure, not a send", async () => {
    fixture([{ handle: "+15550100123", text: "hi mom", at: now, error: 22 }])
    expect(await im.confirmOutgoing("+15550100123", "hi mom", now - 1, fast)).toEqual({ state: "failed", rowid: "1", error: 22 })
  })

  test("no row at all — the reported case — is missing, not sent", async () => {
    fixture([{ handle: "+15550100123", text: "older message", at: now - 3600, sent: 1 }])
    expect(await im.confirmOutgoing("+15550100123", "hi mom", now - 1, fast)).toEqual({ state: "missing" })
  })

  test("same text to a different person does not count", async () => {
    fixture([{ handle: "+15550100999", text: "hi mom", at: now, sent: 1 }])
    expect(await im.confirmOutgoing("+15550100123", "hi mom", now - 1, fast)).toEqual({ state: "missing" })
  })

  test("an incoming message with the same text does not count", async () => {
    fixture([{ handle: "+15550100123", text: "hi mom", fromMe: 0, at: now }])
    expect(await im.confirmOutgoing("+15550100123", "hi mom", now - 1, fast)).toEqual({ state: "missing" })
  })

  test("a row stuck unsent past the deadline is pending, not sent", async () => {
    fixture([{ handle: "+15550100123", text: "hi mom", at: now }])
    expect(await im.confirmOutgoing("+15550100123", "hi mom", now - 1, fast)).toEqual({ state: "pending", rowid: "1" })
  })

  test("email handles match case-insensitively", async () => {
    fixture([{ handle: "Mom@iCloud.com", text: "hi", at: now, sent: 1 }])
    expect(await im.confirmOutgoing("mom@icloud.com", "hi", now - 1, fast)).toMatchObject({ state: "sent" })
  })

  test("unreadable chat.db is unknown, never sent", async () => {
    expect(await im.confirmOutgoing("+15550100123", "hi", now, { ...fast, canRead: () => false })).toMatchObject({ state: "unknown" })
  })
})
