import { describe, expect, test } from "bun:test"
import { splitMetaSecret, redactMeta, assetName, checksumFor, formatArgs, mountArgs, serveArgs, isMounted, validIdentity, DEFAULT_IDENTITY, JUICEFS_VERSION } from "../../src/cli/cmd/platform-hive-drive"

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
    expect(mountArgs(url, "/m", "/c")).toEqual(["mount", "-d", "--all-squash", DEFAULT_IDENTITY, "--cache-dir", "/c", "redis://h:6379/1", "/m"])
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

describe("one identity per drive (measured: without it, 100/100 cross-machine writes were refused)", () => {
  test("every mount squashes all writers to the drive's identity; default is a Mac's first user", () => {
    expect(DEFAULT_IDENTITY).toBe("501:20")
    expect(mountArgs("redis://h/1", "/m", "/c", "1000:1000").slice(0, 4)).toEqual(["mount", "-d", "--all-squash", "1000:1000"])
  })
  test("identity is validated, normalised, never passed through raw", () => {
    expect(validIdentity("501:20")).toBe("501:20")
    expect(validIdentity(" 0100:020 ")).toBe("100:20")
    for (const bad of ["", "root", "501", "501:20; rm -rf /", "-1:2", undefined]) expect(validIdentity(bad as any)).toBeNull()
  })
  test("the gateway for FUSE-less machines listens on loopback only", () => {
    expect(serveArgs("redis://h/1", 9007, "/c")).toEqual(["webdav", "--cache-dir", "/c", "redis://h/1", "127.0.0.1:9007"])
  })
})
