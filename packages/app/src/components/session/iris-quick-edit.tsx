/**
 * CHANGE A CARD FROM ITS FACE (#189806) — status, priority, due date and labels without opening
 * the card. Opened by right-clicking a card, or by s / p / d / l on a focused card, in List and
 * Board view alike.
 *
 * Every choice is its own save, made the moment it is picked: there is no "Save" to forget. The
 * panel shows the change at once (the board's optimistic overlay), and if fl-api refuses, the
 * card goes back and the panel says why — a face that shows a status that did not save is the
 * one thing this must never do.
 *
 * Not a modal (#194375 W5): it is a small panel anchored to the card, non-modal on purpose — the
 * board stays live behind it so a pick shows on the card at once, and it opens inside the card
 * editor dialog (`within`) without replacing it. So it is not a ui Dialog (the dialog context's
 * show() closes every open dialog, the card editor included); its choices are ui Buttons.
 */
import { createEffect, createSignal, For, on, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { Button } from "@opencode-ai/ui/button"
import { useLanguage } from "@/context/language"
import type { IRIS_QUICK_EDIT_ENGLISH } from "@/i18n/iris-quick-edit"
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

type QuickKey = keyof typeof IRIS_QUICK_EDIT_ENGLISH

/** Used until the board's own vocabulary arrives (or when it has none). */
const PRIORITY_FALLBACK: { id: string; label: QuickKey }[] = [
  { id: "low", label: "iris.quickEdit.priority.low" },
  { id: "medium", label: "iris.quickEdit.priority.medium" },
  { id: "high", label: "iris.quickEdit.priority.high" },
  { id: "urgent", label: "iris.quickEdit.priority.urgent" },
]
const STATUS_LABEL: Partial<Record<(typeof WRITABLE_STATUSES)[number], QuickKey>> = {
  active: "iris.quickEdit.status.active",
  todo: "iris.quickEdit.status.todo",
  in_progress: "iris.quickEdit.status.inProgress",
  done: "iris.quickEdit.status.done",
}
const STATUS_FALLBACK = WRITABLE_STATUSES.filter((s) => s !== "pending" && s !== "approved" && s !== "rejected")

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
  /** Show only `field` — a single dropdown, the way Elon's card sidebar opens one (#card-elon). */
  only?: boolean
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
  const language = useLanguage()
  const t = (key: QuickKey, params?: Record<string, string>) => language.t(key, params)
  let el: HTMLDivElement | undefined
  const [newLabel, setNewLabel] = createSignal("")
  const statuses = (): SchemaOption[] =>
    (props.status?.length
      ? props.status
      : STATUS_FALLBACK.map((id) => ({ id, label: STATUS_LABEL[id] ? t(STATUS_LABEL[id]!) : id[0].toUpperCase() + id.slice(1) }))
    ).filter((o) => (WRITABLE_STATUSES as readonly string[]).includes(o.id))
  const priorities = (): SchemaOption[] =>
    props.priority?.length ? props.priority : PRIORITY_FALLBACK.map((o) => ({ id: o.id, label: t(o.label) }))
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
      data-only={props.only && props.field ? "" : undefined}
      data-dismiss-first
      role="dialog"
      aria-label={t("iris.quickEdit.label", { title: props.card.title })}
      style={style()}
      data-prevent-autofocus
      onKeyDown={(e) => e.stopPropagation()}
    >
      <Show when={!(props.only && props.field)}>
        <div class="iris-quick__title truncate">{props.card.title}</div>
      </Show>

      <section data-quick="status" data-active={props.field === "status" ? "" : undefined}>
        <h4 class="iris-quick__head">{t("iris.quickEdit.status")} <kbd>s</kbd></h4>
        <div class="iris-quick__chips">
          <For each={statuses()}>
            {(o) => (
              <Chip pressed={props.card.status === o.id} onClick={() => props.card.status !== o.id && props.onSave({ status: o.id })}>
                {o.label}
              </Chip>
            )}
          </For>
        </div>
      </section>

      <section data-quick="priority" data-active={props.field === "priority" ? "" : undefined}>
        <h4 class="iris-quick__head">{t("iris.quickEdit.priority")} <kbd>p</kbd></h4>
        <div class="iris-quick__chips">
          <For each={priorities()}>
            {(o) => (
              <Chip pressed={(props.card.priority ?? "").toLowerCase() === o.id.toLowerCase()} onClick={() => props.onSave({ priority: o.id })}>
                {o.label}
              </Chip>
            )}
          </For>
          <Show when={props.card.priority}>
            <Chip quiet onClick={() => props.onSave({ priority: null })}>
              {t("iris.quickEdit.none")}
            </Chip>
          </Show>
        </div>
      </section>

      <section data-quick="due" data-active={props.field === "due" ? "" : undefined}>
        <h4 class="iris-quick__head">{t("iris.quickEdit.due")} <kbd>d</kbd></h4>
        <div class="iris-quick__chips">
          <input
            type="date"
            class="iris-field__input iris-quick__date"
            aria-label={t("iris.quickEdit.dueDate")}
            value={props.card.dueDate?.slice(0, 10) ?? ""}
            onChange={(e) => props.onSave({ dueDate: e.currentTarget.value || null })}
          />
          <Chip onClick={() => props.onSave({ dueDate: dayFrom(props.now, 0) })}>{t("iris.quickEdit.today")}</Chip>
          <Chip onClick={() => props.onSave({ dueDate: dayFrom(props.now, 1) })}>{t("iris.quickEdit.tomorrow")}</Chip>
          <Chip onClick={() => props.onSave({ dueDate: dayFrom(props.now, 7) })}>{t("iris.quickEdit.inAWeek")}</Chip>
          <Show when={props.card.dueDate}>
            <Chip quiet onClick={() => props.onSave({ dueDate: null })}>
              {t("iris.quickEdit.clear")}
            </Chip>
          </Show>
        </div>
      </section>

      <section data-quick="labels" data-active={props.field === "labels" ? "" : undefined}>
        <h4 class="iris-quick__head">{t("iris.quickEdit.labels")} <kbd>l</kbd></h4>
        <div class="iris-quick__chips">
          <For each={allLabels()}>
            {(l) => (
              <Chip pressed={labels().includes(l)} onClick={() => toggleLabel(l)}>
                {l}
              </Chip>
            )}
          </For>
          <input
            class="iris-field__input iris-quick__date"
            placeholder={t("iris.quickEdit.newLabel.placeholder")}
            aria-label={t("iris.quickEdit.newLabel")}
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

/**
 * One choice: a small ui Button. A toggle (status, priority, a label) says so with aria-pressed and
 * shows the picked one as the primary variant; "None" / "Clear" are ghost. No pressed prop = an action.
 */
function Chip(props: { pressed?: boolean; quiet?: boolean; onClick: () => void; children: JSX.Element }) {
  return (
    <Button
      size="small"
      variant={props.quiet ? "ghost" : props.pressed ? "primary" : "secondary"}
      class="iris-quick-chip"
      aria-pressed={props.pressed === undefined ? undefined : props.pressed}
      onClick={props.onClick}
    >
      {props.children}
    </Button>
  )
}
