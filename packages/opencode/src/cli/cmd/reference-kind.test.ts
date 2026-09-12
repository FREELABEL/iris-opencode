import { describe, expect, test } from "bun:test"
import { classifyRef, explainWrongRef } from "./reference-kind"

/**
 * One reference, three commands, three different answers (#184599) — and one of
 * them reported a PARSE failure as a permissions problem:
 *
 *   $ iris atlas get-item 01a09279-8f43-73ca-b401-1169abe5f942
 *   No item NaN visible to this account. Check whether the board is shared with you.
 *
 * A wrong cause costs more than a plain refusal: it sends someone to check board
 * sharing for a type mismatch, and leaks an internal coercion into user-facing text.
 */
describe("classifyRef", () => {
  test("a plain number is a bloq item id", () => {
    expect(classifyRef("184598")).toMatchObject({ kind: "item-id", value: "184598" })
  })

  /**
   * The measured uuid from the report. It STARTS WITH DIGITS, which is what makes a
   * looser numeric test wrong rather than merely imprecise — so uuid is checked first.
   */
  test("a uuid that begins with digits is a uuid, never a number", () => {
    const r = classifyRef("01a09279-8f43-73ca-b401-1169abe5f942")
    expect(r.kind).toBe("uuid")
    expect(Number(r.raw)).toBeNaN() // the coercion that produced "No item NaN"
  })

  test("a uuid inside a URL is found and lowercased", () => {
    expect(classifyRef("https://heyiris.io/n/CC0BA5FF-266D-46DF-91B5-CD0AE9BDA2C5")).toMatchObject({
      kind: "uuid",
      value: "cc0ba5ff-266d-46df-91b5-cd0ae9bda2c5",
    })
  })

  test("nonsense is unknown — not a number, and not a lucky partial match", () => {
    expect(classifyRef("the-thing").kind).toBe("unknown")
    expect(classifyRef("184598abc").kind).toBe("unknown")
    expect(classifyRef("").kind).toBe("unknown")
    expect(classifyRef(null).kind).toBe("unknown")
  })

  test("surrounding whitespace does not change the kind", () => {
    expect(classifyRef("  184598\n").kind).toBe("item-id")
  })
})

describe("explainWrongRef — name the kind you got, not a guess at the cause", () => {
  test("a uuid where an item id was wanted points at the command that takes it", () => {
    const msg = explainWrongRef(classifyRef("01a09279-8f43-73ca-b401-1169abe5f942"), "item-id")
    expect(msg).toContain("iris atlas use 01a09279")
    expect(msg).toContain("DELIVERY id") // the taxonomy, so the user doesn't have to know it
    expect(msg).not.toContain("NaN")
    expect(msg).not.toMatch(/shared with you|permission/i) // never blame access for a parse
  })

  test("an item id where a uuid was wanted points the other way", () => {
    expect(explainWrongRef(classifyRef("184598"), "uuid")).toContain("iris atlas get-item 184598")
  })

  test("an unrecognised reference says what was expected instead", () => {
    expect(explainWrongRef(classifyRef("the-thing"), "item-id")).toContain("a plain number")
  })
})
