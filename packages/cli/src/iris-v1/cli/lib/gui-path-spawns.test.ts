import { expect, test } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

// The desktop app runs Hive setup with a GUI PATH that has no node. ensureNodeOnPath() fixes
// process.env.PATH, but under Bun a spawn ignores that change unless it is handed env explicitly —
// measured: ENOENT without, node v22 with (2026-09-18). So every spawn in these files must pass it.
for (const file of ["platform-node.ts", "platform-hive-connect.ts"]) {
  test(`${file}: every node/npm/iris spawn passes env: process.env`, () => {
    const src = readFileSync(join(import.meta.dir, "..", "cmd", file), "utf8")
    const calls = [...src.matchAll(/(?:execFileSync|spawnSync|execSync)\(((?:[^()]|\([^()]*\))*)\)/g)]
      .map((m) => m[1])
      .filter((args) => !/^\s*"(chmod|ln)"/.test(args))
    expect(calls.length).toBeGreaterThan(0)
    for (const args of calls) expect(args).toContain("env: process.env")
  })
}
