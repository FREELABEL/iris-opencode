import { describe, expect, test, afterEach } from "bun:test"
import { mkdirSync, writeFileSync, rmSync, chmodSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The badge must never report "nothing waiting" when it could not look.
 *
 * That distinction is the whole reason this module exists rather than a one-line count:
 * a Hive message sat unread through a live client session because nothing surfaced it, and
 * the fix is worthless if the surface silently says zero whenever it fails.
 */

const INBOX = join(homedir(), ".iris", "hive", "inbox")
const MANIFEST = join(INBOX, ".manifest.jsonl")
const BACKUP = join(tmpdir(), `manifest-backup-${process.pid}.jsonl`)

let saved = false
function stash() {
  try {
    const { existsSync, copyFileSync } = require("node:fs")
    if (existsSync(MANIFEST)) { copyFileSync(MANIFEST, BACKUP); saved = true }
  } catch {}
}
function restore() {
  const { existsSync, copyFileSync, rmSync: rm } = require("node:fs")
  if (saved && existsSync(BACKUP)) { copyFileSync(BACKUP, MANIFEST); rm(BACKUP, { force: true }); saved = false }
}

function write(lines: string[]) {
  mkdirSync(INBOX, { recursive: true })
  writeFileSync(MANIFEST, lines.join("\n") + (lines.length ? "\n" : ""))
}

async function read() {
  // Fresh import each time — the module reads the file at call time, not at import.
  const mod = await import("./hive-inbox")
  return mod.readHiveInbox()
}

afterEach(() => restore())

describe("hive inbox badge", () => {
  test("counts only unread", async () => {
    stash()
    write([
      JSON.stringify({ id: "a", read: true, from_user: "alex", received_at: "2026-09-11T10:00:00Z" }),
      JSON.stringify({ id: "b", read: false, from_user: "alex", received_at: "2026-09-11T11:00:00Z" }),
      JSON.stringify({ id: "c", read: false, from_user: "robyn", received_at: "2026-09-11T12:00:00Z" }),
    ])
    const s = await read()
    expect(s.unread).toBe(2)
    expect(s.unreadable).toBe(false)
    // Newest unread sender, so a one-line hint names who is waiting.
    expect(s.from).toBe("robyn")
  })

  test("an empty manifest is a real zero", async () => {
    stash()
    write([])
    const s = await read()
    expect(s.unread).toBe(0)
    expect(s.unreadable).toBe(false)
  })

  test("all lines unparseable is NOT zero — it is unknown", async () => {
    stash()
    write(["{not json", "also not json"])
    const s = await read()
    // The important assertion in this file. A corrupt manifest reported as 0 would render an
    // empty footer and look exactly like a healthy inbox.
    expect(s.unread).toBeNull()
    expect(s.unreadable).toBe(true)
  })

  test("one bad line among good ones does not poison the count", async () => {
    stash()
    write([
      "{corrupt",
      JSON.stringify({ id: "b", read: false, received_at: "2026-09-11T11:00:00Z" }),
    ])
    const s = await read()
    expect(s.unread).toBe(1)
    expect(s.unreadable).toBe(false)
  })

  test("rows missing the read flag count as unread", async () => {
    stash()
    write([JSON.stringify({ id: "x", received_at: "2026-09-11T09:00:00Z" })])
    const s = await read()
    // Absent is not read. Defaulting the other way would hide a message forever.
    expect(s.unread).toBe(1)
  })
})
