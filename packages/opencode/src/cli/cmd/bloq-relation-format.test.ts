import { describe, test, expect } from "bun:test"
import {
  RELATION_TYPES,
  SYMMETRIC_RELATION_TYPES,
  DIRECTIONAL_RELATION_TYPES,
  isValidRelationType,
  isSymmetricRelationType,
  formatRelationsGrouped,
} from "./bloq-relation-format"

// =============================================================================
// Bloq relations (bug #158309) — typed edges between bloqs (parent/sibling/
// affiliated/partner/feeds_into/mirrors). These pure helpers back
// `iris bloqs relate/unrelate/relations`; keep them framework-free so they can
// be unit tested without a live API.
// =============================================================================

describe("RELATION_TYPES", () => {
  test("includes all six canonical types", () => {
    expect([...RELATION_TYPES].sort()).toEqual(
      ["affiliated", "feeds_into", "mirrors", "parent", "partner", "sibling"].sort(),
    )
  })

  test("directional + symmetric partition covers the full set with no overlap", () => {
    const union = new Set([...DIRECTIONAL_RELATION_TYPES, ...SYMMETRIC_RELATION_TYPES])
    expect(union.size).toBe(RELATION_TYPES.length)
    for (const t of DIRECTIONAL_RELATION_TYPES) {
      expect(SYMMETRIC_RELATION_TYPES).not.toContain(t)
    }
  })
})

describe("isValidRelationType", () => {
  test("accepts every canonical type", () => {
    for (const t of RELATION_TYPES) {
      expect(isValidRelationType(t)).toBe(true)
    }
  })

  test("rejects unknown strings", () => {
    expect(isValidRelationType("not-a-real-type")).toBe(false)
    expect(isValidRelationType("")).toBe(false)
  })
})

describe("isSymmetricRelationType", () => {
  test("sibling/affiliated/partner/mirrors are symmetric", () => {
    expect(isSymmetricRelationType("sibling")).toBe(true)
    expect(isSymmetricRelationType("affiliated")).toBe(true)
    expect(isSymmetricRelationType("partner")).toBe(true)
    expect(isSymmetricRelationType("mirrors")).toBe(true)
  })

  test("parent/feeds_into are directional, not symmetric", () => {
    expect(isSymmetricRelationType("parent")).toBe(false)
    expect(isSymmetricRelationType("feeds_into")).toBe(false)
  })
})

describe("formatRelationsGrouped", () => {
  test("empty list renders a clear empty state", () => {
    expect(formatRelationsGrouped([])).toBe("No relations.")
  })

  test("groups relations by type and renders each related bloq", () => {
    const out = formatRelationsGrouped([
      { relation_type: "sibling", direction: "from", related_bloq: { id: 2, name: "Health" } },
      { relation_type: "parent", direction: "to", related_bloq: { id: 1, name: "MAYO" } },
    ])
    expect(out).toContain("parent")
    expect(out).toContain("sibling")
    expect(out).toContain("MAYO")
    expect(out).toContain("Health")
  })

  test("uses a fallback label when related_bloq is missing", () => {
    const out = formatRelationsGrouped([
      { relation_type: "affiliated", direction: "from", related_bloq: null },
    ])
    expect(out).toContain("affiliated")
    expect(out).toMatch(/Bloq #/)
  })

  test("last row in each type group uses the closing prefix", () => {
    const out = formatRelationsGrouped([
      { relation_type: "mirrors", direction: "from", related_bloq: { id: 2, name: "A" } },
      { relation_type: "mirrors", direction: "from", related_bloq: { id: 3, name: "B" } },
    ])
    const lines = out.split("\n")
    expect(lines.some((l) => l.includes("├─") && l.includes("A"))).toBe(true)
    expect(lines.some((l) => l.includes("└─") && l.includes("B"))).toBe(true)
  })
})
