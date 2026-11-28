// A device that has never opened a project for a server starts with the folders its chats are in
// (#194511). Found on the first iPhone connection: all 63 of Alex's chats were in
// /Users/siralexmayo/Documents/Work, which IRIS Desktop had open and the phone did not, so the
// phone's sidebar said "Nothing here yet" while the engine was returning every chat.
import { describe, expect, test } from "bun:test"
import { seedDirectories, shouldSeedProjects } from "./seed-projects"

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

describe("shouldSeedProjects", () => {
  test("only an empty list that the person did not empty themselves", () => {
    expect(shouldSeedProjects({ projects: 0, recentlyClosed: 0 })).toBe(true)
    expect(shouldSeedProjects({ projects: 1, recentlyClosed: 0 })).toBe(false)
    expect(shouldSeedProjects({ projects: 0, recentlyClosed: 2 })).toBe(false)
  })
})
