/**
 * Agent ownership — every agent belongs to a project (bloq), and the CLI must be able to
 * tell which agents do not (#189966 / #189967, epic "Agents Everywhere" #189973).
 *
 * Two failures this module exists to stop:
 *
 *  1. `iris agents create` without --bloq made an agent that lives nowhere: no project, no
 *     board, nothing a teammate can find. Creation now refuses without an owner project.
 *
 *  2. `iris agents list --orphaned` / `--workspace-orphaned` / `bulk-delete --orphaned`
 *     filtered client-side on `bloq_id` / `workspace_id`, fields the list payload did not
 *     carry. `!undefined` is true, so the filter could not tell "orphaned" from "field
 *     missing" — the list answered for every agent, and bulk-delete --orphaned would have
 *     selected EVERY agent the account owns. A filter that cannot be evaluated must say so,
 *     and a destructive one must refuse.
 */

export const OWNER_BLOQ_REQUIRED_MESSAGE =
  "Every agent needs an owner project. Pass --bloq <id> (see: iris atlas list)"

/** Parse the owner project id from --bloq-id / --bloq. Positive integers only. */
export function resolveOwnerBloq(raw: unknown): { bloqId: number } | { error: string } {
  const n = typeof raw === "number" ? raw : typeof raw === "string" && raw.trim() !== "" ? Number(raw) : NaN
  if (!Number.isInteger(n) || n <= 0) return { error: OWNER_BLOQ_REQUIRED_MESSAGE }
  return { bloqId: n }
}

export type OwnershipField = "bloq_id" | "workspace_id"

export interface OwnershipFilters {
  orphaned?: boolean
  workspaceOrphaned?: boolean
}

/** Server-side query params for the ownership filters (fl-api #189967). */
export function ownershipQueryParams(filters: OwnershipFilters): Record<string, string> {
  const out: Record<string, string> = {}
  if (filters.orphaned) out.orphaned = "1"
  if (filters.workspaceOrphaned) out.workspace_orphaned = "1"
  return out
}

/** A field is evaluable only if every record actually carries the key (null counts; absent does not). */
export function fieldIsEvaluable(agents: Record<string, unknown>[], field: OwnershipField): boolean {
  return agents.every((a) => a != null && typeof a === "object" && Object.prototype.hasOwnProperty.call(a, field))
}

/**
 * Apply the ownership filters client-side, as a second check on the server's answer (an old
 * server ignores the query param and returns everything). Returns the fields that could not
 * be evaluated — the caller must surface them instead of presenting the result as an answer.
 * When a field is unevaluable, the records are left UNFILTERED for that predicate.
 */
export function filterByOwnership<T extends Record<string, unknown>>(
  agents: T[],
  filters: OwnershipFilters,
): { agents: T[]; unevaluable: OwnershipField[] } {
  const unevaluable: OwnershipField[] = []
  let out = agents
  const apply = (on: boolean | undefined, field: OwnershipField) => {
    if (!on) return
    if (!fieldIsEvaluable(out, field)) {
      unevaluable.push(field)
      return
    }
    out = out.filter((a) => a[field] === null || a[field] === undefined || a[field] === 0 || a[field] === "")
  }
  apply(filters.orphaned, "bloq_id")
  apply(filters.workspaceOrphaned, "workspace_id")
  return { agents: out, unevaluable }
}

export function unevaluableWarning(fields: OwnershipField[]): string {
  return (
    `The server's agent list does not include ${fields.join(" / ")}, so this filter cannot be evaluated — ` +
    `the result below is NOT filtered by it. Update fl-api (#189967) or check agents individually with ` +
    `\`iris agents get <id>\`.`
  )
}

/**
 * Bulk delete must never act on a predicate it cannot evaluate. Returns a refusal message,
 * or null when it is safe to proceed.
 */
export function bulkDeleteRefusal(
  agents: Record<string, unknown>[],
  filters: { orphaned?: boolean; bloq?: number },
): string | null {
  const missing: OwnershipField[] = []
  if ((filters.orphaned || filters.bloq) && !fieldIsEvaluable(agents, "bloq_id")) missing.push("bloq_id")
  if (missing.length === 0) return null
  return (
    `Refusing to bulk-delete: the server's agent list does not include ${missing.join(", ")}, so ` +
    `${filters.orphaned ? "--orphaned" : "--bloq"} cannot tell which agents match — it would have selected ` +
    `agents by a field that is not there. Delete by explicit id instead: iris agents bulk-delete --ids 1,2,3`
  )
}
