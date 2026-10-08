import { irisFetch, resolveUserId } from "../cmd/iris-api"
import { matchesSearchQuery } from "../cmd/bloq-item-format"

/**
 * "transcribe this IG for IRIS ORBIT" (#188392). The router kept the verb and dropped the
 * destination, so the transcript landed in ~/.iris/transcripts and nothing tied it to the
 * project that was the reason for asking. `--for <project>` carries that second half: resolve
 * a project NAME to a bloq, and file the result there as an item whose id is printed.
 *
 * Resolution refuses rather than guesses. Filing a client's transcript into the wrong board
 * is worse than not filing it, so anything but one clear match comes back as an error that
 * names the candidates.
 */

export type BloqRef = { id: number; name: string }

const norm = (s: string) =>
  String(s ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()

/**
 * Pick the bloq a project name means. Pure, so it is testable without the network.
 *   1. a numeric id ("735" / "#735") wins outright
 *   2. exact name match (punctuation-insensitive)
 *   3. exactly ONE bloq whose name contains every query word ("iris orbit" → "Iris Orbit — Orbital …")
 * Two or more at tier 3 is ambiguous even if one of them starts with the query — "orbit" must
 * not quietly mean "Orbit Fans" because it sorts first.
 */
export function pickProject(
  query: string,
  bloqs: BloqRef[],
): { bloq: BloqRef } | { error: string; candidates: BloqRef[] } {
  const raw = query.trim()
  const asId = /^#?(\d+)$/.exec(raw)
  if (asId) {
    const hit = bloqs.find((b) => b.id === Number(asId[1]))
    return hit ? { bloq: hit } : { error: `no project with id #${asId[1]}`, candidates: [] }
  }
  const q = norm(raw)
  if (!q) return { error: "no project name given", candidates: [] }
  const tiers: ((b: BloqRef) => boolean)[] = [
    (b) => norm(b.name) === q,
    (b) => matchesSearchQuery(norm(b.name), q),
  ]
  for (const tier of tiers) {
    const hits = bloqs.filter(tier)
    if (hits.length === 1) return { bloq: hits[0] }
    if (hits.length > 1) {
      return {
        error: `"${raw}" matches ${hits.length} projects — pass the id instead (--for <id>)`,
        candidates: hits.slice(0, 8),
      }
    }
  }
  return { error: `no project matches "${raw}" — see: iris bloqs list --search "${raw}"`, candidates: [] }
}

/** The list a filed capture goes to: one called Ideas, else Todo, else the first list. */
export function pickList(lists: { id: number; name?: string }[]): { id: number; name?: string } | undefined {
  const by = (re: RegExp) => lists.find((l) => re.test(String(l.name ?? "")))
  return by(/\bideas?\b/i) ?? by(/\btodo\b/i) ?? lists[0]
}

export type Filed = { ok: true; id: number; bloq: BloqRef; listId: number } | { ok: false; error: string }

export async function fileToProject(project: string, title: string, content: string): Promise<Filed> {
  const userId = await resolveUserId()
  if (!userId) return { ok: false, error: "not logged in — run: iris auth login" }

  const res = await irisFetch(`/api/v1/user/${userId}/bloqs?per_page=500&simplified=1`)
  if (!res.ok) return { ok: false, error: `could not list projects (HTTP ${res.status})` }
  const body = (await res.json().catch(() => null)) as any
  const rows: any[] = Array.isArray(body?.data) ? body.data : Array.isArray(body?.data?.data) ? body.data.data : []
  const picked = pickProject(
    project,
    rows.map((b) => ({ id: Number(b.id), name: String(b.name ?? b.title ?? "") })),
  )
  if ("error" in picked) {
    const also = picked.candidates.map((b) => `${b.name} #${b.id}`).join(" · ")
    return { ok: false, error: also ? `${picked.error}: ${also}` : picked.error }
  }

  const listsRes = await irisFetch(`/api/v1/user/${userId}/bloqs/${picked.bloq.id}/lists`)
  const lists = ((await listsRes.json().catch(() => null)) as any)?.data
  const list = Array.isArray(lists) ? pickList(lists.map((l: any) => ({ id: Number(l.id), name: l.name }))) : undefined
  if (!list) return { ok: false, error: `project #${picked.bloq.id} has no list to file into` }

  const add = await irisFetch(`/api/v1/user/${userId}/bloqs/${picked.bloq.id}/items`, {
    method: "POST",
    // Titles over 191 chars 500 on the server (#188294) — never send one.
    body: JSON.stringify({ title: title.slice(0, 191), content, list_id: list.id, type: "default" }),
  })
  if (!add.ok) return { ok: false, error: `could not file to ${picked.bloq.name} (HTTP ${add.status})` }
  const out = (await add.json().catch(() => null)) as any
  const id = Number(out?.data?.id ?? out?.data?.data?.id ?? out?.id)
  if (!id) return { ok: false, error: "the server accepted the item but returned no id — check the project" }
  return { ok: true, id, bloq: picked.bloq, listId: list.id }
}
