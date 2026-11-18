/**
 * `iris imessage` input guards — #193251, #193252, #193253, #193254.
 *
 * Every assertion here would have failed before the fix:
 *   - `--since garbage` produced NaN and reached SQL (#193251).
 *   - a failed query was swallowed into `[]` and read as "no messages" (#193251).
 *   - sqlite3's error text — SQL and the chat.db path — reached the user (#193251).
 *   - `--last -1` / `--limit -1` became `LIMIT -1`, i.e. no limit (#193253).
 *   - the window label ignored --since (#193254).
 * No real Messages data is read: the query layer runs against an in-memory fixture.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { homedir } from "os"
import { positiveInt, resolveWindow } from "../src/cli/lib/imessage-window"
import * as im from "../src/cli/lib/imessage"

const NOW = new Date(2026, 10, 11, 12, 0, 0).getTime() // 2026-11-11 12:00 local

describe("positiveInt (#193253)", () => {
  test.each([[-1], [0], [1.5], [Number.NaN], ["abc"], [undefined]])("rejects %p", (v) => {
    const r = positiveInt("limit", v)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain("--limit")
  })
  test("accepts whole numbers ≥ 1", () => {
    expect(positiveInt("last", 1)).toEqual({ ok: true, value: 1 })
    expect(positiveInt("last", "25")).toEqual({ ok: true, value: 25 })
  })
})

describe("resolveWindow", () => {
  test.each(["garbage", "2026-13-01", "2026-02-30", "11/01/2026", "", "2026-1-1"])(
    "rejects --since %p instead of letting NaN reach SQL (#193251)",
    (since) => {
      const r = resolveWindow({ since, days: 30 }, NOW)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.error).toContain("--since")
    },
  )

  test("rejects a future --since", () => {
    const r = resolveWindow({ since: "2026-12-01", days: 30 }, NOW)
    expect(r.ok).toBe(false)
  })

  test("--since wins over --days and is described as such (#193254)", () => {
    const r = resolveWindow({ since: "2026-11-01", days: 30 }, NOW)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.value.label).toBe("since 2026-11-01")
    expect(r.value.label).not.toContain("30 days")
    // local midnight 2026-11-01 → noon 2026-11-11 = 10.5 days
    expect(r.value.cutoffSeconds).toBe(10.5 * 86400)
  })

  test("--days: label reflects the real value; negatives rejected (#193253)", () => {
    const ok = resolveWindow({ days: 7 }, NOW)
    expect(ok.ok && ok.value).toEqual({ cutoffSeconds: 7 * 86400, label: "in the last 7 days" })
    expect(resolveWindow({ days: 1 }, NOW)).toMatchObject({ ok: true, value: { label: "in the last 1 day" } })
    expect(resolveWindow({ days: -1 }, NOW).ok).toBe(false)
  })
})

describe("query failures are reported, not swallowed or leaked (#193251)", () => {
  afterEach(() => im.setQueryForTests(null))

  test("queryMessagesWithBody throws instead of returning [] when the query fails", () => {
    const db = new Database(":memory:") // no tables: every query fails
    im.setQueryForTests((sql) => String(db.query(sql).values()))
    expect(() => im.queryMessagesWithBody("1=1", 86400, 10)).toThrow()
  })

  test("an empty result is still []", () => {
    const db = new Database(":memory:")
    db.exec("CREATE TABLE chat (rowid INTEGER PRIMARY KEY, chat_identifier TEXT)")
    db.exec("CREATE TABLE chat_message_join (chat_id INTEGER, message_id INTEGER)")
    db.exec("CREATE TABLE message (rowid INTEGER PRIMARY KEY, text TEXT, is_from_me INTEGER, date INTEGER, attributedBody BLOB, handle_id INTEGER)")
    db.exec("CREATE TABLE handle (rowid INTEGER PRIMARY KEY, id TEXT)")
    im.setQueryForTests((sql) => (db.query(sql).values() as unknown[][]).map((r) => r.join("|")).join("\n"))
    expect(im.queryMessagesWithBody("1=1", 86400, 10)).toEqual([])
  })

  test("describeQueryFailure drops the SQL and the chat.db path", () => {
    const dbPath = `${homedir()}/Library/Messages/chat.db`
    const err = {
      message: `Command failed: sqlite3 "${dbPath}" "SELECT m.rowid FROM message m WHERE x > NaN LIMIT 10;"`,
      stderr: `Parse error near line 1: no such column: NaN\n  SELECT m.rowid FROM message m WHERE x > NaN LIMIT 10;\n        error here ---^\n`,
    }
    const msg = im.describeQueryFailure(err)
    expect(msg).toBe("iMessage database query failed: no such column: NaN")
    expect(msg).not.toContain(dbPath)
    expect(msg).not.toContain(homedir())
    expect(msg).not.toContain("SELECT")
  })

  test("a path inside the sqlite error is masked", () => {
    const dbPath = `${homedir()}/Library/Messages/chat.db`
    const msg = im.describeQueryFailure({ stderr: `Error: unable to open database "${dbPath}": authorization denied` })
    expect(msg).not.toContain(homedir())
    expect(msg).toContain("authorization denied") // the Full Disk Access hint still keys off this
  })
})
