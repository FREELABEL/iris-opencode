/**
 * iMessage time windows must use chat.db's date index — #194233.
 *
 * Every window was written as arithmetic on the column (m.date/1e9 + Apple epoch > now - N), which
 * stops SQLite using `message_idx_date`. On a 188,905-message chat.db on a busy disk that query
 * took 87 s against a 10 s timeout, and the comms sweep reported "no conversations" for five weeks.
 * `sinceClause()` compares the raw column to a constant: same rows, index used, 0.4 s.
 */
import { describe, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import { readFileSync } from "fs"
import { join } from "path"
import { sinceClause, APPLE_EPOCH } from "../src/cli/lib/imessage"

const NOW = Date.UTC(2026, 10, 25, 17, 0, 0)
const nsAgo = (seconds: number) => (BigInt(Math.floor(NOW / 1000) - seconds - APPLE_EPOCH) * 1000000000n).toString()

function fixture() {
  const db = new Database(":memory:")
  db.exec("CREATE TABLE message (rowid INTEGER PRIMARY KEY, date INTEGER, text TEXT)")
  db.exec("CREATE INDEX message_idx_date ON message(date)")
  const ages = [60, 3600, 86400, 2 * 86400, 3 * 86400 - 5, 3 * 86400 + 5, 10 * 86400, 400 * 86400]
  for (const a of ages) db.exec(`INSERT INTO message (date, text) VALUES (${nsAgo(a)}, 'age ${a}')`)
  return { db, ages }
}

describe("sinceClause (#194233)", () => {
  test("selects exactly the messages inside the window", () => {
    const { db, ages } = fixture()
    const rows = db.query(`SELECT text FROM message m WHERE ${sinceClause(3 * 86400, NOW)}`).values() as string[][]
    const got = rows.map((r) => Number(String(r[0]).replace("age ", ""))).sort((a, b) => a - b)
    expect(got).toEqual(ages.filter((a) => a < 3 * 86400).sort((a, b) => a - b))
  })

  test("SQLite uses the date index for it", () => {
    const { db } = fixture()
    const plan = (db.query(`EXPLAIN QUERY PLAN SELECT text FROM message m WHERE ${sinceClause(3 * 86400, NOW)}`).values() as unknown[][])
      .map((r) => String(r[r.length - 1])).join(" ")
    expect(plan).toContain("message_idx_date")
  })

  test("the old column arithmetic does not — the reason for the change", () => {
    const { db } = fixture()
    const plan = (db.query(`EXPLAIN QUERY PLAN SELECT text FROM message m WHERE m.date/1000000000 + ${APPLE_EPOCH} > 1795000000`).values() as unknown[][])
      .map((r) => String(r[r.length - 1])).join(" ")
    expect(plan).not.toContain("message_idx_date")
  })

  test("a negative window is treated as zero, never as a future cutoff that selects nothing silently", () => {
    expect(sinceClause(-5, NOW)).toBe(sinceClause(0, NOW))
  })
})

describe("no iMessage window computes on m.date (#194233)", () => {
  const files = ["src/cli/lib/imessage.ts", "src/cli/cmd/platform-imessage.ts", "src/cli/cmd/platform-atlas-comms.ts"]
  for (const f of files) {
    test(f, () => {
      const code = readFileSync(join(import.meta.dir, "..", f), "utf8")
        .split("\n")
        .filter((l) => !/^\s*(\*|\/\/)/.test(l))
        .join("\n")
      expect(code).not.toMatch(/m\.date\s*\/\s*1000000000\s*\+\s*978307200\)?\s*>/)
    })
  }
})
