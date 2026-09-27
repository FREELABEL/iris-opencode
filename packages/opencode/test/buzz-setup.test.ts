import { describe, expect, test } from "bun:test"
import { buzzHarnessDir, irisHarness, resolveIrisPath } from "../src/cli/cmd/platform-buzz"

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
