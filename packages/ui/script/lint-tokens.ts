#!/usr/bin/env bun
/**
 * Token lint for desktop CSS (#194375).
 *
 * Flags, in packages/app/src and packages/ui/src *.css:
 *   font-size   a literal size (12px, 0.8rem, 1.1em) instead of var(--font-size-*)
 *   radius      a literal border-radius instead of var(--radius-*)
 *   z-index     a bare number instead of var(--z-*)
 *   edge-strip  a coloured bar on one edge (house rule: tint, text colour or icon instead):
 *               border-left/right/inline-start/inline-end ≥ 2px, a one-sided inset box-shadow, or a
 *               thin absolutely-positioned ::before/::after strip
 *
 * Existing violations are listed in lint-tokens.baseline.json, so the check passes today and fails on
 * anything NEW. Fixing old ones shrinks the baseline; run with --update to record the smaller list.
 *
 *   bun run script/lint-tokens.ts            # exit 1 on violations not in the baseline
 *   bun run script/lint-tokens.ts --update   # rewrite the baseline from the current tree
 *   bun run script/lint-tokens.ts --list     # print every violation, baseline or not
 */

import { Glob } from "bun"
import path from "node:path"

const repo = path.resolve(import.meta.dir, "../../..")
const baselineFile = path.join(import.meta.dir, "lint-tokens.baseline.json")
const ROOTS = ["packages/app/src", "packages/ui/src"]
/** Files that define the tokens themselves. */
const SKIP = new Set(["packages/ui/src/styles/theme.css", "packages/ui/src/styles/theme-fallback.css"])

export type Violation = { file: string; line: number; rule: string; text: string }

const LITERAL = /(^|[\s(,])-?\d*\.?\d+(px|rem|em)\b/

export function lintCss(file: string, css: string): Violation[] {
  const out: Violation[] = []
  // Strip comments but keep line numbers.
  const src = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
  const lineAt = (i: number) => src.slice(0, i).split("\n").length
  const stack: string[] = []
  let selector = ""
  let decls: { prop: string; value: string; at: number }[] = []
  const frames: { decls: typeof decls }[] = []
  let buf = ""
  let bufStart = 0

  const pseudoStrip = (sel: string, list: typeof decls) => {
    if (!/::?(before|after)\b/.test(sel)) return
    const get = (p: string) => list.find((d) => d.prop === p)?.value.trim()
    const width = get("width")
    const height = get("height")
    const thin = (v?: string) => !!v && /^([2-4](\.\d+)?)px$/.test(v)
    const full = (v?: string) => !!v && /^(100%|auto)$/.test(v)
    const pos = get("position")
    const painted = list.some((d) => /^background(-color)?$/.test(d.prop) && !/none|transparent/.test(d.value))
    const anchored =
      (thin(width) && (full(height) || (get("top") !== undefined && get("bottom") !== undefined) || /\binset\b/.test(list.map((d) => d.prop).join(" ")))) ||
      (thin(height) && (full(width) || (get("left") !== undefined && get("right") !== undefined)))
    if (pos === "absolute" && painted && anchored) {
      const at = list[0]?.at ?? 0
      out.push({ file, line: lineAt(at), rule: "edge-strip", text: `${sel.trim().split(/\s+/).slice(-1)[0]} { width: ${width}; height: ${height} }` })
    }
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]!
    if (c === "{") {
      frames.push({ decls })
      stack.push(selector)
      selector = buf.trim()
      decls = []
      buf = ""
      bufStart = i + 1
      continue
    }
    if (c === ";" || c === "}") {
      const text = buf.trim()
      const colon = text.indexOf(":")
      if (colon > 0 && !text.startsWith("@")) {
        const prop = text.slice(0, colon).trim().toLowerCase()
        const value = text.slice(colon + 1).trim()
        const at = bufStart + buf.indexOf(text)
        decls.push({ prop, value, at })
        if (!prop.startsWith("--")) check(prop, value, at)
      }
      buf = ""
      bufStart = i + 1
      if (c === "}") {
        pseudoStrip(stack.concat(selector).join(" "), decls)
        selector = stack.pop() ?? ""
        decls = frames.pop()?.decls ?? []
      }
      continue
    }
    buf += c
  }

  function check(prop: string, value: string, at: number) {
    const v = value.replace(/!important/, "").trim()
    const push = (rule: string) => out.push({ file, line: lineAt(at), rule, text: `${prop}: ${v}` })
    if (prop === "font-size" && LITERAL.test(v) && !/var\(--font-size/.test(v)) push("font-size")
    if (/^border(-[a-z]+)*-radius$/.test(prop) && LITERAL.test(v) && !/^0(px)?$/.test(v)) push("radius")
    if (prop === "z-index" && /^-?\d+$/.test(v) && v !== "0") push("z-index")
    if (/^border-(left|right|inline-start|inline-end)(-width)?$/.test(prop)) {
      const w = v.match(/(\d*\.?\d+)px/)
      if (w && Number(w[1]) >= 2 && !/transparent|none/.test(v)) push("edge-strip")
    }
    if (prop === "box-shadow" && /inset/.test(v)) {
      for (const part of v.split(/,(?![^(]*\))/)) {
        const m = part.trim().match(/^inset\s+(-?\d*\.?\d+)(px)?\s+(-?\d*\.?\d+)(px)?(\s+0(px)?)?\s/)
        if (m && Number(m[1]) !== 0 && Number(m[3]) === 0 && Math.abs(Number(m[1])) >= 2) push("edge-strip")
      }
    }
  }
  return out
}

const key = (v: Violation) => `${v.file} | ${v.rule} | ${v.text}`

export async function lintAll(): Promise<Violation[]> {
  const all: Violation[] = []
  for (const root of ROOTS) {
    for await (const rel of new Glob("**/*.css").scan(path.join(repo, root))) {
      const file = `${root}/${rel}`
      if (SKIP.has(file)) continue
      all.push(...lintCss(file, await Bun.file(path.join(repo, file)).text()))
    }
  }
  return all.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)
}

function count(list: Violation[]) {
  const map = new Map<string, number>()
  for (const v of list) map.set(key(v), (map.get(key(v)) ?? 0) + 1)
  return map
}

if (import.meta.main) {
  const found = await lintAll()
  const rules = ["font-size", "radius", "z-index", "edge-strip"]
  const byRule = (list: Violation[]) => rules.map((r) => `${r} ${list.filter((v) => v.rule === r).length}`).join(" · ")
  if (process.argv.includes("--update")) {
    const entries = [...count(found).entries()].sort(([a], [b]) => a.localeCompare(b))
    await Bun.write(baselineFile, JSON.stringify(Object.fromEntries(entries), null, 1) + "\n")
    console.log(`Baseline written: ${found.length} violations (${byRule(found)}).`)
    process.exit(0)
  }
  const baseline: Record<string, number> = (await Bun.file(baselineFile).json().catch(() => ({}))) as Record<string, number>
  const baseTotal = Object.values(baseline).reduce((a, b) => a + b, 0)
  const seen = new Map<string, number>()
  const fresh: Violation[] = []
  for (const v of found) {
    const k = key(v)
    const n = (seen.get(k) ?? 0) + 1
    seen.set(k, n)
    if (n > (baseline[k] ?? 0)) fresh.push(v)
  }
  if (process.argv.includes("--list")) for (const v of found) console.log(`${v.file}:${v.line}  ${v.rule.padEnd(10)} ${v.text}`)
  console.log(`lint-tokens: ${found.length} violations in the tree (${byRule(found)}); baseline allows ${baseTotal}.`)
  if (found.length < baseTotal) console.log(`  ${baseTotal - found.length} fewer than the baseline — run with --update to lock in the progress.`)
  if (fresh.length) {
    console.log(`\n${fresh.length} NEW violation(s) — use the tokens (var(--font-size-*), var(--radius-*), var(--z-*)) or, for an edge strip, a tint / text colour / icon:`)
    for (const v of fresh) console.log(`  ${v.file}:${v.line}  ${v.rule.padEnd(10)} ${v.text}`)
    process.exit(1)
  }
  console.log("No new violations.")
}
