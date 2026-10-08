import { describe, expect, test } from "bun:test"
import path from "path"
import {
  assetName,
  binaryName,
  compareVersions,
  defaultInstallPath,
  installIris2,
  isIris2Path,
  parseSha256,
  pickLatest,
  versionOfTag,
} from "./iris2"

// #188596 — iris2 ships beside the stable iris. The property everything rests on: nothing in
// this module can write the stable binary, and no stable or desktop release is ever picked.

describe("iris2 never touches the stable iris", () => {
  test("only a file named iris2 / iris2.exe is writable", () => {
    expect(isIris2Path("/Users/a/.iris/bin/iris2")).toBe(true)
    expect(isIris2Path("C:\\Users\\a\\.iris\\bin\\iris2.exe".replaceAll("\\", path.sep))).toBe(true)
    expect(isIris2Path("/Users/a/.iris/bin/iris")).toBe(false)
    expect(isIris2Path("/Users/a/.iris/bin/iris.exe")).toBe(false)
    expect(isIris2Path("/usr/local/bin/opencode")).toBe(false)
  })

  test("installIris2 refuses a stable path before any network call", async () => {
    await expect(installIris2({ target: "/tmp/should-not-exist/.iris/bin/iris", version: "1.5.0-beta.1" })).rejects.toThrow(
      /refusing to write/,
    )
  })

  test("default install path is iris2 beside iris", () => {
    expect(defaultInstallPath("/home/a", "linux")).toBe(path.join("/home/a", ".iris", "bin", "iris2"))
    expect(binaryName("win32")).toBe("iris2.exe")
  })
})

describe("release selection", () => {
  test("ignores stable v*, desktop-v* and malformed tags; skips drafts", () => {
    const pick = pickLatest([
      { tag_name: "v1.3.319" },
      { tag_name: "v1.4.11" },
      { tag_name: "desktop-v1.18.40" },
      { tag_name: "iris2-v1.5.0-beta.2" },
      { tag_name: "iris2-v1.5.0-beta.10" },
      { tag_name: "iris2-v9.9.9", draft: true },
      { tag_name: "iris2-vnext" },
    ])
    expect(pick).toEqual({ tag: "iris2-v1.5.0-beta.10", version: "1.5.0-beta.10" })
  })

  test("no iris2 release → null, never a stable one", () => {
    expect(pickLatest([{ tag_name: "v1.3.319" }, { tag_name: "v1.4.0" }])).toBeNull()
  })

  test("versionOfTag", () => {
    expect(versionOfTag("iris2-v1.5.0")).toBe("1.5.0")
    expect(versionOfTag("v1.5.0")).toBeNull()
    expect(versionOfTag("iris2-v1.5")).toBeNull()
  })

  test("semver order is prerelease-aware and numeric", () => {
    expect(compareVersions("1.5.0-beta.10", "1.5.0-beta.9")).toBeGreaterThan(0)
    expect(compareVersions("1.5.0-beta.1", "1.5.0")).toBeLessThan(0)
    expect(compareVersions("1.5.0", "1.5.0-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("1.5.0", "1.5.0")).toBe(0)
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0)
    expect(compareVersions("1.5.0-alpha.1", "1.5.0-beta.1")).toBeLessThan(0)
  })
})

describe("assets", () => {
  test("names match what release-iris2.yml publishes", () => {
    expect(assetName("darwin", "arm64")).toBe("iris2-darwin-arm64.zip")
    expect(assetName("darwin", "x64")).toBe("iris2-darwin-x64.zip")
    expect(assetName("linux", "x64")).toBe("iris2-linux-x64.tar.gz")
    expect(assetName("linux", "arm64")).toBe("iris2-linux-arm64.tar.gz")
    expect(assetName("win32", "x64")).toBe("iris2-windows-x64.zip")
    expect(assetName("win32", "arm64")).toBeNull()
    expect(assetName("freebsd", "x64")).toBeNull()
  })

  test("sha256 parsing accepts sha256sum output and a bare digest, rejects junk", () => {
    const hex = "a".repeat(64)
    expect(parseSha256(`${hex}  iris2-linux-x64.tar.gz\n`)).toBe(hex)
    expect(parseSha256(hex.toUpperCase())).toBe(hex)
    expect(parseSha256("Not Found")).toBeNull()
    expect(parseSha256("a".repeat(63))).toBeNull()
  })
})

// End to end against a fake release server: the real download → checksum → unpack → swap →
// verify path, with no GitHub. Linux only (the asset there is a tar.gz any runner can build).
describe.skipIf(process.platform !== "linux")("installIris2 end to end", () => {
  const fs = require("fs") as typeof import("fs")
  const os = require("os") as typeof import("os")
  const { spawnSync } = require("child_process") as typeof import("child_process")
  const { createHash } = require("crypto") as typeof import("crypto")

  function fakeRelease(script: string, opts: { badSha?: boolean } = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris2-rel-"))
    const pkg = path.join(dir, "pkg")
    fs.mkdirSync(pkg)
    fs.writeFileSync(path.join(pkg, "iris2"), script, { mode: 0o755 })
    const tag = path.join(dir, "iris2-v1.5.0-beta.1")
    fs.mkdirSync(tag)
    const archive = path.join(tag, `iris2-linux-${process.arch}.tar.gz`)
    spawnSync("tar", ["-czf", archive, "-C", pkg, "iris2"])
    const sha = opts.badSha ? "0".repeat(64) : createHash("sha256").update(fs.readFileSync(archive)).digest("hex")
    fs.writeFileSync(archive + ".sha256", `${sha}  ${path.basename(archive)}\n`)
    const server = Bun.serve({
      port: 0,
      fetch: (req) => {
        const file = path.join(dir, decodeURIComponent(new URL(req.url).pathname))
        return fs.existsSync(file) ? new Response(Bun.file(file)) : new Response("Not Found", { status: 404 })
      },
    })
    return { base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
  }

  async function withRelease<T>(script: string, opts: { badSha?: boolean }, fn: (home: string) => Promise<T>) {
    const rel = fakeRelease(script, opts)
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "iris2-home-"))
    const prev = process.env["IRIS2_RELEASE_BASE"]
    process.env["IRIS2_RELEASE_BASE"] = rel.base
    try {
      return await fn(home)
    } finally {
      if (prev === undefined) delete process.env["IRIS2_RELEASE_BASE"]
      else process.env["IRIS2_RELEASE_BASE"] = prev
      rel.stop()
    }
  }

  test("installs, verifies, and reports the new version", async () => {
    await withRelease("#!/bin/sh\necho 1.5.0-beta.1\n", {}, async (home) => {
      const target = path.join(home, ".iris", "bin", "iris2")
      const r = await installIris2({ target, version: "1.5.0-beta.1" })
      expect(r.version).toBe("1.5.0-beta.1")
      expect(fs.existsSync(target)).toBe(true)
      // the stable binary's name was never created
      expect(fs.existsSync(path.join(home, ".iris", "bin", "iris"))).toBe(false)
    })
  })

  test("a checksum mismatch installs nothing and leaves the old iris2 alone", async () => {
    await withRelease("#!/bin/sh\necho 1.5.0-beta.1\n", { badSha: true }, async (home) => {
      const target = path.join(home, ".iris", "bin", "iris2")
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, "#!/bin/sh\necho old\n", { mode: 0o755 })
      await expect(installIris2({ target, version: "1.5.0-beta.1" })).rejects.toThrow(/checksum mismatch/)
      expect(fs.readFileSync(target, "utf8")).toContain("echo old")
      expect(fs.readdirSync(path.dirname(target)).filter((f) => f.startsWith(".iris2-update-"))).toEqual([])
    })
  })

  test("a new binary that cannot start is rolled back", async () => {
    await withRelease("#!/bin/sh\nexit 3\n", {}, async (home) => {
      const target = path.join(home, ".iris", "bin", "iris2")
      fs.mkdirSync(path.dirname(target), { recursive: true })
      fs.writeFileSync(target, "#!/bin/sh\necho old\n", { mode: 0o755 })
      await expect(installIris2({ target, version: "1.5.0-beta.1" })).rejects.toThrow(/did not start/)
      expect(fs.readFileSync(target, "utf8")).toContain("echo old")
    })
  })

  test("already current → no download", async () => {
    await withRelease("#!/bin/sh\necho 1.5.0-beta.1\n", { badSha: true }, async (home) => {
      const target = path.join(home, ".iris", "bin", "iris2")
      const r = await installIris2({ target, version: "1.5.0-beta.1", current: "1.5.0-beta.1" })
      expect(r.upToDate).toBe(true)
    })
  })
})
