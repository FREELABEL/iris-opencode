/**
 * Atlas › Timeline. One scroller holds the card titles and the bars, so a title and its bar can
 * never drift apart; the titles and the date header stay put with `position: sticky`.
 *
 * Dates are set on the calendar itself: click or drag on a card's row to schedule it, drag a bar to
 * move it, drag its ends to change them. A drag lives on `window` and reads its position from the
 * scroller, so a board refresh that rebuilds the rows mid-drag cannot lose it.
 */
import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, type JSX } from "solid-js"
import { ATLAS_PAGE, moreLabel, moreOf, windowOf } from "./iris-atlas-window"
import {
  buildTimeline,
  DAY_WIDTH,
  dayLabel,
  datesFromDrag,
  readTimelineZoom,
  spanOf,
  TIMELINE_ZOOM_DEFAULT,
  TIMELINE_ZOOMS,
  timelineTicks,
  type TimelineBar,
  type TimelineDates,
  type TimelineDrag,
  type TimelineItem,
  type TimelineList,
  type TimelineZoom,
} from "./iris-atlas-timeline-model"

const ZOOM_KEY = "iris.atlas.timeline.zoom"
const TITLE_WIDTH = 168

const STATE_WORD: Record<TimelineBar["state"], string> = {
  overdue: "Overdue",
  soon: "Due soon",
  later: "Planned",
  done: "Done",
}

interface Drag {
  item: TimelineItem
  mode: TimelineDrag
  anchor: number
  current: number
}

export function IrisAtlasTimeline<I extends TimelineItem>(props: {
  lists: TimelineList<I>[]
  now: number
  isFolded: (list: { id: number }) => boolean
  onToggleFold: (id: number) => void
  onOpen: (itemId: number) => void
  onSchedule: (item: I, dates: TimelineDates) => void
  /** A big board is read a page per list (#192670): read more cards of one list. */
  onLoadMore?: (listId: number) => void
  loadingMore?: number
}) {
  let stored: string | null = null
  try {
    stored = localStorage.getItem(ZOOM_KEY)
  } catch {}
  const [zoom, setZoomSig] = createSignal<TimelineZoom>(readTimelineZoom(stored))
  const setZoom = (next: TimelineZoom) => {
    setZoomSig(next)
    try {
      if (next === TIMELINE_ZOOM_DEFAULT) localStorage.removeItem(ZOOM_KEY)
      else localStorage.setItem(ZOOM_KEY, next)
    } catch {}
  }

  const model = createMemo(() => buildTimeline(props.lists, zoom(), props.now))
  const ticks = createMemo(() => timelineTicks(model().from, model().to, zoom()))
  const dayPx = () => DAY_WIDTH[zoom()]
  const px = (day: number) => (day - model().from) * dayPx()
  const width = () => (model().to - model().from + 1) * dayPx()
  const hasBars = () => model().rows.some((row) => row.bars.length > 0)

  let scroller: HTMLDivElement | undefined
  const goToToday = () => {
    if (!scroller) return
    scroller.scrollLeft = Math.max(0, px(model().today) - (scroller.clientWidth - TITLE_WIDTH) / 2)
  }
  // Opens on today, and a new zoom re-centres. The minute clock must not: it would yank the view
  // back from wherever the reader had scrolled.
  createEffect(on(zoom, () => queueMicrotask(goToToday)))

  const dayAt = (clientX: number) => {
    const left = scroller!.getBoundingClientRect().left + TITLE_WIDTH
    return model().from + Math.floor((clientX - left + scroller!.scrollLeft) / dayPx())
  }

  const [drag, setDrag] = createSignal<Drag | null>(null)
  let stopDrag = () => {}
  onCleanup(() => stopDrag())
  function startDrag(e: PointerEvent, item: TimelineItem, mode: TimelineDrag) {
    if (e.button !== 0) return
    e.preventDefault()
    const anchor = dayAt(e.clientX)
    setDrag({ item, mode, anchor, current: anchor })
    const move = (ev: PointerEvent) => setDrag((d) => d && { ...d, current: dayAt(ev.clientX) })
    const up = () => {
      const d = drag()
      stopDrag()
      if (!d) return
      // A bar that did not change days was clicked, not dragged.
      if (d.mode !== "new" && d.anchor === d.current) return props.onOpen(d.item.id)
      props.onSchedule(d.item as I, datesFromDrag(d.item, d.mode, d.anchor, d.current, model().today))
    }
    const key = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") stopDrag()
    }
    stopDrag = () => {
      setDrag(null)
      window.removeEventListener("pointermove", move)
      window.removeEventListener("pointerup", up)
      window.removeEventListener("keydown", key)
      stopDrag = () => {}
    }
    window.addEventListener("pointermove", move)
    window.addEventListener("pointerup", up)
    window.addEventListener("keydown", key)
  }
  const dragSpan = (id: number) => {
    const d = drag()
    return d?.item.id === id
      ? spanOf(d.item, datesFromDrag(d.item, d.mode, d.anchor, d.current, model().today))
      : undefined
  }

  const [opened, setOpened] = createSignal<Record<number, boolean>>({})
  // With nothing scheduled there is nothing else to look at, so the cards to schedule start open.
  // Open by itself only when it is small: a board with no dates used to open every "No dates" group,
  // and 6,899 undated rows crashed the app (#192670).
  const undatedOpen = (id: number, count: number) => opened()[id] ?? (!hasBars() && count <= ATLAS_PAGE)
  const [shownRows, setShownRows] = createSignal<Record<string, number>>({})
  // Cards of a paged list not read yet (#192670): the engine holds only the first pages of a big board.
  const notLoaded = (id: number) => {
    const l = props.lists.find((x) => x.id === id) as ({ total?: number; items: unknown[] } & { id: number }) | undefined
    return l?.total != null ? Math.max(0, l.total - l.items.length) : 0
  }
  const showMoreRows = (key: string) => setShownRows((s) => ({ ...s, [key]: (s[key] ?? ATLAS_PAGE) + ATLAS_PAGE }))
  const MoreRows = (p: { rowKey: string; total: number }) => (
    <Show when={moreOf(p.total, shownRows()[p.rowKey])}>
      {(m) => (
        <button type="button" class="iris-atlas-tl__undated" onClick={() => showMoreRows(p.rowKey)}>
          {moreLabel(m())}
        </button>
      )}
    </Show>
  )

  const grid = () => (
    <div class="iris-atlas-tl__grid" aria-hidden="true">
      <For each={ticks()}>
        {(t) => (
          <i
            class="iris-atlas-tl__line"
            classList={{ "iris-atlas-tl__line--major": t.major }}
            style={{ left: `${px(t.day)}px` }}
          />
        )}
      </For>
      <i class="iris-atlas-tl__today" style={{ left: `${px(model().today) + dayPx() / 2}px` }} />
    </div>
  )

  const row = (item: TimelineItem, bar?: TimelineBar<TimelineItem>) => {
    const [hover, setHover] = createSignal<number | null>(null)
    const span = () => dragSpan(item.id) ?? (bar ? { start: bar.start, end: bar.end } : undefined)
    const dates = () => {
      const s = span()
      if (!s) return ""
      return s.start === s.end ? dayLabel(s.end) : `${dayLabel(s.start)} – ${dayLabel(s.end)}`
    }
    const summary = () => `${item.title} · ${dates()}${bar ? ` · ${STATE_WORD[bar.state]}` : ""}`
    return (
      <div class="iris-atlas-tl__row">
        <button
          type="button"
          class="iris-atlas-tl__name truncate"
          style={{ width: `${TITLE_WIDTH}px` }}
          title={item.title}
          onClick={() => props.onOpen(item.id)}
        >
          {item.title}
        </button>
        <div
          class="iris-atlas-tl__track"
          classList={{ "iris-atlas-tl__track--open": !bar }}
          style={{ width: `${width()}px` }}
          title={bar ? undefined : "Click to set a due date, or drag to choose start and due"}
          onPointerDown={bar ? undefined : (e) => startDrag(e, item, "new")}
          onPointerMove={bar ? undefined : (e) => setHover(dayAt(e.clientX))}
          onPointerLeave={bar ? undefined : () => setHover(null)}
        >
          {grid()}
          <Show when={!bar && !span() && hover() !== null}>
            <i
              class="iris-atlas-tl__ghost"
              style={{ left: `${px(hover()!)}px`, width: `${dayPx()}px` }}
              aria-hidden="true"
            />
            <span class="iris-atlas-tl__date" style={{ left: `${px(hover()!) + dayPx()}px` }}>
              {dayLabel(hover()!)}
            </span>
          </Show>
          <Show when={span()}>
            {(s) => (
              <>
                <button
                  type="button"
                  class="iris-atlas-tl__bar"
                  data-state={bar?.state ?? "later"}
                  style={{ left: `${px(s().start)}px`, width: `${(s().end - s().start + 1) * dayPx()}px` }}
                  title={summary()}
                  aria-label={summary()}
                  onPointerDown={(e) => {
                    e.stopPropagation()
                    const edge = (e.target as HTMLElement).dataset.edge as "start" | "end" | undefined
                    startDrag(e, item, edge ?? "move")
                  }}
                  // A pointer is handled above; this is Enter or Space on a focused bar.
                  onClick={(e) => {
                    if (e.detail === 0) props.onOpen(item.id)
                  }}
                >
                  <i class="iris-atlas-tl__grip" data-edge="start" />
                  <i class="iris-atlas-tl__grip" data-edge="end" />
                </button>
                <Show when={dragSpan(item.id)}>
                  <span class="iris-atlas-tl__date" style={{ left: `${px(s().end) + dayPx()}px` }}>
                    {dates()}
                  </span>
                </Show>
              </>
            )}
          </Show>
        </div>
      </div>
    )
  }

  return (
    <div class="iris-atlas-tl" classList={{ "iris-atlas-tl--dragging": !!drag() }} data-prevent-autofocus>
      <div class="iris-atlas-tl__tools">
        <div class="iris-atlas-tools__chips" role="group" aria-label="Zoom">
          <For each={TIMELINE_ZOOMS}>
            {(z) => (
              <button type="button" aria-pressed={zoom() === z.id} onClick={() => setZoom(z.id)}>
                {z.label}
              </button>
            )}
          </For>
        </div>
        <div class="iris-atlas-tools__chips">
          <button type="button" onClick={goToToday}>
            Today
          </button>
        </div>
        <span class="iris-atlas-tl__note">Click or drag on a card's row to set its dates</span>
      </div>

      <div class="iris-atlas-tl__scroll" ref={scroller}>
        <div class="iris-atlas-tl__inner" style={{ width: `${TITLE_WIDTH + width()}px` }}>
          <div class="iris-atlas-tl__head">
            <div class="iris-atlas-tl__corner" style={{ width: `${TITLE_WIDTH}px` }} />
            <div class="iris-atlas-tl__dates" style={{ width: `${width()}px` }}>
              <For each={ticks()}>
                {(t) => (
                  <span
                    classList={{ "iris-atlas-tl__tick--today": t.day === model().today }}
                    style={{ left: `${px(t.day)}px` }}
                  >
                    {t.label}
                  </span>
                )}
              </For>
            </div>
          </div>

          <For each={model().rows}>
            {(r) => {
              const folded = () => props.isFolded(r)
              return (
                <section classList={{ "iris-atlas-list--folded": folded() }}>
                  <div class="iris-atlas-tl__group" style={{ width: `${TITLE_WIDTH}px` }}>
                    <button
                      type="button"
                      class="iris-atlas-list__head"
                      aria-expanded={!folded()}
                      onClick={() => props.onToggleFold(r.id)}
                    >
                      <span class="iris-atlas-list__chev" aria-hidden="true">
                        ›
                      </span>
                      <h3 class="iris-atlas-list__title truncate">{r.name}</h3>
                      <span class="iris-atlas-list__count font-mono tabular-nums">
                        {/* The list's true size: a big board is read a page per list (#192670). */}
                        {(
                          (props.lists.find((l) => l.id === r.id) as { total?: number } | undefined)?.total ??
                          r.bars.length + r.undated.length
                        ).toLocaleString("en-US")}
                      </span>
                    </button>
                  </div>
                  <Show when={!folded()}>
                    <For each={windowOf(r.bars, shownRows()[`b${r.id}`])}>
                      {(bar) => row(bar.item, bar) as JSX.Element}
                    </For>
                    <MoreRows rowKey={`b${r.id}`} total={r.bars.length} />
                    <Show when={r.undated.length > 0}>
                      <button
                        type="button"
                        class="iris-atlas-tl__undated"
                        aria-expanded={undatedOpen(r.id, r.undated.length)}
                        onClick={() => setOpened({ ...opened(), [r.id]: !undatedOpen(r.id, r.undated.length) })}
                      >
                        {undatedOpen(r.id, r.undated.length) ? "▾" : "▸"} No dates (
                        {r.undated.length.toLocaleString("en-US")}
                        {notLoaded(r.id) ? ` · ${notLoaded(r.id).toLocaleString("en-US")} not loaded` : ""})
                      </button>
                      <Show when={undatedOpen(r.id, r.undated.length)}>
                        <For each={windowOf(r.undated, shownRows()[`u${r.id}`])}>
                          {(item) => row(item) as JSX.Element}
                        </For>
                        <MoreRows rowKey={`u${r.id}`} total={r.undated.length} />
                        <Show when={notLoaded(r.id) > 0 && !moreOf(r.undated.length, shownRows()[`u${r.id}`]) && props.onLoadMore}>
                          <button
                            type="button"
                            class="iris-atlas-tl__undated"
                            disabled={props.loadingMore === r.id}
                            onClick={() => props.onLoadMore?.(r.id)}
                          >
                            {props.loadingMore === r.id
                              ? "Loading…"
                              : `Load ${Math.min(ATLAS_PAGE, notLoaded(r.id))} more · ${notLoaded(r.id).toLocaleString("en-US")} not loaded`}
                          </button>
                        </Show>
                      </Show>
                    </Show>
                  </Show>
                </section>
              )
            }}
          </For>
        </div>
      </div>
    </div>
  )
}
