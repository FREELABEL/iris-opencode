import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync } from "fs"
import { join } from "path"

/**
 * A help text that advertises a flag the parser rejects (#184593).
 *
 * `iris playbook install --help` said "(--no-sync to skip)". Passing `--no-sync`
 * failed with `Unknown arguments: no-sync, noSync` and installed nothing; the only
 * working form was an undocumented `--sync=false`.
 *
 * The cause is global and deliberate: `src/index.ts` sets
 * `parserConfiguration({ "boolean-negation": false })`, because many commands
 * register LITERAL `--no-*` flags and yargs' negation was turning `--no-rag` into
 * `rag=false` and then rejecting it as unknown (#146915). With negation off,
 * `--no-x` is only accepted if someone registered `no-x` — and six commands had
 * written the promise into their help text without registering the flag.
 *
 * This is a source scan rather than a runtime check on purpose: the failure is that
 * a flag DOES NOT EXIST, and a runtime probe of every command would have to invoke
 * every command to find out. Scanning holds the whole class at once.
 *
 * The scan under-reports (it matches per file, not per builder) and never
 * over-reports, which is the right direction for a lint: a green run here is not a
 * proof, but a red run is always a real broken promise.
 */

const CMD_DIR = join(import.meta.dir)

function advertisedNegations(src: string): Set<string> {
  const out = new Set<string>()
  // Only help text counts. A `--no-x` inside a comment is documentation of the
  // hazard, not a promise to the user.
  const describeRe = /(?:describe|description)\s*:\s*(["'`])((?:\\.|(?!\1).)*)\1/gs
  for (const m of src.matchAll(describeRe)) {
    for (const f of m[2].matchAll(/--no-([a-z0-9][a-z0-9-]*)/g)) out.add(f[1])
  }
  return out
}

function registeredNegations(src: string): Set<string> {
  const out = new Set<string>()
  for (const m of src.matchAll(/\.option\(\s*["']no-([a-z0-9][a-z0-9-]*)["']/g)) out.add(m[1])
  // object form: .options({ "no-x": {...} })
  for (const m of src.matchAll(/["']no-([a-z0-9][a-z0-9-]*)["']\s*:/g)) out.add(m[1])
  return out
}

describe("every --no-* the help text promises is a flag the parser accepts", () => {
  const files = readdirSync(CMD_DIR).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))

  test("the scan actually reads the command surface — not zero files", () => {
    // Without this, a bad path would make every assertion below vacuously pass:
    // a lint that cannot fail is the thing it is meant to prevent.
    expect(files.length).toBeGreaterThan(50)
  })

  test("the scan can still detect a gap — a known-broken sample fails it", () => {
    const sample = `.option("sync", { describe: "regenerate (--no-sync to skip)" })`
    expect([...advertisedNegations(sample)]).toEqual(["sync"])
    expect(registeredNegations(sample).has("sync")).toBe(false)
  })

  test("no command advertises a negated flag it did not register", () => {
    const broken: string[] = []
    for (const f of files) {
      const src = readFileSync(join(CMD_DIR, f), "utf8")
      const reg = registeredNegations(src)
      for (const flag of advertisedNegations(src)) {
        if (!reg.has(flag)) broken.push(`${f}: help promises --no-${flag}, no option("no-${flag}") registered`)
      }
    }
    expect(broken).toEqual([])
  })
})
