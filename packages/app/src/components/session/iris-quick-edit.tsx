/**
 * CHANGE A CARD FROM ITS FACE (#189806) — status, priority, due date and labels without opening
 * the card. Opened by right-clicking a card, or by s / p / d / l on a focused card, in List and
 * Board view alike.
 *
 * Every choice is its own save, made the moment it is picked: there is no "Save" to forget. The
 * panel shows the change at once (the board's optimistic overlay), and if fl-api refuses, the
 * card goes back and the panel says why — a face that shows a status that did not save is the
 * one thing this must never do.
 */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js"
import { Portal } from "solid-js/web"
import { WRITABLE_STATUSES, type SchemaOption } from "./iris-card-vocab"
import type { QuickField, QuickPatch } from "./iris-atlas-view"
import { floatingLayer } from "./iris-card-facts"

export interface QuickEditCard {
  id: number
  title: string
  status?: string
  priority?: string
  dueDate?: string
  labels?: string[]
}

const PRIORITY_FALLBACK: SchemaOption[] = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "urgent", label: "Urgent" },
]
const STATUS_FALLBACK: SchemaOption[] = WRITABLE_STATUSES.filter((s) => s !== "pending" && s !== "approved" && s !== "rejected").map((id) => ({
  id,
  label: id === "in_progress" ? "In progress" : id[0].toUpperCase() + id.slice(1),
}))

/** YYYY-MM-DD for a day `days` from today, in the viewer's own calendar. */
export function dayFrom(now: number, days: number): string {
  const d = new Date(now)
  d.setDate(d.getDate() + days)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function IrisQuickEdit(props: {
  card: QuickEditCard
  /** Where to draw it: the card's on-screen box. */
  anchor: { left: number; top: number; bottom: number }
  field?: QuickField
  status?: SchemaOption[]
  priority?: SchemaOption[]
  boardLabels: string[]
  now: number
  note?: string | null
  /** Opened inside a dialog (the card editor): the element to join, so it stays clickable. */
  within?: Element | null
  onSave: (patch: QuickPatch) => void
  onClose: () => void
}) {
  let el: HTMLDivElement | undefined
  const [newLabel, setNewLabel] = createSignal("")
  const statuses = () =>
    (props.status?.length ? props.status : STATUS_FALLBACK).filter((o) => (WRITABLE_STATUSES as readonly string[]).includes(o.id))
  const priorities = () => (props.priority?.length ? props.priority : PRIORITY_FALLBACK)
  const labels = () => props.card.labels ?? []
  const allLabels = () => Array.from(new Set([...props.boardLabels, ...labels()])).sort((a, b) => a.localeCompare(b))
  const toggleLabel = (l: string) =>
    props.onSave({ labels: labels().includes(l) ? labels().filter((x) => x !== l) : [...labels(), l] })

  // The section the key named gets focus; a right-click focuses the first choice.
  const focusField = () =>
    el
      ?.querySelector<HTMLElement>(
        props.field ? `[data-quick="${props.field}"] button, [data-quick="${props.field}"] input` : "button",
      )
      ?.focus()
  onMount(() => {
    queueMicrotask(focusField)
    const away = (e: MouseEvent) => {
      if (el && !el.contains(e.target as Node)) props.onClose()
    }
    // Escape from anywhere while it is open, not only from inside it: focus can leave it.
    const esc = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return
      e.preventDefault()
      // Immediate, on the window: opened inside a card (a dialog that closes on Escape), the
      // Escape must close this and nothing under it.
      e.stopImmediatePropagation()
      props.onClose()
    }
    window.addEventListener("keydown", esc, true)
    // Next tick: the right-click that opened it must not close it.
    const t = setTimeout(() => document.addEventListener("mousedown", away), 0)
    onCleanup(() => {
      clearTimeout(t)
      document.removeEventListener("mousedown", away)
      window.removeEventListener("keydown", esc, true)
    })
  })
  // The board's own vocabulary arrives after the editor opens and replaces the chips; the one
  // that had focus is gone with them. Put focus back rather than strand it on the page.
  createEffect(
    on(
      () => [statuses(), priorities()],
      () =>
        queueMicrotask(() => {
          if (el && !el.contains(document.activeElement)) focusField()
        }),
      { defer: true },
    ),
  )

  // Below the card when there is room, above it when there is not.
  const layer = floatingLayer(props.within)
  const style = () => {
    const below = window.innerHeight - props.anchor.bottom > 320
    const left = Math.max(8, Math.min(props.anchor.left, window.innerWidth - 288)) - layer.dx
    return below
      ? { left: `${left}px`, top: `${props.anchor.bottom + 4 - layer.dy}px` }
      : { left: `${left}px`, top: `${props.anchor.top - 4 - layer.dy}px`, transform: "translateY(-100%)" }
  }

  // On document.body: the panel is a containing block for `position: fixed` (it is transformed),
  // so drawn inside it the editor landed hundreds of pixels from the card it belongs to.
  return (
    <Portal mount={layer.mount}>
    <div
      ref={el}
      class="iris-quick"
      data-dismiss-first
      role="dialog"
      aria-label={`Change ${props.card.title}`}
      style={style()}
      data-prevent-autofocus
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div class="iris-quick__title truncate">{props.card.title}</div>

      <section data-quick="status">
        <h4 class="iris-quick__head">Status <kbd>s</kbd></h4>
        <div class="iris-quick__chips">
          <For each={statuses()}>
            {(o) => (
              <button
                type="button"
                class="iris-quick__chip"
                aria-pressed={props.card.status === o.id}
                onClick={() => props.card.status !== o.id && props.onSave({ status: o.id })}
              >
                {o.label}
              </button>
            )}
          </For>
        </div>
      </section>

      <section data-quick="priority">
        <h4 class="iris-quick__head">Priority <kbd>p</kbd></h4>
        <div class="iris-quick__chips">
          <For each={priorities()}>
            {(o) => (
              <button
                type="button"
                class="iris-quick__chip"
                aria-pressed={(props.card.priority ?? "").toLowerCase() === o.id.toLowerCase()}
                onClick={() => props.onSave({ priority: o.id })}
              >
                {o.label}
              </button>
            )}
          </For>
          <Show when={props.card.priority}>
            <button type="button" class="iris-quick__chip iris-quick__chip--quiet" onClick={() => props.onSave({ priority: null })}>
              None
            </button>
          </Show>
        </div>
      </section>

      <section data-quick="due">
        <h4 class="iris-quick__head">Due <kbd>d</kbd></h4>
        <div class="iris-quick__chips">
          <input
            type="date"
            class="iris-field__input iris-quick__date"
            aria-label="Due date"
            value={props.card.dueDate?.slice(0, 10) ?? ""}
            onChange={(e) => props.onSave({ dueDate: e.currentTarget.value || null })}
          />
          <button type="button" class="iris-quick__chip" onClick={() => props.onSave({ dueDate: dayFrom(props.now, 0) })}>
            Today
          </button>
          <button type="button" class="iris-quick__chip" onClick={() => props.onSave({ dueDate: dayFrom(props.now, 1) })}>
            Tomorrow
          </button>
          <button type="button" class="iris-quick__chip" onClick={() => props.onSave({ dueDate: dayFrom(props.now, 7) })}>
            In a week
          </button>
          <Show when={props.card.dueDate}>
            <button type="button" class="iris-quick__chip iris-quick__chip--quiet" onClick={() => props.onSave({ dueDate: null })}>
              Clear
            </button>
          </Show>
        </div>
      </section>

      <section data-quick="labels">
        <h4 class="iris-quick__head">Labels <kbd>l</kbd></h4>
        <div class="iris-quick__chips">
          <For each={allLabels()}>
            {(l) => (
              <button type="button" class="iris-quick__chip" aria-pressed={labels().includes(l)} onClick={() => toggleLabel(l)}>
                {l}
              </button>
            )}
          </For>
          <input
            class="iris-field__input iris-quick__date"
            placeholder="New label…"
            aria-label="New label"
            value={newLabel()}
            onInput={(e) => setNewLabel(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return
              e.preventDefault()
              const t = newLabel().trim()
              if (t && !labels().includes(t)) props.onSave({ labels: [...labels(), t] })
              setNewLabel("")
            }}
          />
        </div>
      </section>

      <Show when={props.note}>
        <p class="iris-quick__note" role="status">
          {props.note}
        </p>
      </Show>
    </div>
    </Portal>
  )
}
