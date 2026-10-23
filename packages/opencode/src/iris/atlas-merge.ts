/**
 * The three-way merge the CLI's dataset sync uses (`cli/cmd/atlas-dataset-sync.ts` on main),
 * copied here because Desktop ships from a branch that does not contain it (#190537 W3). Keep the
 * two identical: a card and a dataset record that merge differently would be a second set of rules
 * nobody can predict. Pure, no imports.
 */
export type Data = Record<string, unknown>

/** JSON with keys sorted at every level, so two values compare by content and not by key order. */
export function canon(v: unknown): string {
  const norm = (x: unknown): unknown => {
    if (Array.isArray(x)) return x.map(norm)
    if (x && typeof x === "object") {
      return Object.fromEntries(
        Object.keys(x as Data)
          .sort()
          .map((k) => [k, norm((x as Data)[k])]),
      )
    }
    return x
  }
  return JSON.stringify(norm(v))
}

const same = (a: unknown, b: unknown) => canon(a) === canon(b)
const ABSENT = Symbol("absent")

/** Three-way merge of two records' data against their common base, field by field. */
export function merge3(base: Data, local: Data, remote: Data): { merged: Data; conflicts: string[] } {
  const merged: Data = {}
  const conflicts: string[] = []
  const keys = [...new Set([...Object.keys(base), ...Object.keys(local), ...Object.keys(remote)])].sort()
  for (const k of keys) {
    const b = k in base ? base[k] : ABSENT
    const l = k in local ? local[k] : ABSENT
    const r = k in remote ? remote[k] : ABSENT
    let out: unknown
    if (same(l, r)) out = l
    else if (same(l, b)) out = r // only the server changed it
    else if (same(r, b)) out = l // only you changed it
    else {
      out = l // both changed it differently: yours stays, and it is named
      conflicts.push(k)
    }
    if (out !== ABSENT) merged[k] = out
  }
  return { merged, conflicts }
}
