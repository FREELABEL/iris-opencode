/**
 * Array coercion for API responses.
 *
 * The bug this exists to kill: a list was built with a `??` chain and *annotated*
 * as an array, but never *checked* —
 *
 *     const items: any[] = data?.data ?? data?.requests ?? []
 *     for (const r of items) ...          // TypeError: {} is not iterable
 *
 * `??` only falls through on null/undefined. When an endpoint answers
 * `{"data": {}}` — an empty *object* rather than an empty array — `data?.data`
 * is `{}`, which satisfies `??`, lands in `items`, and kills the command on the
 * next line. The trailing `[]` never runs: the chain short-circuited earlier.
 *
 * It fails as a CRASH where the right answer is an EMPTY LIST, so the user
 * cannot tell "this subsystem is broken" from "you have none of these".
 * Reported seven times against six different commands before being traced to
 * one idiom (bloq #297; root cause on item #182167).
 */

/** The value if it is an array, otherwise an empty array. Never throws. */
export function asArray<T = any>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : []
}

/**
 * The first candidate that IS an array, otherwise `[]`.
 *
 * Drop-in for a `??` chain, and deliberately equivalent to it apart from the
 * crash: `a ?? b ?? []` becomes `firstArray(a, b)`. A candidate that is null,
 * undefined, or any non-array (`{}` included) is skipped rather than returned.
 * An operand that is a genuinely empty array still wins, exactly as `??` gave
 * it precedence — this does not "find the first non-empty" list.
 */
export function firstArray<T = any>(...candidates: unknown[]): T[] {
  for (const c of candidates) if (Array.isArray(c)) return c as T[]
  return []
}
