import { describe, expect, test } from "bun:test"
import { hostOf, originOf, pageRefusal, parseGrants } from "./browser-grants"

describe("originOf", () => {
  test("web pages have an origin; nothing else does", () => {
    expect(originOf("https://www.youtube.com/watch?v=x")).toBe("https://www.youtube.com")
    expect(originOf("http://localhost:8765/a.html")).toBe("http://localhost:8765")
    expect(originOf("about:blank")).toBeUndefined()
    expect(originOf("tauri://localhost/")).toBeUndefined()
    expect(originOf("not a url")).toBeUndefined()
    expect(originOf(undefined)).toBeUndefined()
  })
  test("hostOf drops www", () => {
    expect(hostOf("https://www.youtube.com")).toBe("youtube.com")
  })
})

test("parseGrants keeps only web origins, and survives junk", () => {
  expect(parseGrants('["https://x.com","tauri://localhost",3,"nope"]')).toEqual(["https://x.com"])
  expect(parseGrants("{")).toEqual([])
  expect(parseGrants(null)).toEqual([])
})

describe("pageRefusal: the app's check before the agent reads the pane", () => {
  const granted = ["https://www.youtube.com"]
  test("a granted site may be read", () => {
    expect(pageRefusal({ mode: "read", url: "https://www.youtube.com/feed", granted })).toBeUndefined()
  })
  test("a site that was never granted is refused, and says how to grant it", () => {
    const why = pageRefusal({ mode: "read", url: "https://x.com/home", granted })
    expect(why).toContain("x.com")
    expect(why).toContain("Let IRIS use this page")
  })
  test("the grant is per origin: another subdomain is another site", () => {
    expect(pageRefusal({ mode: "read", url: "https://studio.youtube.com/", granted })).toBeDefined()
  })
  test("acting is refused even on a granted site, until B2", () => {
    expect(pageRefusal({ mode: "act", url: "https://www.youtube.com/feed", granted })).toContain("can only read")
  })
  test("no page open", () => {
    expect(pageRefusal({ mode: "read", url: "about:blank", granted })).toContain("no web page")
  })
})
