import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { outline, spill } from "../../src/cli/cmd/mcp-overflow"

/**
 * Oversized MCP output used to be sliced at 100KB with "...(truncated)". A JSON
 * payload cut mid-object is unparseable, so the model lost the data AND every route
 * back to it — and read the result as a failure. On 2026-08-17 a 68KB
 * `bloqs get 544 --json` came back mangled and the agent told the user it could not
 * access the IRIS platform at all.
 *
 * These tests pin the three properties that make the replacement useful: the data
 * survives, the model is told the SHAPE without a discovery round-trip, and the
 * message says the command succeeded.
 */
describe("outline", () => {
  test("names the top-level keys and their types for a JSON object", () => {
    const o = outline(JSON.stringify({ id: 544, name: "MAYO", lists: [{ id: 1, name: "x" }], config: {} }))
    expect(o).toContain("JSON object")
    expect(o).toContain("id: number")
    expect(o).toContain("name: string")
    expect(o).toContain("lists: array(1)")
  })

  test("reveals the shape of the FIRST element of an array of objects", () => {
    // This is the round-trip saver: a model writing a jq filter needs the element
    // keys, and without this its first move is always `jq keys`.
    const o = outline(JSON.stringify({ lists: [{ id: 1, name: "Kids", items_count: 3 }] }))
    expect(o).toContain("lists[0] keys: id, name, items_count")
  })

  test("counts elements for a top-level JSON array", () => {
    const o = outline(JSON.stringify([{ id: 1 }, { id: 2 }, { id: 3 }]))
    expect(o).toContain("JSON array, 3 elements")
    expect(o).toContain("Element shape: id")
  })

  test("falls back to a line count and head sample for plain text", () => {
    const o = outline(Array.from({ length: 400 }, (_, i) => `line ${i}`).join("\n"))
    expect(o).toContain("Plain text, 400 lines")
    expect(o).toContain("line 0")
  })

  test("does not throw on something that merely starts like JSON", () => {
    // ANSI-decorated CLI output often begins with a brace-ish sequence; guessing
    // wrong must not lose the sample.
    const o = outline("{ this is not json at all\nsecond line")
    expect(o).toContain("Plain text")
  })
})

describe("spill", () => {
  const big = JSON.stringify({
    id: 544,
    name: "MAYO — Life Atlas",
    lists: Array.from({ length: 20 }, (_, i) => ({ id: 1600 + i, name: `List ${i}`, items: [] })),
  })

  test("writes the COMPLETE payload — nothing is lost", () => {
    const msg = spill(big, "bloqs get 544 --json")
    expect(msg).not.toBeNull()
    const path = msg!.match(/FILE: (.+)/)![1].trim()
    const written = readFileSync(path, "utf8")
    expect(written).toBe(big)
    expect(JSON.parse(written).lists).toHaveLength(20)
  })

  test("states plainly that the command SUCCEEDED", () => {
    // The whole failure mode was an agent reading "exceeds maximum" as "tool broken"
    // and telling the user the platform was down.
    const msg = spill(big, "bloqs get 544 --json")!
    expect(msg).toContain("SUCCEEDED")
    expect(msg).toContain("do not report this as a failure")
    expect(msg).toContain("SAVED, not lost")
  })

  test("includes the outline inline, so no discovery round-trip is needed", () => {
    const msg = spill(big, "bloqs get 544 --json")!
    expect(msg).toContain("OUTLINE:")
    expect(msg).toContain("lists: array(20)")
    expect(msg).toContain("lists[0] keys:")
  })

  test("gives jq examples for JSON and grep/head for text", () => {
    expect(spill(big, "bloqs get 544 --json")!).toContain("jq 'keys'")
    const text = spill("plain\n".repeat(5000), "logs tail")!
    expect(text).toContain("grep -n")
  })

  test("suggests narrowing the command rather than always reading the file", () => {
    expect(spill(big, "bloqs get 544 --json")!).toContain("narrower command")
  })
})
