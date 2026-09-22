import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Artifacts } from "./artifacts"

// Epic #186508 — the artifact store behind the desktop's Artifacts tab.

const root = () => mkdtempSync(path.join(tmpdir(), "iris-artifacts-"))
const S = "ses_abc123"

describe("Artifacts.rootFor", () => {
  test("project when the session has one, the home folder when it does not", () => {
    expect(Artifacts.rootFor("/work/app", "/Users/x")).toEqual({ dir: "/work/app/.iris/artifacts", root: "project" })
    expect(Artifacts.rootFor(undefined, "/Users/x")).toEqual({ dir: "/Users/x/.iris/artifacts", root: "user" })
  })
})

describe("Artifacts.write / read / list", () => {
  test("create, then update: same id, revision 2, content replaced, created kept", () => {
    const r = root()
    const a = Artifacts.write(
      r,
      { session: S, title: "Landing", kind: "html", content: "<h1>v1</h1>" },
      new Date("2026-09-22T00:00:00Z"),
    )
    expect(a.revision).toBe(1)
    const b = Artifacts.write(
      r,
      { session: S, id: a.id, title: "Landing", kind: "html", content: "<h1>v2</h1>" },
      new Date("2026-09-22T00:01:00Z"),
    )
    expect(b).toMatchObject({ id: a.id, revision: 2, created: a.created, updated: "2026-09-22T00:01:00.000Z" })
    expect(Artifacts.read(r, S, a.id)).toMatchObject({
      content: "<h1>v2</h1>",
      truncated: false,
      meta: { revision: 2 },
    })
    // no temp files left behind by the atomic writes
    expect(readdirSync(path.join(r, S, a.id)).sort()).toEqual(["content.html", "meta.json"])
  })

  test("list is newest first and scoped to the session", () => {
    const r = root()
    Artifacts.write(
      r,
      { session: S, id: "old", title: "Old", kind: "markdown", content: "# old" },
      new Date("2026-09-20T00:00:00Z"),
    )
    Artifacts.write(
      r,
      { session: S, id: "new", title: "New", kind: "csv", content: "a,b" },
      new Date("2026-09-22T00:00:00Z"),
    )
    Artifacts.write(r, { session: "ses_other", id: "elsewhere", title: "X", kind: "html", content: "x" })
    expect(Artifacts.list(r, S).map((m) => m.id)).toEqual(["new", "old"])
  })

  test("an empty or missing session is [] — not an error", () => {
    expect(Artifacts.list(root(), S)).toEqual([])
    expect(Artifacts.read(root(), S, "nope")).toBeUndefined()
  })

  test("changing kind changes the file, so the extension never lies", () => {
    const r = root()
    const a = Artifacts.write(r, { session: S, title: "t", kind: "html", content: "<p>" })
    const b = Artifacts.write(r, { session: S, id: a.id, title: "t", kind: "markdown", content: "# md" })
    expect(b.filename).toBe("content.md")
    expect(Artifacts.read(r, S, a.id)?.content).toBe("# md")
  })

  test("oversized content is truncated and says so", () => {
    const r = root()
    const big = "x".repeat(Artifacts.MAX_CONTENT_BYTES + 10)
    const a = Artifacts.write(r, { session: S, title: "big", kind: "code", content: big })
    const got = Artifacts.read(r, S, a.id)!
    expect(got.truncated).toBe(true)
    expect(got.content.length).toBe(Artifacts.MAX_CONTENT_BYTES)
  })
})

describe("Artifacts — nothing climbs out of the store", () => {
  test("session and id are single path segments", () => {
    for (const bad of ["..", "../x", "a/b", "a.b", "", ".hidden", "x".repeat(81)]) {
      expect(Artifacts.validSegment(bad)).toBe(false)
      expect(Artifacts.list(root(), bad)).toEqual([])
      expect(Artifacts.read(root(), S, bad)).toBeUndefined()
      expect(() => Artifacts.write(root(), { session: bad, title: "t", kind: "html", content: "x" })).toThrow()
    }
  })

  test("a meta.json whose filename points outside its folder is ignored, not followed", () => {
    const r = root()
    const dir = path.join(r, S, "evil")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(r, "secret.txt"), "TOKEN")
    for (const filename of ["../../secret.txt", "/etc/hosts", ".env"]) {
      writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: "evil", kind: "html", filename, revision: 1 }))
      expect(Artifacts.read(r, S, "evil")).toBeUndefined()
      expect(Artifacts.list(r, S)).toEqual([])
    }
  })

  test("a folder whose meta claims another id is ignored", () => {
    const r = root()
    const dir = path.join(r, S, "one")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "content.html"), "x")
    writeFileSync(path.join(dir, "meta.json"), JSON.stringify({ id: "two", kind: "html", filename: "content.html" }))
    expect(Artifacts.list(r, S)).toEqual([])
    expect(Artifacts.read(r, S, "one")).toBeUndefined()
  })
})

// #186510 — the SHARED pane: several agents write one session's artifacts.
describe("Artifacts — several writers", () => {
  const build = { agent: "build", session: "ses_parent1" }
  const researcher = { agent: "researcher", session: "ses_child22" }

  test("every revision records its author; createdBy stays the first writer", () => {
    const r = root()
    const a = Artifacts.write(r, { session: S, title: "Brief", kind: "markdown", content: "# v1", author: build })
    const b = Artifacts.write(r, {
      session: S,
      id: a.id,
      title: "Brief",
      kind: "markdown",
      content: "# v2",
      author: researcher,
    })
    expect(b).toMatchObject({ revision: 2, author: researcher, createdBy: build })
    // …and it survives a round trip through disk, which is what the pane actually reads.
    expect(Artifacts.list(r, S)[0]).toMatchObject({ author: researcher, createdBy: build })
    expect(Artifacts.read(r, S, a.id)!.meta.author).toEqual(researcher)
  })

  test("a write based on a stale revision is refused, and names who moved it", () => {
    const r = root()
    const a = Artifacts.write(r, { session: S, title: "Table", kind: "csv", content: "a\n1", author: build })
    // Both agents read revision 1. The researcher writes first…
    Artifacts.write(r, {
      session: S,
      id: a.id,
      title: "Table",
      kind: "csv",
      content: "a\n2",
      author: researcher,
      baseRevision: 1,
    })
    // …so build's edit, also based on 1, must not erase it.
    let err: unknown
    try {
      Artifacts.write(r, {
        session: S,
        id: a.id,
        title: "Table",
        kind: "csv",
        content: "a\n3",
        author: build,
        baseRevision: 1,
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(Artifacts.Conflict)
    expect((err as Error).message).toContain("revision 2")
    expect((err as Error).message).toContain("researcher")
    expect(Artifacts.read(r, S, a.id)!.content).toBe("a\n2")
  })

  test("baseRevision 0 means 'must not exist yet'", () => {
    const r = root()
    const a = Artifacts.write(r, {
      session: S,
      id: "fixed-id",
      title: "x",
      kind: "code",
      content: "1",
      baseRevision: 0,
    })
    expect(a.revision).toBe(1)
    expect(() =>
      Artifacts.write(r, { session: S, id: "fixed-id", title: "x", kind: "code", content: "2", baseRevision: 0 }),
    ).toThrow(Artifacts.Conflict)
  })

  test("an author read from disk is sanitised, not trusted", () => {
    const r = root()
    const dir = path.join(r, S, "hand1")
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, "content.md"), "x")
    writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({
        id: "hand1",
        kind: "markdown",
        filename: "content.md",
        author: { agent: "a".repeat(500), session: "../../etc" },
      }),
    )
    const m = Artifacts.list(r, S)[0]
    expect(m.author!.agent.length).toBe(80)
    expect(m.author!.session).toBeUndefined()
  })
})
