import { describe, expect, test } from "bun:test"
import {
  publishGate, scriptReach, publishFailure, publishBody, parseScriptRef, scriptTags,
  runsOnLabel, splitAuthorRef, resolveRunTarget, sharedRunCommand, ambiguousMessage, sharedRunLine, shellArg,
  type SharedScript,
} from "./platform-scripts"

/**
 * `iris scripts publish` / `unpublish` — the rules, tested as pure functions (house pattern:
 * the yargs handler is thin; what it decides is here).
 *
 * Mirrors `iris playbook publish`: a PUBLIC publish is the irreversible direction, so it needs
 * consent — a prompt at a terminal, `--force` without one. Unlisted and unpublish only ever
 * narrow or keep reach bounded, and ask nothing.
 */
describe("publishGate — consent follows the direction of the change", () => {
  test("public at a terminal asks", () => {
    expect(publishGate({ scope: "public", force: false, interactive: true })).toBe("ask")
  })

  test("public with --force goes, terminal or not", () => {
    expect(publishGate({ scope: "public", force: true, interactive: false })).toBe("go")
    expect(publishGate({ scope: "public", force: true, interactive: true })).toBe("go")
  })

  // The case this gate exists for: an agent or a CI job with no terminal must not be able to
  // make a script public by omission. It is REFUSED, not silently allowed.
  test("public with no terminal and no --force is refused", () => {
    expect(publishGate({ scope: "public", force: false, interactive: false })).toBe("refuse")
  })

  test("unlisted needs no consent — it appears in no listing", () => {
    expect(publishGate({ scope: "unlisted", force: false, interactive: false })).toBe("go")
  })
})

describe("scriptReach — says who can open it, in words", () => {
  test("each visibility names its audience", () => {
    expect(scriptReach("public")).toContain("marketplace")
    expect(scriptReach("unlisted")).toContain("link")
    expect(scriptReach("private")).toContain("Only you")
  })

  // An unrecognised value is reported as the narrowest reading would be dangerous: the server
  // treats anything unrecognised as private, and so does this — never as public.
  test("an unknown visibility reads as private, never as public", () => {
    expect(scriptReach("")).toContain("Only you")
    expect(scriptReach("weird")).toContain("Only you")
  })
})

describe("publishFailure — a refusal names its cause", () => {
  test("404 says the script does not exist rather than 'failed'", () => {
    expect(publishFailure(404, {}, "photo-resize")).toContain("No script named 'photo-resize'")
  })

  test("422 carries the manifest errors the server refused it for", () => {
    const msg = publishFailure(422, {
      error: "This script has manifest errors and cannot be published.",
      errors: ["arg=fixture: required and default together"],
    }, "x")
    expect(msg).toContain("manifest errors")
    expect(msg).toContain("required and default together")
  })

  test("anything else keeps the status so it can be reported", () => {
    expect(publishFailure(500, { message: "Server Error" }, "x")).toContain("500")
  })
})


// #191674 — playbook-style scoping for scripts.
describe("publishBody — project needs a board", () => {
  test("project with no --bloq is refused before any request", () => {
    expect(publishBody("project", [])).toEqual({ error: "--bloq <id> is required when --scope project" })
  })

  test("project with repeated --bloq sends every board once", () => {
    expect(publishBody("project", [12, "40", 12])).toEqual({ body: { visibility: "project", bloq_ids: [12, 40] } })
  })

  test("a non-numeric --bloq is refused", () => {
    expect("error" in publishBody("project", ["abc"])).toBe(true)
  })

  test("unlisted/public without --bloq send visibility alone, as before", () => {
    expect(publishBody("unlisted", [])).toEqual({ body: { visibility: "unlisted" } })
  })

  test("project needs no consent prompt — a board's members are a bounded audience", () => {
    expect(publishGate({ scope: "project", force: false, interactive: false })).toBe("go")
  })

  test("project reach names its boards", () => {
    expect(scriptReach("project", [12, 40])).toContain("boards #12, #40")
  })
})

describe("parseScriptRef — only a plain slug of mine is hashed locally", () => {
  const uuid = "3f2a1c9e-8b7d-4e6f-9a0b-1c2d3e4f5a6b"

  test("plain slug", () => {
    expect(parseScriptRef("photo-resize")).toMatchObject({ ref: "photo-resize", plainSlug: true, uuid: false, version: null })
  })

  test("slug@3 is pinned — the server hashes it", () => {
    expect(parseScriptRef("photo-resize@3")).toMatchObject({ ref: "photo-resize@3", base: "photo-resize", version: "3", plainSlug: false })
  })

  test("uuid and uuid@3 are someone else's script", () => {
    expect(parseScriptRef(uuid)).toMatchObject({ uuid: true, plainSlug: false, version: null })
    expect(parseScriptRef(`${uuid}@3`)).toMatchObject({ ref: `${uuid}@3`, uuid: true, version: "3", plainSlug: false })
  })
})

describe("scriptTags — version, visibility, audience, routing on one line", () => {
  test("all fields", () => {
    expect(scriptTags({ version: 3, visibility: "project", bloq_ids: [12], runs_on: "capability:gpu" }))
      .toBe("v3 · project · board #12 · runs-on capability:gpu")
  })

  test("an older API row with none of them prints nothing extra", () => {
    expect(scriptTags({})).toBe("")
  })
})

// The API returns runs_on PARSED — `{ kind, node?, capability? }` — and it printed as
// "runs-on [object Object]" in every listing.
describe("runsOnLabel — runs-on as its author wrote it", () => {
  test("each parsed kind", () => {
    expect(runsOnLabel({ kind: "any" })).toBe("any")
    expect(runsOnLabel({ kind: "node", node: "studio-mac" })).toBe("studio-mac")
    expect(runsOnLabel({ kind: "capability", capability: "gpu" })).toBe("capability:gpu")
  })

  test("absent or unreadable prints nothing", () => {
    expect(runsOnLabel(null)).toBe("")
    expect(runsOnLabel({ kind: "weird" })).toBe("")
  })

  test("scriptTags uses it for the API's object form", () => {
    expect(scriptTags({ version: 2, runs_on: { kind: "node", node: "iris-hive-001" } })).toBe("v2 · runs-on iris-hive-001")
  })
})

describe("splitAuthorRef — author/slug and --from", () => {
  test("author/slug and author/slug@2", () => {
    expect(splitAuthorRef("ana/photo-resize")).toEqual({ author: "ana", ref: "photo-resize" })
    expect(splitAuthorRef("Ana Ruiz/photo-resize@2")).toEqual({ author: "Ana Ruiz", ref: "photo-resize@2" })
  })

  test("--from names the author when the ref has none; a / in the ref wins", () => {
    expect(splitAuthorRef("photo-resize", "Ana")).toEqual({ author: "Ana", ref: "photo-resize" })
    expect(splitAuthorRef("bob/photo-resize", "Ana")).toEqual({ author: "bob", ref: "photo-resize" })
  })

  test("a plain slug has no author", () => {
    expect(splitAuthorRef("photo-resize")).toEqual({ author: null, ref: "photo-resize" })
    expect(splitAuthorRef("photo-resize", "  ")).toEqual({ author: null, ref: "photo-resize" })
  })
})

describe("resolveRunTarget — a slug shared with me runs without its uuid", () => {
  const ana: SharedScript = { id: "aaaaaaaa-0000-4000-8000-000000000001", slug: "photo-resize", name: "Photo Resize", version: 3, author_name: "Ana Ruiz" }
  const bob: SharedScript = { id: "bbbbbbbb-0000-4000-8000-000000000002", slug: "photo-resize", name: "Photo Resize", version: 1, author_name: "bob" }
  const other: SharedScript = { id: "cccccccc-0000-4000-8000-000000000003", slug: "inbox-scan", version: 1, author_name: "bob" }
  const r = (x: string) => parseScriptRef(x)

  test("MINE FIRST — my own slug is never swapped for a teammate's", () => {
    expect(resolveRunTarget({ ref: r("photo-resize"), author: null, mine: true, shared: [ana] })).toEqual({ kind: "as-is" })
  })

  test("an unknown 'mine' (lookup failed) is not evidence — sent as-is", () => {
    expect(resolveRunTarget({ ref: r("photo-resize"), author: null, mine: null, shared: [ana] })).toEqual({ kind: "as-is" })
  })

  test("not mine, exactly one shared → its id", () => {
    expect(resolveRunTarget({ ref: r("photo-resize"), author: null, mine: false, shared: [ana, other] }))
      .toEqual({ kind: "shared", row: ana, ref: ana.id! })
  })

  test("a pinned version carries over to the id", () => {
    expect(resolveRunTarget({ ref: r("photo-resize@2"), author: null, mine: false, shared: [ana] }))
      .toEqual({ kind: "shared", row: ana, ref: `${ana.id}@2` })
  })

  test("several people shared it → ambiguous, never a guess", () => {
    expect(resolveRunTarget({ ref: r("photo-resize"), author: null, mine: false, shared: [ana, bob] }))
      .toEqual({ kind: "ambiguous", rows: [ana, bob] })
  })

  test("the author picks one, case-insensitively — even when I have the same slug", () => {
    expect(resolveRunTarget({ ref: r("photo-resize"), author: "ana ruiz", mine: null, shared: [ana, bob] }))
      .toEqual({ kind: "shared", row: ana, ref: ana.id! })
  })

  test("a named author who shared nothing by that slug is refused, not run as mine", () => {
    expect(resolveRunTarget({ ref: r("photo-resize"), author: "carol", mine: null, shared: [ana, bob] }))
      .toEqual({ kind: "not-shared-by", author: "carol" })
  })

  test("found nowhere → as-is (the server's 'not found' is the answer, as before)", () => {
    expect(resolveRunTarget({ ref: r("nope"), author: null, mine: false, shared: [ana] })).toEqual({ kind: "as-is" })
  })

  test("a uuid is never re-resolved", () => {
    expect(resolveRunTarget({ ref: r(ana.id!), author: null, mine: false, shared: [ana] })).toEqual({ kind: "as-is" })
  })

  test("sharedRunLine says whose code is about to run", () => {
    expect(sharedRunLine(ana, null)).toBe("running Ana Ruiz's Photo Resize v3")
    expect(sharedRunLine(ana, "2")).toBe("running Ana Ruiz's Photo Resize v2")
  })
})

describe("sharedRunCommand — the copyable command in list --shared", () => {
  const ana: SharedScript = { id: "aaaaaaaa-0000-4000-8000-000000000001", slug: "photo-resize", version: 3, author_name: "Ana Ruiz" }
  const bob: SharedScript = { id: "bbbbbbbb-0000-4000-8000-000000000002", slug: "photo-resize", version: 1, author_name: "bob" }
  const bob2: SharedScript = { id: "dddddddd-0000-4000-8000-000000000004", slug: "photo-resize", version: 1, author_name: "Bob" }

  test("unambiguous slug, not one of mine → the bare slug", () => {
    expect(sharedRunCommand(ana, [ana], new Set(["inbox-scan"]))).toBe("iris scripts run photo-resize")
  })

  test("I have a script with that slug → author/slug, so mine is not run instead", () => {
    expect(sharedRunCommand(ana, [ana], new Set(["photo-resize"]))).toBe('iris scripts run "Ana Ruiz/photo-resize"')
  })

  test("my slugs unknown → never the bare slug", () => {
    expect(sharedRunCommand(bob, [bob], null)).toBe("iris scripts run bob/photo-resize")
  })

  test("two sharers → each by author", () => {
    expect(sharedRunCommand(bob, [ana, bob], new Set())).toBe("iris scripts run bob/photo-resize")
  })

  test("two authors whose names match case-insensitively → the uuid", () => {
    expect(sharedRunCommand(bob, [bob, bob2], new Set())).toBe(`iris scripts run ${bob.id}`)
  })

  test("ambiguousMessage lists each author and the --from form", () => {
    const msg = ambiguousMessage("photo-resize", [ana, bob])
    expect(msg).toContain("2 people shared a script called 'photo-resize'")
    expect(msg).toContain('iris scripts run "Ana Ruiz/photo-resize"')
    expect(msg).toContain("(bob · v1)")
    expect(msg).toContain("--from <author>")
  })

  test("shellArg quotes only what a shell would split or expand", () => {
    expect(shellArg("bob/photo-resize")).toBe("bob/photo-resize")
    expect(shellArg('A "B" $C')).toBe('"A \\"B\\" \\$C"')
  })
})
