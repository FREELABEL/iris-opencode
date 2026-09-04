import { describe, expect, test } from "bun:test"
import { diffComponentSource, mergeComponentSource } from "./component-diff"
import { componentHeader } from "./component-base"

/**
 * `library diff` and `library merge`.
 *
 * Pages got `pages diff` and a three-way merge. Components got neither, so a component conflict
 * had exactly one recovery — pull their version and redo your edit from memory. That is the
 * shape that makes people pass `--force`, and a reflex `--force` removes the protection for the
 * case it exists for.
 *
 * THE MERGE UNIT IS DIFFERENT HERE, AND DELIBERATELY SO.
 *
 * A page is JSON with stable component ids, so its merge is structural and a textual merge on
 * pretty-printed JSON would resolve a whole-array replacement "cleanly" by taking one side
 * entirely (ADR-01). A component is a `.vue` FILE — hand-written text with no addressable
 * units. Line-based three-way is exactly right for it, and structural merge is not available.
 * Same epic, opposite tool, because the artifacts are not the same kind of thing.
 *
 * The provenance marker is stripped from every side before diffing. It differs on every pull by
 * construction (hash and timestamp), so leaving it in would report a conflict on line 1 of every
 * single merge — a guard that always fires is a guard that gets turned off.
 */
const BASE = `<template>
  <p>{{ heading }}</p>
</template>
<script>
export default {
  props: { heading: { type: String, default: 'base' } },
}
</script>`

const withMarker = (src: string, hash: string) =>
  componentHeader({ slug: "s", hash, compiler: "3.10.0", pulledAt: "t" }) + "\n" + src

describe("diffComponentSource", () => {
  test("identical sources report no change", () => {
    const d = diffComponentSource(BASE, BASE)
    expect(d.changed).toBe(false)
    expect(d.added).toBe(0)
    expect(d.removed).toBe(0)
  })

  test("the provenance marker alone is NOT a change", () => {
    // It differs on every pull by construction. Reporting it would mean `diff` never says
    // "clean", and a tool that always cries wolf stops being read.
    const d = diffComponentSource(withMarker(BASE, "AAA"), withMarker(BASE, "BBB"))
    expect(d.changed).toBe(false)
  })

  test("a real edit is counted and shown", () => {
    const mine = BASE.replace("'base'", "'mine'")
    const d = diffComponentSource(BASE, mine)
    expect(d.changed).toBe(true)
    expect(d.added).toBe(1)
    expect(d.removed).toBe(1)
    expect(d.lines.join("\n")).toContain("mine")
  })

  test("trailing-newline differences alone are not a change", () => {
    expect(diffComponentSource(BASE, BASE + "\n").changed).toBe(false)
  })
})

describe("mergeComponentSource — three-way, line based", () => {
  test("disjoint edits both survive", () => {
    // The whole point: two people touching different parts of one component keep both.
    const ours = BASE.replace("'base'", "'ours'")
    const theirs = BASE.replace("<p>{{ heading }}</p>", "<p class=\"x\">{{ heading }}</p>")
    const r = mergeComponentSource(BASE, ours, theirs)
    expect(r.conflicted).toBe(false)
    expect(r.merged).toContain("'ours'")
    expect(r.merged).toContain('class="x"')
  })

  test("the same line edited both ways is a CONFLICT, not a guess", () => {
    const ours = BASE.replace("'base'", "'ours'")
    const theirs = BASE.replace("'base'", "'theirs'")
    const r = mergeComponentSource(BASE, ours, theirs)
    expect(r.conflicted).toBe(true)
    expect(r.merged).toContain("<<<<<<<")
    expect(r.merged).toContain(">>>>>>>")
  })

  test("a conflict names both sides so a human can choose", () => {
    const r = mergeComponentSource(BASE, BASE.replace("'base'", "'ours'"), BASE.replace("'base'", "'theirs'"))
    expect(r.merged).toContain("'ours'")
    expect(r.merged).toContain("'theirs'")
  })

  test("identical edits on both sides are not a conflict", () => {
    const same = BASE.replace("'base'", "'same'")
    const r = mergeComponentSource(BASE, same, same)
    expect(r.conflicted).toBe(false)
    expect(r.merged.trim()).toBe(same.trim())
  })

  test("markers are stripped from all three sides before merging", () => {
    // Otherwise line 1 conflicts on every merge, because the marker differs by construction.
    const r = mergeComponentSource(
      withMarker(BASE, "B"),
      withMarker(BASE.replace("'base'", "'ours'"), "O"),
      withMarker(BASE.replace("<p>{{ heading }}</p>", "<p id=\"t\">{{ heading }}</p>"), "T"),
    )
    expect(r.conflicted).toBe(false)
    expect(r.merged).not.toContain("iris:component")
    expect(r.merged).toContain("'ours'")
    expect(r.merged).toContain('id="t"')
  })

  test("no base means REFUSE, not a two-way guess", () => {
    // Same rule the page merge follows: coercing a missing ancestor into an empty document
    // makes every line read as "added on both sides", and the result either resolves falsely
    // clean or conflicts on everything. Both look like a working merge.
    const r = mergeComponentSource(null, BASE, BASE.replace("'base'", "'theirs'"))
    expect(r.refused).toBe(true)
    expect(r.conflicted).toBe(false)
  })

  test("an unchanged side yields the other side exactly", () => {
    const theirs = BASE.replace("'base'", "'theirs'")
    const r = mergeComponentSource(BASE, BASE, theirs)
    expect(r.conflicted).toBe(false)
    expect(r.merged.trim()).toBe(theirs.trim())
  })
})

import { parseComponentHeader, restampComponentHeader } from "./component-base"

describe("after a merge, the next publish must still be guarded", () => {
  test("the merged file is stamped with THEIRS' hash, not left bare", () => {
    // Found by the production round trip. `merge` wrote the file with no marker, so the
    // follow-up publish sent no expected_hash and was completely unguarded — a third writer
    // publishing between your merge and your publish would be clobbered silently. That is the
    // exact defect this epic removes, reappearing in the recovery path for it.
    //
    // THEIRS is the correct anchor: you merged against the published state, so that is the
    // state you are claiming to replace. Stamping OURS would claim a state that never existed
    // on the server, and stamping nothing claims none at all.
    const merged = "<template><p/></template>"
    const stamped = restampComponentHeader(merged, {
      slug: "s", hash: "THEIRS_HASH", compiler: "3.10.0", pulledAt: "t",
    })
    const meta = parseComponentHeader(stamped)
    expect(meta).not.toBeNull()
    expect(meta!.hash).toBe("THEIRS_HASH")
  })

  test("a conflicted merge is NOT stamped — it is not a publishable state", () => {
    // Conflict markers in the file mean it does not compile. Stamping it would let a reflex
    // publish send <<<<<<< to the server as source.
    const stamped = restampComponentHeader("<<<<<<< ours\nx\n=======\ny\n>>>>>>> theirs", {
      slug: "s", hash: "", compiler: "3.10.0", pulledAt: "t",
    })
    expect(parseComponentHeader(stamped)).toBeNull()
  })
})
