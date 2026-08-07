import { describe, expect, test } from "bun:test"
import { extractVersions, setNestedValue } from "./platform-pages"

/**
 * Regression cover for `iris pages set` (#179314).
 *
 * The bug that motivated these: `set <path>.-1` printed "Updated" and wrote nothing. `/^\d+$/`
 * does not match a leading minus, so "-1" was treated as a STRING key and assigned onto an
 * array — a non-index property, which JSON.stringify then drops. Three green ticks, zero writes.
 */
describe("setNestedValue — append", () => {
  test("-1 appends to an array", () => {
    const o = { list: [{ id: "a" }] }
    setNestedValue(o, "list.-1", { id: "b" })
    expect(o.list.map((x) => x.id)).toEqual(["a", "b"])
  })

  test("+ and [] append too", () => {
    const o: any = { list: [] }
    setNestedValue(o, "list.+", 1)
    setNestedValue(o, "list.[]", 2)
    expect(o.list).toEqual([1, 2])
  })

  test("the appended value SURVIVES serialisation — this is what silently failed before", () => {
    const o = { list: [{ id: "a" }] }
    setNestedValue(o, "list.-1", { id: "b" })
    expect(JSON.parse(JSON.stringify(o)).list).toHaveLength(2)
  })

  test("appending to a non-array throws instead of pretending", () => {
    expect(() => setNestedValue({ a: { b: 1 } }, "a.-1", 2)).toThrow(/not an array/)
  })

  test("appends into a nested path", () => {
    const o = { components: [{ props: { tabs: [{ id: "one" }] } }] }
    setNestedValue(o, "components.0.props.tabs.-1", { id: "two" })
    expect(o.components[0].props.tabs.map((t: any) => t.id)).toEqual(["one", "two"])
  })
})

describe("setNestedValue — array index safety", () => {
  test("a numeric index still replaces in place", () => {
    const o = { list: ["a", "b"] }
    setNestedValue(o, "list.1", "B")
    expect(o.list).toEqual(["a", "B"])
  })

  test("index exactly at length appends rather than erroring", () => {
    const o = { list: ["a"] }
    setNestedValue(o, "list.1", "b")
    expect(o.list).toEqual(["a", "b"])
  })

  test("an index past the end throws rather than punching a hole", () => {
    expect(() => setNestedValue({ list: ["a"] }, "list.5", "x")).toThrow(/past the end/)
  })

  test("a non-numeric key on an array throws — it would be dropped on serialise", () => {
    expect(() => setNestedValue({ list: ["a"] }, "list.name", "x")).toThrow(/numeric index/)
  })
})

describe("setNestedValue — ordinary object writes still work", () => {
  test("sets a nested scalar", () => {
    const o: any = { a: { b: {} } }
    setNestedValue(o, "a.b.c", 42)
    expect(o.a.b.c).toBe(42)
  })

  test("creates missing intermediate objects", () => {
    const o: any = {}
    setNestedValue(o, "x.y.z", "v")
    expect(o.x.y.z).toBe("v")
  })

  test("creates an array when the next segment is an index", () => {
    const o: any = {}
    setNestedValue(o, "rows.0.name", "first")
    expect(Array.isArray(o.rows)).toBe(true)
    expect(o.rows[0].name).toBe("first")
  })

  test("a numeric-looking object key still resolves as an index into an array", () => {
    const o = { list: [{ v: 1 }] }
    setNestedValue(o, "list.0.v", 9)
    expect(o.list[0].v).toBe(9)
  })
})

describe("extractVersions", () => {
  test("unwraps a Laravel paginator — the bug that reported envelope keys as versions", () => {
    const paginator = {
      current_page: 1,
      data: [{ version_number: 3 }, { version_number: 2 }],
      first_page_url: "http://x",
      last_page: 1,
      links: [],
      next_page_url: null, // this null is what threw
      path: "http://x",
      per_page: 15,
      prev_page_url: null,
      to: 2,
      total: 2,
    }
    expect(extractVersions(paginator).map((v) => v.version_number)).toEqual([3, 2])
  })

  test("a bare array still works", () => {
    expect(extractVersions([{ version_number: 1 }])).toHaveLength(1)
  })

  test("nulls inside the rows are dropped rather than dereferenced", () => {
    expect(extractVersions({ data: [{ version_number: 1 }, null, "x"] })).toHaveLength(1)
  })

  test("an unexpected shape yields none instead of throwing", () => {
    expect(extractVersions(undefined)).toEqual([])
    expect(extractVersions({ current_page: 1, next_page_url: null })).toEqual([])
  })
})
