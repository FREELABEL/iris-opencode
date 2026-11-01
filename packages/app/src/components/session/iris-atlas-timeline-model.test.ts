import { describe, expect, test } from "bun:test"
import { readAtlasLayout } from "./iris-atlas-view"
import {
  buildTimeline,
  datesFromDrag,
  dayOf,
  readTimelineZoom,
  spanOf,
  timelineTicks,
} from "./iris-atlas-timeline-model"

const NOW = Date.parse("2026-11-10T15:00:00")
const day = (s: string) => dayOf(s) as number
const one = (item: Parameters<typeof buildTimeline>[0][number]["items"][number]) =>
  buildTimeline([{ id: 1, name: "L", items: [item] }], "month", NOW).rows[0]

describe("dayOf", () => {
  test("a due date stored as midnight UTC is the date it names, in any time zone", () => {
    expect(dayOf("2026-11-12T00:00:00.000000Z")).toBe(day("2026-11-12"))
  })
  test("nothing, or nonsense, is no day", () => {
    expect(dayOf(undefined)).toBeUndefined()
    expect(dayOf("soon")).toBeUndefined()
  })
})

describe("buildTimeline", () => {
  test("start and due draw a bar, in its due state", () => {
    const [bar] = one({ id: 1, title: "a", startDate: "2026-11-01", dueDate: "2026-11-20" }).bars
    expect([bar.start, bar.end, bar.state]).toEqual([day("2026-11-01"), day("2026-11-20"), "later"])
    expect(one({ id: 1, title: "a", dueDate: "2026-11-02" }).bars[0].state).toBe("overdue")
    expect(one({ id: 1, title: "a", dueDate: "2026-11-11" }).bars[0].state).toBe("soon")
  })
  test("one date alone is a single day", () => {
    const due = one({ id: 1, title: "a", dueDate: "2026-11-20" }).bars[0]
    expect([due.start, due.end]).toEqual([day("2026-11-20"), day("2026-11-20")])
    const start = one({ id: 1, title: "a", startDate: "2026-11-20" }).bars[0]
    expect([start.start, start.end, start.state]).toEqual([day("2026-11-20"), day("2026-11-20"), "later"])
  })
  test("a finished card is done, not overdue", () => {
    expect(one({ id: 1, title: "a", status: "done", dueDate: "2026-11-02" }).bars[0].state).toBe("done")
  })
  test("start after due is a point, not a backwards bar", () => {
    const [bar] = one({ id: 1, title: "a", startDate: "2026-11-05", dueDate: "2026-11-03" }).bars
    expect([bar.start, bar.end]).toEqual([day("2026-11-03"), day("2026-11-03")])
  })
  test("a card with no start or due date is counted, not placed, whatever else it has", () => {
    const row = one({ id: 1, title: "a", createdAt: "2026-11-01", updatedAt: "2026-11-05" } as never)
    expect(row.bars).toEqual([])
    expect(row.undated.map((i) => i.id)).toEqual([1])
  })
  test("the range always holds today and every bar, with room either side", () => {
    const empty = buildTimeline([{ id: 1, name: "L", items: [] }], "month", NOW)
    expect(empty.from).toBeLessThan(empty.today)
    expect(empty.to).toBeGreaterThan(empty.today)
    const far = buildTimeline(
      [{ id: 1, name: "L", items: [{ id: 1, title: "a", startDate: "2026-01-01", dueDate: "2027-03-01" }] }],
      "month",
      NOW,
    )
    expect(far.from).toBeLessThan(day("2026-01-01"))
    expect(far.to).toBeGreaterThan(day("2027-03-01"))
  })
  test("bars read in start order, and the input is not touched", () => {
    const items = [
      { id: 2, title: "b", startDate: "2026-11-05" },
      { id: 1, title: "a", startDate: "2026-11-01" },
    ]
    const row = buildTimeline([{ id: 1, name: "L", items }], "month", NOW).rows[0]
    expect(row.bars.map((b) => b.item.id)).toEqual([1, 2])
    expect(items[0].id).toBe(2)
  })
})

describe("timelineTicks", () => {
  const from = day("2026-11-01")
  const to = day("2026-12-31")
  test("week marks every day; month marks Mondays; quarter marks each 1st", () => {
    expect(timelineTicks(from, to, "week").length).toBe(61)
    const mondays = timelineTicks(from, to, "month")
    expect(mondays[0].day).toBe(day("2026-11-02"))
    expect(mondays.every((t) => (t.day - mondays[0].day) % 7 === 0)).toBe(true)
    expect(timelineTicks(from, to, "quarter").map((t) => t.day)).toEqual([day("2026-11-01"), day("2026-12-01")])
  })
})

test("an unknown stored zoom falls back to month", () => {
  expect(readTimelineZoom("week")).toBe("week")
  expect(readTimelineZoom("decade")).toBe("month")
  expect(readTimelineZoom(null)).toBe("month")
})

test("a stored Timeline choice survives a reload; anything else opens on Board", () => {
  expect(readAtlasLayout("timeline")).toBe("timeline")
  expect(readAtlasLayout("list")).toBe("list")
  expect(readAtlasLayout("nonsense")).toBe("board")
})

describe("datesFromDrag", () => {
  const a = { id: 1, title: "a" }
  const n = day("2026-11-10")
  test("a click on a new card sets a due date that starts today; a past one starts that day", () => {
    expect(datesFromDrag(a, "new", n + 5, n + 5, n)).toEqual({ startDate: "2026-11-10", dueDate: "2026-11-15" })
    expect(datesFromDrag(a, "new", n - 5, n - 5, n)).toEqual({ startDate: "2026-11-05", dueDate: "2026-11-05" })
  })
  test("a drag sets both, in either direction", () => {
    expect(datesFromDrag(a, "new", n, n + 2, n)).toEqual({ startDate: "2026-11-10", dueDate: "2026-11-12" })
    expect(datesFromDrag(a, "new", n, n - 2, n)).toEqual({ startDate: "2026-11-08", dueDate: "2026-11-10" })
  })
  test("moving shifts only the dates the card has", () => {
    expect(datesFromDrag({ ...a, dueDate: "2026-11-10" }, "move", n, n + 3, n)).toEqual({ dueDate: "2026-11-13" })
    expect(datesFromDrag({ ...a, startDate: "2026-11-01", dueDate: "2026-11-10" }, "move", n, n - 1, n)).toEqual({
      startDate: "2026-10-31",
      dueDate: "2026-11-09",
    })
  })
  test("an edge changes that end and cannot pass the other", () => {
    const c = { ...a, startDate: "2026-11-05", dueDate: "2026-11-10" }
    expect(datesFromDrag(c, "start", n, day("2026-11-01"), n).startDate).toBe("2026-11-01")
    expect(datesFromDrag(c, "start", n, day("2026-11-20"), n).startDate).toBe("2026-11-10")
    expect(datesFromDrag(c, "end", n, day("2026-11-20"), n).dueDate).toBe("2026-11-20")
    expect(datesFromDrag(c, "end", n, day("2026-11-01"), n).dueDate).toBe("2026-11-05")
  })
  test("a drag previews the span it would save", () => {
    expect(spanOf(a, { dueDate: "2026-11-10" })).toEqual({ start: n, end: n })
    expect(spanOf(a, {})).toBeUndefined()
  })
})

test("there is calendar ahead to schedule into on a board with no dates", () => {
  const m = buildTimeline([{ id: 1, name: "L", items: [] }], "month", NOW)
  expect(m.to - m.today).toBeGreaterThanOrEqual(90)
})
