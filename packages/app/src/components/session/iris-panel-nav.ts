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
  if (pane === "artifacts" || pane === "atlas-artifacts") return "session"
  if (ACCOUNT_SURFACES.has(surface) || pane === "graph" || pane === "catalog" || pane === "rooms") return "account"
  return "project"
}

/**
 * THE FILE TREE IS A PIN TOO (#187129). The Review/file-tree tab sat first in the strip for
 * everyone, with no way to remove it — in front of the products a non-technical person came for.
 * It now obeys the same rule as the products: shown when pinned, reachable from "+" when not.
 *
 * Nothing stored is the case that decides who loses what. The tab's default was already "Review
 * first" in a git project and nothing useful elsewhere (`reviewFirst`, helpers.ts), so a git
 * project keeps it — that is where a developer uses it daily — and anything else starts without
 * it. Once someone pins or unpins, that choice is stored and wins everywhere.
 *
 * What stays in the strip no matter what is a short, deliberate list: the "+" menu, because it is
 * the only way back to anything unpinned. Everything else is a pin.
 */
export const FILES_PIN_KEY = "iris.panel.files"

export function filesTabPinned(raw: string | null, isGitProject: boolean): boolean {
  if (raw === "1") return true
  if (raw === "0") return false
  return isGitProject
}

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
