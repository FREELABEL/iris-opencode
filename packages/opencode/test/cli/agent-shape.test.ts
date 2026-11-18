import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"
import { describeShape, parseShape, SHAPE_CHOICES, shapeOf, shapeUrl, withShapeUrl } from "../../src/cli/cmd/agent-shape"

// IRIS Shapes SH-03 (#190378): an agent's chosen Shape lives in bloq_agents.shape (fl-api), 0–9
// or null. The picture is drawn by fl-iris-api GET /api/v1/public/shapes/agent/{id}/{n}.svg.
describe("agent shape (#190378)", () => {
  test("--shape accepts 0–9 and none, the same set the server accepts", () => {
    expect([...SHAPE_CHOICES]).toEqual(["0", "1", "2", "3", "4", "5", "6", "7", "8", "9", "none"])
    for (let n = 0; n <= 9; n++) {
      expect(parseShape(String(n))).toBe(n)
      expect(parseShape(n)).toBe(n)
    }
    expect(parseShape("none")).toBeNull()
    expect(parseShape(" None ")).toBeNull()
  })

  test("--shape refuses anything else before a request is made", () => {
    for (const bad of ["10", "-1", "3.0", "3.5", "shape:3", "", "  ", "https://evil.example/x.svg", "<svg>", "three", 10, -1, 3.5, true, null, undefined]) {
      expect(() => parseShape(bad as any)).toThrow(/0 to 9, or none/)
    }
  })

  test("the public Shape URL is the fl-iris-api route, on the public host", () => {
    expect(shapeUrl(679, 3, "https://heyiris.io")).toBe("https://heyiris.io/api/v1/public/shapes/agent/679/3.svg")
    expect(shapeUrl(679, 0, "https://heyiris.io/")).toBe("https://heyiris.io/api/v1/public/shapes/agent/679/0.svg")
  })

  test("an agent that never chose a Shape shows option 0, and says so", () => {
    expect(shapeOf({ id: 1 })).toBe(0)
    expect(shapeOf({ id: 1, shape: null })).toBe(0)
    expect(shapeOf({ id: 1, shape: 7 })).toBe(7)
    expect(shapeOf({ id: 1, shape: "7" })).toBe(7)
    // A value the server would never store is not trusted into a URL.
    expect(shapeOf({ id: 1, shape: 12 })).toBe(0)
    expect(shapeOf({ id: 1, shape: "x" })).toBe(0)
    expect(describeShape({ id: 1 })).toBe("0 (default — not chosen)")
    expect(describeShape({ id: 1, shape: 7 })).toBe("7")
  })

  test("--json gets shape and shape_url; the FA icon is left as it is", () => {
    const out = withShapeUrl({ id: 679, name: "FORGE", icon: "fas fa-robot", shape: 4 }, "https://heyiris.io")
    expect(out).toEqual({
      id: 679,
      name: "FORGE",
      icon: "fas fa-robot",
      shape: 4,
      shape_url: "https://heyiris.io/api/v1/public/shapes/agent/679/4.svg",
    })
    expect(withShapeUrl({ id: 5 }, "https://heyiris.io").shape_url).toBe("https://heyiris.io/api/v1/public/shapes/agent/5/0.svg")
    expect(withShapeUrl({ id: 5 }, "https://heyiris.io").shape).toBeNull()
    // No id, no URL: never a link to /agent/undefined.
    expect(withShapeUrl({ name: "x" }, "https://heyiris.io").shape_url).toBeUndefined()
  })

  test("agents update / get / list are wired to it", () => {
    const src = readFileSync(join(import.meta.dir, "../../src/cli/cmd/platform-agents.ts"), "utf8")
    expect(src).toContain('.option("shape"')
    expect(src).toContain("choices: [...SHAPE_CHOICES]")
    expect(src).toContain("payload.shape = parseShape(args.shape)")
    expect(src).toContain('printKV("Shape", describeShape(a))')
    expect(src).toContain("await writeJson(withShapeUrl(a, PUBLIC_SITE))")
    expect(src).toContain("· shape ${shapeOf(a)}")
  })
})
