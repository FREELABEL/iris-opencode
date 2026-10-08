import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { nodeBinary, nodeVaultArgv, nodeVaultCliPath, validVaultName } from "./hive-node-vault"

describe("nodeVaultArgv", () => {
  test("add carries only non-secret fields on argv, and defaults to a login", () => {
    expect(nodeVaultArgv("add", "availity", { username: "kmontero", url: "https://apps.availity.com" })).toEqual([
      "add", "availity", "--type", "login", "--username", "kmontero", "--url", "https://apps.availity.com",
    ])
  })

  test("--totp asks the daemon to prompt; a seed passed explicitly wins over the prompt", () => {
    expect(nodeVaultArgv("add", "a", { totp: true })).toContain("--totp")
    const withSeed = nodeVaultArgv("add", "a", { totp: true, totpSecret: "JBSWY3DPEHPK3PXP" })
    expect(withSeed).toContain("--totp-secret")
    expect(withSeed).not.toContain("--totp")
  })

  test("--password-stdin is forwarded so a script can pipe the secret instead of typing it", () => {
    expect(nodeVaultArgv("add", "a", { passwordStdin: true })).toContain("--password-stdin")
  })

  test("there is no way to put a password on argv", () => {
    const argv = nodeVaultArgv("add", "a", { username: "u", url: "x", totp: true, passwordStdin: true } as any)
    expect(argv.join(" ")).not.toMatch(/--password(?!-stdin)/)
  })

  test("list needs no name; remove and add refuse a bad one before any prompt opens", () => {
    expect(nodeVaultArgv("list")).toEqual(["list"])
    expect(nodeVaultArgv("list", undefined, { json: true })).toEqual(["list", "--json"])
    expect(nodeVaultArgv("remove", "availity")).toEqual(["remove", "availity"])
    expect(() => nodeVaultArgv("add", undefined)).toThrow(/vault name is required/)
    expect(() => nodeVaultArgv("remove", "../etc")).toThrow(/vault name/)
    expect(() => nodeVaultArgv("add", "--username")).toThrow(/vault name/)
  })
})

describe("validVaultName mirrors the daemon's NAME_RE", () => {
  test.each([["availity", true], ["payer.portal_2", true], ["-lead", false], ["", false], ["a".repeat(65), false], ["has space", false]])(
    "%p → %p",
    (name, ok) => expect(validVaultName(name)).toBe(ok as boolean),
  )
})

describe("locating the daemon", () => {
  test("the vault CLI is the bridge's lib/node-vault-cli.js", () => {
    expect(nodeVaultCliPath("/home/x")).toBe("/home/x/.iris/bridge/lib/node-vault-cli.js")
  })

  test("uses the daemon's pinned node when it exists, else node on PATH", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nv-"))
    const fakeNode = path.join(dir, "node")
    fs.writeFileSync(fakeNode, "")
    expect(nodeBinary("/h", () => `${fakeNode}\n`)).toBe(fakeNode)
    expect(nodeBinary("/h", () => "/nonexistent/node")).toBe("node")
    expect(nodeBinary("/h", () => { throw new Error("ENOENT") })).toBe("node")
  })
})
