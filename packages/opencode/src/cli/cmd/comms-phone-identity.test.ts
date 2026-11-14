/**
 * #183513 — comms ingest must match a lead to a conversation by WHOLE identity, never a substring.
 *
 * Every store here is a fixture SQLite database built in memory with the columns the real code
 * queries. No real WhatsApp or Messages data is read; the numbers are 555-01xx fiction and
 * ITU-reserved drama ranges.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import * as wa from "../lib/whatsapp"
import * as im from "../lib/imessage"
import { parsePhoneIdentity, samePhone } from "../lib/phone-identity"
import * as comms from "./platform-atlas-comms"

// Namespace access so this file also LOADS against the pre-fix code (to prove it fails there).
const ingestWhatsapp = (lead: any) => comms.ingestWhatsapp(lead)
const ingestImessage = (lead: any) => comms.ingestImessage(lead)
const pickLeadForHandle = (h: string, leads: any[]) => comms.pickLeadForHandle(h, leads)
const sweepSummary = (c: comms.SweepCounts) => comms.sweepSummary(c)

const CORE_DATA_EPOCH = 978307200
const asSqlite3Cli = (db: Database) => (sql: string) =>
  (db.query(sql).values() as unknown[][]).map((r) => r.map((v) => (v == null ? "" : String(v))).join("|")).join("\n")

// ── WhatsApp fixture ──

function waDb(chats: { pk: number; jid: string; name?: string; removed?: number }[]) {
  const db = new Database(":memory:")
  db.exec(`CREATE TABLE ZWACHATSESSION (Z_PK INTEGER PRIMARY KEY, ZCONTACTJID TEXT, ZPARTNERNAME TEXT, ZSESSIONTYPE INTEGER,
           ZREMOVED INTEGER, ZLASTMESSAGEDATE REAL, ZUNREADCOUNT INTEGER)`)
  db.exec(`CREATE TABLE ZWAMESSAGE (Z_PK INTEGER PRIMARY KEY, ZCHATSESSION INTEGER, ZMESSAGEDATE REAL, ZISFROMME INTEGER,
           ZTEXT TEXT, ZFROMJID TEXT, ZGROUPMEMBER INTEGER, ZMESSAGETYPE INTEGER)`)
  db.exec(`CREATE TABLE ZWAGROUPMEMBER (Z_PK INTEGER PRIMARY KEY, ZMEMBERJID TEXT, ZCONTACTNAME TEXT, ZFIRSTNAME TEXT,
           ZCHATSESSION INTEGER, ZISACTIVE INTEGER, ZISADMIN INTEGER)`)
  const now = Date.now() / 1000 - CORE_DATA_EPOCH
  let mid = 1
  for (const c of chats) {
    db.query("INSERT INTO ZWACHATSESSION VALUES (?,?,?,0,?,?,0)").run(c.pk, c.jid, c.name ?? `Contact ${c.pk}`, c.removed ?? 0, now - 60)
    for (let i = 0; i < 2; i++) {
      db.query("INSERT INTO ZWAMESSAGE VALUES (?,?,?,?,?,?,NULL,0)").run(mid++, c.pk, now - 3600 - i, i % 2, `fixture text for chat ${c.pk} #${i}`, c.jid)
    }
  }
  wa.setQueryForTests(asSqlite3Cli(db))
  return db
}

const chatsOf = (items: any[]) => [...new Set(items.map((i) => i.body.match(/chat (\d+)/)?.[1]))].map(Number).sort()

// ── iMessage fixture ──

function imDb(identifiers: { rowid: number; id: string }[]) {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE chat (rowid INTEGER PRIMARY KEY, chat_identifier TEXT)")
  db.exec("CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)")
  db.exec("CREATE TABLE message (rowid INTEGER PRIMARY KEY, text TEXT, is_from_me INTEGER, date INTEGER, attributedBody BLOB, handle_id INTEGER)")
  const ns = Math.floor(Date.now() / 1000 - CORE_DATA_EPOCH - 3600) * 1_000_000_000
  let mid = 1
  for (const c of identifiers) {
    db.query("INSERT INTO chat VALUES (?,?)").run(c.rowid, c.id)
    db.query("INSERT INTO message VALUES (?,?,0,?,NULL,0)").run(mid, `fixture text for chat ${c.rowid}`, ns)
    db.query("INSERT INTO chat_message_join VALUES (?,?)").run(c.rowid, mid++)
  }
  im.setQueryForTests(asSqlite3Cli(db))
  return db
}

afterEach(() => {
  wa.setQueryForTests(null)
  im.setQueryForTests(null)
})

// ── The rule ──

describe("phone identity", () => {
  test("formatting variants of one NANP number are the same number", () => {
    const forms = ["+1 (512) 555-0100", "5125550100", "1-512-555-0100", "512.555.0100", "+15125550100", "001 512 555 0100"]
    const parsed = forms.map(parsePhoneIdentity)
    for (const p of parsed) expect(p).toEqual({ ok: true, kind: "full", digits: "15125550100" })
  })

  test("partial and short numbers are not identities", () => {
    for (const bad of ["555-0100", "5550100", "512555010", "+1 512", "0100", "", "call me", "1125550100"]) {
      expect(parsePhoneIdentity(bad).ok).toBe(false)
    }
  })

  test("a national number with a trunk 0 matches only that number under a 1-3 digit country code", () => {
    const uk = parsePhoneIdentity("07700 900123")
    expect(uk).toEqual({ ok: true, kind: "national", nsn: "7700900123" })
    expect(samePhone(uk, parsePhoneIdentity("+447700900123"))).toBe(true)
    expect(samePhone(uk, parsePhoneIdentity("+44417700900123"))).toBe(false) // 4-digit "country code" = a different number
    expect(samePhone(uk, parsePhoneIdentity("+44770090012"))).toBe(false)
    expect(parsePhoneIdentity("0123 4567").ok).toBe(false) // NSN too short
  })

  test("a number is never the same as a longer number containing it", () => {
    expect(samePhone(parsePhoneIdentity("+15125550100"), parsePhoneIdentity("+4415125550100"))).toBe(false)
  })
})

// ── WhatsApp ──

describe("WhatsApp phone matching (#183513)", () => {
  test("a partial number on a lead matches NO chat — it used to match a stranger's", () => {
    waDb([{ pk: 1, jid: "15125550100@s.whatsapp.net" }])
    const r = ingestWhatsapp({ id: 1, phone: "512555010" })
    expect(r.items).toHaveLength(0)
    expect(r.unavailable.join(" ")).toMatch(/phone skipped/)
  })

  test("a 7-digit number shared by two chats in different area codes writes nothing and says why", () => {
    waDb([
      { pk: 1, jid: "14695550100@s.whatsapp.net" },
      { pk: 2, jid: "15125550100@s.whatsapp.net" },
    ])
    const r = ingestWhatsapp({ id: 1, phone: "555-0100" })
    expect(r.items).toHaveLength(0)
    expect(r.unavailable.join(" ")).toMatch(/only 7 digits/)
  })

  test("the full number picks its own chat, not a longer number that contains it", () => {
    waDb([
      { pk: 1, jid: "4415125550100@s.whatsapp.net" }, // stranger, lower pk — LIMIT 1 used to pick this
      { pk: 2, jid: "15125550100@s.whatsapp.net" },
      { pk: 3, jid: "15125550100-1600000000@g.us" }, // a group id containing the digits
    ])
    const r = ingestWhatsapp({ id: 1, phone: "+1 (512) 555-0100" })
    expect(chatsOf(r.items)).toEqual([2])
    expect(r.items[0].metadata).toMatchObject({ matched_by: "phone", matched_chat: "15125550100@s.whatsapp.net" })
  })

  test("formatting variants on the lead reach the same one chat", () => {
    waDb([
      { pk: 1, jid: "14695550100@s.whatsapp.net" },
      { pk: 2, jid: "15125550100@s.whatsapp.net" },
    ])
    for (const phone of ["+1 (512) 555-0100", "5125550100", "512.555.0100", "1 512 555 0100"]) {
      expect(chatsOf(ingestWhatsapp({ id: 1, phone }).items)).toEqual([2])
    }
  })

  test("two chats sharing the lead's national number are AMBIGUOUS: nothing is written, both are named", () => {
    waDb([
      { pk: 1, jid: "447700900123@s.whatsapp.net" },
      { pk: 2, jid: "337700900123@s.whatsapp.net" },
    ])
    const r = ingestWhatsapp({ id: 1, phone: "07700 900123", name: "Sam Example" })
    expect(r.items).toHaveLength(0)
    const why = r.unavailable.join(" ")
    expect(why).toMatch(/ambiguous, nothing written/)
    expect(why).toContain("+447700900123")
    expect(why).toContain("+337700900123")
  })

  test("a national number with exactly one owner is matched", () => {
    waDb([
      { pk: 1, jid: "447700900123@s.whatsapp.net" },
      { pk: 2, jid: "44417700900123@s.whatsapp.net" }, // 4 digits in front: a different number
    ])
    expect(chatsOf(ingestWhatsapp({ id: 1, phone: "07700 900123" }).items)).toEqual([1])
  })

  test("searchByPhone (used by the inbox scan) follows the same rule", () => {
    waDb([
      { pk: 1, jid: "14695550100@s.whatsapp.net" },
      { pk: 2, jid: "15125550100@s.whatsapp.net" },
    ])
    expect(wa.searchByPhone("5550100")).toHaveLength(0)
    expect(wa.searchByPhone("5125550100").map((m) => m.chat_session)).toEqual([2, 2])
    expect(wa.resolvePhoneChat("5550100").status).toBe("invalid")
  })

  test("removed chats are never matched", () => {
    waDb([{ pk: 1, jid: "15125550100@s.whatsapp.net", removed: 1 }])
    expect(wa.resolvePhoneChat("5125550100")).toEqual({ status: "none" })
  })
})

// ── iMessage ──

describe("iMessage handle matching (#183513)", () => {
  test("a short number matches nothing", () => {
    imDb([{ rowid: 1, id: "+15125550100" }, { rowid: 2, id: "+14695550100" }])
    const r = ingestImessage({ id: 1, phone: "555-0100" })
    expect(r.items).toHaveLength(0)
    expect(r.unavailable.join(" ")).toMatch(/only 7 digits/)
  })

  test("an email matches only that address, not a longer one containing it", () => {
    imDb([{ rowid: 1, id: "jimbob@example.com" }, { rowid: 2, id: "bob@example.com" }])
    expect(chatsOf(ingestImessage({ id: 1, email: "BOB@example.com" }).items)).toEqual([2])
  })

  test("the full number matches its SMS and iMessage threads (one person), not a longer number", () => {
    imDb([
      { rowid: 1, id: "+4415125550100" },
      { rowid: 2, id: "+15125550100" },
      { rowid: 3, id: "5125550100" },
    ])
    expect(chatsOf(ingestImessage({ id: 1, phone: "(512) 555-0100" }).items)).toEqual([2, 3])
  })

  test("two different conversations for a national number: ambiguous, nothing written for the lead", () => {
    imDb([
      { rowid: 1, id: "+447700900123" },
      { rowid: 2, id: "+337700900123" },
      { rowid: 3, id: "sam@example.com" },
    ])
    const r = ingestImessage({ id: 1, phone: "07700 900123", email: "sam@example.com" })
    expect(r.items).toHaveLength(0)
    expect(r.unavailable.join(" ")).toMatch(/ambiguous, nothing written/)
  })

  test("an instagram handle is no longer substring-searched against chat identifiers", () => {
    imDb([{ rowid: 1, id: "bob.smith@example.com" }])
    const r = ingestImessage({ id: 1, instagram: "@bob" })
    expect(r.items).toHaveLength(0)
  })
})

// ── --all sweep: handle → lead ──

describe("--all sweep handle → lead (#183513)", () => {
  const leads = [
    { id: 10, phone: "469-555-0100" },
    { id: 11, phone: "+1 (512) 555-0100" },
    { id: 12, email: "pat@example.com", contact_info: { emails: ["pat.alt@example.com"] } },
  ]

  test("a handle goes to the lead that owns that whole number, not the first search hit", () => {
    expect(pickLeadForHandle("+15125550100", leads)).toMatchObject({ status: "matched", lead: { id: 11 } })
    expect(pickLeadForHandle("+15125550199", leads)).toEqual({ status: "none" })
    expect(pickLeadForHandle("pat.alt@example.com", leads)).toMatchObject({ status: "matched", lead: { id: 12 } })
    expect(pickLeadForHandle("at@example.com", leads)).toEqual({ status: "none" })
  })

  test("two leads owning one handle is ambiguous: neither gets the conversation", () => {
    const dupes = [...leads, { id: 13, contact_info: { phone: "5125550100" } }]
    expect(pickLeadForHandle("+15125550100", dupes)).toEqual({ status: "ambiguous", leadIds: [11, 13] })
  })

  test("a short-code / malformed handle is skipped with a reason", () => {
    const m = pickLeadForHandle("55501", leads)
    expect(m.status).toBe("invalid")
  })

  test("the summary names matched, ambiguous and skipped", () => {
    const line = sweepSummary({
      conversations: 9, matched: 4, ambiguous: ["+15125550100: owned by leads 11, 13"], skipped: ["55501: short"],
      unmatched: 3, totalNew: 7, totalKnown: 2, failed: 0,
    })
    expect(line).toContain("4 matched")
    expect(line).toContain("1 ambiguous (nothing written)")
    expect(line).toContain("1 skipped")
    expect(line).toContain("3 matched no lead")
  })
})
