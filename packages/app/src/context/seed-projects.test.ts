// A device that has never opened a project for a server starts with the folders its chats are in
// (#194511). Found on the first iPhone connection: all 63 of Alex's chats were in
// /Users/siralexmayo/Documents/Work, which IRIS Desktop had open and the phone did not, so the
// phone's sidebar said "Nothing here yet" while the engine was returning every chat.
import { describe, expect, test } from "bun:test"
import { missingSeeds, seedDirectories } from "./seed-projects"

const session = (directory: string | undefined, updated: number) => ({ location: { directory }, time: { created: updated - 10, updated } })

describe("seedDirectories", () => {
  test("the folders of the most recent chats, newest first, each once", () => {
    expect(
      seedDirectories([session("/a", 1), session("/b", 5), session("/a", 9), session("/c", 3)]),
    ).toEqual(["/a", "/b", "/c"])
  })

  test("Alex's real shape: 63 chats in one folder → one project", () => {
    const work = "/Users/siralexmayo/Documents/Work"
    expect(seedDirectories(Array.from({ length: 63 }, (_, i) => session(work, i)))).toEqual([work])
  })

  test("at most five, and never the filesystem root or a chat with no folder", () => {
    const many = ["/1", "/2", "/3", "/4", "/5", "/6", "/7"].map((d, i) => session(d, 100 - i))
    expect(seedDirectories([...many, session("/", 999), session(undefined, 998)])).toEqual(["/1", "/2", "/3", "/4", "/5"])
  })

  test("created time is used when a chat was never updated", () => {
    expect(seedDirectories([{ location: { directory: "/old" }, time: { created: 1 } }, { location: { directory: "/new" }, time: { created: 2 } }])).toEqual(["/new", "/old"])
  })
})

describe("missingSeeds", () => {
  test("adds the recent folders that are not listed yet — even when some project already is (build 28: 'Desktop' blocked 'Work')", () => {
    expect(missingSeeds(["/Users/me/Documents/Work", "/Users/me/Desktop"], { listed: ["/Users/me/Desktop"], closed: [] })).toEqual(["/Users/me/Documents/Work"])
  })

  test("never re-adds a folder the person closed on this device", () => {
    expect(missingSeeds(["/a", "/b"], { listed: [], closed: ["/a"] })).toEqual(["/b"])
  })

  test("nothing to add when everything is already listed", () => {
    expect(missingSeeds(["/a"], { listed: ["/a"], closed: [] })).toEqual([])
  })
})
