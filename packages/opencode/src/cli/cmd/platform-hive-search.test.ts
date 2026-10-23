import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { searchLocalFiles } from "./platform-hive-search"

describe("iris hive search --type files (#188665)", () => {
  test("a machine that is not a Hive node is told so, instead of searching nothing silently", async () => {
    const r = await searchLocalFiles("x", 5, "/nonexistent/disk-search.js")
    expect(r.rows).toEqual([])
    expect(r.note).toContain("iris node install")
  })

  test("the installed node module answers, and its rows are tagged as this machine", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-"))
    const mod = join(dir, "disk-search.js")
    writeFileSync(mod, `exports.searchDisk = async (q, o) => ({ backend: "spotlight", rows: [{ source: "files", match: "/Users/a/" + q + ".pdf", preview: "found by spotlight · 3 ms" }].slice(0, o.limit) })`)
    const r = await searchLocalFiles("invoice", 5, mod)
    expect(r.rows).toEqual([{ source: "files", match: "/Users/a/invoice.pdf", preview: "found by spotlight · 3 ms", node_name: "local", node_id: "local" }])
  })

  test("a module that throws becomes a note, not a crash", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ds-"))
    const mod = join(dir, "disk-search.js")
    writeFileSync(mod, `exports.searchDisk = async () => { throw new Error("mds off") }`)
    const r = await searchLocalFiles("x", 5, mod)
    expect(r.note).toContain("mds off")
  })
})
