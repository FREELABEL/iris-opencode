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

// [request, accepted commands, accepted agent ids?]. A case WITH agent ids is scored on the agent
// hand-off; a case without them counts a hand-off as a FALSE hand-off (it was a command's job).
const cases: [string, string[], number[]?][] = await Bun.file(join(import.meta.dir, "intent-cases.json")).json()
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
const agentRows: { ok: boolean }[] = []
let falseHandoffs = 0
for (const [q, accept, agents] of cases) {
  let j: any
  let wall = 0
  // One retry: a run that printed no JSON (a transient network or start-up failure) is not a
  // wrong answer, and scoring it as one moved the headline number by 2/32 (measured).
  for (let attempt = 0; attempt < 2 && !j; attempt++) {
    const t = performance.now()
    const out = await new Response(Bun.spawn(cmd(q), { stdout: "pipe", stderr: "ignore" }).stdout).text()
    wall = performance.now() - t
    try {
      j = JSON.parse(out.slice(out.indexOf("{")))
    } catch {}
  }
  if (!j) {
    console.log(`✗ ${q} — no JSON (twice)`)
    continue
  }
  const handed = j.agent?.handed_off ? j.agent : null
  if (agents) {
    const ok = !!handed && agents.includes(handed.id)
    agentRows.push({ ok })
    console.log(
      `${ok ? "✓" : "✗"} ${q.slice(0, 48).padEnd(48)} → agent ${handed ? `${handed.id} ${handed.name}` : "(none)"}`,
    )
    continue
  }
  if (handed) falseHandoffs++
  const ok = accept.includes(j.choice)
  rows.push({
    ok,
    wall,
    decide: j.timing?.decide_ms ?? NaN,
    fill: j.timing?.fill_ms ?? NaN,
    total: j.timing?.total_ms ?? NaN,
  })
  console.log(
    `${ok ? "✓" : "✗"} ${q.slice(0, 48).padEnd(48)} → ${String(j.choice).padEnd(28)} ${Math.round(wall)}ms${handed ? `  (handed to agent ${handed.id})` : ""}`,
  )
}
const col = (k: keyof (typeof rows)[number]) => rows.map((r) => r[k] as number).filter(Number.isFinite)
console.log(
  `\ncommand @1 ${rows.filter((r) => r.ok).length}/${rows.length}   false hand-offs ${falseHandoffs}/${rows.length}`,
)
if (agentRows.length) console.log(`agent   @1 ${agentRows.filter((r) => r.ok).length}/${agentRows.length}`)
for (const k of ["decide", "fill", "total", "wall"] as const)
  console.log(`${k.padEnd(6)} p50 ${pct(col(k), 0.5)}ms  p95 ${pct(col(k), 0.95)}ms`)
