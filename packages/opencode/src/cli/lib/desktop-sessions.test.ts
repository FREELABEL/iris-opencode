import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  asContext,
  channelsIn,
  desktopAccounts,
  findDb,
  DesktopSessionsError,
  getSession,
  listSessions,
  openDesktopDb,
  pickAccount,
  readTranscript,
  redact,
  searchPassages,
  excerpt,
} from "./desktop-sessions"

// The columns IRIS Desktop's engine writes (packages/core/src/session/sql.ts on iris/1.18.23).
function makeDb(path: string, opts: { dropColumn?: boolean } = {}) {
  const db = new Database(path)
  db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, project_id TEXT, parent_id TEXT, slug TEXT, directory TEXT, title TEXT,
           version TEXT, time_created INTEGER, time_updated INTEGER ${opts.dropColumn ? "" : ", time_archived INTEGER"})`)
  db.exec("CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  db.exec("CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)")
  return db
}

function seed(db: Database) {
  const s = db.prepare("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated, time_archived) VALUES (?,?,?,?,?,?,?,?,?)")
  s.run("ses_a", "p", "a", "/Users/me/app", "Quarterly pricing", "1", 1000, 5000, null)
  s.run("ses_b", "p", "b", "/Users/me/app", "Fix the 50% discount_code", "1", 2000, 9000, null)
  s.run("ses_c", "p", "c", "/Users/me/old", "Old archived chat", "1", 500, 600, 700)
  const m = db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?)")
  const p = db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?,?,?,?,?,?)")
  m.run("m1", "ses_a", 1001, 1001, JSON.stringify({ role: "user" }))
  p.run("p1", "m1", "ses_a", 1001, 1001, JSON.stringify({ type: "text", text: "what did we charge Acme? my key is sk-proj-abcdefghijklmnopqrstuv" }))
  m.run("m2", "ses_a", 1002, 1002, JSON.stringify({ role: "assistant" }))
  p.run("p2", "m2", "ses_a", 1002, 1002, JSON.stringify({ type: "tool", tool: "bash", state: { output: "secret tool output" } }))
  p.run("p3", "m2", "ses_a", 1002, 1002, JSON.stringify({ type: "text", text: "Acme paid $4,200 per quarter." }))
  p.run("p4", "m2", "ses_a", 1002, 1002, JSON.stringify({ type: "text", text: "system reminder", synthetic: true }))
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "desktop-sessions-"))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function seeded() {
  const path = join(dir, "opencode.db")
  const db = makeDb(path)
  seed(db)
  db.close()
  return openDesktopDb(path)
}

describe("listing and paging (#190641)", () => {
  test("newest activity first, archived left out unless asked", () => {
    const db = seeded()
    expect(listSessions(db).map((s) => s.id)).toEqual(["ses_b", "ses_a"])
    expect(listSessions(db, { archived: true }).map((s) => s.id)).toEqual(["ses_b", "ses_a", "ses_c"])
    expect(listSessions(db)[1]).toMatchObject({ title: "Quarterly pricing", messages: 2, archived: null })
  })

  test("pages with limit/offset, and --since gives only what changed (incremental sync)", () => {
    const db = seeded()
    expect(listSessions(db, { limit: 1 }).map((s) => s.id)).toEqual(["ses_b"])
    expect(listSessions(db, { limit: 1, offset: 1 }).map((s) => s.id)).toEqual(["ses_a"])
    expect(listSessions(db, { since: 6000 }).map((s) => s.id)).toEqual(["ses_b"])
  })

  test("search matches the title or what was said, and treats % and _ literally", () => {
    const db = seeded()
    expect(listSessions(db, { query: "Acme" }).map((s) => s.id)).toEqual(["ses_a"])
    expect(listSessions(db, { query: "discount_code" }).map((s) => s.id)).toEqual(["ses_b"])
    expect(listSessions(db, { query: "50%" }).map((s) => s.id)).toEqual(["ses_b"])
    expect(listSessions(db, { query: "secret tool output" })).toEqual([])   // tool output is not searched
  })
})

describe("passages and project folders (#190641 follow-up)", () => {
  test("search returns the passages that mention the query, each traced to its session and message", () => {
    const hits = searchPassages(seeded(), "Acme")
    expect(hits.map((h) => [h.sessionId, h.messageId, h.role])).toEqual([
      ["ses_a", "m2", "assistant"],
      ["ses_a", "m1", "user"],
    ])
    expect(hits[0]).toMatchObject({ sessionTitle: "Quarterly pricing", directory: "/Users/me/app", excerpt: "Acme paid $4,200 per quarter." })
    expect(hits[1].excerpt).toContain("[redacted key]")   // redacted before it leaves
  })

  test("passages never come from tool output or synthetic text", () => {
    const db = seeded()
    expect(searchPassages(db, "secret tool output")).toEqual([])
    expect(searchPassages(db, "system reminder")).toEqual([])
  })

  test("--directory keeps a project folder and what is below it, not a sibling with the same prefix", () => {
    const db = seeded()
    db.close()
    const w = new Database(join(dir, "opencode.db"))
    w.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_d','p','d','/Users/me/app/web','Nested','1',1,8000)")
    w.run("INSERT INTO session (id, project_id, slug, directory, title, version, time_created, time_updated) VALUES ('ses_e','p','e','/Users/me/app2','Sibling','1',1,7000)")
    w.close()
    const db2 = openDesktopDb(join(dir, "opencode.db"))
    expect(listSessions(db2, { directory: "/Users/me/app/" }).map((s) => s.id)).toEqual(["ses_b", "ses_d", "ses_a"])
    expect(listSessions(db2, { directory: "/Users/me/old", archived: true }).map((s) => s.id)).toEqual(["ses_c"])
    expect(searchPassages(db2, "Acme", { directory: "/Users/me/app2" })).toEqual([])
  })

  test("an excerpt is centred on the match and marks what it cut", () => {
    const long = "a".repeat(300) + " the Acme invoice " + "b".repeat(300)
    const e = excerpt(long, "acme", 60)
    expect(e).toContain("Acme")
    expect(e.startsWith("…") && e.endsWith("…")).toBe(true)
    expect(e.length).toBeLessThanOrEqual(62)
  })
})

describe("reading a session", () => {
  test("user and assistant text in order, tool output and synthetic text left out, secrets redacted", () => {
    const turns = readTranscript(seeded(), "ses_a")
    expect(turns.map((t) => t.role)).toEqual(["user", "assistant"])
    expect(turns[0].text).toContain("[redacted key]")
    expect(turns[0].text).not.toContain("sk-proj")
    expect(turns[1].text).toBe("Acme paid $4,200 per quarter.")
  })

  test("as agent context: Markdown with the title and every turn", () => {
    const db = seeded()
    const md = asContext(getSession(db, "ses_a")!, readTranscript(db, "ses_a"))
    expect(md).toStartWith("# IRIS Desktop session: Quarterly pricing")
    expect(md).toContain("## assistant\n\nAcme paid $4,200 per quarter.")
  })

  test("--around returns the cited message and the turns either side", () => {
    const db = seeded()
    expect(readTranscript(db, "ses_a", { around: "m2", context: 0 }).map((t) => t.messageId)).toEqual(["m2"])
    expect(readTranscript(db, "ses_a", { around: "m1", context: 1 }).map((t) => t.messageId)).toEqual(["m1", "m2"])
    expect(() => readTranscript(db, "ses_a", { around: "m9" })).toThrow(DesktopSessionsError)
  })

  test("an unknown session is a plain refusal", () => {
    expect(() => readTranscript(seeded(), "ses_nope")).toThrow(DesktopSessionsError)
  })
})

describe("refusals", () => {
  test("a history format this CLI does not know says to update, instead of guessing", () => {
    const path = join(dir, "opencode.db")
    makeDb(path, { dropColumn: true }).close()
    expect(() => openDesktopDb(path)).toThrow(/session lacks time_archived.*iris update/)
  })

  test("a database another OS user owns is not opened", () => {
    const path = join(dir, "opencode.db")
    makeDb(path).close()
    expect(() => openDesktopDb(path, 999999)).toThrow(/belongs to another user/)
  })

  test("the database is opened read-only", () => {
    const db = seeded()
    expect(() => db.exec("DELETE FROM session")).toThrow()
  })
})

describe("accounts", () => {
  test("finds every account's history folder and never returns an API key", () => {
    const home = join(dir, "home")
    mkdirSync(join(home, ".iris", "accounts", "default", "opencode"), { recursive: true })
    makeDb(join(home, ".iris", "accounts", "default", "opencode", "opencode.db")).close()
    const second = join(home, ".iris", "accounts", "5498")
    mkdirSync(join(second, "opencode"), { recursive: true })
    makeDb(join(second, "opencode", "opencode-latest.db")).close()
    writeFileSync(
      join(home, ".iris", "accounts.json"),
      JSON.stringify({ version: 1, accounts: [{ user_id: 5498, email: "k@x.test", key: "iris_live_SECRET", data_dir: second }] }),
    )

    const accts = desktopAccounts(home)
    expect(accts.map((a) => a.id)).toEqual(["default", "5498"])
    expect(accts[1].db).toEndWith("opencode-latest.db")   // no opencode.db: the only channel file
    expect(JSON.stringify(accts)).not.toContain("iris_live_SECRET")
    expect(pickAccount(accts, "k@x.test").id).toBe("5498")
    expect(pickAccount(accts).id).toBe("default")
  })

  test("with no history anywhere, says to open Desktop first", () => {
    const home = join(dir, "empty")
    mkdirSync(home)
    const prev = process.env.XDG_DATA_HOME
    process.env.XDG_DATA_HOME = join(home, "xdg")
    try {
      expect(() => pickAccount(desktopAccounts(home))).toThrow(/open IRIS Desktop/)
    } finally {
      if (prev === undefined) delete process.env.XDG_DATA_HOME
      else process.env.XDG_DATA_HOME = prev
    }
  })
})

test("the released app's opencode.db wins over newer preview-build files; --channel picks one", () => {
  const home = join(dir, "h2")
  const oc = join(home, "opencode")
  mkdirSync(oc, { recursive: true })
  makeDb(join(oc, "opencode.db")).close()
  makeDb(join(oc, "opencode-preview-tonight.db")).close()   // written after — newer
  makeDb(join(oc, "opencode-local.db")).close()
  expect(findDb(home)).toBe(join(oc, "opencode.db"))
  expect(findDb(home, "preview-tonight")).toBe(join(oc, "opencode-preview-tonight.db"))
  expect(findDb(home, "nope")).toBeNull()
  expect(channelsIn(home)).toEqual(["local", "preview-tonight"])
})

test("redact catches the common credential shapes", () => {
  const out = redact(
    "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456 ghp_abcdefghijklmnopqrstuvwxyz AKIAABCDEFGHIJKLMNOP password=hunter2hunter2",
  )
  for (const leak of ["abcdefghijklmnopqrstuvwxyz123456", "ghp_", "AKIA", "hunter2"]) expect(out).not.toContain(leak)
})
