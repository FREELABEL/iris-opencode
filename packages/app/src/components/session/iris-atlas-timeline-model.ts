/**
 * Atlas › Timeline — the same lists, laid out against the calendar.
 *
 * Pure, so the date rules are tested without a DOM. It runs on the lists the filters already
 * produced; it never refetches.
 *
 * A card is placed by the dates someone SET: start → due is a bar, one of the two is a single day.
 * A card with neither is not drawn. Created and last-edited say what happened, not what is planned,
 * and drawing them would invent a schedule nobody set.
 */
import { asDate, dueState, isDone, type DueState } from "./iris-atlas-view"

export type TimelineZoom = "week" | "month" | "quarter"
export const TIMELINE_ZOOMS: { id: TimelineZoom; label: string }[] = [
  { id: "week", label: "Week" },
  { id: "month", label: "Month" },
  { id: "quarter", label: "Quarter" },
]
export const TIMELINE_ZOOM_DEFAULT: TimelineZoom = "month"
export const readTimelineZoom = (raw: string | null | undefined): TimelineZoom =>
  TIMELINE_ZOOMS.some((z) => z.id === raw) ? (raw as TimelineZoom) : TIMELINE_ZOOM_DEFAULT

/** Pixels per day. */
export const DAY_WIDTH: Record<TimelineZoom, number> = { week: 40, month: 14, quarter: 5 }
const PAD_DAYS: Record<TimelineZoom, number> = { week: 3, month: 7, quarter: 21 }
/** There must be calendar ahead to schedule into, even on a board with no dates yet. */
const AHEAD_DAYS: Record<TimelineZoom, number> = { week: 28, month: 90, quarter: 270 }
const DAY_MS = 86_400_000

export interface TimelineItem {
  id: number
  title: string
  status?: string
  startDate?: string
  dueDate?: string
}
export interface TimelineList<I extends TimelineItem = TimelineItem> {
  id: number
  name: string
  items: I[]
}
export type BarState = DueState | "done"
export interface TimelineBar<I extends TimelineItem = TimelineItem> {
  item: I
  start: number
  end: number
  state: BarState
}
export interface TimelineRow<I extends TimelineItem = TimelineItem> {
  id: number
  name: string
  bars: TimelineBar<I>[]
  /** Cards with no start or due date: no bar, kept apart until someone schedules them. */
  undated: I[]
}
export interface TimelineTick {
  day: number
  label: string
  /** A heavier line: the start of a week, or of a year. */
  major: boolean
}
export interface TimelineModel<I extends TimelineItem = TimelineItem> {
  from: number
  to: number
  today: number
  rows: TimelineRow<I>[]
}

/** A calendar day as a whole number, in the viewer's own time zone. Undefined if unreadable. */
export function dayOf(raw: string | undefined): number | undefined {
  if (!raw) return undefined
  const value = asDate(raw)
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(value)
  const d = new Date(dateOnly ? `${value}T12:00:00` : value)
  if (Number.isNaN(d.getTime())) return undefined
  return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()) / DAY_MS
}

function barFor<I extends TimelineItem>(item: I, now: number): TimelineBar<I> | undefined {
  const start = dayOf(item.startDate)
  const due = dayOf(item.dueDate)
  if (start === undefined && due === undefined) return undefined
  const last = due ?? (start as number)
  return {
    item,
    // Start after due is a typo, not a backwards bar: it draws as the single day it is due.
    start: Math.min(start ?? last, last),
    end: last,
    state: isDone(item.status) ? "done" : due === undefined ? "later" : (dueState(item.dueDate, now) ?? "later"),
  }
}

export function buildTimeline<I extends TimelineItem, L extends TimelineList<I>>(
  lists: L[],
  zoom: TimelineZoom,
  now: number,
): TimelineModel<I> {
  const clock = new Date(now)
  const today = Date.UTC(clock.getFullYear(), clock.getMonth(), clock.getDate()) / DAY_MS
  let from = today
  let to = today
  const rows = lists.map((list) => {
    const bars: TimelineBar<I>[] = []
    const undated: I[] = []
    for (const item of list.items) {
      const bar = barFor(item, now)
      if (!bar) {
        undated.push(item)
        continue
      }
      bars.push(bar)
      from = Math.min(from, bar.start)
      to = Math.max(to, bar.end)
    }
    bars.sort((a, b) => a.start - b.start || a.end - b.end || a.item.id - b.item.id)
    return { id: list.id, name: list.name, bars, undated }
  })
  return { from: from - PAD_DAYS[zoom], to: Math.max(to, today + AHEAD_DAYS[zoom]) + PAD_DAYS[zoom], today, rows }
}

const asUtc = (day: number) => new Date(day * DAY_MS)
const monthName = (d: Date) => d.toLocaleDateString(undefined, { month: "short", timeZone: "UTC" })

/** The header's marks: every day, every Monday, or every 1st of the month as the zoom widens. */
export function timelineTicks(from: number, to: number, zoom: TimelineZoom): TimelineTick[] {
  const ticks: TimelineTick[] = []
  for (let day = from; day <= to; day++) {
    const d = asUtc(day)
    const date = d.getUTCDate()
    const monday = d.getUTCDay() === 1
    if (zoom === "week") {
      ticks.push({ day, label: date === 1 || day === from ? `${monthName(d)} ${date}` : String(date), major: monday })
    } else if (zoom === "month") {
      if (monday) ticks.push({ day, label: `${monthName(d)} ${date}`, major: date <= 7 })
    } else if (date === 1) {
      const january = d.getUTCMonth() === 0
      ticks.push({ day, label: january ? `${monthName(d)} ${d.getUTCFullYear()}` : monthName(d), major: january })
    }
  }
  return ticks
}

/** "Nov 3" for one calendar day. */
export const dayLabel = (day: number) =>
  asUtc(day).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" })

/** A calendar day as the YYYY-MM-DD the card's date fields take. */
export const dayToDate = (day: number) => asUtc(day).toISOString().slice(0, 10)

export type TimelineDrag = "new" | "move" | "start" | "end"
export interface TimelineDates {
  startDate?: string
  dueDate?: string
}

/**
 * What a gesture changes on a card, and nothing else: a card with only a due date keeps only a due
 * date when it is moved. On a new card a drag sets both, and a click sets the due date and starts
 * today, as fl-api does for any due date set without a start. A past date starts on that day.
 */
export function datesFromDrag(
  item: TimelineItem,
  mode: TimelineDrag,
  anchor: number,
  current: number,
  today: number,
): TimelineDates {
  const start = dayOf(item.startDate)
  const due = dayOf(item.dueDate)
  if (mode === "new") {
    if (anchor === current) return { startDate: dayToDate(Math.min(today, anchor)), dueDate: dayToDate(anchor) }
    return { startDate: dayToDate(Math.min(anchor, current)), dueDate: dayToDate(Math.max(anchor, current)) }
  }
  if (mode === "move") {
    const delta = current - anchor
    return {
      ...(start === undefined ? {} : { startDate: dayToDate(start + delta) }),
      ...(due === undefined ? {} : { dueDate: dayToDate(due + delta) }),
    }
  }
  const last = (due ?? start) as number
  const first = Math.min(start ?? last, last)
  // An edge stops at the other edge: a bar is never dragged inside out.
  if (mode === "start") return { startDate: dayToDate(Math.min(current, last)), dueDate: dayToDate(last) }
  return { startDate: dayToDate(first), dueDate: dayToDate(Math.max(current, first)) }
}

/** The days a card covers with these dates applied, for drawing a drag before it is saved. */
export function spanOf(item: TimelineItem, dates: TimelineDates): { start: number; end: number } | undefined {
  const start = dayOf(dates.startDate ?? item.startDate)
  const due = dayOf(dates.dueDate ?? item.dueDate)
  const end = due ?? start
  if (end === undefined) return undefined
  return { start: Math.min(start ?? end, end), end }
}

/** "Nov 3 – Nov 8", or "Nov 8" for a single day: what an Undo toast says was set. */
export function timelineDatesLabel(dates: TimelineDates): string {
  const start = dayOf(dates.startDate)
  const due = dayOf(dates.dueDate)
  if (start !== undefined && due !== undefined && start !== due) return `${dayLabel(start)} – ${dayLabel(due)}`
  const day = due ?? start
  return day === undefined ? "No dates" : dayLabel(day)
}
