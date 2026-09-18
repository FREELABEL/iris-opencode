import { expect, test } from "bun:test"
import { readFileSync, readdirSync, statSync } from "fs"
import { join, relative } from "path"

// ONE writer of the node key (#185896), and it is not in this repo.
//
// Eleven places across two repos minted Hive node keys — five blocks in `install`, `install.ps1`,
// `iris hive connect`, daemonctl twice, the daemon — through two endpoints, nine with no machine
// fingerprint. A client's machine ended up holding a key the hub had never issued. The daemon
// (FREELABEL/iris-daemon, daemon/node-key-heal.js) now owns enrollment; installers and the CLI
// only sign in and start it. This fails the moment anything here starts minting keys again.

const ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const MINT = /\/api\/v1\/hive\/register-node|["'`]\/api\/v6\/nodes["'`]\s*,\s*\{[^}]*method:\s*["']POST/s

function files(): string[] {
  const out = [join(ROOT, "install"), join(ROOT, "install.ps1")]
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p)
    }
  }
  walk(join(ROOT, "packages", "opencode", "src"))
  return out
}

const code = (src: string) =>
  src
    .split("\n")
    .filter((l) => !/^\s*(#|\/\/|\*|\/\*)/.test(l))
    .join("\n")

test("nothing in the CLI repo mints a Hive node key", () => {
  const minters = files()
    .filter((f) => MINT.test(code(readFileSync(f, "utf-8"))))
    .map((f) => relative(ROOT, f))
  expect(minters).toEqual([])
})

test("the guard can see a minting call (so the pass above means something)", () => {
  expect(MINT.test('curl -d x "https://raichu.heyiris.io/api/v1/hive/register-node"')).toBe(true)
  expect(MINT.test('hiveFetch("/api/v6/nodes", {\n  method: "POST",')).toBe(true)
  expect(MINT.test('hiveFetch(`/api/v6/nodes/?user_id=1`)')).toBe(false)
})
