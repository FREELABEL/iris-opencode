/**
 * Flag parsing for seats (#192422) — pure, so every shape a person types is tested.
 *
 *   --set egress=self --set payment=12        decision rights: who decides each effect
 *   --cap egress.per_hour=5                   a seat's rate caps
 *   --add "dso|DSO under 40|iris invoices dso --max 40"   an objective: id | title | exit_check
 */

export const DECISION_TYPES = ["own_write", "unclassified", "shared_write", "shared_overwrite", "egress", "payment"] as const
export const CAPPED = ["shared_write", "shared_overwrite", "egress", "payment"] as const

export class SeatArgError extends Error {}

const list = (raw: unknown): string[] => ([] as unknown[]).concat(raw ?? []).map(String).filter(Boolean)

/** `egress=self`, `payment=12` → `{ egress: "self", payment: 12 }`; `egress=` (empty) removes it. */
export function parseRights(raw: unknown, current: Record<string, unknown> = {}): Record<string, "self" | number> {
  const out: Record<string, "self" | number> = {}
  for (const [k, v] of Object.entries(current ?? {})) {
    const d = typeof v === "object" && v !== null ? (v as any).decide : v
    if (d === "self" || typeof d === "number") out[k] = d
  }
  for (const pair of list(raw)) {
    const i = pair.indexOf("=")
    if (i <= 0) throw new SeatArgError(`--set "${pair}" must be effect=self|<seat id>`)
    const effect = pair.slice(0, i).trim()
    const val = pair.slice(i + 1).trim()
    if (!(DECISION_TYPES as readonly string[]).includes(effect))
      throw new SeatArgError(`"${effect}" is not a decision type. One of: ${DECISION_TYPES.join(", ")}`)
    if (val === "") delete out[effect]
    else if (val === "self") out[effect] = "self"
    else if (/^\d+$/.test(val)) out[effect] = Number(val)
    else throw new SeatArgError(`--set ${effect}=${val}: the decider is "self" or a seat id`)
  }
  return out
}

/** `egress.per_hour=5` → `{ rate_caps: { egress: { per_hour: 5 } } }`, merged onto the current limits. */
export function parseCaps(raw: unknown, current: Record<string, any> | null = null): Record<string, any> | null {
  const out: Record<string, any> = JSON.parse(JSON.stringify(current ?? {}))
  for (const pair of list(raw)) {
    const m = pair.match(/^([a-z_]+)\.(per_hour|per_day)=(\d*)$/)
    if (!m) throw new SeatArgError(`--cap "${pair}" must be effect.per_hour|per_day=<n>`)
    const [, effect, window, n] = m
    if (!(CAPPED as readonly string[]).includes(effect)) throw new SeatArgError(`--cap ${effect}: only ${CAPPED.join(", ")} are counted`)
    out.rate_caps ??= {}
    out.rate_caps[effect] ??= {}
    if (n === "") delete out.rate_caps[effect][window]
    else out.rate_caps[effect][window] = Number(n)
    if (!Object.keys(out.rate_caps[effect]).length) delete out.rate_caps[effect]
  }
  if (out.rate_caps && !Object.keys(out.rate_caps).length) delete out.rate_caps
  return Object.keys(out).length ? out : null
}

export interface Objective {
  id: string
  title: string
  exit_check: string
  last?: { ok: boolean; at: string; exit_code: number | null; output?: string }
}

/** `id|title|command` → an objective. The command may itself contain `|`: only the first two split. */
export function parseObjective(raw: string): Objective {
  const s = String(raw ?? "")
  const a = s.indexOf("|")
  const b = a < 0 ? -1 : s.indexOf("|", a + 1)
  if (a < 0 || b < 0) throw new SeatArgError(`--add "${s}" must be "id|title|exit_check command"`)
  const id = s.slice(0, a).trim()
  const title = s.slice(a + 1, b).trim()
  const exit_check = s.slice(b + 1).trim()
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(id)) throw new SeatArgError(`objective id "${id}" must be a slug`)
  if (!title || !exit_check) throw new SeatArgError("an objective needs a title and an exit_check command — a goal no command can score is not an objective")
  return { id, title, exit_check }
}

/**
 * Who reviews a seat's red objective: the holder of the seat it reports to — the seat with
 * authority over it. A vacant or agent-held parent escalates to the next human up. Null = nobody
 * up the line; the owner reviews.
 */
export function reviewerFor(roleId: number, roles: Array<{ id: number; reports_to_role_id: number | null; holder: { type: string; id: number } | null; title?: string }>) {
  const byId = new Map(roles.map((r) => [r.id, r]))
  let r = byId.get(byId.get(roleId)?.reports_to_role_id ?? -1)
  for (let guard = 0; r && guard < 20; guard++) {
    if (r.holder?.type === "human") return { role_id: r.id, title: r.title ?? `#${r.id}`, user_id: r.holder.id }
    r = byId.get(r.reports_to_role_id ?? -1)
  }
  return null
}
