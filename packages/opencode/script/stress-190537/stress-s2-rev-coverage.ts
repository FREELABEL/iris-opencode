/**
 * #190537 S2 — is there a change a card SHOWS that its rev does not cover?
 *
 * A rev that misses a visible change means the Desktop copy keeps a stale card forever: the board
 * version does not move, so the app never re-downloads it. This makes each kind of change to a
 * scratch card on the DEPLOYED fl-api, straight after the previous one (inside the same second —
 * the hard case for updated_at), and records whether the card face moved and whether the rev moved.
 *
 *   bun run script/stress-s2-rev-coverage.ts <bloq> <list> <otherList>
 *
 * Verdict per change: ok (both moved, or neither) · GAP (face moved, rev did not) · extra (rev
 * moved, face did not — harmless, a wasted re-download).
 */
import { irisFetch, resolveUserId } from "../../src/cli/cmd/iris-api"

const [BLOQ, LIST, OTHER] = process.argv.slice(2).map(Number)
const uid = await resolveUserId()

async function j(res: Response): Promise<any> {
  const t = await res.text()
  try { const x = JSON.parse(t); return x?.data ?? x } catch { return { status: res.status, raw: t.slice(0, 200) } }
}
async function card(id: number) {
  const b = await j(await irisFetch(`/api/v1/user/${uid}/bloqs/${BLOQ}?ids=${id}&light=1&summary=1`))
  for (const l of b?.lists ?? []) for (const i of l.items ?? []) if (i.id === id) return i
  return null
}
const face = (c: any) => {
  const { rev, updated_at, ...rest } = c ?? {}
  return JSON.stringify(rest)
}
const put = (id: number, body: object) => irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "PUT", body: JSON.stringify(body) })
const sub = (id: number, path: string, method: string, body?: object) =>
  irisFetch(`/api/v1/user/${uid}/bloqs/list/item/${id}${path}`, { method, body: body ? JSON.stringify(body) : undefined })
const task = (id: number, path: string, method: string, body?: object) =>
  irisFetch(`/api/v1/user/bloqs/list/item/${id}/tasks${path}`, { method, body: body ? JSON.stringify(body) : undefined })

const created = await j(await irisFetch(`/api/v1/user/${uid}/bloqs/${BLOQ}/lists/${LIST}/items`, {
  method: "POST", body: JSON.stringify({ title: "s2 probe", content: "body one", type: "default", status: "todo" }),
}))
const id = Number(created.id)
let taskIds: number[] = []

const changes: [string, () => Promise<Response | void>][] = [
  ["title", () => put(id, { title: "s2 probe renamed" })],
  ["title, one character", () => put(id, { title: "s2 probe renamex" })],
  ["content (body)", () => put(id, { content: "body two" })],
  ["content_merge", () => put(id, { content_merge: { note: "merged" } })],
  ["status", () => put(id, { status: "in_progress" })],
  ["priority", () => put(id, { priority: "high" })],
  ["card_type", () => put(id, { card_type: "bug" })],
  ["is_public", () => put(id, { is_public: true })],
  ["is_sensitive", () => put(id, { is_sensitive: true })],
  ["sort_order", () => put(id, { sort_order: 7 })],
  ["attachments (column, via PUT)", () => put(id, { attachments: [{ name: "a.txt", url: "https://example.com/a.txt" }] })],
  ["attachment (card route)", () => sub(id, "/attachments", "POST", { attachment: { name: "b.txt", url: "https://example.com/b.txt" } })],
  ["comment", () => sub(id, "/comments", "POST", { body: "a comment" })],
  ["second comment, same second", () => sub(id, "/comments", "POST", { body: "another comment" })],
  ["task added", async () => { const r = await task(id, "", "POST", { title: "task one" }); const t = await j(r); taskIds.push(Number(t?.id ?? t?.task?.id)); }],
  ["second task added", async () => { const r = await task(id, "", "POST", { title: "task two" }); const t = await j(r); taskIds.push(Number(t?.id ?? t?.task?.id)); }],
  ["task renamed", () => task(id, `/${taskIds[0]}`, "PUT", { title: "task one renamed" })],
  ["task ticked", () => task(id, `/${taskIds[0]}`, "PUT", { is_completed: true })],
  ["tasks reordered", () => task(id, "/reorder", "POST", { task_ids: [...taskIds].reverse() })],
  ["task deleted", () => task(id, `/${taskIds[1]}`, "DELETE")],
  ["assignee added (self)", () => sub(id, "/assignees", "POST", { user_id: uid })],
  ["moved to another list", () => put(id, { bloq_list_id: OTHER })],
]

const rows: string[] = []
let before = (await card(id))!
for (const [name, run] of changes) {
  const res = await run()
  const code = res instanceof Response ? res.status : "ok"
  const after = await card(id)
  if (!after) { rows.push(`${name.padEnd(30)} HTTP ${code}  card vanished`); continue }
  const faceMoved = face(after) !== face(before)
  const revMoved = after.rev !== before.rev
  const verdict = faceMoved === revMoved ? (faceMoved ? "ok" : "ok (no visible change)") : faceMoved ? "GAP" : "extra"
  rows.push(`${name.padEnd(30)} HTTP ${String(code).padEnd(4)} face ${faceMoved ? "moved" : "same "} · rev ${revMoved ? "moved" : "same "} → ${verdict}`)
  before = after
}
console.log(`card ${id} on board ${BLOQ}\n` + rows.join("\n"))
await irisFetch(`/api/v1/user/bloqs/list/item/${id}`, { method: "DELETE" })
