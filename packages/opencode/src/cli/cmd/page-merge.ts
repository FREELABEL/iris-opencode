/**
 * GLD-02 — three-way merge for `iris pages merge <slug>`.
 *
 *   base   = the page version the local file was pulled from (`_base.version`)
 *   ours   = ./pages/<slug>.json
 *   theirs = the current live version
 *
 * STRUCTURAL, KEYED ON ID — NOT TEXTUAL, AND THAT IS THE WHOLE POINT.
 *
 * A line-based merge of pretty-printed JSON produces structurally invalid documents about
 * half the time, which at least fails loudly. The other half is worse: the losses actually
 * observed on this codebase were whole-ARRAY replacements (a `layout.navItems` or a
 * `components` array pushed entire), and a line merge resolves those *cleanly* — it takes one
 * side in full and reports success. That is the same failure as #183600 wearing a merge tool's
 * clothes.
 *
 * So every unit is addressed by a stable key and merged on its own:
 *
 *   component            -> json_content.components[].id   (backfilled by assignComponentIds)
 *   layout.navItems item -> id ?? key ?? url ?? href ?? label
 *   siteNavigation item  -> same (it is the same shape, and it is nav, which is what got lost)
 *   page scalars         -> title, seo_*, og_image, visibility, owner_*
 *   json_content scalars -> theme, css, gate, render_mode, …
 *   layout scalars       -> themeMode, pageTitle, logo, …
 *
 * The three-way rule, everywhere:
 *
 *   ours == theirs                     -> agreed, take it
 *   ours == base                       -> they changed it, take theirs
 *   theirs == base                     -> we changed it, take ours
 *   otherwise, or base unknown         -> CONFLICT (never a guess)
 *
 * Pure and dependency-free — see page-merge.test.ts.
 */

export type MergeConflict = {
  /** Addressable unit: "title", "component:hero-0", "json_content.layout.navItems:/p/a", … */
  unit: string
  kind:
    | "edit/edit"
    | "delete/edit"
    | "edit/delete"
    | "move/edit"
    | "order"
    | "duplicate-id"
    | "missing-id"
  /** Human label for the report — component type, nav label, remediation hint. */
  label?: string
  base?: unknown
  ours?: unknown
  theirs?: unknown
}

export type MergeChange = {
  unit: string
  from: "ours" | "theirs"
  kind: "added" | "removed" | "changed" | "reordered"
  label?: string
}

export type MergeOutcome = {
  merged: any
  conflicts: MergeConflict[]
  changes: MergeChange[]
  /** False when the merge must not be written: an unresolved conflict, or a broken id set. */
  mergeable: boolean
}

export type MergeOptions = {
  /** How to settle conflicts. They are still REPORTED either way. */
  resolve?: "ours" | "theirs"
}

// ---------------------------------------------------------------------------
// Equality
// ---------------------------------------------------------------------------

/**
 * Key-order-insensitive deep serialisation. The server and the local file routinely disagree
 * on key order for identical content (PHP assoc arrays vs. whatever last wrote the file), and
 * reading that as an edit would make every merge a conflict storm.
 */
function stable(v: unknown): string {
  return JSON.stringify(canon(v))
}

function canon(v: any): any {
  if (Array.isArray(v)) return v.map(canon)
  if (v && typeof v === "object") {
    const out: Record<string, any> = {}
    for (const k of Object.keys(v).sort()) out[k] = canon(v[k])
    return out
  }
  return v
}

function eq(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b)
}

function clone<T>(v: T): T {
  return v === undefined ? (undefined as any) : JSON.parse(JSON.stringify(v))
}

// ---------------------------------------------------------------------------
// Scalar three-way
// ---------------------------------------------------------------------------

const ABSENT = Symbol("absent")
type Maybe = unknown | typeof ABSENT

function get(obj: any, key: string): Maybe {
  if (!obj || typeof obj !== "object" || !(key in obj)) return ABSENT
  return obj[key]
}

type ScalarResult = {
  value: Maybe
  conflict: boolean
  from: "same" | "ours" | "theirs"
}

/**
 * A key that is `null` on one side and simply not present on the other is the SAME absence.
 *
 * `pages pull` writes `seo_title: null`; the live payload omits the key. Reading that as a
 * difference made the merge report list three untouched scalars as "changed" next to one real
 * conflict — and a report padded with non-findings is one the reader learns to skim, which
 * costs you the finding that mattered.
 *
 * Only for scalars: components and nav entries are objects, never nullish.
 */
function nullish(v: Maybe): boolean {
  return v === ABSENT || v === null
}

function merge3(base: Maybe, ours: Maybe, theirs: Maybe, baseKnown: boolean): ScalarResult {
  if (nullish(ours) && nullish(theirs)) {
    // Keep whichever spelling is actually present so the written file does not churn.
    return { value: ours !== ABSENT ? ours : theirs, conflict: false, from: "same" }
  }
  if (ours !== ABSENT && theirs !== ABSENT && eq(ours, theirs)) return { value: ours, conflict: false, from: "same" }

  if (baseKnown) {
    const sameAsBase = (v: Maybe) => (v === ABSENT ? base === ABSENT : base !== ABSENT && eq(v, base))
    if (sameAsBase(ours)) return { value: theirs, conflict: false, from: "theirs" }
    if (sameAsBase(theirs)) return { value: ours, conflict: false, from: "ours" }
  }
  // Both moved away from a known base, or the base is unknown and they disagree. Either way
  // there is no answer that is not a guess.
  return { value: ours, conflict: true, from: "ours" }
}

function applyResolve(r: ScalarResult, ours: Maybe, theirs: Maybe, opts?: MergeOptions): Maybe {
  if (!r.conflict) return r.value
  if (opts?.resolve === "theirs") return theirs
  return ours
}

// ---------------------------------------------------------------------------
// Keyed collections
// ---------------------------------------------------------------------------

type Keyed = { order: string[]; map: Map<string, any>; duplicates: string[]; unkeyed: number[] }

function index(arr: any[] | undefined, identify: (item: any) => string | null): Keyed {
  const order: string[] = []
  const map = new Map<string, any>()
  const duplicates: string[] = []
  const unkeyed: number[] = []
  if (!Array.isArray(arr)) return { order, map, duplicates, unkeyed }
  arr.forEach((item, i) => {
    const k = identify(item)
    if (k === null) {
      unkeyed.push(i)
      return
    }
    if (map.has(k)) {
      duplicates.push(k)
      return
    }
    map.set(k, item)
    order.push(k)
  })
  return { order, map, duplicates, unkeyed }
}

/**
 * Rank each key within the subset present in all three sides. Restricting to the common
 * subset is what stops an addition or a deletion from reading as a move of everything after
 * it.
 */
function ranks(order: string[], common: Set<string>): Map<string, number> {
  const m = new Map<string, number>()
  let n = 0
  for (const k of order) if (common.has(k)) m.set(k, n++)
  return m
}

function seqEq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Which keys a side actually MOVED, relative to base.
 *
 * Not "its index differs" — that was the first implementation and it is wrong in the ordinary
 * case: dragging one component to the top shifts the index of every component below it, so
 * every one of them reads as moved and any edit anywhere becomes a spurious move/edit
 * conflict. A merge tool that cries conflict on the common case gets `--theirs`'d reflexively,
 * and then it is not a guard at all.
 *
 * The moved set is everything OUTSIDE a longest common subsequence of the two orders — the
 * minimal set of elements you would have to pick up and reinsert to get from base to side.
 * base [a,b,c] -> [c,a,b] yields {c}, which is what a person would say happened.
 */
function movedKeys(baseSeq: string[], sideSeq: string[]): Set<string> {
  const n = baseSeq.length, m = sideSeq.length
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = baseSeq[i] === sideSeq[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
    }
  }
  const kept = new Set<string>()
  let i = 0, j = 0
  while (i < n && j < m) {
    if (baseSeq[i] === sideSeq[j]) { kept.add(baseSeq[i]); i++; j++ }
    else if (dp[i + 1][j] >= dp[i][j + 1]) i++
    else j++
  }
  return new Set(baseSeq.filter((k) => !kept.has(k)))
}

type KeyedMergeResult = {
  items: any[]
  conflicts: MergeConflict[]
  changes: MergeChange[]
  fatal: boolean
}

function mergeKeyedArray(
  unitPrefix: string,
  baseArr: any[] | undefined,
  oursArr: any[] | undefined,
  theirsArr: any[] | undefined,
  identify: (item: any) => string | null,
  describe: (item: any) => string,
  baseKnown: boolean,
  opts: MergeOptions | undefined,
  missingIdHint: string,
): KeyedMergeResult {
  const conflicts: MergeConflict[] = []
  const changes: MergeChange[] = []

  const B = index(baseArr, identify)
  const O = index(oursArr, identify)
  const T = index(theirsArr, identify)

  // Fatal id problems first. Without a usable key there is no merge, only a guess dressed up
  // as one — and the guess is exactly what this command exists to refuse.
  let fatal = false
  for (const [side, ix] of [["local file", O], ["live page", T]] as const) {
    for (const dup of ix.duplicates) {
      fatal = true
      conflicts.push({
        unit: `${unitPrefix}:${dup}`,
        kind: "duplicate-id",
        label: `"${dup}" appears more than once in the ${side} — ids must be unique to merge`,
      })
    }
    if (ix.unkeyed.length > 0) {
      fatal = true
      conflicts.push({
        unit: `${unitPrefix}[${ix.unkeyed.join(",")}]`,
        kind: "missing-id",
        label: `${ix.unkeyed.length} entr${ix.unkeyed.length === 1 ? "y has" : "ies have"} no stable id in the ${side}. ${missingIdHint}`,
      })
    }
  }
  if (fatal) return { items: clone(oursArr) ?? [], conflicts, changes, fatal: true }

  // ---- membership + content, per key ----
  const merged = new Map<string, any>()
  const allKeys = new Set<string>([...O.order, ...T.order, ...B.order])
  const conflicted = new Set<string>()

  for (const k of allKeys) {
    const inB = B.map.has(k), inO = O.map.has(k), inT = T.map.has(k)
    const b = B.map.get(k), o = O.map.get(k), t = T.map.get(k)
    const label = describe(o ?? t ?? b)

    if (inO && inT) {
      const r = merge3(inB ? b : ABSENT, o, t, baseKnown && inB)
      if (r.conflict) {
        conflicted.add(k)
        conflicts.push({ unit: `${unitPrefix}:${k}`, kind: "edit/edit", label, base: b, ours: o, theirs: t })
        merged.set(k, clone(opts?.resolve === "theirs" ? t : o))
      } else {
        merged.set(k, clone(r.value))
        if (r.from === "theirs") changes.push({ unit: `${unitPrefix}:${k}`, from: "theirs", kind: "changed", label })
        else if (r.from === "ours") changes.push({ unit: `${unitPrefix}:${k}`, from: "ours", kind: "changed", label })
      }
      continue
    }

    if (inO && !inT) {
      if (!inB) {
        // We added it.
        merged.set(k, clone(o))
        changes.push({ unit: `${unitPrefix}:${k}`, from: "ours", kind: "added", label })
      } else if (eq(o, b)) {
        // They deleted it, we did not touch it. Accept the delete.
        changes.push({ unit: `${unitPrefix}:${k}`, from: "theirs", kind: "removed", label })
      } else {
        // They deleted it, we edited it. Dropping our edit silently is the loss this whole
        // command exists to prevent.
        conflicted.add(k)
        conflicts.push({ unit: `${unitPrefix}:${k}`, kind: "delete/edit", label, base: b, ours: o, theirs: undefined })
        if (opts?.resolve !== "theirs") merged.set(k, clone(o))
      }
      continue
    }

    if (!inO && inT) {
      if (!inB) {
        merged.set(k, clone(t))
        changes.push({ unit: `${unitPrefix}:${k}`, from: "theirs", kind: "added", label })
      } else if (eq(t, b)) {
        changes.push({ unit: `${unitPrefix}:${k}`, from: "ours", kind: "removed", label })
      } else {
        conflicted.add(k)
        conflicts.push({ unit: `${unitPrefix}:${k}`, kind: "edit/delete", label, base: b, ours: undefined, theirs: t })
        if (opts?.resolve === "theirs") merged.set(k, clone(t))
      }
      continue
    }
    // In base only — both deleted. Agreed.
  }

  // ---- order ----
  const common = new Set<string>([...B.order].filter((k) => O.map.has(k) && T.map.has(k)))
  const baseSeq = [...ranks(B.order, common).keys()]
  const ourSeq = [...ranks(O.order, common).keys()]
  const theirSeq = [...ranks(T.order, common).keys()]
  const oursMoved = baseKnown && !seqEq(ourSeq, baseSeq)
  const theirsMoved = baseKnown && !seqEq(theirSeq, baseSeq)

  let skeleton: string[]
  if (oursMoved && theirsMoved && !seqEq(ourSeq, theirSeq)) {
    conflicts.push({
      unit: `${unitPrefix}:order`,
      kind: "order",
      label: "both sides reordered differently",
      base: baseSeq,
      ours: ourSeq,
      theirs: theirSeq,
    })
    skeleton = opts?.resolve === "theirs" ? T.order : O.order
  } else if (theirsMoved) {
    skeleton = T.order
    changes.push({ unit: `${unitPrefix}:order`, from: "theirs", kind: "reordered" })
  } else {
    skeleton = O.order
    if (oursMoved) changes.push({ unit: `${unitPrefix}:order`, from: "ours", kind: "reordered" })
  }

  // A component moved on one side and edited on the other is a CONFLICT, not a guess: one
  // side's intent was "this belongs here", the other's was "this should say that", and there
  // is no way to know whether the move was made in view of the edit.
  if (baseKnown) {
    const ourMoves = movedKeys(baseSeq, ourSeq)
    const theirMoves = movedKeys(baseSeq, theirSeq)
    for (const k of common) {
      if (conflicted.has(k)) continue
      const b = B.map.get(k), o = O.map.get(k), t = T.map.get(k)
      const weMoved = ourMoves.has(k)
      const theyMoved = theirMoves.has(k)
      const weEdited = !eq(o, b)
      const theyEdited = !eq(t, b)
      if ((weMoved && theyEdited && !weEdited) || (theyMoved && weEdited && !theyEdited)) {
        conflicted.add(k)
        conflicts.push({
          unit: `${unitPrefix}:${k}`,
          kind: "move/edit",
          label: `${describe(o ?? t)} — moved on one side and edited on the other`,
          base: b, ours: o, theirs: t,
        })
        merged.set(k, clone(opts?.resolve === "theirs" ? t : o))
      }
    }
  }

  // ---- assemble ----
  // Start from the winning order, then splice in surviving keys the skeleton side lacks,
  // anchored to their neighbour on the other side. Appending them all at the end would be a
  // second, quieter way of losing a position.
  const other = skeleton === T.order ? O.order : T.order
  const result: string[] = skeleton.filter((k) => merged.has(k))
  const placed = new Set(result)
  for (let i = 0; i < other.length; i++) {
    const k = other[i]
    if (placed.has(k) || !merged.has(k)) continue
    let at = 0
    for (let j = i - 1; j >= 0; j--) {
      const idx = result.indexOf(other[j])
      if (idx >= 0) { at = idx + 1; break }
    }
    result.splice(at, 0, k)
    placed.add(k)
  }

  return { items: result.map((k) => merged.get(k)), conflicts, changes, fatal: false }
}

// ---------------------------------------------------------------------------
// Identity
// ---------------------------------------------------------------------------

function componentId(c: any): string | null {
  return c && typeof c === "object" && typeof c.id === "string" && c.id ? c.id : null
}

function componentLabel(c: any): string {
  const t = c?.type ? String(c.type) : "component"
  return c?.id ? `${t} (${c.id})` : t
}

/**
 * Nav entries carry no `id` in any page in this workspace — 311 of them across 46 pages, all
 * `{label, url, icon, active}`. `url` is the stable identity in practice; `label` is the last
 * resort, and an entry with neither cannot be keyed.
 */
function navId(item: any): string | null {
  if (!item || typeof item !== "object") return null
  for (const k of ["id", "key", "url", "href", "to", "label"]) {
    const v = (item as any)[k]
    if (typeof v === "string" && v) return v
  }
  return null
}

function navLabel(item: any): string {
  const l = item?.label ?? item?.title
  const u = item?.url ?? item?.href
  return l ? `${l}${u ? ` → ${u}` : ""}` : String(u ?? "nav item")
}

// ---------------------------------------------------------------------------
// The merge
// ---------------------------------------------------------------------------

/**
 * Page-level fields the local file owns — exactly what `pages pull` writes, minus identity
 * and lifecycle.
 *
 * An allowlist rather than "every key on `theirs`" on purpose: `getBySlug` returns
 * `cache_key`, `created_at`, `views`, `current_version` and friends, and merging those into
 * the local file would quietly turn a content file into a stale copy of server state.
 *
 * `status` is absent because push never sends it. `id`/`slug` are identity.
 */
const PAGE_SCALARS = ["title", "seo_title", "seo_description", "og_image", "visibility", "owner_type", "owner_id"] as const

/** Handled inside json_content by their own mergers, not as scalars. */
const JSON_CONTENT_SPECIAL = new Set(["components", "layout", "siteNavigation"])

export function mergePageDocs(
  base: any,
  ours: any,
  theirs: any,
  opts?: MergeOptions,
): MergeOutcome {
  const conflicts: MergeConflict[] = []
  const changes: MergeChange[] = []
  const baseKnown = !!base && typeof base === "object"

  const bJc = baseKnown ? (base.json_content ?? {}) : {}
  const oJc = ours?.json_content ?? {}
  const tJc = theirs?.json_content ?? {}

  const merged: any = {}

  // ---- page-level scalars ----
  for (const key of PAGE_SCALARS) {
    const r = merge3(baseKnown ? get(bJc && base, key) : ABSENT, get(ours, key), get(theirs, key), baseKnown)
    if (r.conflict) {
      conflicts.push({ unit: key, kind: "edit/edit", label: key, base: get(base, key), ours: get(ours, key), theirs: get(theirs, key) })
    } else if (r.from !== "same") {
      changes.push({ unit: key, from: r.from, kind: "changed", label: key })
    }
    const v = applyResolve(r, get(ours, key), get(theirs, key), opts)
    if (v !== ABSENT) merged[key] = clone(v)
  }

  // `requires_auth` NEVER conflicts and always takes the LIVE value.
  //
  // #181984: `push` deliberately does not send this field — fl-api only assigns the column
  // inside `if ($request->has('requires_auth'))`, so the local file is purely informational
  // for it. A conflict on a field nothing will act on is noise, and the one time this file's
  // value was treated as authoritative an internal document was served publicly. Take what is
  // live, so the file at least stops lying about the gate.
  const liveGate = get(theirs, "requires_auth")
  if (liveGate !== ABSENT) merged.requires_auth = clone(liveGate)
  else if (get(ours, "requires_auth") !== ABSENT) merged.requires_auth = clone(get(ours, "requires_auth"))

  // ---- json_content ----
  const mJc: any = {}
  const jcKeys = new Set<string>([...Object.keys(oJc ?? {}), ...Object.keys(tJc ?? {}), ...Object.keys(bJc ?? {})])
  for (const key of jcKeys) {
    if (JSON_CONTENT_SPECIAL.has(key)) continue
    if (key === "_base") continue // provenance is not content — never round-trip it into json_content
    const r = merge3(baseKnown ? get(bJc, key) : ABSENT, get(oJc, key), get(tJc, key), baseKnown)
    const unit = `json_content.${key}`
    if (r.conflict) {
      conflicts.push({ unit, kind: "edit/edit", label: unit, base: get(bJc, key), ours: get(oJc, key), theirs: get(tJc, key) })
    } else if (r.from !== "same") {
      changes.push({ unit, from: r.from, kind: "changed", label: unit })
    }
    const v = applyResolve(r, get(oJc, key), get(tJc, key), opts)
    if (v !== ABSENT) mJc[key] = clone(v)
  }

  // ---- components ----
  let fatal = false
  const anyComponents =
    Array.isArray(oJc?.components) || Array.isArray(tJc?.components) || Array.isArray(bJc?.components)
  if (anyComponents) {
    const r = mergeKeyedArray(
      "component",
      bJc?.components,
      oJc?.components,
      tJc?.components,
      componentId,
      componentLabel,
      baseKnown,
      opts,
      "Run `iris pages push` once to backfill ids (assignComponentIds), then pull and merge.",
    )
    // "component:order" reads oddly in a report; the unit for the whole array is
    // "components:order".
    for (const c of r.conflicts) conflicts.push(c.unit === "component:order" ? { ...c, unit: "components:order" } : c)
    for (const c of r.changes) changes.push(c.unit === "component:order" ? { ...c, unit: "components:order" } : c)
    if (r.fatal) fatal = true
    mJc.components = r.items
  }

  // ---- layout (object, with navItems keyed inside it) ----
  const layouts = [bJc?.layout, oJc?.layout, tJc?.layout]
  const layoutIsObject = layouts.some((l) => l && typeof l === "object" && !Array.isArray(l))
  if (layoutIsObject) {
    const bL = bJc?.layout ?? {}, oL = oJc?.layout ?? {}, tL = tJc?.layout ?? {}
    const mL: any = {}
    const lKeys = new Set<string>([...Object.keys(oL), ...Object.keys(tL), ...Object.keys(bL)])
    for (const key of lKeys) {
      if (key === "navItems") continue
      const r = merge3(baseKnown ? get(bL, key) : ABSENT, get(oL, key), get(tL, key), baseKnown)
      const unit = `json_content.layout.${key}`
      if (r.conflict) conflicts.push({ unit, kind: "edit/edit", label: unit, base: get(bL, key), ours: get(oL, key), theirs: get(tL, key) })
      else if (r.from !== "same") changes.push({ unit, from: r.from, kind: "changed", label: unit })
      const v = applyResolve(r, get(oL, key), get(tL, key), opts)
      if (v !== ABSENT) mL[key] = clone(v)
    }
    if (lKeys.has("navItems")) {
      const nav = mergeNavArray("json_content.layout.navItems", bL.navItems, oL.navItems, tL.navItems, baseKnown, opts)
      conflicts.push(...nav.conflicts)
      changes.push(...nav.changes)
      if (nav.fatal) fatal = true
      mL.navItems = nav.items
    }
    mJc.layout = mL
  } else if (jcKeysHas(bJc, oJc, tJc, "layout")) {
    const r = merge3(baseKnown ? get(bJc, "layout") : ABSENT, get(oJc, "layout"), get(tJc, "layout"), baseKnown)
    if (r.conflict) conflicts.push({ unit: "json_content.layout", kind: "edit/edit", label: "json_content.layout", base: get(bJc, "layout"), ours: get(oJc, "layout"), theirs: get(tJc, "layout") })
    const v = applyResolve(r, get(oJc, "layout"), get(tJc, "layout"), opts)
    if (v !== ABSENT) mJc.layout = clone(v)
  }

  // ---- siteNavigation ----
  // The contract lists this among the page-level scalars, but on disk it is an ARRAY of the
  // same {label,url,active} entries as navItems — and it is nav, which is the thing a
  // whole-array replacement has actually lost here. Treated as scalar it would conflict on
  // every append. Keyed when both sides are arrays; scalar otherwise.
  if (jcKeysHas(bJc, oJc, tJc, "siteNavigation")) {
    const arrays = [oJc?.siteNavigation, tJc?.siteNavigation].every((v) => v === undefined || Array.isArray(v))
    if (arrays) {
      const nav = mergeNavArray("json_content.siteNavigation", bJc?.siteNavigation, oJc?.siteNavigation, tJc?.siteNavigation, baseKnown, opts)
      conflicts.push(...nav.conflicts)
      changes.push(...nav.changes)
      if (nav.fatal) fatal = true
      mJc.siteNavigation = nav.items
    } else {
      const r = merge3(baseKnown ? get(bJc, "siteNavigation") : ABSENT, get(oJc, "siteNavigation"), get(tJc, "siteNavigation"), baseKnown)
      if (r.conflict) conflicts.push({ unit: "json_content.siteNavigation", kind: "edit/edit", label: "json_content.siteNavigation", base: get(bJc, "siteNavigation"), ours: get(oJc, "siteNavigation"), theirs: get(tJc, "siteNavigation") })
      const v = applyResolve(r, get(oJc, "siteNavigation"), get(tJc, "siteNavigation"), opts)
      if (v !== ABSENT) mJc.siteNavigation = clone(v)
    }
  }

  merged.json_content = mJc

  const unresolved = fatal || (!opts?.resolve && conflicts.length > 0)
  return { merged, conflicts, changes, mergeable: !unresolved }
}

function mergeNavArray(
  unitPrefix: string,
  b: any,
  o: any,
  t: any,
  baseKnown: boolean,
  opts: MergeOptions | undefined,
): KeyedMergeResult {
  const r = mergeKeyedArray(
    unitPrefix,
    Array.isArray(b) ? b : undefined,
    Array.isArray(o) ? o : undefined,
    Array.isArray(t) ? t : undefined,
    navId,
    navLabel,
    baseKnown,
    opts,
    "Give each entry a `url` or `label` so it can be matched across versions.",
  )
  return r
}

function jcKeysHas(b: any, o: any, t: any, key: string): boolean {
  return (
    (!!o && typeof o === "object" && key in o) ||
    (!!t && typeof t === "object" && key in t) ||
    (!!b && typeof b === "object" && key in b)
  )
}

/** Page-level scalars a historical version row may carry. Same set the local file owns. */
const VERSION_ROW_SCALARS = PAGE_SCALARS

/**
 * Turn one `page_versions` row into a merge BASE, or null when that version's content is not
 * actually available.
 *
 * `GET /api/v1/pages/{id}/versions/{n}` returns `json_content: null` for versions written
 * before database snapshotting (they carry a `db://` gcs_path and no inline document) and for
 * pruned versions. It does NOT error — it answers 200 with a null.
 *
 * Coercing that null to `{}` is the trap. An empty base makes every component on both sides
 * read as "added", and the merge then either resolves falsely clean or conflicts on
 * absolutely everything. Both outcomes look exactly like a working merge, which is the worst
 * available failure shape: it is #183600 again, wearing a merge tool's clothes.
 *
 * `{}` and `{components: []}` ARE available — a page really can have no components. `null` is
 * an absence. Telling those apart is the entire job of this function.
 */
export function versionDocFromRow(row: any): any | null {
  if (!row || typeof row !== "object") return null
  let jc = row.json_content ?? row.content ?? null
  if (typeof jc === "string") {
    // Could be a JSON document, or could be a `db://` pointer. Only a parse tells you, and a
    // pointer does not parse into an object.
    try { jc = JSON.parse(jc) } catch { return null }
  }
  if (!jc || typeof jc !== "object" || Array.isArray(jc)) return null
  const doc: any = { json_content: jc }
  // Scalars only when the row actually carries them. A missing scalar must stay MISSING:
  // filling it in from our own file is precisely the shared-failure-mode mistake #181984
  // records, and it would make our own value look like the ancestor's.
  for (const k of VERSION_ROW_SCALARS) if (row[k] !== undefined) doc[k] = row[k]
  return doc
}

/**
 * Whether a merge may proceed at all, checked BEFORE merging.
 *
 * The case that matters: the file names a base version and that version's content could not
 * be loaded. That is not the same as having no base — it is having a base we cannot see — and
 * the two must not produce the same behaviour. Falling back to a two-way merge here would be
 * a silent downgrade at the exact moment the ancestor mattered.
 *
 * An explicit `--ours` / `--theirs` lifts the refusal: the user has already said which side
 * wins, so the ancestor is irrelevant, and refusing would leave no way forward at all.
 */
export function mergePreconditions(
  localBase: { version: number } | null,
  baseDoc: any | null,
  resolve?: "ours" | "theirs",
): { ok: boolean; lines: string[] } {
  if (!localBase) return { ok: true, lines: [] }
  if (baseDoc) return { ok: true, lines: [] }
  if (resolve) return { ok: true, lines: [] }
  return {
    ok: false,
    lines: [
      `Refusing to merge — the base version this file was pulled from (v${localBase.version}) could not be loaded.`,
      `Its content is unavailable: versions written before database snapshotting hold a pointer, not a document, and pruned versions are gone.`,
      ``,
      `Merging without the ancestor is a TWO-way merge wearing a three-way merge's output, so it is not offered.`,
      ``,
      `  See what actually differs:    iris pages diff`,
      `  Keep your file wherever the two disagree:   --ours`,
      `  Keep the live page instead:                 --theirs`,
    ],
  }
}

/**
 * A one-screen report of what the merge did and what it refuses to decide. Returned as lines
 * so the command can style them and the tests can read them.
 */
export function formatMergeReport(slug: string, out: MergeOutcome, resolve?: "ours" | "theirs"): string[] {
  const lines: string[] = []
  const fromTheirs = out.changes.filter((c) => c.from === "theirs")
  const fromOurs = out.changes.filter((c) => c.from === "ours")
  lines.push(`  taken from live:   ${fromTheirs.length}`)
  for (const c of fromTheirs.slice(0, 12)) lines.push(`    ${c.kind.padEnd(9)} ${c.label ?? c.unit}`)
  if (fromTheirs.length > 12) lines.push(`    … +${fromTheirs.length - 12} more`)
  lines.push(`  kept from your file: ${fromOurs.length}`)
  for (const c of fromOurs.slice(0, 12)) lines.push(`    ${c.kind.padEnd(9)} ${c.label ?? c.unit}`)
  if (fromOurs.length > 12) lines.push(`    … +${fromOurs.length - 12} more`)

  if (out.conflicts.length > 0) {
    const n = out.conflicts.length
    const plural = n === 1 ? "" : "s"
    lines.push("")
    // The header has to match what the caller is about to DO. `--theirs` used to print
    // "nothing written" and then write the file — the report contradicting its own action,
    // which is the same class of defect as a refusal that exits 0, and worse here because the
    // file on disk had already changed by the time you read it.
    if (resolve) lines.push(`  ${n} conflict${plural} — resolved in favour of ${resolve === "ours" ? "YOUR FILE (--ours)" : "the LIVE page (--theirs)"}:`)
    else lines.push(`  ${n} conflict${plural} — nothing written:`)
    for (const c of out.conflicts) {
      lines.push(`    [${c.kind}] ${c.unit}${c.label ? `  ${c.label}` : ""}`)
    }
    if (!resolve) {
      lines.push("")
      lines.push(`  Take your side everywhere:   iris pages merge ${slug} --ours`)
      lines.push(`  Take the live side:          iris pages merge ${slug} --theirs`)
      lines.push(`  Resolve by hand:             iris pages merge ${slug} --edit`)
    }
  }
  return lines
}
