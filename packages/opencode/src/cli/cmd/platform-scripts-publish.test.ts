import { describe, expect, test } from "bun:test"
import { publishGate, scriptReach, publishFailure, publishBody, parseScriptRef, scriptTags } from "./platform-scripts"

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
