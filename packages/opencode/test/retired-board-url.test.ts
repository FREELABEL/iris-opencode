import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { RETIRED_BOARD_URL } from "../src/cli/cmd/bloq-web-url"

// #190012 — Elon is being retired, and its board routes kept reaching people anyway:
// `iris remotion register` printed web.heyiris.io/iris/bloq/{id} two releases after #185736
// moved every board to the Atlas console. A compiled binary cannot be corrected after release,
// so the check has to happen before one is cut. Comments may NAME the old route (that is how
// the next reader learns why it is gone); code may not EMIT it.

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p))
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(p)
  }
  return out
}

describe("no retired board address in shipped code", () => {
  test("no source line outside a comment emits a web.*/(iris/)bloq address", () => {
    const hits: string[] = []
    for (const file of sourceFiles(join(import.meta.dir, "../src"))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const code = line.trim()
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return
          if (RETIRED_BOARD_URL.test(code)) hits.push(`${file.split("/src/")[1]}:${i + 1}  ${code.slice(0, 120)}`)
        })
    }
    expect(hits).toEqual([])
  })
})
