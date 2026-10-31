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

/**
 * Did the person pin this product THEMSELVES (#189766)? Only a stored, valid pin list counts.
 * The default set (pages, atlas, agents, pulse) is what everyone gets without choosing, so
 * reading it as a choice would make "only if they added it" true for nearly everyone.
 */
export function pinnedByChoice(raw: string | null, id: string): boolean {
  try {
    const list = JSON.parse(raw ?? "null")
    return Array.isArray(list) && list.includes(id)
  } catch {
    return false
  }
}

/**
 * Which product the panel opens on when the app starts (#189766). Atlas, for anyone who pinned
 * it; everyone else gets the product they used last, exactly as before. Applied once per launch
 * — a product you pick after that stays picked until the next launch.
 */
export function openingSurface<T extends string>(lastUsed: T, pinsRaw: string | null): T | "atlas" {
  return pinnedByChoice(pinsRaw, "atlas") ? "atlas" : lastUsed
}

/** The tabs actually drawn: the pinned set, plus the active product if it is not pinned. */
export function visibleTabs<T extends string>(pinned: T[], active: T): T[] {
  return pinned.includes(active) ? pinned : [...pinned, active]
}

/** What the project row says: the project, or honestly that this view is not per-project. */
export function panelScope(surface: string, pane: string): "project" | "session" | "account" {
  if (pane === "artifacts" || pane === "atlas-artifacts") return "session"
  if (ACCOUNT_SURFACES.has(surface) || pane === "graph" || pane === "catalog" || pane === "rooms") return "account"
  return "project"
}

/**
 * THE FILE TREE IS A PIN TOO (#187129): shown when pinned, reachable from "+" when not. Its
 * visibility now lives in the panel's layout with the products' (#191509, iris-nav-layout.ts).
 */

/**
 * The scope chip's words (#187130, option C). The row it replaces NAMED the project — that is how
 * a person knew which project they were in — so a project view shows the name, never the word
 * "project". Session and account views say so plainly.
 */
export function scopeChipLabel(scope: "project" | "session" | "account", projectName?: string): string {
  if (scope === "session") return "this session"
  if (scope === "account") return "account"
  return projectName?.trim() || "choose a project"
}
