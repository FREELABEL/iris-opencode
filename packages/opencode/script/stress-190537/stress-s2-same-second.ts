// #190537 S2b — a change inside the SAME second as the previous write: does the rev still move?
import { irisFetch, resolveUserId } from "../../src/cli/cmd/iris-api"
const [BLOQ, LIST] = process.argv.slice(2).map(Number)
const uid = await resolveUserId()
const j = async (r: Response) => { const x = await r.json().catch(() => ({})); return x?.data ?? x }
const card = async (id: number) => { const b = await j(await irisFetch(`/api/v1/user/${uid}/bloqs/${BLOQ}?ids=${id}&light=1&summary=1`)); for (const l of b?.lists ?? []) for (const i of l.items ?? []) if (i.id === id) return i }
const put = (id: number, body: object) => irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "PUT", body: JSON.stringify(body) })
const id = Number((await j(await irisFetch(`/api/v1/user/${uid}/bloqs/${BLOQ}/lists/${LIST}/items`, { method: "POST", body: JSON.stringify({ title: "s2b", content: "x", type: "default" }) }))).id)
for (const [field, a, b] of [["is_sensitive", false, true], ["priority", "low", "high"], ["contains_phi", false, true]] as const) {
  const out: string[] = []
  for (let i = 0; i < 6; i++) {
    await put(id, { [field]: a, title: `s2b ${field} ${i}` }) // write 1: sets up, and stamps updated_at
    const r1 = await card(id)
    await put(id, { [field]: b }) // write 2: only this field
    const r2 = await card(id)
    const same = r1.updated_at === r2.updated_at
    out.push(`${same ? "same-second" : "next-second"}:${r1.rev === r2.rev ? "REV SAME" : "rev moved"}`)
    if (field === "contains_phi") break // restrict-only: cannot be set back, one round is enough
  }
  console.log(field.padEnd(13), out.join("  "))
}
await irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "DELETE" })
