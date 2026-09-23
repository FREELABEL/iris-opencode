import { describe, expect, test } from "bun:test"
import { fileKind, promotedFiles, safeRelative } from "./iris-promote"

const user = (id: string, diffs: { file: string; status?: "added" | "deleted" | "modified" }[]) => ({
  id,
  role: "user",
  summary: { diffs },
})

describe("promotedFiles", () => {
  test("a shell-made spreadsheet is promoted — the case that prompted #186584", () => {
    const r = promotedFiles([
      user("m1", [{ file: "hardware/open-mic-setup/open-mic-equipment-sheet.xlsx", status: "added" }]),
    ])
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({
      id: "file:hardware/open-mic-setup/open-mic-equipment-sheet.xlsx",
      kind: "sheet",
      status: "added",
      name: "open-mic-equipment-sheet.xlsx",
    })
  })
  test("only documents — source code is not an artifact", () => {
    const r = promotedFiles([
      user("m1", [{ file: "src/index.ts" }, { file: "notes.md" }, { file: "a.pdf" }, { file: "b.DOCX" }]),
    ])
    expect(r.map((f) => f.kind).sort()).toEqual(["docx", "markdown", "pdf"])
  })
  test("newest turn first; a later edit moves a file up and keeps 'added'", () => {
    const r = promotedFiles([
      user("m1", [
        { file: "a.csv", status: "added" },
        { file: "b.md", status: "added" },
      ]),
      { id: "a1", role: "assistant" },
      user("m2", [{ file: "a.csv", status: "modified" }]),
    ])
    expect(r.map((f) => f.path)).toEqual(["a.csv", "b.md"])
    expect(r[0]).toMatchObject({ status: "added", messageID: "m2" })
  })
  test("a deleted file drops out", () => {
    const r = promotedFiles([
      user("m1", [{ file: "a.pdf", status: "added" }]),
      user("m2", [{ file: "a.pdf", status: "deleted" }]),
    ])
    expect(r).toEqual([])
  })
  test("never outside the project, never vendored or the artifact store itself", () => {
    const r = promotedFiles([
      user("m1", [
        { file: "../secrets.csv" },
        { file: "/etc/report.pdf" },
        { file: "C:\\Users\\x\\a.docx" },
        { file: "node_modules/pkg/README.md" },
        { file: ".iris/artifacts/ses/x/index.html" },
        { file: "docs/ok.md" },
      ]),
    ])
    expect(r.map((f) => f.path)).toEqual(["docs/ok.md"])
  })
  test("messages without summaries are ignored", () => {
    expect(
      promotedFiles([
        { id: "m", role: "user" },
        { id: "n", role: "user", summary: {} },
      ]),
    ).toEqual([])
  })
})

test("fileKind / safeRelative", () => {
  expect(fileKind("x.XLSX")).toBe("sheet")
  expect(fileKind("x.ts")).toBeUndefined()
  expect(safeRelative("a/b.md")).toBe(true)
  expect(safeRelative("a/../b.md")).toBe(false)
})
