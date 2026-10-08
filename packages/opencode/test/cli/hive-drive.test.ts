import { describe, expect, test } from "bun:test"
import { splitMetaSecret, redactMeta, assetName, checksumFor, formatArgs, mountArgs, isMounted, JUICEFS_VERSION } from "../../src/cli/cmd/platform-hive-drive"

// #188567 — iris hive drive wraps JuiceFS (adopted, not written). These pin the parts that are ours:
// the password never reaches argv or the screen, the binary is checksum-verified, and "mounted" is
// read from the kernel's table.

describe("metadata URL secrets", () => {
  test("the password is split out so it can go via META_PASSWORD, not argv", () => {
    expect(splitMetaSecret("redis://:s3cr%40t@100.64.0.5:6379/1")).toEqual({ url: "redis://100.64.0.5:6379/1", password: "s3cr@t" })
    expect(splitMetaSecret("postgres://drive:pw@db.local:5432/jfs")).toEqual({ url: "postgres://drive@db.local:5432/jfs", password: "pw" })
    expect(splitMetaSecret("redis://100.64.0.5:6379/1")).toEqual({ url: "redis://100.64.0.5:6379/1", password: null })
  })
  test("what is printed never contains it", () => {
    expect(redactMeta("redis://:hunter2@100.64.0.5:6379/1")).toBe("redis://100.64.0.5:6379/1")
    expect(redactMeta("postgres://u:hunter2@h/db")).not.toContain("hunter2")
    expect(redactMeta("not a url")).toBe("(unparseable meta url)")
  })
  test("the juicefs argv carries the stripped url, never the password", () => {
    const { url } = splitMetaSecret("redis://:hunter2@h:6379/1")
    expect(formatArgs("team", url, "s3", "https://b").join(" ")).not.toContain("hunter2")
    expect(mountArgs(url, "/m", "/c").join(" ")).not.toContain("hunter2")
    expect(mountArgs(url, "/m", "/c")).toEqual(["mount", "-d", "--cache-dir", "/c", "redis://h:6379/1", "/m"])
  })
})

describe("install", () => {
  test("asset per platform, none for unsupported", () => {
    expect(assetName("linux", "x64")).toBe(`juicefs-${JUICEFS_VERSION}-linux-amd64.tar.gz`)
    expect(assetName("darwin", "arm64")).toBe(`juicefs-${JUICEFS_VERSION}-darwin-arm64.tar.gz`)
    expect(assetName("win32", "x64")).toBeNull()
  })
  test("checksum is read for the exact asset only; malformed lines are not a checksum", () => {
    const a = "a".repeat(64), b = "b".repeat(64)
    const sums = `${a}  juicefs-1.4.1-linux-amd64.tar.gz\n${b}  juicefs-1.4.1-linux-arm64.tar.gz\nzzz  juicefs-1.4.1-darwin-arm64.tar.gz\n`
    expect(checksumFor(sums, "juicefs-1.4.1-linux-amd64.tar.gz")).toBe(a)
    expect(checksumFor(sums, "juicefs-1.4.1-darwin-arm64.tar.gz")).toBeNull()
    expect(checksumFor("", "x")).toBeNull()
  })
})

test("isMounted reads the mount table: exact mountpoint only", () => {
  const table = "JuiceFS:team /home/u/IrisDrive/team fuse.juicefs rw 0 0\n/dev/sda1 / ext4 rw 0 0\n"
  expect(isMounted("/home/u/IrisDrive/team", table)).toBe(true)
  expect(isMounted("/home/u/IrisDrive/te", table)).toBe(false)
  expect(isMounted("/home/u/IrisDrive/other", table)).toBe(false)
  expect(isMounted("/Users/u/IrisDrive/team", "JuiceFS:team on /Users/u/IrisDrive/team (macfuse)\n")).toBe(true)
})
