import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { sweepDesktop, sweepOpencode, type SweepOptions } from "./pulse-check-sweep"

// #190966 — the opencode source read only the old JSON part store, which stopped being written when
// the engine moved to SQLite. It reported "searched" and found nothing recent: a topic worked on in
// the CLI yesterday read as cold.
let home: string
const DAY = 864e5
const now = Date.now()

function seedDb(path: string, rows: [sid: string, at: number, text: string][]) {
  mkdirSync(join(path, ".."), { recursive: true })
  const db = new Database(path)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT, version TEXT,
           time_created INTEGER, time_updated INTEGER, time_archived INTEGER)`)
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  for (const [sid, at, text] of rows) {
    db.prepare("INSERT OR IGNORE INTO session VALUES (?,?,?,?,?,?,?,?,?,?)").run(sid, "p", null, sid, "/Users/me/freelabel", `title ${sid}`, "1", at, at, null)
    const mid = `m_${sid}_${at}`
    db.prepare("INSERT INTO message VALUES (?,?,?,?,?)").run(mid, sid, at, at, JSON.stringify({ role: "user" }))
    db.prepare("INSERT INTO part VALUES (?,?,?,?,?,?)").run(`p_${mid}`, mid, sid, at, at, JSON.stringify({ type: "text", text }))
  }
  db.close()
}

function seedJsonPart(sid: string, text: string) {
  const dir = join(home, ".local", "share", "opencode", "storage", "part", sid)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "prt_1.json"), JSON.stringify({ sessionID: sid, type: "text", text }))
}

const cli = () => join(home, ".local", "share", "opencode")
const desktop = () => join(home, ".iris", "accounts", "default", "opencode")
/** Desktop with a folder of its own (the normal case) — so the CLI's databases are this stop's alone. */
const ownDesktop = () => seedDb(join(desktop(), "opencode.db"), [])

const xdg = process.env.XDG_DATA_HOME
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pulse-opencode-"))
  process.env.XDG_DATA_HOME = join(home, ".local", "share")
})
afterEach(() => {
  process.env.XDG_DATA_HOME = xdg
  rmSync(home, { recursive: true, force: true })
})

const opts = (o: Partial<SweepOptions> = {}): SweepOptions =>
  ({ keyword: "hive sessions", repo: "/tmp", windowDays: 7, limit: 10, sources: ["opencode"], ...o }) as SweepOptions

describe("topic route — opencode stop reads the SQLite store", () => {
  test("a session in opencode.db counts, with its title, and an older one lands in the prior window", () => {
    ownDesktop()
    seedDb(join(cli(), "opencode.db"), [
      ["ses_live", now - DAY, "promote hive sessions into rooms"],
      ["ses_old", now - 10 * DAY, "hive sessions, before"],
    ])
    const sw = sweepOpencode(opts(), home)
    expect(sw.searched).toBe(true)
    expect(sw.hits).toBe(1)
    expect(sw.hitsPrior).toBe(1)
    expect(sw.items[0].text).toBe("title ses_live")
  })

  test("a preview channel's database counts too, and the old JSON store is merged in by session", () => {
    ownDesktop()
    seedDb(join(cli(), "opencode.db"), [["ses_a", now - DAY, "hive sessions"]])
    seedDb(join(cli(), "opencode-local.db"), [["ses_b", now - 2 * DAY, "hive-sessions panel"], ["ses_a", now - 3 * DAY, "hive sessions again"]])
    seedJsonPart("ses_json", "hive sessions in the old store")
    const sw = sweepOpencode(opts(), home)
    expect(sw.hits).toBe(3) // ses_a once across two databases, ses_b, ses_json
  })

  test("leaves out the session running the check", () => {
    ownDesktop()
    seedDb(join(cli(), "opencode.db"), [["ses_self", now - 1000, "hive sessions"], ["ses_other", now - DAY, "hive sessions"]])
    expect(sweepOpencode(opts({ excludeSessions: ["ses_self"] }), home).hits).toBe(1)
  })

  test("a database Desktop's stop reads is not counted again here", () => {
    // Desktop falls back to the CLI's folder when it has none of its own — then both stops would see it.
    seedDb(join(cli(), "opencode.db"), [["ses_shared", now - DAY, "hive sessions"]])
    expect(sweepDesktop({ ...opts(), sources: ["iris_desktop"] } as SweepOptions, home).hits).toBe(1)
    const sw = sweepOpencode(opts(), home)
    expect(sw.hits).toBe(0)
  })

  test("Desktop with its own folder leaves the CLI database to this stop", () => {
    seedDb(join(desktop(), "opencode.db"), [["ses_desk", now - DAY, "hive sessions"]])
    seedDb(join(cli(), "opencode.db"), [["ses_cli", now - DAY, "hive sessions"]])
    expect(sweepOpencode(opts(), home).items.map((i) => i.where).join(" ")).toContain("ses_cli")
    expect(sweepOpencode(opts(), home).hits).toBe(1)
  })

  test("no history at all is a SHUT stop with the reason, never 0 found", () => {
    const sw = sweepOpencode(opts(), home)
    expect(sw.searched).toBe(false)
    expect(sw.unavailableReason).toMatch(/opencode/)
  })
})
