import { describe, expect, test } from "bun:test"
import path from "path"
import {
  assetName,
  binaryName,
  channelOfVersion,
  compareVersions,
  defaultInstallPath,
  installIris2,
  isIris2Path,
  parseSha256,
  pickLatest,
  planUpdate,
  selfUpdate,
  slotOf,
  versionOfTag,
  type Release,
} from "./iris2"

// #188596 — iris2 ships beside the stable iris. Updates are decided by SLOT (which file is
// replaced: the running binary itself) and CHANNEL (which releases it follows).

const BEFORE_SWITCH: Release[] = [
  { tag_name: "desktop-v1.18.40" },
  { tag_name: "iris2-v1.5.0-beta.2", prerelease: true },
  { tag_name: "v1.3.319" },
  { tag_name: "iris2-v1.5.0-beta.10", prerelease: true },
  { tag_name: "v1.3.318" },
  { tag_name: "v1.4.11" }, // stray April tag: older by recency, so never the stable pick
]
const AFTER_SWITCH: Release[] = [{ tag_name: "v1.5.0" }, ...BEFORE_SWITCH]

describe("slots", () => {
  test("only iris and iris2 (and their .exe) are slots", () => {
    expect(slotOf("/Users/a/.iris/bin/iris2")).toBe("iris2")
    expect(slotOf("/Users/a/.iris/bin/iris")).toBe("iris")
    expect(slotOf("C:/Users/a/.iris/bin/IRIS2.EXE")).toBe("iris2")
    expect(slotOf("/usr/local/bin/opencode")).toBeNull()
    expect(slotOf("/tmp/iris-dev")).toBeNull()
    expect(isIris2Path("/Users/a/.iris/bin/iris")).toBe(false)
  })

  test("a build's channel comes from its version", () => {
    expect(channelOfVersion("1.5.0-beta.3")).toBe("preview")
    expect(channelOfVersion("0.0.0-iris2-local")).toBe("preview")
    expect(channelOfVersion("1.5.0")).toBe("stable")
    expect(channelOfVersion("1.3.319")).toBe("stable")
  })

  test("default install path is iris2 beside iris", () => {
    expect(defaultInstallPath("/home/a", "linux")).toBe(path.join("/home/a", ".iris", "bin", "iris2"))
    expect(binaryName("win32")).toBe("iris2.exe")
  })
})

describe("planUpdate — every scenario", () => {
  test("iris2 upgrade → newest preview", () => {
    expect(planUpdate({ slot: "iris2", current: "1.5.0-beta.2", releases: BEFORE_SWITCH })).toMatchObject({
      kind: "install",
      channel: "preview",
      tag: "iris2-v1.5.0-beta.10",
    })
  })

  test("iris2 already newest → current", () => {
    expect(planUpdate({ slot: "iris2", current: "1.5.0-beta.10", releases: BEFORE_SWITCH }).kind).toBe("current")
  })

  test("iris2 upgrade --channel stable → refused (an iris2 file holding a v1 build helps nobody)", () => {
    const p = planUpdate({ slot: "iris2", current: "1.5.0-beta.2", requested: "stable", releases: BEFORE_SWITCH })
    expect(p.kind).toBe("refuse")
  })

  test("canary: a preview build running as iris follows the preview and writes iris", () => {
    expect(planUpdate({ slot: "iris", current: "1.5.0-beta.2", releases: BEFORE_SWITCH })).toMatchObject({
      kind: "install",
      channel: "preview",
      tag: "iris2-v1.5.0-beta.10",
    })
  })

  test("rollback: iris --channel stable installs newest stable even though it is a lower version", () => {
    const p = planUpdate({ slot: "iris", current: "1.5.0-beta.10", requested: "stable", releases: BEFORE_SWITCH })
    expect(p).toMatchObject({ kind: "install", channel: "stable", tag: "v1.3.319", version: "1.3.319" })
    expect(p.kind === "install" && p.note).toContain("switching")
  })

  test("stable picks by recency like iris update does — the stray v1.4.11 tag is not chosen", () => {
    expect(pickLatest(BEFORE_SWITCH, "stable")).toEqual({ tag: "v1.3.319", version: "1.3.319" })
  })

  test("after the switch, iris2 says it has graduated and installs nothing", () => {
    const p = planUpdate({ slot: "iris2", current: "1.5.0-beta.10", releases: AFTER_SWITCH })
    expect(p.kind).toBe("refuse")
    expect(p.kind === "refuse" && p.message).toContain("graduated")
  })

  test("after the switch, a preview build in the iris slot follows the engine into stable", () => {
    expect(planUpdate({ slot: "iris", current: "1.5.0-beta.10", releases: AFTER_SWITCH })).toMatchObject({
      kind: "install",
      channel: "stable",
      tag: "v1.5.0",
    })
  })

  test("after the switch, a stable v2 build updates along stable", () => {
    expect(planUpdate({ slot: "iris", current: "1.5.0", releases: [{ tag_name: "v1.5.1" }, ...AFTER_SWITCH] })).toMatchObject({
      kind: "install",
      channel: "stable",
      tag: "v1.5.1",
    })
  })

  test("a binary with any other name is refused", () => {
    expect(planUpdate({ slot: null, current: "1.5.0-beta.2", releases: BEFORE_SWITCH }).kind).toBe("refuse")
  })

  test("pinned versions: iris2 accepts a preview, refuses a stable one", () => {
    expect(planUpdate({ slot: "iris2", current: "1.5.0-beta.10", pinned: "1.5.0-beta.2", releases: [] })).toMatchObject({
      kind: "install",
      tag: "iris2-v1.5.0-beta.2",
    })
    expect(planUpdate({ slot: "iris2", current: "1.5.0-beta.10", pinned: "1.3.319", releases: [] }).kind).toBe("refuse")
    expect(planUpdate({ slot: "iris", current: "1.5.0-beta.10", pinned: "1.3.318", releases: [] })).toMatchObject({
      kind: "install",
      channel: "stable",
      tag: "v1.3.318",
    })
  })

  test("nothing published → refused with a plain reason, never a stable pick for iris2", () => {
    const p = planUpdate({ slot: "iris2", current: "1.5.0-beta.1", releases: [{ tag_name: "v1.3.319" }] })
    expect(p.kind).toBe("refuse")
  })
})

describe("release parsing", () => {
  test("versionOfTag per channel", () => {
    expect(versionOfTag("iris2-v1.5.0")).toBe("1.5.0")
    expect(versionOfTag("v1.5.0")).toBeNull()
    expect(versionOfTag("v1.5.0", "stable")).toBe("1.5.0")
    expect(versionOfTag("desktop-v1.18.40", "stable")).toBeNull()
    expect(versionOfTag("iris2-v1.5.0-beta.1", "stable")).toBeNull()
  })

  test("semver order is prerelease-aware and numeric", () => {
    expect(compareVersions("1.5.0-beta.10", "1.5.0-beta.9")).toBeGreaterThan(0)
    expect(compareVersions("1.5.0-beta.1", "1.5.0")).toBeLessThan(0)
    expect(compareVersions("1.5.0", "1.5.0-beta.1")).toBeGreaterThan(0)
    expect(compareVersions("1.5.0", "1.5.0")).toBe(0)
    expect(compareVersions("1.10.0", "1.9.0")).toBeGreaterThan(0)
    expect(compareVersions("1.5.0-alpha.1", "1.5.0-beta.1")).toBeLessThan(0)
  })

  test("asset names match both release workflows", () => {
    expect(assetName("darwin", "arm64")).toBe("iris2-darwin-arm64.zip")
    expect(assetName("linux", "x64")).toBe("iris2-linux-x64.tar.gz")
    expect(assetName("win32", "x64")).toBe("iris2-windows-x64.zip")
    expect(assetName("darwin", "arm64", "stable")).toBe("iris-darwin-arm64.zip")
    expect(assetName("linux", "arm64", "stable")).toBe("iris-linux-arm64.tar.gz")
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

// End to end against a fake release server holding BOTH a preview and a stable release: the
// real download → checksum → unpack → swap → verify path, with no GitHub. Linux only.
describe.skipIf(process.platform !== "linux")("end to end", () => {
  const fs = require("fs") as typeof import("fs")
  const os = require("os") as typeof import("os")
  const { spawnSync } = require("child_process") as typeof import("child_process")
  const { createHash } = require("crypto") as typeof import("crypto")
  const sh = (out: string) => `#!/bin/sh\n[ "$1" = "--version" ] && echo ${out}\nexit 0\n`

  type Asset = { tag: string; prefix: "iris" | "iris2"; script: string; badSha?: boolean }
  function server(assets: Asset[]) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iris2-rel-"))
    for (const a of assets) {
      const pkg = fs.mkdtempSync(path.join(os.tmpdir(), "iris2-pkg-"))
      fs.writeFileSync(path.join(pkg, a.prefix), a.script, { mode: 0o755 })
      fs.mkdirSync(path.join(dir, a.tag), { recursive: true })
      const archive = path.join(dir, a.tag, `${a.prefix}-linux-${process.arch}.tar.gz`)
      spawnSync("tar", ["-czf", archive, "-C", pkg, a.prefix])
      const sha = a.badSha ? "0".repeat(64) : createHash("sha256").update(fs.readFileSync(archive)).digest("hex")
      fs.writeFileSync(archive + ".sha256", `${sha}  ${path.basename(archive)}\n`)
    }
    const s = Bun.serve({
      port: 0,
      fetch: (req) => {
        const file = path.join(dir, decodeURIComponent(new URL(req.url).pathname))
        return fs.existsSync(file) ? new Response(Bun.file(file)) : new Response("Not Found", { status: 404 })
      },
    })
    return { base: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) }
  }

  async function withServer<T>(assets: Asset[], fn: (bin: string) => Promise<T>) {
    const srv = server(assets)
    const bin = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "iris2-home-")), ".iris", "bin")
    fs.mkdirSync(bin, { recursive: true })
    const prev = process.env["IRIS2_RELEASE_BASE"]
    process.env["IRIS2_RELEASE_BASE"] = srv.base
    try {
      return await fn(bin)
    } finally {
      if (prev === undefined) delete process.env["IRIS2_RELEASE_BASE"]
      else process.env["IRIS2_RELEASE_BASE"] = prev
      srv.stop()
    }
  }
  const put = (file: string, script: string) => fs.writeFileSync(file, script, { mode: 0o755 })
  const read = (file: string) => fs.readFileSync(file, "utf8")
  const PREVIEW = { tag: "iris2-v1.5.0-beta.10", prefix: "iris2" as const, script: sh("1.5.0-beta.10") }
  const STABLE = { tag: "v1.3.319", prefix: "iris" as const, script: sh("1.3.319") }
  const rels: Release[] = [{ tag_name: "iris2-v1.5.0-beta.10" }, { tag_name: "v1.3.319" }]

  test("iris2 upgrade replaces iris2 and leaves the stable iris byte-identical", async () => {
    await withServer([PREVIEW, STABLE], async (bin) => {
      put(path.join(bin, "iris"), sh("STABLE-UNTOUCHED"))
      put(path.join(bin, "iris2"), sh("1.5.0-beta.2"))
      const before = read(path.join(bin, "iris"))
      expect(await selfUpdate([], "1.5.0-beta.2", { execPath: path.join(bin, "iris2"), releases: rels })).toBe(0)
      expect(read(path.join(bin, "iris2"))).toContain("1.5.0-beta.10")
      expect(read(path.join(bin, "iris"))).toBe(before)
    })
  })

  test("canary: a preview build running as iris updates itself from the preview, iris2 untouched", async () => {
    await withServer([PREVIEW, STABLE], async (bin) => {
      put(path.join(bin, "iris"), sh("1.5.0-beta.2"))
      expect(await selfUpdate([], "1.5.0-beta.2", { execPath: path.join(bin, "iris"), releases: rels })).toBe(0)
      expect(read(path.join(bin, "iris"))).toContain("1.5.0-beta.10")
      expect(fs.existsSync(path.join(bin, "iris2"))).toBe(false)
    })
  })

  test("rollback: iris --channel stable puts the stable build back in the iris slot", async () => {
    await withServer([PREVIEW, STABLE], async (bin) => {
      put(path.join(bin, "iris"), sh("1.5.0-beta.10"))
      expect(await selfUpdate(["--channel", "stable"], "1.5.0-beta.10", { execPath: path.join(bin, "iris"), releases: rels })).toBe(0)
      expect(read(path.join(bin, "iris"))).toContain("1.3.319")
    })
  })

  test("iris2 --channel stable is refused and writes nothing", async () => {
    await withServer([PREVIEW, STABLE], async (bin) => {
      put(path.join(bin, "iris2"), sh("1.5.0-beta.2"))
      expect(await selfUpdate(["--channel", "stable"], "1.5.0-beta.2", { execPath: path.join(bin, "iris2"), releases: rels })).toBe(1)
      expect(read(path.join(bin, "iris2"))).toContain("1.5.0-beta.2")
    })
  })

  test("a binary with another name is refused and writes nothing", async () => {
    await withServer([PREVIEW, STABLE], async (bin) => {
      put(path.join(bin, "iris-dev"), sh("1.5.0-beta.2"))
      expect(await selfUpdate([], "1.5.0-beta.2", { execPath: path.join(bin, "iris-dev"), releases: rels })).toBe(1)
      expect(fs.readdirSync(bin).sort()).toEqual(["iris-dev"])
    })
  })

  test("a checksum mismatch installs nothing and leaves the old binary alone", async () => {
    await withServer([{ ...PREVIEW, badSha: true }], async (bin) => {
      put(path.join(bin, "iris2"), sh("old"))
      await expect(installIris2({ target: path.join(bin, "iris2"), version: "1.5.0-beta.10" })).rejects.toThrow(/checksum mismatch/)
      expect(read(path.join(bin, "iris2"))).toContain("old")
      expect(fs.readdirSync(bin).filter((f) => f.startsWith(".iris2-update-"))).toEqual([])
    })
  })

  test("a new binary that cannot start is rolled back", async () => {
    await withServer([{ ...PREVIEW, script: "#!/bin/sh\nexit 3\n" }], async (bin) => {
      put(path.join(bin, "iris2"), sh("old"))
      await expect(installIris2({ target: path.join(bin, "iris2"), version: "1.5.0-beta.10" })).rejects.toThrow(/did not start/)
      expect(read(path.join(bin, "iris2"))).toContain("old")
    })
  })

  test("iris iris2 install refuses a stable path before any network call", async () => {
    await expect(installIris2({ target: "/tmp/should-not-exist/.iris/bin/iris", version: "1.5.0-beta.1" })).rejects.toThrow(
      /refusing to write/,
    )
  })
})
