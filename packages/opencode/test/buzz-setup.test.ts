import { describe, expect, test } from "bun:test"
import { buzzHarnessDir, irisHarness, localBinLinkPlan, resolveIrisPath } from "../src/cli/cmd/platform-buzz"

/**
 * `iris buzz setup` writes the custom-harness file Buzz loads at launch (Tauri app_data_dir() +
 * "custom_harnesses", identifier xyz.block.buzz.app — desktop/src-tauri/src/lib.rs:316-321 at
 * block/buzz @02753722). Epic #186854, Rung 1.
 */
describe("buzzHarnessDir — where Buzz reads custom harnesses", () => {
  test("macOS: Application Support/<identifier>", () => {
    expect(buzzHarnessDir("darwin", "/Users/a", {})).toBe(
      "/Users/a/Library/Application Support/xyz.block.buzz.app/custom_harnesses",
    )
  })
  test("Linux: XDG_DATA_HOME wins, else ~/.local/share", () => {
    expect(buzzHarnessDir("linux", "/home/a", { XDG_DATA_HOME: "/data" })).toBe(
      "/data/xyz.block.buzz.app/custom_harnesses",
    )
    expect(buzzHarnessDir("linux", "/home/a", {})).toBe("/home/a/.local/share/xyz.block.buzz.app/custom_harnesses")
  })
  test("Windows: roaming APPDATA", () => {
    expect(buzzHarnessDir("win32", "C:\\Users\\a", { APPDATA: "C:\\Users\\a\\AppData\\Roaming" })).toContain(
      "xyz.block.buzz.app",
    )
  })
})

describe("irisHarness — the definition Buzz loads", () => {
  test("runs `<absolute iris> acp` and carries no install commands", () => {
    const def = irisHarness("/Users/a/.iris/bin/iris")
    expect(def.id).toBe("iris")
    expect(def.command).toBe("/Users/a/.iris/bin/iris")
    expect(def.args).toEqual(["acp"])
    expect(JSON.stringify(def)).not.toContain("install_commands")
    // Buzz's id rule: [a-z0-9_][a-z0-9_-]*
    expect(def.id).toMatch(/^[a-z0-9_][a-z0-9_-]*$/)
  })
  test("refuses a bare command name — a Dock-launched Buzz cannot resolve it (#184675)", () => {
    expect(() => irisHarness("iris")).toThrow(/absolute/)
  })
})

describe("resolveIrisPath — which binary Buzz should run", () => {
  const none = () => false
  test("a compiled iris is its own execPath", () => {
    expect(resolveIrisPath("/Users/a/.iris/bin/iris", "/Users/a", none, "", "darwin")).toBe("/Users/a/.iris/bin/iris")
  })
  test("from source (execPath is bun) → the installer's ~/.iris/bin/iris", () => {
    const has = (p: string) => p === "/Users/a/.iris/bin/iris"
    expect(resolveIrisPath("/opt/bun/bin/bun", "/Users/a", has, "/usr/bin", "darwin")).toBe("/Users/a/.iris/bin/iris")
  })
  test("falls back to PATH, then gives up with null rather than guessing", () => {
    const has = (p: string) => p === "/opt/homebrew/bin/iris"
    expect(resolveIrisPath("/opt/bun/bin/bun", "/Users/a", has, "/usr/bin:/opt/homebrew/bin", "darwin")).toBe(
      "/opt/homebrew/bin/iris",
    )
    expect(resolveIrisPath("/opt/bun/bin/bun", "/Users/a", none, "/usr/bin", "darwin")).toBeNull()
  })
})

import { buzzJoinLink } from "../src/cli/cmd/platform-buzz"

/**
 * `iris buzz setup --community <invite>` — promised on the 2026-09-29 X-ART call: one command
 * installs IRIS AND joins the team's Buzz community. The relay's /invite/<code> page fires
 * buzz://join?relay=<ws(s)://host>&code=<code>; we build the same link from the shareable URL.
 */
describe("buzzJoinLink — invite URL → buzz://join", () => {
  test("an https invite page becomes a wss join link", () => {
    expect(buzzJoinLink("https://xart.communities.buzz.xyz/invite/AbC123")).toBe(
      "buzz://join?relay=wss%3A%2F%2Fxart.communities.buzz.xyz&code=AbC123",
    )
  })
  test("a local http relay becomes ws", () => {
    expect(buzzJoinLink("http://localhost:3100/invite/xyz")).toBe(
      "buzz://join?relay=ws%3A%2F%2Flocalhost%3A3100&code=xyz",
    )
  })
  test("an existing buzz://join link passes through", () => {
    const l = "buzz://join?relay=wss%3A%2F%2Fa.example&code=k"
    expect(buzzJoinLink(l)).toBe(l)
  })
  test("anything else is refused, not guessed", () => {
    for (const bad of ["", "xart", "https://buzz.xyz/", "https://a.example/channel/1", "ftp://a/invite/x", "buzz://join?relay=x"]) {
      expect(buzzJoinLink(bad)).toBeNull()
    }
  })
})

import { pickBuzzDmg, isBlockSigned } from "../src/cli/cmd/platform-buzz"

/** `--install` puts a downloaded app into /Applications, so the signature gate must refuse by default. */
describe("Buzz one-line install — asset pick and signature gate", () => {
  const assets = [
    { name: "Buzz_0.5.25_aarch64.dmg", browser_download_url: "u-arm" },
    { name: "Buzz_0.5.25_x64.dmg", browser_download_url: "u-x64" },
    { name: "Buzz_0.5.25_aarch64.app.tar.gz", browser_download_url: "u-tar" },
  ]
  test("picks the dmg for this CPU", () => {
    expect(pickBuzzDmg(assets, "arm64")?.browser_download_url).toBe("u-arm")
    expect(pickBuzzDmg(assets, "x64")?.browser_download_url).toBe("u-x64")
    expect(pickBuzzDmg([], "arm64")).toBeNull()
  })

  const blockSig = "Identifier=xyz.block.buzz.app\nAuthority=Developer ID Application: Block, Inc. (EYF346PHUG)\nTeamIdentifier=EYF346PHUG"
  const notarized = "/Volumes/Buzz/Buzz.app: accepted\nsource=Notarized Developer ID\norigin=Developer ID Application: Block, Inc. (EYF346PHUG)"
  test("accepts Block-signed + notarized (the real v0.5.24 output)", () => {
    expect(isBlockSigned(blockSig, notarized)).toBe(true)
  })
  test("refuses another developer's valid, notarized signature", () => {
    const other = "Authority=Developer ID Application: Evil LLC (ABCDE12345)\nTeamIdentifier=ABCDE12345"
    expect(isBlockSigned(other, notarized.replaceAll("Block, Inc. (EYF346PHUG)", "Evil LLC (ABCDE12345)"))).toBe(false)
  })
  test("refuses Block-signed but NOT notarized / rejected by Gatekeeper", () => {
    expect(isBlockSigned(blockSig, "/x/Buzz.app: rejected\nsource=Unnotarized Developer ID")).toBe(false)
    expect(isBlockSigned(blockSig, "")).toBe(false)
  })
  test("refuses unsigned", () => {
    expect(isBlockSigned("code object is not signed at all", "rejected")).toBe(false)
  })
})

describe("localBinLinkPlan — so Buzz's built-in IRIS entry can find the binary", () => {
  const iris = "/Users/a/.iris/bin/iris"
  test("nothing at ~/.local/bin/iris → create the link", () => {
    expect(localBinLinkPlan(iris, "/Users/a", "darwin", undefined)).toEqual({
      action: "create",
      link: "/Users/a/.local/bin/iris",
    })
  })
  test("already a link to this iris → nothing to do", () => {
    expect(localBinLinkPlan(iris, "/Users/a", "darwin", iris).action).toBe("ok")
  })
  test("a real file, or a link somewhere else → never overwritten", () => {
    expect(localBinLinkPlan(iris, "/Users/a", "darwin", null).action).toBe("leave")
    expect(localBinLinkPlan(iris, "/Users/a", "darwin", "/opt/other/iris").action).toBe("leave")
  })
  test("Windows → skipped (no ~/.local/bin convention there)", () => {
    expect(localBinLinkPlan(iris, "C:\\Users\\a", "win32", undefined).action).toBe("skip")
  })
})
