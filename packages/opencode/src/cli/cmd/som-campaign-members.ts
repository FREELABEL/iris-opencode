// ─── iris som campaign members / mine — pure helpers (#193486) ───────────────
//
// The API (fl-api SomCampaignMemberController):
//   GET    /api/v1/som/campaigns/{idOrName}/members
//   POST   /api/v1/som/campaigns/{idOrName}/members   {type, id|email, role}
//   DELETE /api/v1/som/campaigns/{idOrName}/members?type=&id=
//   GET    /api/v1/som/campaigns/mine[?agent_id=&active=1&live=1]
// Kept free of I/O so the argument rules and the output are testable.

export type MemberType = "user" | "agent"
export type MemberRole = "owner" | "rep"

export interface CampaignMember {
  type: MemberType
  id: number
  name: string | null
  role: MemberRole
}

export interface MemberArgs {
  user?: string | number
  agent?: string | number
  role?: string
}

/** Who a members add/remove names: exactly one of --user (id or email) or --agent (id). */
export function memberTarget(
  args: MemberArgs,
): { ok: true; type: MemberType; id?: number; email?: string } | { ok: false; error: string } {
  const hasUser = args.user !== undefined && String(args.user).trim() !== ""
  const hasAgent = args.agent !== undefined && String(args.agent).trim() !== ""
  if (hasUser === hasAgent) return { ok: false, error: "give exactly one of --user <id|email> or --agent <id>" }

  if (hasAgent) {
    const id = Number(String(args.agent).trim())
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: `--agent must be a numeric agent id, got "${args.agent}"` }
    return { ok: true, type: "agent", id }
  }

  const raw = String(args.user).trim()
  if (/^\d+$/.test(raw)) return { ok: true, type: "user", id: Number(raw) }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) return { ok: true, type: "user", email: raw }
  return { ok: false, error: `--user must be a user id or an email, got "${raw}"` }
}

/** POST body for adding (or re-roling) a member. Role defaults to rep, as on the server. */
export function addBody(args: MemberArgs): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const t = memberTarget(args)
  if (!t.ok) return t
  const role = args.role ?? "rep"
  if (role !== "owner" && role !== "rep") return { ok: false, error: `--role must be owner or rep, got "${role}"` }
  const body: Record<string, unknown> = { type: t.type, role }
  if (t.id !== undefined) body.id = t.id
  if (t.email !== undefined) body.email = t.email
  return { ok: true, body }
}

/** DELETE query for removing a member. The server removes by id, so an email cannot be used here. */
export function removeQuery(args: MemberArgs): { ok: true; qs: string } | { ok: false; error: string } {
  const t = memberTarget(args)
  if (!t.ok) return t
  if (t.id === undefined) return { ok: false, error: "remove needs a numeric --user id (see: iris som campaign members <campaign>)" }
  return { ok: true, qs: new URLSearchParams({ type: t.type, id: String(t.id) }).toString() }
}

/** Query string for `mine`. */
export function mineQuery(args: { agent?: string | number; active?: boolean; live?: boolean }): string {
  const p = new URLSearchParams()
  if (args.agent !== undefined && String(args.agent).trim() !== "") p.set("agent_id", String(args.agent).trim())
  if (args.active) p.set("active", "1")
  if (args.live) p.set("live", "1")
  const s = p.toString()
  return s ? `?${s}` : ""
}

/** One line per member: role, type, id, name. Owners first (the server already orders them). */
export function formatMembers(members: CampaignMember[]): string[] {
  if (members.length === 0) return ["  (no members — add one: iris som campaign members <campaign> add --user <id|email> --role owner)"]
  return members.map((m) => {
    const role = m.role === "owner" ? "owner" : "rep  "
    const who = `${m.type} #${m.id}`.padEnd(14)
    return `  ${role}  ${who} ${m.name ?? "(unknown — removed?)"}`
  })
}

/** Short members summary for a campaign row: "owner Ana · 2 reps". */
export function membersSummary(members: CampaignMember[] | undefined): string {
  if (!members || members.length === 0) return "no members"
  const owner = members.find((m) => m.role === "owner")
  const reps = members.filter((m) => m.role === "rep").length
  const parts: string[] = []
  if (owner) parts.push(`owner ${owner.name ?? `${owner.type} #${owner.id}`}`)
  if (reps) parts.push(`${reps} rep${reps === 1 ? "" : "s"}`)
  return parts.join(" · ")
}
