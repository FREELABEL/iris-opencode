import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { countInbox, decodeInboxBody, firstLine, locateInboxRow, markInboxRead, readInboxMessage } from "./platform"

const row = (o: Record<string, unknown>) => JSON.stringify(o)

describe("countInbox", () => {
  test("counts unread and names the newest sender", () => {
    const raw = [
      row({ read: true, from_node: "old", received_at: "2026-09-01T00:00:00Z" }),
      row({ read: false, from_node: "MacBookPro", received_at: "2026-09-11T00:00:00Z" }),
      row({ read: false, from_node: "newest", received_at: "2026-09-12T00:00:00Z" }),
    ].join("\n")
    const s = countInbox(raw)
    expect(s.unread).toBe(2)
    expect(s.total).toBe(3)
    expect(s.from).toBe("newest")
    expect(s.unreadable).toBe(false)
  })

  test("an empty manifest is a genuine zero", () => {
    expect(countInbox("")).toEqual({ unread: 0, total: 0, unreadable: false, items: [], unparsed: 0 })
  })

  test("a fully corrupt manifest is NOT an empty one", () => {
    // This is the whole point of the null. Returning 0 here reports "nothing waiting" for a
    // file we could not parse, and the badge goes quiet exactly when something is wrong.
    const s = countInbox("not json\nalso not json")
    expect(s.unread).toBeNull()
    expect(s.unreadable).toBe(true)
  })

  test("a partially corrupt manifest still counts what it can, and does not claim to be broken", () => {
    const s = countInbox(["garbage", row({ read: false, from_node: "a" })].join("\n"))
    expect(s.unread).toBe(1)
    expect(s.unreadable).toBe(false)
    // And it says what it dropped. A shorter list with no explanation is the silent undercount.
    expect(s.unparsed).toBe(1)
    expect(s.items).toHaveLength(1)
  })

  test("item indexes are MANIFEST positions, not positions in the returned array", () => {
    // The number is what `iris hive inbox read <n>` takes. Renumbering the rows we kept — after
    // dropping a corrupt one, or after sorting unread to the top — prints a number that opens a
    // different message.
    const s = countInbox(
      [
        row({ read: true, type: "message", message: "first", received_at: "2026-09-01T00:00:00Z" }),
        "garbage",
        row({ read: false, type: "message", message: "third", received_at: "2026-09-03T00:00:00Z" }),
      ].join("\n"),
    )
    expect(s.items.map((i) => i.index)).toEqual([3, 1])
    expect(s.items[0].label).toBe("third")
  })
})

// Fictional fixtures only — this repo is public.
function inboxFixture(rows: Record<string, unknown>[], files: Record<string, string> = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "iris-inbox-"))
  writeFileSync(path.join(dir, ".manifest.jsonl"), rows.map((r) => JSON.stringify(r)).join("\n") + "\n")
  for (const [name, body] of Object.entries(files)) writeFileSync(path.join(dir, name), body)
  return dir
}
const manifestOf = (dir: string) =>
  readFileSync(path.join(dir, ".manifest.jsonl"), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))

describe("readInboxMessage (#189279)", () => {
  test("returns the FULL body from the backing file, not the 500-char manifest copy", () => {
    const long = "Subject line here\n\n" + "x".repeat(900)
    const dir = inboxFixture(
      [{ id: "m1", type: "message", from_node: "studio-mac", file: "a_message.txt", message: long.slice(0, 500), read: false }],
      { "a_message.txt": long + "\n" },
    )
    const r = readInboxMessage(1, "m1", dir)
    expect(r.measured).toBe(true)
    expect(r.message?.body).toBe(long)
    expect(r.message?.bodyState).toBe("ok")
    expect(r.message?.preview).toBe("Subject line here")
    expect(r.message?.from).toBe("studio-mac")
  })

  test("opening does not mark read", () => {
    const dir = inboxFixture([{ id: "m1", type: "text", file: "a.txt", read: false }], { "a.txt": "hi" })
    readInboxMessage(1, "m1", dir)
    expect(manifestOf(dir)[0].read).toBe(false)
  })

  test("a missing body falls back to the manifest's copy and says it may be cut", () => {
    const dir = inboxFixture([{ id: "m1", type: "message", file: "gone.txt", message: "partial text" }])
    const r = readInboxMessage(1, "m1", dir)
    expect(r.message?.body).toBe("partial text")
    expect(r.message?.bodyState).toBe("truncated")
  })

  test("a binary file is not dumped as text", () => {
    const dir = inboxFixture([{ id: "f1", type: "file", file: "b.bin", original_name: "b.bin" }], { "b.bin": "PK\u0000\u0003" })
    const r = readInboxMessage(1, "f1", dir)
    expect(r.message?.body).toBeNull()
    expect(r.message?.bodyState).toBe("binary")
  })

  test("a manifest path cannot escape the inbox directory", () => {
    const dir = inboxFixture([{ id: "x", type: "text", file: "../../etc/hostname" }])
    expect(readInboxMessage(1, "x", dir).message?.bodyState).toBe("missing")
  })

  test("a gone message is a stated miss, not an empty message", () => {
    const dir = inboxFixture([{ id: "m1", type: "text", file: "a.txt" }])
    const r = readInboxMessage(5, "nope", dir)
    expect(r.measured).toBe(false)
    expect(r.message).toBeNull()
  })
})

describe("locateInboxRow", () => {
  const lines = [{ raw: "", row: { id: "a" } }, { raw: "", row: { id: "b" } }, { raw: "x", row: null }] as any
  test("index wins when the id still matches", () => expect(locateInboxRow(lines, 2, "b")).toBe(1))
  test("a shifted manifest is found by id, not by the stale position", () => expect(locateInboxRow(lines, 1, "b")).toBe(1))
  test("an unparseable line is never a message", () => expect(locateInboxRow(lines, 3)).toBe(-1))
})

describe("markInboxRead", () => {
  test("marks read and keeps every other line byte-for-byte, unparseable ones included", async () => {
    const dir = inboxFixture([{ id: "a", read: false }, { id: "b", read: false }])
    writeFileSync(path.join(dir, ".manifest.jsonl"), readFileSync(path.join(dir, ".manifest.jsonl"), "utf-8") + "not json\n")
    const r = await markInboxRead(2, "b", dir)
    expect(r).toEqual({ measured: true, read: true, burned: false })
    const raw = readFileSync(path.join(dir, ".manifest.jsonl"), "utf-8").split("\n").filter(Boolean)
    expect(raw).toHaveLength(3)
    expect(JSON.parse(raw[0]).read).toBe(false)
    expect(JSON.parse(raw[1]).read).toBe(true)
    expect(raw[2]).toBe("not json")
  })

  test("burn-after-read deletes the row and its body", async () => {
    const dir = inboxFixture([{ id: "k", burn: true, file: "k.txt" }, { id: "z" }], { "k.txt": "secret-ish" })
    const r = await markInboxRead(1, "k", dir)
    expect(r.burned).toBe(true)
    expect(existsSync(path.join(dir, "k.txt"))).toBe(false)
    expect(manifestOf(dir).map((x: any) => x.id)).toEqual(["z"])
  })
})

describe("inbox helpers", () => {
  test("firstLine skips blank lines and caps", () => {
    expect(firstLine("\n\n  hello there \nmore")).toBe("hello there")
    expect(firstLine("")).toBeUndefined()
    expect(firstLine("abcdef", 4)).toBe("abc…")
  })
  test("decodeInboxBody treats NUL as binary", () => {
    expect(decodeInboxBody(new Uint8Array([104, 105]))).toBe("hi")
    expect(decodeInboxBody(new Uint8Array([104, 0]))).toBeNull()
  })
})
