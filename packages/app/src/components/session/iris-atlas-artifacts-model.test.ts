import { describe, expect, test } from "bun:test"
import { atlasNotes, atlasNoteUrl, fallbackTitle } from "./iris-atlas-artifacts-model"

const A = "17ac82c8-ade9-4384-9311-9d48a0930f2f"
const B = "bbeca56c-e5c8-4548-8fec-27ad13e838b4"
const url = (u: string) => `https://heyiris.io/n/${u}`

const tool = (u: string, title?: string, status = "completed") => ({
  type: "tool",
  tool: "atlas_artifact",
  state: { status, input: { url: u }, metadata: status === "completed" ? { url: u, title } : undefined },
})
const shell = (output: string, status = "completed") => ({ type: "tool", tool: "bash", state: { status, output } })

describe("atlasNotes — the session is the store (#187717 ADR-02)", () => {
  test("a shown note and a shell-published note are both listed, newest first", () => {
    const notes = atlasNotes([
      tool(url(A), "The epic"),
      { type: "text" },
      shell(`  Public URL  ${url(B)}\n`),
    ])
    expect(notes.map((n) => [n.url, n.title, n.source])).toEqual([
      [url(B), fallbackTitle(url(B)), "shell"],
      [url(A), "The epic", "tool"],
    ])
  })

  test("the same note from both sources is ONE row, and the tool's title survives a later shell mention", () => {
    const notes = atlasNotes([shell(`made ${url(A)}`), tool(url(A), "Named"), shell(`again ${url(A)}`)])
    expect(notes).toHaveLength(1)
    expect(notes[0]).toMatchObject({ url: url(A), title: "Named", source: "tool" })
  })

  test("a tool call that has not completed (or failed — a 404) is not a note", () => {
    expect(atlasNotes([tool(url(A), "x", "running"), tool(url(B), "y", "error")])).toEqual([])
  })

  test("a running shell, other tools' output, and lookalike hosts are ignored", () => {
    expect(
      atlasNotes([
        shell(url(A), "running"),
        { type: "tool", tool: "read", state: { status: "completed", output: url(A) } },
        shell(`https://heyiris.io.evil.example/n/${A} https://heyiris.io/p/${A}`),
      ]),
    ).toEqual([])
  })

  test("a tool part whose metadata url is not a note is dropped, never framed", () => {
    const bad = { type: "tool", tool: "atlas_artifact", state: { status: "completed", metadata: { url: "https://evil.example/" } } }
    expect(atlasNotes([bad])).toEqual([])
    expect(atlasNoteUrl("https://evil.example/")).toBeUndefined()
  })
})
