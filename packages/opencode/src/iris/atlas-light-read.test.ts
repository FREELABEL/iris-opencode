import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import * as platform from "./platform"

// #190231 phase 0d: the board is read WITHOUT bodies (light=1) — 0.6 MB instead of 2.1 MB on
// board 174, over the user's own connection — and a list row's second line comes from fl-api's
// summary.preview. Only search reads bodies. An fl-api without previews must never leave rows
// blank, and must not cost two reads on every open either.

const item = (id: number, extra: Record<string, unknown> = {}) => ({ id, title: `t${id}`, ...extra })
const board = (items: any[]) => ({ data: { lists: [{ id: 1, name: "L", items }] } })

describe("fetchAtlas reads the board without bodies", () => {
  const spies: { mockRestore(): void }[] = []
  let asked: string[] = []
  let previews = true

  beforeEach(() => {
    asked = []
    previews = true
    platform.resetRecentBloqs()
    platform.resetPreviewSupport()
    spies.push(spyOn(platform, "resolveUserId").mockResolvedValue(7))
    spies.push(
      spyOn(platform, "irisFetch").mockImplementation((async (p: string) => {
        if (p.includes("/bloqs?simplified=true")) return Response.json({ data: [{ id: 42, name: "b" }] })
        const q = p.split("?")[1] ?? ""
        asked.push(q)
        if (q.includes("light=1"))
          return Response.json(
            board([item(1, { summary: previews ? { preview: "the start of the body", labels: [] } : { labels: [] } })]),
          )
        return Response.json(board([item(1, { content: "the whole body", summary: { labels: [] } })]))
      }) as any),
    )
  })
  afterEach(() => {
    while (spies.length) spies.pop()!.mockRestore()
  })

  test("by default: one light read, and each row carries its preview, not a body", async () => {
    const r = await platform.fetchAtlas(42)
    expect(asked).toEqual(["light=1&summary=1"])
    const it = r.data.lists[0].items![0]
    expect(it.preview).toBe("the start of the body")
    expect(it.content).toBeUndefined()
  })

  test("search asks for bodies, because a search matches the body", async () => {
    const r = await platform.fetchAtlas(42, { bodies: true })
    expect(asked).toEqual(["no_searchable_content=1&summary=1"])
    expect(r.data.lists[0].items![0].content).toBe("the whole body")
  })

  test("an fl-api without previews: the board is read again with bodies, so no row goes blank", async () => {
    previews = false
    const r = await platform.fetchAtlas(42)
    expect(asked).toEqual(["light=1&summary=1", "no_searchable_content=1&summary=1"])
    expect(r.data.lists[0].items![0].content).toBe("the whole body")
  })

  test("…and the next opens skip the light read instead of paying for both", async () => {
    previews = false
    await platform.fetchAtlas(42)
    asked = []
    await platform.fetchAtlas(42)
    expect(asked).toEqual(["no_searchable_content=1&summary=1"])
  })

  test("an empty preview is a real answer, not a missing one", () => {
    expect(platform.lightReadUsable(board([item(1, { summary: { preview: "" } })]).data)).toBe(true)
    expect(platform.lightReadUsable(board([item(1, { summary: {} })]).data)).toBe(false)
    expect(platform.lightReadUsable(board([]).data)).toBe(true)
  })
})
