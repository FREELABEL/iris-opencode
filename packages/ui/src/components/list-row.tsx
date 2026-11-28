import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"
import { RelativeTime, type TimeInput } from "./relative-time"
import { StatusBadge, type StatusTone } from "./status-badge"

/**
 * One row of a list: who or what it is, one line about it, when, its status, and a value.
 *
 *   [logo]  Title                                   [Status]  12 pages
 *           A secondary line · 5m ago                         [actions]
 *
 * Replaces the bare rows ("● name 12p", "board · 7f"): every part is a word, a badge or a relative
 * time with the exact time on hover. Long text is cut with an ellipsis, never wrapped into the
 * next row.
 *
 * INTERACTIVE ROWS: pass `onSelect` and the title area becomes a real `<button>` (Enter / Space,
 * a focus ring, a hover tint). `actions` sit beside it, never inside it — a button inside a button
 * cannot be clicked. Without `onSelect` the row is plain content.
 */
export interface ListRowStatus {
  label: JSX.Element
  tone?: StatusTone
  mark?: "dot"
}

export interface ListRowProps extends Omit<ComponentProps<"div">, "title"> {
  /** An Avatar, a logo, an app icon — 32px reads best. */
  leading?: JSX.Element
  title: JSX.Element
  /** One line under the title: what it is, where, who. */
  secondary?: JSX.Element
  /** When it last changed. Rendered relative ("5m ago"), exact on hover. */
  time?: TimeInput
  /** Freeze the clock (tests, screenshots). */
  now?: number
  status?: ListRowStatus
  /** A value or meta on the right: "12 pages", "$4,200", a count. */
  trailing?: JSX.Element
  /** Buttons for this row (e.g. a CommandAction). Shown beside the row, not inside it. */
  actions?: JSX.Element
  /** Makes the row a button. */
  onSelect?: () => void
  /** Accessible name of the row button, when the title alone is not enough. */
  selectLabel?: string
  selected?: boolean
  density?: "compact" | "normal"
}

export function ListRow(props: ListRowProps) {
  const [split, rest] = splitProps(props, [
    "leading",
    "title",
    "secondary",
    "time",
    "now",
    "status",
    "trailing",
    "actions",
    "onSelect",
    "selectLabel",
    "selected",
    "density",
    "class",
    "classList",
  ])
  const body = () => (
    <>
      <Show when={split.leading}>
        <span data-slot="list-row-leading">{split.leading}</span>
      </Show>
      <span data-slot="list-row-text">
        <span data-slot="list-row-title">{split.title}</span>
        <Show when={split.secondary || split.time}>
          <span data-slot="list-row-secondary">
            <Show when={split.secondary}>
              <span data-slot="list-row-secondary-text">{split.secondary}</span>
            </Show>
            <Show when={split.secondary && split.time}>
              <span data-slot="list-row-sep" aria-hidden="true">
                ·
              </span>
            </Show>
            <Show when={split.time}>
              <RelativeTime data-slot="list-row-time" value={split.time} now={split.now} />
            </Show>
          </span>
        </Show>
      </span>
      <Show when={split.status}>
        {(s) => (
          <StatusBadge data-slot="list-row-status" size="small" tone={s().tone} mark={s().mark}>
            {s().label}
          </StatusBadge>
        )}
      </Show>
      <Show when={split.trailing}>
        <span data-slot="list-row-trailing">{split.trailing}</span>
      </Show>
    </>
  )
  return (
    <div
      {...rest}
      data-component="list-row"
      data-density={split.density ?? "normal"}
      data-interactive={split.onSelect ? "" : undefined}
      data-selected={split.selected ? "" : undefined}
      classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}
    >
      <Show when={split.onSelect} fallback={<div data-slot="list-row-main">{body()}</div>}>
        <button
          type="button"
          data-slot="list-row-main"
          aria-label={split.selectLabel}
          aria-current={split.selected ? "true" : undefined}
          onClick={() => split.onSelect?.()}
        >
          {body()}
        </button>
      </Show>
      <Show when={split.actions}>
        <div data-slot="list-row-actions">{split.actions}</div>
      </Show>
    </div>
  )
}
