/**
 * The pure half of the `atlas_epic` chat card: reading the tool's input/metadata into one shape,
 * and the words the buttons put in the composer. Kept out of the .tsx so it is testable without
 * a DOM, and so the card can never disagree with its tests about what a button asks for.
 */

export type EpicStatus = "ready" | "needs" | "done" | "none"
export type EpicKind = "draft" | "alert" | "record" | "note"

export interface CardItem {
  title: string
  subtitle?: string
  body?: string
  kind?: EpicKind
  actions?: string[]
  ref?: { type: string; id: string }
  id?: number
  done?: boolean
}
export interface CardList {
  title: string
  source?: string
  status?: EpicStatus
  label?: string
  items: CardItem[]
}
export interface CardEpic {
  title: string
  summary?: string
  lists: CardList[]
  saved?: boolean
  bloqId?: number
  listIds?: number[]
  reason?: string
  /** True while the call has not completed — the card is drawn from the INPUT. */
  working: boolean
}

const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined)
const STATUSES = new Set(["ready", "needs", "done", "none"])
const KINDS = new Set(["draft", "alert", "record", "note"])

/**
 * Metadata once the tool has finished (it is normalized and carries ids), the raw input while it
 * is still running. Either may be partial — streaming input arrives a field at a time — so every
 * field is read defensively and a list without a title is skipped rather than drawn blank.
 */
export function readEpic(input: unknown, metadata: unknown, status: string | undefined): CardEpic {
  const m = (metadata ?? {}) as Record<string, any>
  const done = status === "completed" && Array.isArray(m.lists)
  const src = (done ? m : (input ?? {})) as Record<string, any>
  const lists: CardList[] = (Array.isArray(src.lists) ? src.lists : [])
    .filter((l: any) => str(l?.title))
    .map((l: any) => ({
      title: str(l.title)!,
      source: str(l.source)?.toLowerCase(),
      status: STATUSES.has(l.status) ? l.status : undefined,
      label: str(l.label),
      items: (Array.isArray(l.items) ? l.items : [])
        .filter((i: any) => str(i?.title))
        .map((i: any) => ({
          title: str(i.title)!,
          subtitle: str(i.subtitle),
          body: str(i.body),
          kind: KINDS.has(i.kind) ? i.kind : undefined,
          actions: Array.isArray(i.actions) ? i.actions.filter((a: unknown) => typeof a === "string") : undefined,
          ref: i.ref && str(i.ref.type) && str(i.ref.id) ? { type: str(i.ref.type)!, id: str(i.ref.id)! } : undefined,
          id: typeof i.id === "number" ? i.id : undefined,
          done: i.done === true || undefined,
        })),
    }))
  return {
    title: str(src.title) ?? "Atlas Epic",
    summary: str(src.summary),
    lists,
    working: !done,
    saved: done ? m.saved === true : undefined,
    bloqId: done && typeof m.bloqId === "number" ? m.bloqId : undefined,
    listIds: done && Array.isArray(m.listIds) ? m.listIds : undefined,
    reason: done ? str(m.reason) : undefined,
  }
}

/** A stable key for an item's tick state: the Atlas id when saved, else its position. */
export const itemKey = (li: number, ii: number, item: CardItem) => (item.id ? `id:${item.id}` : `${li}:${ii}`)

export function progress(epic: CardEpic, ticked: (key: string) => boolean | undefined): { done: number; total: number } {
  let done = 0
  let total = 0
  epic.lists.forEach((l, li) =>
    l.items.forEach((it, ii) => {
      total++
      const t = ticked(itemKey(li, ii, it))
      if (t ?? (it.done || l.status === "done")) done++
    }),
  )
  return { done, total }
}

export function initials(name: string): string {
  const words = name.replace(/[^\p{L}\p{N}\s]/gu, " ").trim().split(/\s+/).filter(Boolean)
  if (words.length === 0) return "?"
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[words.length - 1][0]).toUpperCase()
}

/** A hue from the name, so the same person gets the same avatar colour every time. */
export function hue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0
  return h % 360
}

export const STATUS_LABEL: Record<EpicStatus, string> = {
  ready: "Ready",
  needs: "Needs you",
  done: "Done",
  none: "",
}

/** Two-letter mark for an app with no logo — same idea as the IRIS panel's providerMark. */
const MARKS: Record<string, string> = { calendar: "31", slack: "Sl", stripe: "S", books: "Bk", leads: "Ld", iris: "I" }
export function sourceMark(source: string | undefined): string {
  if (!source) return "•"
  return MARKS[source] ?? (source.slice(0, 2).replace(/^./, (c) => c.toUpperCase()) || "•")
}

export type ButtonAction = "send" | "edit" | "walk" | "dismiss" | "open"

/** Which buttons an item shows. Explicit `actions` win; otherwise the kind decides. */
export function buttonsFor(item: CardItem): ButtonAction[] {
  const kind = item.kind ?? (item.body ? "draft" : undefined)
  if (item.actions?.length) {
    const out: ButtonAction[] = []
    if (item.actions.includes("send")) out.push("send")
    if (item.actions.includes("edit")) out.push("edit")
    if (item.actions.includes("open")) out.push(kind === "alert" ? "walk" : "open")
    if (item.actions.includes("dismiss")) out.push("dismiss")
    return out
  }
  if (kind === "draft") return ["send", "edit"]
  if (kind === "alert") return ["walk", "dismiss"]
  return []
}

export const BUTTON_LABEL: Record<ButtonAction, string> = {
  send: "Review & send",
  edit: "Edit",
  walk: "Walk me through it",
  dismiss: "Dismiss",
  open: "Open",
}

/**
 * What a button puts in the composer. Nothing is sent by the click: the person reads this, can
 * change it, and presses enter — and the agent then acts on it as a normal request.
 * "Dismiss" has no prompt: it is local, it ticks the item off (and saves that, when saved).
 */
export function promptFor(action: Exclude<ButtonAction, "dismiss">, item: CardItem, list: CardList): string {
  const about = item.subtitle ? ` ("${item.subtitle}")` : ""
  const ref = item.ref ? ` [${item.ref.type} ${item.ref.id}]` : ""
  const where = list.source ? ` in ${list.source}` : ""
  switch (action) {
    case "send":
      return `Send the drafted reply to ${item.title}${about}${ref}${where}.`
    case "edit":
      return `Edit the drafted reply to ${item.title}${about}${ref}: `
    case "walk":
      return `Walk me through "${item.title}"${about}${ref} from "${list.title}".`
    case "open":
      return `Open ${item.title}${about}${ref}${where}.`
  }
}
