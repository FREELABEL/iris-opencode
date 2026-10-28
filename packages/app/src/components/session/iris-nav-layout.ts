/**
 * THE SIDE PANEL'S LAYOUT IS DATA (#191509).
 *
 * Which items the panel's strip shows, in what order, comes from one record: a versioned DEFAULT
 * that ships with the app, merged with the layout the person saved. The renderer maps over the
 * result and never asks "is this Atlas?" — changing what a new user sees is an edit to
 * DEFAULT_NAV_LAYOUT, not to a component.
 *
 * The rule that decides everything: a choice the person made always wins. A new default reaches
 * only what they have never seen — an item that is not in their saved layout at all — and it
 * lands where the default puts it. Nothing they showed is hidden again; nothing they hid comes
 * back; their order is never reshuffled.
 */

/** A layout: every item, in order, and the ones not shown. Items are product ids, plus `files`. */
export type NavLayout = { version: number; order: string[]; hidden: string[] }

export const NAV_LAYOUT_KEY = "iris.panel.navLayout"
/** The file tree's id in the layout. It is an item like any product, not a special case. */
export const FILES_ITEM = "files"
/** Where the layout lived before #191509 — read once, to carry an existing person's choices over. */
export const LEGACY_PINS_KEY = "iris.panel.pinned"
export const LEGACY_FILES_KEY = "iris.panel.files"

/**
 * v2 (#191509): a new person meets Atlas (their records), then Genesis (their pages). The file
 * tree is hidden — reachable from "+", not the first thing on screen. v1 was the pre-#191509
 * behaviour: Genesis, Atlas, Agents, Pulse pinned, the file tree shown in git projects.
 */
export const DEFAULT_NAV_LAYOUT: NavLayout = {
  version: 2,
  order: ["atlas", "pages", "agents", "pulse", FILES_ITEM, "leads", "playbooks", "hive", "integrations", "mcp"],
  hidden: [FILES_ITEM, "leads", "playbooks", "hive", "integrations", "mcp"],
}

const uniq = (xs: string[]) => [...new Set(xs)]

/**
 * The layout to draw: the default, with the person's saved choices on top.
 *
 * - Nothing saved → the default.
 * - Saved → their order and their visibility, for every item they have seen (it is in their
 *   `order` or `hidden`). Ids the app no longer knows are dropped.
 * - An item they have never seen goes in at the default's position (right after the nearest item
 *   that precedes it in the default) with the default's visibility.
 */
export function mergeNavLayout(def: NavLayout, saved: NavLayout | null | undefined): NavLayout {
  if (!saved) return { version: def.version, order: [...def.order], hidden: [...def.hidden] }
  const known = new Set(def.order)
  const savedHidden = new Set(saved.hidden.filter((id) => known.has(id)))
  const order = uniq(saved.order.filter((id) => known.has(id)))
  const seen = new Set([...order, ...savedHidden])
  const defHidden = new Set(def.hidden)
  // Items hidden but missing from `order` are seen — they just need a slot, the default's.
  def.order.forEach((id, i) => {
    if (order.includes(id)) return
    const before = def.order.slice(0, i).reverse().find((x) => order.includes(x))
    order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, id)
  })
  const hidden = order.filter((id) => (seen.has(id) ? savedHidden.has(id) : defHidden.has(id)))
  return { version: def.version, order, hidden }
}

/** Show or hide one item. Showing an item puts it after the last shown one, as pinning always did. */
export function setNavItemVisible(layout: NavLayout, id: string, visible: boolean): NavLayout {
  const hidden = visible ? layout.hidden.filter((x) => x !== id) : uniq([...layout.hidden, id])
  if (!visible || !layout.hidden.includes(id)) return { ...layout, hidden }
  const rest = layout.order.filter((x) => x !== id)
  const lastShown = rest.reduce((at, x, i) => (layout.hidden.includes(x) ? at : i), -1)
  rest.splice(lastShown + 1, 0, id)
  return { ...layout, order: rest, hidden }
}

/** The shown items, in order. */
export function visibleNavItems(layout: NavLayout): string[] {
  return layout.order.filter((id) => !layout.hidden.includes(id))
}

export const isNavItemVisible = (layout: NavLayout, id: string) =>
  layout.order.includes(id) && !layout.hidden.includes(id)

/** A stored layout, or null when there is none or it is not one. */
export function parseNavLayout(raw: string | null): NavLayout | null {
  try {
    const v = JSON.parse(raw ?? "null")
    if (!v || typeof v !== "object" || !Array.isArray(v.order)) return null
    const strings = (xs: unknown) => (Array.isArray(xs) ? xs.filter((x): x is string => typeof x === "string") : [])
    return { version: typeof v.version === "number" ? v.version : 1, order: strings(v.order), hidden: strings(v.hidden) }
  } catch {
    return null
  }
}

/**
 * The layout a person saved BEFORE #191509, as a v1 layout — or null if they saved nothing.
 *
 * Their pinned products were a choice: pinned is shown in that order, unpinned is hidden. Their
 * file-tree choice ("1"/"0") is kept. A person with pins who never touched the file tree had it
 * in their strip (in git projects, the only place it can show), so it stays shown.
 */
export function legacyNavLayout(pinsRaw: string | null, filesRaw: string | null, def: NavLayout): NavLayout | null {
  let pins: string[] | null = null
  try {
    const list = JSON.parse(pinsRaw ?? "null")
    if (Array.isArray(list)) {
      const ok = uniq(list.filter((x): x is string => typeof x === "string" && x !== FILES_ITEM && def.order.includes(x)))
      if (ok.length) pins = ok
    }
  } catch {}
  const filesChoice = filesRaw === "1" || filesRaw === "0"
  if (!pins && !filesChoice) return null
  const order = [...(pins ?? [])]
  const hidden = pins ? def.order.filter((id) => id !== FILES_ITEM && !pins.includes(id)) : []
  if (filesRaw === "0") hidden.push(FILES_ITEM)
  else if (filesChoice || pins) order.unshift(FILES_ITEM)
  return { version: 1, order, hidden }
}
