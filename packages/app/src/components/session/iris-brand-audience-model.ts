/**
 * The Audience tab's logic (#194611), kept out of the component so it can be tested: what a save
 * sends, what changed for the confirm, and which validation issue belongs to which field.
 *
 * The definition itself — types, enums, validator — is ./iris-brand-audience-schema.ts, a byte-for-byte
 * copy of the engine's packages/opencode/src/iris/brand-audience.ts (a test there compares them).
 */
import {
  SEGMENT_GROUPS,
  normalizeAudience,
  pruneAudience,
  uniqueSegmentId,
  type Audience,
  type AudienceIssue,
  type Segment,
  type SegmentGroupKey,
} from "./iris-brand-audience-schema"

/** JSON with sorted keys — the same comparison the engine pins saves with. */
export function stableJson(v: unknown): string {
  const sort = (x: unknown): unknown =>
    Array.isArray(x)
      ? x.map(sort)
      : x && typeof x === "object"
        ? Object.fromEntries(Object.keys(x as object).sort().map((k) => [k, sort((x as Record<string, unknown>)[k])]))
        : x
  return JSON.stringify(sort(v ?? null))
}

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T

/** Segments with no id get one from their name, unique in the audience — what use cases point at. */
export function withIds(a: Audience): Audience {
  const out = clone(a)
  const taken = out.segments.map((s) => s.id)
  for (const s of out.segments)
    if (!s.id?.trim() && s.name.trim()) {
      s.id = uniqueSegmentId(s.name, taken)
      taken.push(s.id)
    }
  return out
}

/** What the editor sends: ids filled in, empty fields dropped. */
export function audienceToSave(a: Audience): Audience {
  return pruneAudience(withIds(a))
}

/** Whether the draft differs from what was read, ignoring empty fields the editor adds to bind to. */
export function audienceChanged(read: unknown, draft: Audience): boolean {
  return stableJson(pruneAudience(normalizeAudience(read))) !== stableJson(pruneAudience(clone(draft)))
}

/** Issues at a path or under it: "segments[0].demographics" holds "segments[0].demographics.age_band[1]". */
export function issuesUnder(issues: AudienceIssue[], prefix: string): AudienceIssue[] {
  return issues.filter((i) => i.path === prefix || i.path.startsWith(prefix + ".") || i.path.startsWith(prefix + "["))
}

/** Which segment group an issue path falls in — identity for fields on the segment itself. */
export function groupOfPath(path: string): { segment: number; group: SegmentGroupKey } | undefined {
  const m = /^segments\[(\d+)\](?:\.([a-z_]+))?/.exec(path)
  if (!m) return undefined
  const key = m[2] as SegmentGroupKey | undefined
  const group = key && SEGMENT_GROUPS.some((g) => g.key === key && g.shape !== "flat") ? key : "identity"
  return { segment: Number(m[1]), group }
}

export type AudienceDiffLine = { section: "audience"; part: "audience"; label: string; note: string }

/**
 * What a save changes, one line per segment touched plus one per brand-level part — for the confirm.
 * Segments are matched by id, then by name.
 */
export function audienceDiff(
  read: unknown,
  draft: Audience,
  words: {
    segment: (name: string) => string
    brand: (part: "use_cases" | "not_for" | "positioning") => string
    group: (key: SegmentGroupKey) => string
    added: string
    removed: string
    changed: (parts: string) => string
    unnamed: string
  },
): AudienceDiffLine[] {
  const was = pruneAudience(normalizeAudience(read))
  const now = pruneAudience(clone(draft))
  const out: AudienceDiffLine[] = []
  const line = (label: string, note: string) => out.push({ section: "audience", part: "audience", label, note })
  const key = (s: Segment, i: number) => s.id || s.name || `#${i}`
  const before = new Map(was.segments.map((s, i) => [key(s, i), s]))
  const seen = new Set<string>()
  now.segments.forEach((s, i) => {
    const k = key(s, i)
    // By id, then by name. Not by position: a segment removed and another added would read as one renamed.
    // A segment saved once has an id, so renaming it later still matches.
    const old = before.get(k) ?? (s.name ? was.segments.find((x) => x.name === s.name) : undefined)
    const name = s.name || words.unnamed
    if (!old) return line(words.segment(name), words.added)
    seen.add(key(old, was.segments.indexOf(old)))
    const parts = SEGMENT_GROUPS.filter((g) => {
      if (g.shape === "flat") return g.fields.some((f) => stableJson((s as any)[f.key]) !== stableJson((old as any)[f.key]))
      return stableJson((s as any)[g.key]) !== stableJson((old as any)[g.key])
    }).map((g) => words.group(g.key))
    if (parts.length) line(words.segment(name), words.changed(parts.join(", ")))
  })
  was.segments.forEach((s, i) => {
    if (!seen.has(key(s, i))) line(words.segment(s.name || words.unnamed), words.removed)
  })
  for (const part of ["use_cases", "not_for", "positioning"] as const)
    if (stableJson((now as any)[part]) !== stableJson((was as any)[part])) line(words.brand(part), words.changed(words.brand(part)))
  return out
}
