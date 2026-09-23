import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync } from "fs"
import { tmpdir } from "os"
import path from "path"
import { Artifacts } from "./artifacts"
import { htmlToPageContent, pageUrl, publishArtifact, slugify, validSlug } from "./artifact-publish"

// Artifact → page (→ site). One page per artifact, the scope asked every time.

const S = "ses_pub1"
const root = () => mkdtempSync(path.join(tmpdir(), "iris-publish-"))
const PAGE =
  "<!doctype html><html><head><title>All Hallows</title><style>h1{color:purple}</style></head><body><h1>Hi</h1></body></html>"

type Call = { url: string; method: string; body: any }
let calls: Call[] = []
let replies: Array<(c: Call) => Response> = []
const realFetch = globalThis.fetch
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })

beforeEach(() => {
  calls = []
  replies = []
  process.env.IRIS_API_KEY = "test-token"
  process.env.IRIS_USER_ID = "193"
  globalThis.fetch = (async (url: any, init?: any) => {
    const c = { url: String(url), method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : undefined }
    calls.push(c)
    if (c.url.includes("/cache/purge-page")) return json(200, {})
    const next = replies.shift()
    return next ? next(c) : json(500, { message: "unexpected call" })
  }) as typeof fetch
})
afterEach(() => {
  globalThis.fetch = realFetch
})

describe("publishArtifact", () => {
  test("the scope is required and sent as chosen — never defaulted to public", async () => {
    const r = root()
    const a = Artifacts.write(r, { session: S, title: "All Hallows", kind: "html", content: PAGE })
    const bad = await publishArtifact({
      rootDir: r,
      session: S,
      id: a.id,
      slug: "all-hallows",
      visibility: "" as any,
      requiresAuth: false,
    })
    expect(bad).toMatchObject({ ok: false, reason: "choose a scope" })
    expect(calls).toHaveLength(0)

    replies.push(() => json(201, { data: { id: 901, slug: "all-hallows", public_id: "pg_abc", status: "published" } }))
    const ok = await publishArtifact({
      rootDir: r,
      session: S,
      id: a.id,
      slug: "all-hallows",
      visibility: "unlisted",
      requiresAuth: true,
      bloqId: 628,
    })
    expect(ok.ok).toBe(true)
    const create = calls[0]
    expect(create.method).toBe("POST")
    expect(create.url).toEndWith("/api/v1/pages")
    expect(create.body).toMatchObject({
      owner_type: "bloq",
      owner_id: 628,
      slug: "all-hallows",
      visibility: "unlisted",
      requires_auth: true,
      auto_publish: true,
      json_content: { render_mode: "html", html: "<h1>Hi</h1>", css: "h1{color:purple}", requireOtp: true },
    })
    // Unlisted: only the id link resolves, so that is the link we hand back.
    expect(ok.published!.url).toEndWith("/p/pg_abc")
  })

  test("publishing again UPDATES the same page — no second copy on /p/", async () => {
    const r = root()
    const a = Artifacts.write(r, { session: S, title: "All Hallows", kind: "html", content: PAGE })
    replies.push(() => json(201, { data: { id: 901, slug: "all-hallows" } }))
    await publishArtifact({
      rootDir: r,
      session: S,
      id: a.id,
      slug: "all-hallows",
      visibility: "public",
      requiresAuth: false,
    })
    expect(Artifacts.read(r, S, a.id)!.meta.published).toMatchObject({ pageId: 901, revision: 1, visibility: "public" })

    // Edit it, then publish again.
    Artifacts.write(r, {
      session: S,
      id: a.id,
      title: "All Hallows",
      kind: "html",
      content: PAGE.replace("Hi", "Hello"),
    })
    expect(Artifacts.read(r, S, a.id)!.meta.published!.revision).toBe(1) // the page is behind
    calls = []
    replies.push(
      () => json(200, { data: { id: 901, slug: "all-hallows" } }),
      () => json(200, {}),
    )
    const again = await publishArtifact({
      rootDir: r,
      session: S,
      id: a.id,
      slug: "all-hallows",
      visibility: "public",
      requiresAuth: false,
    })
    expect(again.ok).toBe(true)
    const methods = calls.filter((c) => !c.url.includes("purge")).map((c) => `${c.method} ${new URL(c.url).pathname}`)
    expect(methods).toEqual(["PUT /api/v1/pages/901", "POST /api/v1/pages/901/publish"])
    expect(Artifacts.read(r, S, a.id)!.meta.published!.revision).toBe(2)
  })

  test("a taken address says so", async () => {
    const r = root()
    const a = Artifacts.write(r, { session: S, title: "x", kind: "html", content: PAGE })
    replies.push(() =>
      json(422, { message: "Validation failed", errors: { slug: ["The slug has already been taken."] } }),
    )
    const out = await publishArtifact({
      rootDir: r,
      session: S,
      id: a.id,
      slug: "home",
      visibility: "public",
      requiresAuth: false,
    })
    expect(out).toMatchObject({ ok: false, reason: "the address home is taken — pick another" })
    expect(Artifacts.read(r, S, a.id)!.meta.published).toBeUndefined()
  })

  test("markdown needs the panel's rendering; csv and code are refused, with no network call", async () => {
    const r = root()
    const md = Artifacts.write(r, { session: S, title: "Brief", kind: "markdown", content: "# Brief" })
    const csv = Artifacts.write(r, { session: S, title: "Table", kind: "csv", content: "a,b" })
    expect(
      (
        await publishArtifact({
          rootDir: r,
          session: S,
          id: md.id,
          slug: "brief",
          visibility: "private",
          requiresAuth: false,
        })
      ).ok,
    ).toBe(false)
    expect(
      (
        await publishArtifact({
          rootDir: r,
          session: S,
          id: csv.id,
          slug: "table",
          visibility: "private",
          requiresAuth: false,
        })
      ).reason,
    ).toContain("csv")
    expect(calls).toHaveLength(0)
  })
})

test("the store keeps itself out of git", () => {
  const r = root()
  Artifacts.write(r, { session: S, title: "x", kind: "html", content: PAGE })
  expect(existsSync(path.join(r, ".gitignore"))).toBe(true)
  expect(readFileSync(path.join(r, ".gitignore"), "utf8")).toContain("\n*\n")
})

test("slugs", () => {
  expect(slugify("All Hallows — Landing Page!")).toBe("all-hallows-landing-page")
  expect(slugify("😀")).toBe("artifact")
  expect(validSlug("all-hallows")).toBe(true)
  expect(validSlug("All Hallows")).toBe(false)
  expect(validSlug("../etc")).toBe(false)
})

test("html → standalone page fields", () => {
  const c = htmlToPageContent(PAGE, false)
  expect(c.title).toBe("All Hallows")
  expect(c.json_content).toEqual({
    version: "2.0",
    type: "article",
    render_mode: "html",
    html: "<h1>Hi</h1>",
    css: "h1{color:purple}",
    requireOtp: false,
  })
  expect(pageUrl({ slug: "x", public_id: "pg_1" }, "public")).toEndWith("/p/x")
})
