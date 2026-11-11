import { describe, expect, test } from "bun:test"
import {
  answerConfirm,
  askedSite,
  confirmAct,
  grantSite,
  handBack,
  hostOf,
  isGranted,
  originOf,
  pageRefusal,
  parseGrants,
  revokeSite,
  stripState,
  takeOver,
  takenOverSites,
} from "./browser-grants"

describe("originOf", () => {
  test("web pages have an origin; nothing else does", () => {
    expect(originOf("https://www.youtube.com/watch?v=x")).toBe("https://www.youtube.com")
    expect(originOf("http://localhost:8765/a.html")).toBe("http://localhost:8765")
    expect(originOf("about:blank")).toBeUndefined()
    expect(originOf("tauri://localhost/")).toBeUndefined()
    expect(originOf(undefined)).toBeUndefined()
  })
  test("hostOf drops www", () => {
    expect(hostOf("https://www.youtube.com")).toBe("youtube.com")
  })
})

describe("parseGrants", () => {
  test("v1 grants (read-only build) come back READ-ONLY, never clickable", () => {
    expect(parseGrants(null, '["https://x.com","tauri://localhost",3]')).toEqual([{ origin: "https://x.com", act: false }])
  })
  test("v2 keeps act, and v2 wins over v1 for the same site", () => {
    expect(parseGrants('[{"origin":"https://x.com","act":true}]', '["https://x.com"]')).toEqual([
      { origin: "https://x.com", act: true },
    ])
  })
  test("junk is dropped", () => {
    expect(parseGrants("{", "nope")).toEqual([])
  })
})

describe("pageRefusal", () => {
  const grants = [
    { origin: "https://www.youtube.com", act: false },
    { origin: "https://www.airbnb.com", act: true },
  ]
  test("read on a read site: yes", () => {
    expect(pageRefusal({ mode: "read", url: "https://www.youtube.com/feed", grants })).toBeUndefined()
  })
  test("act on a READ-only site: refused, and says how to allow clicking", () => {
    const why = pageRefusal({ mode: "act", url: "https://www.youtube.com/feed", grants })
    expect(why).toContain("READ youtube.com")
    expect(why).toContain("Allow clicking")
  })
  test("act on an act site: yes", () => {
    expect(pageRefusal({ mode: "act", url: "https://www.airbnb.com/s/Tokyo", grants })).toBeUndefined()
  })
  test("Take over stops acting but not reading", () => {
    const takenOver = ["https://www.airbnb.com"]
    expect(pageRefusal({ mode: "act", url: "https://www.airbnb.com/", grants, takenOver })).toContain("took over")
    expect(pageRefusal({ mode: "read", url: "https://www.airbnb.com/", grants, takenOver })).toBeUndefined()
  })
  test("a site never granted, and another subdomain, are refused", () => {
    expect(pageRefusal({ mode: "read", url: "https://x.com/home", grants })).toContain("Let IRIS use this page")
    expect(pageRefusal({ mode: "read", url: "https://studio.youtube.com/", grants })).toBeDefined()
  })
  test("no page open", () => {
    expect(pageRefusal({ mode: "read", url: "about:blank", grants })).toContain("no web page")
  })
})

describe("the person's controls", () => {
  const o = "https://example.com"
  test("allow, allow clicking, then Stop revokes both", () => {
    grantSite(o)
    expect(isGranted(o, "read")).toBe(true)
    expect(isGranted(o, "act")).toBe(false)
    grantSite(o, true)
    expect(isGranted(o, "act")).toBe(true)
    grantSite(o) // a later plain Allow never removes clicking
    expect(isGranted(o, "act")).toBe(true)
    revokeSite(o)
    expect(isGranted(o, "read")).toBe(false)
  })
  test("take over and hand back", () => {
    takeOver(o)
    expect(takenOverSites()).toContain(o)
    handBack(o)
    expect(takenOverSites()).not.toContain(o)
  })
  test("an irreversible click waits for the person: Allow once → true", async () => {
    const p = confirmAct(o, "Book")
    expect(askedSite()).toMatchObject({ kind: "confirm", label: "Book" })
    answerConfirm(true)
    expect(await p).toBe(true)
    expect(askedSite()).toBeUndefined()
  })
  test("Deny, Stop, or silence is a no", async () => {
    const denied = confirmAct(o, "Pay")
    answerConfirm(false)
    expect(await denied).toBe(false)
    const stopped = confirmAct(o, "Send")
    revokeSite(o)
    expect(await stopped).toBe(false)
    expect(await confirmAct(o, "Delete", 20)).toBe(false)
  })
})

describe("stripState: most urgent first", () => {
  const o = "https://www.airbnb.com"
  const read = [{ origin: o, act: false }]
  const act = [{ origin: o, act: true }]
  const now = Date.now()
  test("nothing allowed → off; another page's ask is not this page's", () => {
    expect(stripState({ origin: o, grants: [] })).toBe("off")
    expect(stripState({ origin: o, grants: [], asked: { origin: "https://x.com", kind: "read" } })).toBe("off")
  })
  test("a refused read or act offers the missing permission", () => {
    expect(stripState({ origin: o, grants: [], asked: { origin: o, kind: "read" } })).toBe("ask-read")
    expect(stripState({ origin: o, grants: read, asked: { origin: o, kind: "act" } })).toBe("ask-act")
  })
  test("a pending Allow once outranks everything, even take-over", () => {
    expect(
      stripState({ origin: o, grants: act, takenOver: [o], asked: { origin: o, kind: "confirm", label: "Book", resolve: () => {} } }),
    ).toBe("confirm")
  })
  test("take-over outranks the agent's activity", () => {
    expect(stripState({ origin: o, grants: act, takenOver: [o], activity: { origin: o, doing: "x", mode: "act", at: now } })).toBe(
      "taken",
    )
  })
  test("acting vs reading vs idle", () => {
    expect(stripState({ origin: o, grants: act, activity: { origin: o, doing: "clicking", mode: "act", at: now } })).toBe("acting")
    expect(stripState({ origin: o, grants: read, activity: { origin: o, doing: "reading", mode: "read", at: now } })).toBe("reading")
    expect(stripState({ origin: o, grants: act })).toBe("can-act")
    expect(stripState({ origin: o, grants: read })).toBe("can-read")
  })
  test("no page → no strip", () => {
    expect(stripState({ origin: undefined, grants: act })).toBeUndefined()
  })
})
