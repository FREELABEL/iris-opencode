// Shared, pure logic for bloq-to-bloq relations (bug #158309): parent/sibling/
// affiliated/partner/feeds_into/mirrors typed edges, backed by fl-api's
// bloq_relations table (App\Models\Atlas\BloqRelation). Extracted so
// `iris bloqs relate/unrelate/relations` share one validated type list and one
// text renderer, testable without a live API.

/** Directional: one row expresses the whole relationship (A parent-of B does not imply B parent-of A). */
export const DIRECTIONAL_RELATION_TYPES = ["parent", "feeds_into"] as const

/** Symmetric: the API auto-creates the reciprocal row, so a relation reads the same from either side. */
export const SYMMETRIC_RELATION_TYPES = ["sibling", "affiliated", "partner", "mirrors"] as const

export const RELATION_TYPES = [...DIRECTIONAL_RELATION_TYPES, ...SYMMETRIC_RELATION_TYPES] as const

export type RelationType = (typeof RELATION_TYPES)[number]

export function isValidRelationType(type: string): type is RelationType {
  return (RELATION_TYPES as readonly string[]).includes(type)
}

export function isSymmetricRelationType(type: string): boolean {
  return (SYMMETRIC_RELATION_TYPES as readonly string[]).includes(type)
}

export interface RelationRow {
  relation_type: string
  direction: "from" | "to"
  related_bloq?: { id: number; name: string } | null
}

/** Groups relations by type for `iris bloqs relations <id>` text output. */
export function formatRelationsGrouped(relations: RelationRow[]): string {
  if (!relations || relations.length === 0) {
    return "No relations."
  }

  const byType = new Map<string, RelationRow[]>()
  for (const relation of relations) {
    const rows = byType.get(relation.relation_type) ?? []
    rows.push(relation)
    byType.set(relation.relation_type, rows)
  }

  const lines: string[] = []
  for (const type of Array.from(byType.keys()).sort()) {
    lines.push(type)
    const rows = byType.get(type)!
    rows.forEach((row, i) => {
      const isLast = i === rows.length - 1
      const prefix = isLast ? "└─" : "├─"
      const arrow = row.direction === "from" ? "→" : "←"
      const label = row.related_bloq?.name || `Bloq #${row.related_bloq?.id ?? "?"}`
      lines.push(`  ${prefix} ${arrow} ${label}`)
    })
  }
  return lines.join("\n")
}
