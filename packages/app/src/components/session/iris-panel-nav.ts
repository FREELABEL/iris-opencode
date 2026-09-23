/**
 * The IRIS panel's navigation, as pure functions (#186509 nav): project first, products as tabs
 * you pin. Kept out of session-iris-tab.tsx so it is testable without mounting the panel.
 */

/** Products that belong to the account or machine, not to a project. */
export const ACCOUNT_SURFACES = new Set<string>(["hive", "integrations", "mcp"])

/** The pinned product ids from storage — unknown ids dropped, duplicates removed, never empty. */
export function readPinnedIds<T extends string>(raw: string | null, valid: readonly string[], fallback: T[]): T[] {
  try {
    const list = JSON.parse(raw ?? "null")
    if (Array.isArray(list)) {
      const ok = list.filter((x): x is T => typeof x === "string" && valid.includes(x))
      if (ok.length) return [...new Set(ok)]
    }
  } catch {}
  return [...fallback]
}

/** The tabs actually drawn: the pinned set, plus the active product if it is not pinned. */
export function visibleTabs<T extends string>(pinned: T[], active: T): T[] {
  return pinned.includes(active) ? pinned : [...pinned, active]
}

/** What the project row says: the project, or honestly that this view is not per-project. */
export function panelScope(surface: string, pane: string): "project" | "session" | "account" {
  if (pane === "artifacts") return "session"
  if (ACCOUNT_SURFACES.has(surface) || pane === "graph" || pane === "catalog" || pane === "rooms") return "account"
  return "project"
}
