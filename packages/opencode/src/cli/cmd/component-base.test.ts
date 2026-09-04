import { describe, expect, test } from "bun:test"
import {
  componentHeader,
  parseComponentHeader,
  stripComponentHeader,
  handleComponentConflictResponse,
} from "./component-base"

/**
 * Editing a stored component is the only path that changes production without a deploy.
 *
 * The stored library IS the source — a filesystem search on 2026-09-03 found no `.vue` on disk
 * for `workspace-shell`, `registry-table`, `chat-stage`, `record-detail` or any of their
 * siblings. They exist in `code_components` and nowhere else. So `show --source` printing to a
 * terminal was the only way to read them, and copy-paste out of scrollback was the only way to
 * edit them.
 *
 * `pull` closes that, and the moment it exists the page problem arrives with it: two writers,
 * one artifact, no divergence check. That already cost this workspace three separate losses in
 * one evening on a shared page, and components are worse — one slug is named by several pages,
 * so a clobber propagates to all of them at once (#182331).
 *
 * The marker lives IN the .vue rather than a sidecar, because a sidecar is lost the moment
 * someone copies just the file, and a guard that silently disables itself when the file moves
 * is the defect it was built to prevent. Verified against the real compiler: a leading HTML
 * comment compiles.
 */
const SRC = `<template><p>{{ heading }}</p></template>
<script>
export default { props: { heading: { type: String, default: 'x' } } }
</script>`

describe("componentHeader / parseComponentHeader — provenance that travels with the file", () => {
  test("a pulled file round-trips its own marker", () => {
    const header = componentHeader({ slug: "chat-stage", hash: "abc123", compiler: "3.10.0", pulledAt: "2026-09-04T00:00:00Z" })
    const meta = parseComponentHeader(header + "\n" + SRC)
    expect(meta).toEqual({ slug: "chat-stage", hash: "abc123", compiler: "3.10.0", pulledAt: "2026-09-04T00:00:00Z" })
  })

  test("a file with no marker parses as null rather than throwing", () => {
    // A hand-written component, or one pulled before this shipped. Absence of a marker is not
    // evidence of safety, but refusing every unmarked file is worse — the same call
    // `bloqs publish` makes on missing frontmatter.
    expect(parseComponentHeader(SRC)).toBeNull()
  })

  test("a malformed marker parses as null rather than half a marker", () => {
    expect(parseComponentHeader("<!-- iris:component -->\n" + SRC)).toBeNull()
  })

  test("the marker is only honoured at the top of the file", () => {
    // Otherwise a marker quoted inside a template — documentation, an example — would be read
    // as provenance, and the guard would compare against a hash that was never a real state.
    const sneaky = SRC + "\n<!-- iris:component slug=x hash=deadbeef compiler=3.10.0 pulled=2026-01-01T00:00:00Z -->"
    expect(parseComponentHeader(sneaky)).toBeNull()
  })
})

describe("stripComponentHeader — the marker must never be stored as source", () => {
  test("it removes the marker before publishing", () => {
    const withHeader = componentHeader({ slug: "s", hash: "h", compiler: "3.10.0", pulledAt: "2026-09-04T00:00:00Z" }) + "\n" + SRC
    expect(stripComponentHeader(withHeader)).toBe(SRC)
  })

  test("a source with no marker is returned untouched", () => {
    expect(stripComponentHeader(SRC)).toBe(SRC)
  })

  test("stripping is idempotent", () => {
    const once = stripComponentHeader(componentHeader({ slug: "s", hash: "h", compiler: "c", pulledAt: "p" }) + "\n" + SRC)
    expect(stripComponentHeader(once)).toBe(once)
  })

  test("it does not eat a legitimate leading comment that is not ours", () => {
    const doc = "<!-- a note from the author -->\n" + SRC
    expect(stripComponentHeader(doc)).toBe(doc)
  })

  test("the stored source is byte-identical after a pull/publish round trip", () => {
    // This is the property that matters: the marker must not accumulate, and must not change
    // the hash. If the stored source drifted by one byte per pull, every publish would report
    // a conflict against itself.
    const pulled = componentHeader({ slug: "s", hash: "h1", compiler: "3.10.0", pulledAt: "t1" }) + "\n" + SRC
    const sent = stripComponentHeader(pulled)
    const repulled = componentHeader({ slug: "s", hash: "h2", compiler: "3.10.0", pulledAt: "t2" }) + "\n" + sent
    expect(stripComponentHeader(repulled)).toBe(SRC)
  })
})

describe("handleComponentConflictResponse — a refusal that names the blast radius", () => {
  const body = {
    error: "component_conflict",
    message: "changed since you pulled it",
    expectedHash: "mine",
    currentHash: "theirs",
    changedAt: "2026-09-04T12:00:00+00:00",
    usedByPages: 3,
  }

  test("a 409 conflicts and exits non-zero", () => {
    // #181601: a refusal that exits 0 is read by a script as a successful publish.
    const out = handleComponentConflictResponse("chat-stage", 409, body)
    expect(out.conflicted).toBe(true)
    expect(out.exitCode).toBe(1)
  })

  test("it says how many pages the publish would have changed", () => {
    // A component is not a file. #182331: one slug is named by several pages and a publish
    // changes all of them at once. The refusal is the moment somebody is actually looking.
    expect(handleComponentConflictResponse("chat-stage", 409, body).lines.join("\n")).toMatch(/3 page/)
  })

  test("it points at the recovery path, not just the problem", () => {
    const text = handleComponentConflictResponse("chat-stage", 409, body).lines.join("\n")
    expect(text).toContain("iris pages library pull chat-stage")
    expect(text).toContain("--force")
  })

  test("a 200 is not a conflict", () => {
    expect(handleComponentConflictResponse("s", 200, null).conflicted).toBe(false)
    expect(handleComponentConflictResponse("s", 200, null).exitCode).toBe(0)
  })

  test("a 409 that is NOT a component_conflict is left to the normal error path", () => {
    // `component_exists` is a different refusal with a different fix; mislabelling it would
    // send someone to re-pull a component they never had.
    const out = handleComponentConflictResponse("s", 409, { error: "component_exists" } as any)
    expect(out.conflicted).toBe(false)
  })

  test("an unknown page count is not reported as zero pages", () => {
    // The server returns 0 when the blast-radius lookup itself failed. Printing "0 pages" would
    // state as a finding something that was never measured.
    const out = handleComponentConflictResponse("s", 409, { ...body, usedByPages: undefined } as any)
    expect(out.lines.join("\n")).not.toMatch(/0 page/)
  })
})

import { restampComponentHeader } from "./component-base"

describe("restampComponentHeader — a guard that cries wolf gets disabled, not fixed", () => {
  const body = `<template><p/></template>`

  test("after a successful publish the file points at the state it just created", () => {
    // Measured: pull (hash A) -> edit -> publish (server now at hash B) -> publish again, and
    // the second publish REFUSED, because the file still claimed hash A. Publishing your own
    // file twice conflicting with yourself is the fastest way to teach someone to pass --force
    // by reflex, which removes the protection entirely.
    const pulled = componentHeader({ slug: "s", hash: "A", compiler: "3.10.0", pulledAt: "t1" }) + "\n" + body
    const after = restampComponentHeader(pulled, { slug: "s", hash: "B", compiler: "3.10.0", pulledAt: "t2" })
    expect(parseComponentHeader(after)!.hash).toBe("B")
    expect(stripComponentHeader(after)).toBe(body)
  })

  test("a file that had no marker gains one, so the NEXT publish is guarded", () => {
    const after = restampComponentHeader(body, { slug: "s", hash: "B", compiler: "3.10.0", pulledAt: "t2" })
    expect(parseComponentHeader(after)!.hash).toBe("B")
    expect(stripComponentHeader(after)).toBe(body)
  })

  test("it never stacks markers", () => {
    let f = componentHeader({ slug: "s", hash: "A", compiler: "c", pulledAt: "t" }) + "\n" + body
    for (const h of ["B", "C", "D"]) f = restampComponentHeader(f, { slug: "s", hash: h, compiler: "c", pulledAt: "t" })
    expect(f.match(/iris:component/g)!.length).toBe(1)
    expect(stripComponentHeader(f)).toBe(body)
  })

  test("with no new hash the old marker is removed rather than left lying", () => {
    // A server that returned no hash cannot be checked against. Keeping the stale marker would
    // make the next publish compare against a state that is no longer live — a check whose
    // inputs disagree with reality is worse than no check.
    const pulled = componentHeader({ slug: "s", hash: "A", compiler: "c", pulledAt: "t" }) + "\n" + body
    const after = restampComponentHeader(pulled, { slug: "s", hash: "", compiler: "c", pulledAt: "t" })
    expect(parseComponentHeader(after)).toBeNull()
    expect(stripComponentHeader(after)).toBe(body)
  })
})

describe("blast radius has THREE states, not two", () => {
  const base = { error: "component_conflict", changedAt: "2026-09-04T12:00:00+00:00" }

  test("zero pages says so, rather than saying nothing", () => {
    // Found by the production run, 2026-09-04. A component named by no page printed NO blast
    // radius line at all, because the code branched on `> 0` and on `null` and let 0 fall
    // between them. Silence there is indistinguishable from "we did not check" — which is the
    // exact absent-vs-equal confusion this whole epic exists to remove.
    const out = handleComponentConflictResponse("s", 409, { ...base, usedByPages: 0 } as any)
    expect(out.lines.join("\n")).toMatch(/no page/i)
  })

  test("a positive count is named", () => {
    expect(handleComponentConflictResponse("s", 409, { ...base, usedByPages: 3 } as any)
      .lines.join("\n")).toMatch(/3 pages/)
  })

  test("one page is singular", () => {
    expect(handleComponentConflictResponse("s", 409, { ...base, usedByPages: 1 } as any)
      .lines.join("\n")).toMatch(/1 page\b/)
  })

  test("unknown stays distinguishable from zero", () => {
    const out = handleComponentConflictResponse("s", 409, { ...base } as any)
    expect(out.lines.join("\n")).toMatch(/could not determine/i)
    expect(out.lines.join("\n")).not.toMatch(/no page/i)
  })
})
