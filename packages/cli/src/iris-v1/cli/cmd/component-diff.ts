/**
 * `library diff` and `library merge` — the recovery pages had and components did not.
 *
 * A component conflict used to have exactly one way out: pull their version and redo your edit
 * from memory. That is the shape that makes people reach for `--force`, and a reflex `--force`
 * removes the protection for the case it exists for.
 *
 * WHY THIS IS A LINE MERGE WHEN THE PAGE MERGE IS STRUCTURAL
 *
 * A page is JSON with stable component ids, so its units are addressable and a textual merge
 * there is actively wrong — it resolves a whole-array replacement "cleanly" by taking one side
 * entirely (ADR-01). A component is a `.vue` file: hand-written text with no addressable units.
 * Line-based three-way is the correct tool, and structural merge is not available. Same epic,
 * opposite instrument, because the artifacts are not the same kind of thing.
 *
 * Implemented here rather than shelling out to `git merge-file` so it is pure, testable without
 * temp files, and identical on every platform — the client is on Windows more often than our
 * validation is (#183651).
 *
 * The provenance marker is stripped from every side first. It differs on every pull by
 * construction (hash + timestamp), so leaving it in would conflict on line 1 of every merge,
 * and a guard that always fires is a guard that gets turned off.
 */
import { stripComponentHeader } from "./component-base"

const lines = (s: string): string[] => stripComponentHeader(s ?? "").replace(/\s+$/, "").split("\n")

/** base[start,end) was replaced by `repl`. */
type Op = { start: number; end: number; repl: string[] }

/**
 * Longest common subsequence over lines, backtracked into replace-ranges.
 *
 * O(n·m); component sources are hundreds of lines, so this is microseconds and the simple
 * implementation is the right one — a cleverer diff would be more code to be wrong in.
 */
function ops(base: string[], other: string[]): Op[] {
  const n = base.length
  const m = other.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = base[i] === other[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const out: Op[] = []
  let i = 0
  let j = 0
  let pendingStart = -1
  let pending: string[] = []
  const flush = (end: number) => {
    if (pendingStart >= 0) {
      out.push({ start: pendingStart, end, repl: pending })
      pendingStart = -1
      pending = []
    }
  }
  while (i < n && j < m) {
    if (base[i] === other[j]) {
      flush(i)
      i++
      j++
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      if (pendingStart < 0) pendingStart = i
      i++
    } else {
      if (pendingStart < 0) pendingStart = i
      pending.push(other[j])
      j++
    }
  }
  if (i < n || j < m) {
    if (pendingStart < 0) pendingStart = i
    while (j < m) pending.push(other[j++])
    i = n
  }
  flush(i)
  return out
}

/** Does an op touch base lines in [s,e)? */
const overlaps = (o: Op, s: number, e: number) => o.start < e && s < o.end

export type ComponentDiff = { changed: boolean; added: number; removed: number; lines: string[] }

/**
 * A unified-ish diff between two component sources, marker-insensitive.
 *
 * `changed` is the only field a caller should branch on. Reporting the marker as a change would
 * mean `diff` never says "clean".
 */
export function diffComponentSource(live: string, local: string): ComponentDiff {
  const a = lines(live)
  const b = lines(local)
  const o = ops(a, b)
  let added = 0
  let removed = 0
  const out: string[] = []
  for (const op of o) {
    for (let k = op.start; k < op.end; k++) {
      out.push(`- ${a[k]}`)
      removed++
    }
    for (const l of op.repl) {
      out.push(`+ ${l}`)
      added++
    }
  }
  return { changed: added > 0 || removed > 0, added, removed, lines: out }
}

export type ComponentMerge = {
  merged: string
  conflicted: boolean
  refused: boolean
  conflicts: number
}

/**
 * Three-way merge of a component's source.
 *
 * A NULL BASE IS A REFUSAL, not a two-way guess — the same rule the page merge follows. Coercing
 * a missing ancestor into an empty document makes every line read as "added on both sides", and
 * the result either resolves falsely clean or conflicts on everything. Both look like a working
 * merge, which is the worst possible failure here.
 */
export function mergeComponentSource(
  base: string | null | undefined,
  ours: string,
  theirs: string,
): ComponentMerge {
  if (base === null || base === undefined) {
    return { merged: "", conflicted: false, refused: true, conflicts: 0 }
  }

  const b = lines(base)
  const o = ops(b, lines(ours))
  const t = ops(b, lines(theirs))

  const out: string[] = []
  let conflicts = 0
  let i = 0

  while (i <= b.length) {
    const oo = o.find((x) => overlaps(x, i, i + 1) || (x.start === i && x.end === i))
    const to = t.find((x) => overlaps(x, i, i + 1) || (x.start === i && x.end === i))

    if (oo && to) {
      // Both sides touched this region. Identical intent is not a conflict — two people making
      // the same edit is agreement, and reporting it would be noise.
      const end = Math.max(oo.end, to.end)
      if (oo.repl.join("\n") === to.repl.join("\n") && oo.start === to.start && oo.end === to.end) {
        out.push(...oo.repl)
      } else {
        conflicts++
        out.push("<<<<<<< ours (your local file)")
        out.push(...oo.repl)
        out.push("=======")
        out.push(...to.repl)
        out.push(">>>>>>> theirs (published)")
      }
      i = Math.max(end, i + 1)
      continue
    }
    if (oo) {
      out.push(...oo.repl)
      i = Math.max(oo.end, i + 1)
      continue
    }
    if (to) {
      out.push(...to.repl)
      i = Math.max(to.end, i + 1)
      continue
    }
    if (i < b.length) out.push(b[i])
    i++
  }

  return { merged: out.join("\n"), conflicted: conflicts > 0, refused: false, conflicts }
}
