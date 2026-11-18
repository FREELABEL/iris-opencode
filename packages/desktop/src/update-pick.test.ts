import { describe, expect, test } from "bun:test"
import { newestToInstall } from "./update-pick"

// #190091: someone on A while D is out installs D — never B, then C, then D. The download in hand
// can be older than what the feed names by the time they click Restart.
describe("newestToInstall", () => {
  test("a newer version on the feed than the one downloaded wins", () => {
    expect(newestToInstall("1.18.131", "1.18.133")).toBe("latest")
  })
  test("the same version: install what is already downloaded", () => {
    expect(newestToInstall("1.18.133", "1.18.133")).toBe("pending")
  })
  test("no answer from the feed (offline, error): install what is downloaded", () => {
    expect(newestToInstall("1.18.133", undefined)).toBe("pending")
  })
  test("never step backwards to an older feed answer", () => {
    expect(newestToInstall("1.18.133", "1.18.132")).toBe("pending")
    expect(newestToInstall("1.18.99", "1.18.100")).toBe("latest")
  })
})
