/**
 * #190537 W1 — production probe of the write guard, on scratch board 811 only.
 *   P1  10 saves from one read, at the same instant      → exactly 1×200, 9×409
 *   P2  the 409 body, as Desktop will read it             → message, changed_by, your_edit, retry
 *   P3  a save with NO base_rev (every client today)      → 200, applied, no behaviour change
 *   P4  guarded vs unguarded save latency, 10 each        → the cost of holding the row lock
 *   P5  delete with a stale base_rev                      → 409, card survives
 *
 *   bun script/stress-190537/prod-w1-probe.ts   (BLOQ/LIST default to the scratch board)
 */
import { irisFetch, resolveUserId } from "../../src/cli/cmd/iris-api"

const BLOQ = Number(process.env.IRIS_CONTRACT_BLOQ ?? 811)
const LIST = Number(process.env.IRIS_CONTRACT_LIST ?? 2953)
if (BLOQ !== 811) throw new Error("this probe writes; it runs on the scratch board only")
const made: number[] = []
const userId = await resolveUserId()

const body = async (r: Response) => {
  const t = await r.text()
  try {
    return JSON.parse(t)
  } catch {
    return { raw: t.slice(0, 200) }
  }
}
const create = async (title: string) => {
  const r = await irisFetch(`/api/v1/user/${userId}/bloqs/${BLOQ}/lists/${LIST}/items`, {
    method: "POST",
    body: JSON.stringify({ title, content: "probe", type: "default", status: "todo" }),
  })
  const j = await body(r)
  const id = Number((j?.data ?? j)?.id)
  made.push(id)
  return id
}
const read = async (id: number) => {
  const j = await body(await irisFetch(`/api/v1/user/${userId}/bloqs/${BLOQ}?ids=${id}`))
  for (const l of (j?.data ?? j)?.lists ?? []) for (const i of l.items ?? []) if (i.id === id) return i
  return null
}
const put = (id: number, b: Record<string, unknown>) =>
  irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "PUT", body: JSON.stringify(b) })
const tally = (xs: number[]) =>
  Object.entries(xs.reduce<Record<number, number>>((a, s) => ((a[s] = (a[s] ?? 0) + 1), a), {}))
    .map(([s, n]) => `${n}×${s}`)
    .join(" ")
const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]
let ok = true
const verdict = (pass: boolean) => ((ok &&= pass), pass ? "PASS" : "FAIL")

try {
  // P1
  const a = await create("probe race")
  const base = (await read(a))!.rev
  const rs = await Promise.all(Array.from({ length: 10 }, (_, i) => put(a, { title: `writer ${i}`, base_rev: base })))
  const codes = rs.map((r) => r.status)
  const won = rs.findIndex((r) => r.status === 200)
  const after = await read(a)
  console.log(
    `P1  10 saves from one read, at once: ${tally(codes)} · title now "${after?.title}" (winner was writer ${won}) → ` +
      verdict(codes.filter((c) => c === 200).length === 1 && codes.filter((c) => c === 409).length === 9 && after?.title === `writer ${won}`),
  )

  // P2 — one of the refusals, field by field
  const refused = await body(rs.find((r) => r.status === 409)!.clone())
  const d = refused.data ?? {}
  console.log(`P2  the 409 Desktop receives:`)
  console.log(`      error          ${refused.error}`)
  console.log(`      message        ${refused.message}`)
  console.log(`      changed_by     ${JSON.stringify(d.changed_by)}`)
  console.log(`      changed_at     ${d.changed_at}`)
  console.log(`      recent_changes ${JSON.stringify(d.recent_changes)}`)
  console.log(`      your_edit      ${JSON.stringify(d.your_edit)}`)
  console.log(`      current.title  ${d.current?.title} · current.rev = retry.base_rev: ${d.current?.rev === d.retry?.base_rev}`)
  console.log(`      header         x-card-rev ${rs.find((r) => r.status === 409)!.headers.get("x-card-rev") === d.retry?.base_rev ? "matches" : "MISSING/WRONG"}`)
  const leak = /\b(rev|base_rev|409|stale)\b/i.test(refused.message ?? "")
  console.log(
    `    → ` +
      verdict(
        refused.error === "card_changed" && !!refused.message && !leak && d.your_edit?.title?.yours?.startsWith("writer") && !!d.retry?.base_rev,
      ),
  )

  // P3 — today's clients
  const r3 = await put(a, { title: "legacy save, no base_rev" })
  const j3 = await body(r3)
  const t3 = (await read(a))?.title
  console.log(`P3  save with no base_rev: HTTP ${r3.status} · applied: ${t3 === "legacy save, no base_rev"} · card_rev in reply: ${"card_rev" in j3} → ${verdict(r3.status === 200 && t3 === "legacy save, no base_rev" && !("card_rev" in j3))}`)

  // P4 — latency, alternating so drift hits both equally
  const b = await create("probe latency")
  let rev = (await read(b))!.rev
  const g: number[] = []
  const u: number[] = []
  for (let i = 0; i < 10; i++) {
    let t = performance.now()
    const r = await put(b, { content: `g${i}`, base_rev: rev })
    g.push(performance.now() - t)
    rev = (await body(r)).card_rev ?? rev
    t = performance.now()
    await put(b, { status: i % 2 ? "todo" : "in_progress" })
    u.push(performance.now() - t)
    rev = (await read(b))!.rev
  }
  console.log(`P4  save latency, 10 each: guarded p50 ${pct(g, 0.5).toFixed(0)} ms p90 ${pct(g, 0.9).toFixed(0)} ms · unguarded p50 ${pct(u, 0.5).toFixed(0)} ms p90 ${pct(u, 0.9).toFixed(0)} ms`)

  // P5
  const c = await create("probe delete")
  const stale = (await read(c))!.rev
  await put(c, { status: "done" })
  const r5 = await irisFetch(`/api/v1/user/bloqs/list/item/${c}?base_rev=${stale}`, { method: "DELETE" })
  const still = !!(await read(c))
  console.log(`P5  stale delete: HTTP ${r5.status} · card still there: ${still} → ${verdict(r5.status === 409 && still)}`)
} finally {
  for (const id of made) await irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "DELETE" }).catch(() => {})
  console.log(`cleanup: deleted ${made.length} scratch cards`)
}
console.log(ok ? "ALL PASS" : "SOMETHING FAILED")
process.exit(ok ? 0 : 1)
