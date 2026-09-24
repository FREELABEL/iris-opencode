#!/usr/bin/env bun
/**
 * iris intent — accuracy and speed, on the same cases every time.
 *
 *   bun run script/intent-bench.ts                 # uses `bun run src/index.ts`
 *   IRIS_BIN=~/.iris/bin/iris bun run script/intent-bench.ts   # a compiled binary (real start-up)
 *   bun run script/intent-bench.ts --fill          # include the model argument filler
 *
 * Reports @1 accuracy (the lead command is one of the case's accepted answers) and p50/p95 of the
 * stages `--json` reports: decide_ms, fill_ms, total_ms, plus wall time per invocation.
 * Cases: script/intent-cases.json — [request, [accepted command names]].
 */
import { join } from "path"

const cases: [string, string[]][] = await Bun.file(join(import.meta.dir, "intent-cases.json")).json()
const extra = process.argv.includes("--fill") ? ["--fill"] : []
const bin = process.env.IRIS_BIN
const cmd = (q: string) =>
  bin
    ? [bin, "intent", q, "--json", ...extra]
    : ["bun", "run", join(import.meta.dir, "../src/index.ts"), "intent", q, "--json", ...extra]

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))]) : NaN
}
const rows: { ok: boolean; wall: number; decide: number; fill: number; total: number }[] = []
for (const [q, accept] of cases) {
  const t = performance.now()
  const out = await new Response(Bun.spawn(cmd(q), { stdout: "pipe", stderr: "ignore" }).stdout).text()
  const wall = performance.now() - t
  let j: any
  try {
    j = JSON.parse(out.slice(out.indexOf("{")))
  } catch {
    console.log(`✗ ${q} — no JSON`)
    continue
  }
  const ok = accept.includes(j.choice)
  rows.push({
    ok,
    wall,
    decide: j.timing?.decide_ms ?? NaN,
    fill: j.timing?.fill_ms ?? NaN,
    total: j.timing?.total_ms ?? NaN,
  })
  console.log(`${ok ? "✓" : "✗"} ${q.slice(0, 48).padEnd(48)} → ${String(j.choice).padEnd(28)} ${Math.round(wall)}ms`)
}
const col = (k: keyof (typeof rows)[number]) => rows.map((r) => r[k] as number).filter(Number.isFinite)
console.log(`\n@1 ${rows.filter((r) => r.ok).length}/${rows.length}`)
for (const k of ["decide", "fill", "total", "wall"] as const)
  console.log(`${k.padEnd(6)} p50 ${pct(col(k), 0.5)}ms  p95 ${pct(col(k), 0.95)}ms`)
