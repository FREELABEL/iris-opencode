import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { sweepDesktop, type SweepOptions } from "./pulse-check-sweep"
import { DESKTOP_CHANNEL, desktopSourceFor, type ContactQuery } from "./pulse-contact-script"

// #190661 — Pulse read only the old opencode file store, so IRIS Desktop's chats (SQLite under
// ~/.iris/accounts) never counted. This is the Desktop stop on the topic and contact routes.
let home: string
const DAY = 864e5
const now = Date.now()

function seed() {
  const dir = join(home, ".iris", "accounts", "default", "opencode")
  mkdirSync(dir, { recursive: true })
  const db = new Database(join(dir, "opencode.db"))
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT,
           time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`)
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  const s = db.prepare("INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?)")
  const m = db.prepare("INSERT INTO message VALUES (?,?,?,?,?)")
  const p = db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)")
  const say = (sid: string, mid: string, at: number, role: string, text: string) => {
    m.run(mid, sid, at, at, JSON.stringify({ role }))
    p.run(`p_${mid}`, mid, sid, at, at, JSON.stringify({ type: "text", text }))
  }
  s.run("ses_now", "p", null, "a", "/Users/me/freelabel", "Hive sessions design", "1", now - 2 * DAY, now - 1 * DAY, null)
  say("ses_now", "m1", now - 1 * DAY, "user", "what if Hive Sessions could promote a chat into a room")
  s.run("ses_spell", "p", null, "b", "/Users/me/freelabel", "Spelling", "1", now - 3 * DAY, now - 3 * DAY, null)
  say("ses_spell", "m2", now - 3 * DAY, "assistant", "the hive-sessions panel lists every machine")
  s.run("ses_prior", "p", null, "c", "/Users/me/freelabel", "Earlier", "1", now - 10 * DAY, now - 10 * DAY, null)
  say("ses_prior", "m3", now - 10 * DAY, "user", "hive sessions came up before")
  s.run("ses_self", "p", null, "d", "/Users/me/freelabel", "This run", "1", now, now, null)
  say("ses_self", "m4", now - 1000, "user", "hive sessions — the session running this check")
  s.run("ses_lead", "p", null, "e", "/Users/me/freelabel", "Deal notes", "1", now - DAY, now - DAY, null)
  say("ses_lead", "m5", now - DAY, "user", "Kristen Moore (kristen@acme.test) wants the pilot; token=abcdefgh12345678")
  db.close()
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pulse-desktop-"))
})
afterEach(() => rmSync(home, { recursive: true, force: true }))

const opts = (o: Partial<SweepOptions> = {}): SweepOptions =>
  ({ keyword: "hive sessions", repo: "/tmp", windowDays: 7, limit: 10, sources: ["iris_desktop"], ...o }) as SweepOptions

describe("topic route — IRIS Desktop stop", () => {
  test("counts the sessions that mention the subject in the window, spellings converged, with a prior window", () => {
    seed()
    const sw = sweepDesktop(opts(), home)
    expect(sw.searched).toBe(true)
    expect(sw.source).toBe("iris_desktop")
    expect(sw.hits).toBe(3)                 // ses_now, ses_spell ("hive-sessions"), ses_self
    expect(sw.hitsPrior).toBe(1)            // ses_prior, 10 days ago
    expect(sw.items[0].text).toContain("iris desktop sessions show")
  })

  test("leaves out the session running the check", () => {
    seed()
    const sw = sweepDesktop(opts({ excludeSessions: ["ses_self"] }), home)
    expect(sw.hits).toBe(2)
    expect(sw.items.map((i) => i.text).join(" ")).not.toContain("running this check")
  })

  test("no Desktop on this machine is a SHUT stop with the reason, never 0 found", () => {
    const sw = sweepDesktop(opts(), home)
    expect(sw.searched).toBe(false)
    expect(sw.unavailableReason).toMatch(/IRIS Desktop/)
  })
})

describe("contact route — IRIS Desktop channel", () => {
  const q = (o: Partial<ContactQuery> = {}): ContactQuery =>
    ({ leadId: 1, lead: {}, name: "Kristen Moore", email: "kristen@acme.test", phone: "", allEmails: ["kristen@acme.test"], days: 30, msgLimit: 50, timeoutMs: 5000, ...o }) as ContactQuery

  test("finds your chats that name the person, once per message, redacted, each with the command to open it", async () => {
    seed()
    const r = await desktopSourceFor(home).read(q())
    expect(r.measured).toBe(true)
    expect(r.channels[0].name).toBe(DESKTOP_CHANNEL)
    const msgs = r.channels[0].messages
    expect(msgs).toHaveLength(1)            // matched by name AND email — one message
    expect(msgs[0]).toMatchObject({ session_id: "ses_lead", message_id: "m5", subject: "Deal notes" })
    expect(msgs[0].text).toContain("[redacted]")
    expect(msgs[0].open).toBe("iris desktop sessions show ses_lead --around m5")
  })

  test("a lead with no name or email is said, not searched", async () => {
    seed()
    const r = await desktopSourceFor(home).read(q({ name: "", email: "", allEmails: [] }))
    expect(r.measured).toBe(false)
    expect(r.channels[0].error).toMatch(/No name or email/)
  })

  test("is never filed into the comms ledger — it is context, not contact", async () => {
    const src = await Bun.file(join(import.meta.dir, "platform-leads.ts")).text()
    const map = src.slice(src.indexOf("const channelMap"), src.indexOf("}", src.indexOf("const channelMap")))
    expect(map).not.toContain("IRIS Desktop")
  })
})
