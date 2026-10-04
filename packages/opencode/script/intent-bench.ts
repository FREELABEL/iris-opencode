#!/usr/bin/env bun
/**
 * iris intent — accuracy and speed, on the same cases every time.
 *
 *   bun run script/intent-bench.ts                 # uses `bun run src/index.ts`
 *   IRIS_BIN=~/.iris/bin/iris bun run script/intent-bench.ts   # a compiled binary (real start-up)
 *   bun run script/intent-bench.ts --fill          # include the model argument filler
 *   bun run script/intent-bench.ts --cases intent-cases.json,intent-money-cases.json --gate 43 2
 *
 * Reports @1 accuracy (the lead command is one of the case's accepted answers), NOISE in the top 5
 * "also relevant" (below), and p50/p95 of the stages `--json` reports: decide_ms, fill_ms,
 * total_ms, plus wall time per invocation. `--gate <min @1> <max noise>` exits 1 when either fails.
 * Cases: script/intent-cases.json — [request, [accepted command names]].
 *
 * NOISE exists because @1 alone scored 25/28 while the list a person reads under the pick carried
 * 12 useless rows across 48 requests (#187829): agents with no description, a stub, `find` and
 * `web-search` beside a confident local answer, and one client's playbook for a stranger's request.
 */
import { join } from "path"

// [request, accepted commands, accepted agent ids?]. A case WITH agent ids is scored on the agent
// hand-off; a case without them counts a hand-off as a FALSE hand-off (it was a command's job).
const arg = (flag: string, n = 1) => {
  const i = process.argv.indexOf(flag)
  return i < 0 ? undefined : process.argv.slice(i + 1, i + 1 + n)
}
const files = (arg("--cases")?.[0] ?? "intent-cases.json").split(",")
const cases: [string, string[], number[]?][] = (
  await Promise.all(files.map((f) => Bun.file(join(import.meta.dir, f)).json()))
).flat()
const gate = arg("--gate", 2)?.map(Number)

// A playbook written for one client (frontmatter `client:`), read from the same index intent uses.
const index = await Bun.file(join(import.meta.dir, "../capabilities.json")).json()
const clientOf = new Map<string, string>(
  index.entries.filter((e: any) => e.client).map((e: any) => [`playbook run ${e.name}`, e.client]),
)
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "")
const unasked = (q: string, name: string) => {
  const c = clientOf.get(name)
  return !!c && !flat(q).includes(flat(c))
}
function noise(q: string, j: any): string[] {
  const rel: any[] = (j.related ?? []).slice(0, 5)
  const sure = Math.max(j.confidence ?? 0, ...rel.map((r) => r.relevance ?? 0)) >= 0.6
  const out: string[] = []
  for (const r of rel) {
    const d = String(r.describe ?? "")
    if (d.includes("(no description)")) out.push(`undescribed:${r.name}`)
    else if (/\bstub\b/i.test(d)) out.push(`stub:${r.name}`)
    else if ((r.name === "find" || r.name === "web-search") && sure) out.push(`fallback:${r.name}`)
    else if (unasked(q, r.name)) out.push(`client:${r.name}`)
  }
  if (unasked(q, j.choice ?? "")) out.push(`client-pick:${j.choice}`)
  return out
}
let noiseTotal = 0
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
  const n = noise(q, j)
  noiseTotal += n.length
  rows.push({
    ok,
    wall,
    decide: j.timing?.decide_ms ?? NaN,
    fill: j.timing?.fill_ms ?? NaN,
    total: j.timing?.total_ms ?? NaN,
  })
  console.log(
    `${ok ? "✓" : "✗"} ${q.slice(0, 48).padEnd(48)} → ${String(j.choice).padEnd(28)} ${Math.round(wall)}ms${handed ? `  (handed to agent ${handed.id})` : ""}${n.length ? `  noise: ${n.join(" ")}` : ""}`,
  )
}
const col = (k: keyof (typeof rows)[number]) => rows.map((r) => r[k] as number).filter(Number.isFinite)
console.log(
  `\ncommand @1 ${rows.filter((r) => r.ok).length}/${rows.length}   noise ${noiseTotal} in top-5 related   false hand-offs ${falseHandoffs}/${rows.length}`,
)
if (agentRows.length) console.log(`agent   @1 ${agentRows.filter((r) => r.ok).length}/${agentRows.length}`)
for (const k of ["decide", "fill", "total", "wall"] as const)
  console.log(`${k.padEnd(6)} p50 ${pct(col(k), 0.5)}ms  p95 ${pct(col(k), 0.95)}ms`)
if (gate) {
  const at1 = rows.filter((r) => r.ok).length
  const pass = at1 >= gate[0] && noiseTotal <= gate[1]
  console.log(`gate @1 >= ${gate[0]} and noise <= ${gate[1]}: ${pass ? "PASS" : "FAIL"}`)
  if (!pass) process.exitCode = 1
}
