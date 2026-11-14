import { afterEach, describe, expect, test } from "bun:test"
import {
  applyPinOp,
  boardMeta,
  boardsFrom,
  filterBoards,
  landingContent,
  needsSignIn,
  parsePins,
  PIN_MAX,
  refusalWords,
  retrySlug,
  slugify,
  slugTaken,
  type Pins,
} from "./marketing-core"
import { changePins, checkOwnPage, marketingDeps, readBoards, readPins } from "./platform-marketing"

// #193357 — `iris marketing` must agree with Desktop › Marketing. These are the rules both sides share.

describe("boards: the ones you own or edit, with their list count", () => {
  const raw = [
    { id: 905, name: "IRIS Drives", is_owner: true, lists: [1, 2, 3, 4, 5] },
    { id: 40, name: " Client board ", is_owner: false, user_permission: "editor" },
    { id: 41, name: "Read only", is_owner: false, user_permission: "viewer" },
    { id: "x", name: "Broken", is_owner: true },
  ]
  test("viewers and broken rows are never offered", () => {
    expect(boardsFrom(raw)).toEqual([
      { id: 905, name: "IRIS Drives", role: "owner", lists: 5 },
      { id: 40, name: "Client board", role: "editor" },
    ])
  })
  test("filter by words in any order, or by id", () => {
    const b = boardsFrom(raw)
    expect(filterBoards(b, "drives iris").map((x) => x.id)).toEqual([905])
    expect(filterBoards(b, "905").map((x) => x.id)).toEqual([905])
    expect(filterBoards(b, "#40").map((x) => x.id)).toEqual([40])
    expect(filterBoards(b, "")).toEqual(b)
  })
  test("the meta line matches Desktop's", () => {
    expect(boardMeta({ id: 905, name: "x", role: "owner", lists: 5 })).toBe("#905 · 5 lists")
    expect(boardMeta({ id: 905, name: "x", role: "owner", lists: 1 })).toBe("#905 · 1 list")
    expect(boardMeta({ id: 905, name: "x", role: "owner" })).toBe("#905")
  })
})

describe("names and slugs: the same as Desktop's marketing-create", () => {
  test("slugify", () => {
    expect(slugify("Acme Shoes — Spring!")).toBe("acme-shoes-spring")
    expect(slugify("Café Été")).toBe("cafe-ete")
    expect(slugify("!!!")).toBe("")
  })
  test("a taken slug: 409, or 422 naming the slug", () => {
    expect(slugTaken(409, "")).toBe(true)
    expect(slugTaken(422, '{"message":"The slug has already been taken."}')).toBe(true)
    expect(slugTaken(422, '{"message":"The title field is required."}')).toBe(false)
    expect(retrySlug("x".repeat(60), "ab12")).toHaveLength(59)
  })
  test("refusals carry no ids or HTTP codes", () => {
    for (const s of [401, 403, 404, 409, 422, 429, 500, 418]) expect(refusalWords(s, "landing")).not.toMatch(/\b\d{3}\b/)
  })
  test("the starting page is a hero and a footer", () => {
    expect(landingContent("spring", "Spring", 2026).components.map((c) => c.type)).toEqual(["Hero", "SiteFooter"])
  })
  test("sign-in when the page asks for one or isn't public", () => {
    expect(needsSignIn({ requires_auth: true })).toBe(true)
    expect(needsSignIn({ visibility: "unlisted" })).toBe(true)
    expect(needsSignIn({ visibility: "public" })).toBe(false)
  })
})

describe("pins: the same limits as fl-api AccountSettingKeys and Desktop", () => {
  const two: Pins = { pins: [{ slug: "a", label: "A" }, { slug: "b", label: "B" }], selected: "a" }
  test("a stored value is cleaned, never trusted", () => {
    expect(parsePins({ pins: [{ slug: "A" }, { slug: "a" }, { slug: "../x" }, { slug: "b", label: "  B  ", signIn: true }], selected: "zzz" })).toEqual({
      pins: [{ slug: "a", label: "a" }, { slug: "b", label: "B", signIn: true }],
    })
  })
  test("pin adds and selects; pinning again only selects", () => {
    const r = applyPinOp(two, { op: "pin", pin: { slug: "c", label: "C" } })
    expect(r).toMatchObject({ ok: true, changed: true, pins: { selected: "c" } })
    expect(applyPinOp(two, { op: "pin", pin: { slug: "b", label: "B" } })).toMatchObject({ ok: true, pins: { selected: "b", pins: two.pins } })
  })
  test("at the limit, pinning says so", () => {
    const full: Pins = { pins: Array.from({ length: PIN_MAX }, (_, i) => ({ slug: `p${i}`, label: `P${i}` })) }
    expect(applyPinOp(full, { op: "pin", pin: { slug: "new", label: "N" } })).toMatchObject({ ok: false })
  })
  test("unpin moves the selection to a neighbour; rename and move", () => {
    expect(applyPinOp(two, { op: "unpin", slug: "a" })).toMatchObject({ ok: true, pins: { pins: [{ slug: "b" }], selected: "b" } })
    expect(applyPinOp(two, { op: "rename", slug: "b", label: "  Bee  " })).toMatchObject({ ok: true, pins: { pins: [{ slug: "a" }, { label: "Bee" }] } })
    expect(applyPinOp(two, { op: "move", slug: "b", by: -1000 })).toMatchObject({ ok: true, pins: { pins: [{ slug: "b" }, { slug: "a" }] } })
    expect(applyPinOp(two, { op: "move", slug: "a", by: -1 })).toMatchObject({ ok: true, changed: false })
    expect(applyPinOp(two, { op: "unpin", slug: "zzz" })).toMatchObject({ ok: false })
  })
})

// ── the network paths, with the platform stubbed ──────────────────────────

const real = { ...marketingDeps }
afterEach(() => Object.assign(marketingDeps, real))
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
type Call = { path: string; method: string; body?: any }
function stub(answer: (c: Call, n: number) => Response) {
  const calls: Call[] = []
  marketingDeps.userId = async () => 31
  marketingDeps.fetch = async (path, init = {}) => {
    const c = { path, method: String(init.method ?? "GET"), body: init.body ? JSON.parse(String(init.body)) : undefined }
    calls.push(c)
    return answer(c, calls.length)
  }
  return calls
}

describe("pins on the account (fl-api /api/v1/me/settings/marketing.pins)", () => {
  test("before the server change is deployed, it says so — never an empty list", async () => {
    stub(() => json(404, { message: "Not Found" }))
    expect(await readPins()).toMatchObject({ ok: false, notDeployed: true })
  })
  test("a save carries the version it read", async () => {
    const calls = stub((c) =>
      c.method === "GET" ? json(200, { data: { value: { pins: [] }, version: 3 } }) : json(200, { data: { value: c.body.value, version: 4 } }),
    )
    const r = await changePins({ op: "pin", pin: { slug: "spring", label: "Spring" } })
    expect(r).toMatchObject({ ok: true, changed: true, pins: { pins: [{ slug: "spring" }] } })
    expect(calls[1]).toMatchObject({ method: "PUT", body: { version: 3, value: { pins: [{ slug: "spring", label: "Spring" }] } } })
  })
  test("someone else saved meanwhile (409): the same change is applied to theirs, once", async () => {
    const calls = stub((c, n) => {
      if (c.method === "GET") return json(200, { data: { value: { pins: [] }, version: 0 } })
      if (n === 2) return json(409, { current: { value: { pins: [{ slug: "theirs", label: "Theirs" }] }, version: 1 } })
      return json(200, { data: { value: c.body.value, version: 2 } })
    })
    const r = await changePins({ op: "pin", pin: { slug: "mine", label: "Mine" } })
    expect(r).toMatchObject({ ok: true, pins: { pins: [{ slug: "theirs" }, { slug: "mine" }] } })
    expect(calls[2].body.version).toBe(1)
  })
  test("a change that changes nothing sends nothing", async () => {
    const calls = stub(() => json(200, { data: { value: { pins: [{ slug: "a", label: "A" }] }, version: 1 } }))
    expect(await changePins({ op: "rename", slug: "a", label: "A" })).toMatchObject({ ok: true, changed: false })
    expect(calls.map((c) => c.method)).toEqual(["GET"])
  })
})

describe("own pages only", () => {
  test("the exact slug, never a search hit that merely contains it", async () => {
    stub(() => json(200, { data: { data: [{ slug: "spring-launch-2", title: "Other" }] } }))
    expect(await checkOwnPage("spring-launch")).toMatchObject({ ok: false })
    stub(() => json(200, { data: { data: [{ slug: "spring-launch", title: "Spring", visibility: "unlisted" }] } }))
    expect(await checkOwnPage("Spring-Launch")).toEqual({ ok: true, title: "Spring", signIn: true, status: "draft" })
  })
  test("a list that can't be read refuses", async () => {
    stub(() => json(500, {}))
    expect(await checkOwnPage("spring")).toMatchObject({ ok: false })
  })
})

describe("boards from the platform", () => {
  test("signed out, or unreadable, says so in words", async () => {
    stub(() => json(401, {}))
    expect(await readBoards()).toMatchObject({ ok: false, reason: expect.stringContaining("Sign in") })
    stub(() => json(200, { data: [{ id: 905, name: "IRIS Drives", is_owner: true, lists: [] }] }))
    expect(await readBoards()).toEqual({ ok: true, boards: [{ id: 905, name: "IRIS Drives", role: "owner", lists: 0 }] })
  })
})

import { pageUrl } from "./marketing-core"

describe("page addresses (#188508)", () => {
  test("IRIS never sends people to freelabel.net: pages are on heyiris.io", () => {
    expect(pageUrl("spring-launch")).toBe("https://heyiris.io/p/spring-launch")
    expect(pageUrl("Spring Launch")).toBe("https://heyiris.io/p/spring%20launch")
  })
})
