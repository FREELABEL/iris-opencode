import { describe, expect, test } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Guard for the "{} is not iterable" class (root cause on bloq item #182167).
 *
 * Bans:   const items: any[] = data?.data ?? data?.items ?? []
 * Because `??` only falls through on null/undefined, so an endpoint answering
 * `{"data": {}}` puts a plain object into a binding annotated as an array, and
 * the next `for...of` throws. Six commands were reported separately before the
 * shared cause was found. Use firstArray()/asArray() from src/util/array.
 */

const SRC = join(import.meta.dir, "..", "src")

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (p.endsWith(".ts") && !p.endsWith("util/array.ts")) out.push(p)
  }
  return out
}

/** split on ?? and || that sit at paren/bracket/brace depth 0, outside strings */
function splitTopLevel(s: string): string[] | null {
  const parts: string[] = []
  let buf = "", depth = 0, quote: string | null = null
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (quote) {
      if (c === "\\") { buf += s.slice(i, i + 2); i++; continue }
      if (c === quote) quote = null
      buf += c; continue
    }
    if (c === '"' || c === "'" || c === "`") { quote = c; buf += c; continue }
    if ("([{".includes(c)) { depth++; buf += c; continue }
    if (")]}".includes(c)) { depth--; if (depth < 0) return null; buf += c; continue }
    if (depth === 0 && (s.startsWith("??", i) || s.startsWith("||", i))) { parts.push(buf); buf = ""; i++; continue }
    if (depth === 0 && c === "?" && !s.startsWith("??", i) && !s.startsWith("?.", i)) return null // ternary
    buf += c
  }
  if (depth !== 0 || quote) return null
  parts.push(buf)
  return parts.map((p) => p.trim()).filter(Boolean)
}

const DECL = /^\s*(?:const|let)\s+[A-Za-z_$][\w$]*\s*:\s*(?:any|unknown|[A-Za-z_$][\w$<>,\s[\]{}|.]*?)\[\]\s*=\s*(.+?);?\s*$/

describe("no unsafe ??-to-array coercion", () => {
  test("every array binding built from a ?? / || chain is array-checked", () => {
    const offenders: string[] = []
    for (const file of walk(SRC)) {
      const lines = readFileSync(file, "utf8").split("\n")
      lines.forEach((line, i) => {
        const m = DECL.exec(line)
        if (!m) return
        const rhs = m[1]!
        if (!rhs.includes("??") && !rhs.includes("||")) return
        if (rhs.includes("firstArray(") || rhs.includes("asArray(")) return
        const ops = splitTopLevel(rhs)
        if (!ops || ops.length < 2) return // ambiguous shape, not this pattern
        const unguarded = ops.filter((o) => !/^\[\s*\]$/.test(o) && !o.includes("Array.isArray"))
        if (unguarded.length) {
          offenders.push(`${file.slice(SRC.length + 1)}:${i + 1}  ${rhs.slice(0, 90)}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
