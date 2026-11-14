import { describe, expect, test } from "bun:test"
import { asArray, firstArray } from "../src/util/array"

describe("firstArray — the '{} is not iterable' regression", () => {
  test("the exact shape that crashed: {\"data\": {}}", () => {
    const data: any = { data: {} }
    // old: const items: any[] = data?.data ?? data?.requests ?? []  -> {}
    const items = firstArray(data?.data, data?.requests)
    expect(items).toEqual([])
    expect(() => { for (const _ of items) void _ }).not.toThrow()
  })

  test("an empty object anywhere in the chain is skipped, not returned", () => {
    expect(firstArray({}, [1, 2])).toEqual([1, 2])
    expect(firstArray({}, {}, {})).toEqual([])
  })

  test("preserves ?? semantics: first ARRAY wins, even when empty", () => {
    expect(firstArray([], [1])).toEqual([])          // as `[] ?? [1]` gave []
    expect(firstArray(null, [1])).toEqual([1])       // null falls through
    expect(firstArray(undefined, [1])).toEqual([1])
  })

  test("non-array scalars never leak into the result", () => {
    for (const junk of ["", "str", 0, 7, true, false, NaN, Symbol("s")]) {
      expect(firstArray(junk)).toEqual([])
    }
  })

  test("no candidates -> empty array, never undefined", () => {
    expect(firstArray()).toEqual([])
  })
})

describe("asArray", () => {
  test("passes arrays through by reference", () => {
    const a = [1, 2]
    expect(asArray(a)).toBe(a)
  })
  test("coerces every non-array to []", () => {
    for (const junk of [{}, null, undefined, 0, "", "x", true, new Map()]) {
      expect(asArray(junk)).toEqual([])
    }
  })
})
