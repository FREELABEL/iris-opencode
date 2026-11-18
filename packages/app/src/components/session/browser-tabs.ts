import { createSignal } from "solid-js"

/**
 * The Browser's tabs, per chat (#193328).
 *
 * Each chat keeps its own row of tabs, so switching chats swaps the whole set (#543: a chat never
 * shows another chat's pages). A tab is a page key the native Browser knows: the chat's FIRST tab
 * is the chat id itself — the page every chat already had, so nothing a chat had open is lost —
 * and its other tabs are "<chat>:<tab id>".
 *
 * The person adds, closes and switches tabs; the agent opens one with a label ("Car rental",
 * "Map", "Itinerary") and names the tab it acts on. Same rules in every tab: the Allow, the human
 * check and the confirm-once live on the page command, not here.
 */

export type BrowserTab = {
  /** "1" is the chat's first tab; the others "t2", "t3"… never reused within a chat. */
  id: string
  /** What the agent or a link called it; the page title shows when there is none. */
  label?: string
}

type ChatTabs = { tabs: BrowserTab[]; active: string; next: number }

/** Each tab is a native webview (~100 MB): a chat holds at most this many. */
export const MAX_TABS = 6
const FIRST = "1"

const [all, setAll] = createSignal<Record<string, ChatTabs>>({})

const fresh = (): ChatTabs => ({ tabs: [{ id: FIRST }], active: FIRST, next: 2 })
const read = (chat: string): ChatTabs => all()[chat] ?? fresh()
const write = (chat: string, v: ChatTabs) => setAll((m) => ({ ...m, [chat]: v }))

/** The native Browser's page key for a chat's tab. */
export function pageKey(chat: string, tab: string): string {
  return tab === FIRST ? chat : `${chat}:${tab}`
}

/** The chat and tab a page key belongs to, or undefined for a key that is not a page's. */
export function fromPageKey(key: string): { chat: string; tab: string } | undefined {
  const i = key.indexOf(":")
  if (i < 0) return key ? { chat: key, tab: FIRST } : undefined
  const chat = key.slice(0, i)
  const tab = key.slice(i + 1)
  return chat && /^[a-z0-9]{1,8}$/.test(tab) ? { chat, tab } : undefined
}

export function tabsOf(chat: string): BrowserTab[] {
  return read(chat).tabs
}

export function activeTab(chat: string): string {
  return read(chat).active
}

export function setActiveTab(chat: string, tab: string): boolean {
  const c = read(chat)
  if (!c.tabs.some((t) => t.id === tab)) return false
  if (c.active !== tab) write(chat, { ...c, active: tab })
  return true
}

/** Open a new tab and show it. Undefined when the chat already has MAX_TABS. */
export function addTab(chat: string, label?: string, opts: { show?: boolean } = {}): string | undefined {
  const c = read(chat)
  if (c.tabs.length >= MAX_TABS) return undefined
  const id = `t${c.next}`
  const tab: BrowserTab = { id, ...(label?.trim() ? { label: label.trim().slice(0, 40) } : {}) }
  write(chat, { tabs: [...c.tabs, tab], active: opts.show === false ? c.active : id, next: c.next + 1 })
  return id
}

export function renameTab(chat: string, tab: string, label: string) {
  const c = read(chat)
  write(chat, { ...c, tabs: c.tabs.map((t) => (t.id === tab ? { ...t, label: label.trim().slice(0, 40) || undefined } : t)) })
}

/**
 * Close a tab. The last tab never closes (the Browser always has a page to show); closing the
 * active one shows its neighbour. Returns the tab now shown, or undefined if nothing closed.
 */
export function closeTab(chat: string, tab: string): string | undefined {
  const c = read(chat)
  const at = c.tabs.findIndex((t) => t.id === tab)
  if (at < 0 || c.tabs.length <= 1) return undefined
  const tabs = c.tabs.filter((t) => t.id !== tab)
  const active = c.active === tab ? tabs[Math.min(at, tabs.length - 1)]!.id : c.active
  write(chat, { ...c, tabs, active })
  return active
}

/**
 * Which tab the agent means: its number in the row ("2"), its id ("t2"), or its label, any case
 * ("map"). Undefined when nothing matches — the caller lists what there is.
 */
export function resolveTab(chat: string, ref: string | undefined): string | undefined {
  const c = read(chat)
  const want = String(ref ?? "").trim()
  if (!want) return c.active
  if (/^\d+$/.test(want)) return c.tabs[Number(want) - 1]?.id
  const lower = want.toLowerCase()
  return (
    c.tabs.find((t) => t.id === lower)?.id ??
    c.tabs.find((t) => t.label?.toLowerCase() === lower)?.id ??
    c.tabs.find((t) => t.label?.toLowerCase().includes(lower))?.id
  )
}

/** A short name for a new tab opened by a page: the site it goes to. */
export function labelForUrl(url: string): string | undefined {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return undefined
  }
}

/** Test seam: forget every chat's tabs. */
export function resetBrowserTabs() {
  setAll({})
}

/** An address a tab opens when it first shows (a new tab from the agent or a page's link). */
const pending = new Map<string, string>()
export function setPendingOpen(key: string, url: string) {
  pending.set(key, url)
}
export function takePendingOpen(key: string): string | undefined {
  const u = pending.get(key)
  pending.delete(key)
  return u
}

/** What each tab's page last said it was: the strip's titles, and the agent's list of tabs. */
const [pages, setPages] = createSignal<Record<string, { url?: string; title?: string | null }>>({})
export function noteTabPage(key: string, s: { url?: string; title?: string | null }) {
  const prev = pages()[key]
  if (prev?.url === s.url && (s.title === undefined || prev?.title === s.title)) return
  setPages((m) => ({ ...m, [key]: { url: s.url, title: s.title ?? prev?.title } }))
}
export function tabPage(key: string) {
  return pages()[key]
}
export function forgetTabPage(key: string) {
  setPages((m) => {
    const { [key]: _, ...rest } = m
    return rest
  })
}

/** What a tab is called on screen: its label, else the page's title or site, else "New tab". */
export function tabName(chat: string, tab: BrowserTab): string {
  if (tab.label) return tab.label
  const p = tabPage(pageKey(chat, tab.id))
  return p?.title?.trim() || (p?.url && p.url !== "about:blank" ? labelForUrl(p.url) : undefined) || "New tab"
}

/** The chat's tabs as the agent reads them: number, name, address, and which one is showing. */
export function describeTabs(chat: string): { n: number; id: string; label?: string; title?: string; url?: string; active: boolean }[] {
  const c = read(chat)
  return c.tabs.map((t, i) => {
    const p = tabPage(pageKey(chat, t.id))
    return {
      n: i + 1,
      id: t.id,
      ...(t.label ? { label: t.label } : {}),
      ...(p?.title ? { title: p.title } : {}),
      ...(p?.url && p.url !== "about:blank" ? { url: p.url } : {}),
      active: t.id === c.active,
    }
  })
}
