import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

/**
 * Two files can each define a const with the same name: platform-hive.ts has the PEER
 * `HiveFilesCommand` (`hive files <connection-id>`), platform-hive-files.ts has the own-node one
 * (`hive fs`), re-exported as `HiveFilesCommandExport`. The index builder used to read
 * `.command(HiveFilesCommandExport)` as `HiveFilesCommand` and resolve it to the peer command in
 * the parent's file — so `hive fs` and all three subcommands were invisible to every agent and to
 * `iris find`, while `iris hive fs --help` worked fine for a person.
 */
const index = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "capabilities.json"), "utf8"))
const entries = index.entries as { kind: string; name: string; haystack: string }[]
const names = entries.map((e) => e.name)

describe("capability index resolves a re-exported command to its own file", () => {
  test("hive fs and its subcommands are indexed", () => {
    for (const n of ["hive fs", "hive fs ls", "hive fs pull", "hive fs push"]) expect(names).toContain(n)
  })

  test("the peer `hive files` is indexed once, as the peer command — not shadowing `hive fs`", () => {
    expect(names.filter((n) => n === "hive files")).toHaveLength(1)
    expect(entries.find((e) => e.name === "hive fs")!.haystack).toContain("your own hive nodes")
  })
})

describe("capability index collects a group DEFINED with an Export-suffixed name", () => {
  // `export const HiveHostCommandExport = cmd({...})` was never collected (the definition pattern
  // required the name to END in Command), so `iris hive host` and all of `iris hive vpn` were
  // invisible to agents and `iris find` while working fine for a person.
  test("hive host and hive vpn, with their subcommands, are indexed", () => {
    for (const n of ["hive host", "hive host run", "hive host policy allow", "hive host lockdown", "hive vpn", "hive vpn connect"])
      expect(names).toContain(n)
  })
})

