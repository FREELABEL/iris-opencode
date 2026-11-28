import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"
import type { StatusTone } from "./status-badge"

/**
 * One line (or two) of what just happened or what to know, inside a pane (#194375 W5): a tint of
 * the tone with an optional icon in the tone, and at most one action — usually Dismiss or Retry.
 * Never a coloured bar down one edge (house rule).
 */
export interface NoticeProps extends ComponentProps<"div"> {
  tone?: StatusTone
  icon?: JSX.Element
  /** Trailing controls: a dismiss IconButton, a Retry Button. */
  action?: JSX.Element
}

export function Notice(props: NoticeProps) {
  const [split, rest] = splitProps(props, ["tone", "icon", "action", "class", "classList", "children"])
  return (
    <div
      {...rest}
      data-component="notice"
      data-tone={split.tone ?? "neutral"}
      classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}
    >
      <Show when={split.icon}>
        <span data-slot="notice-icon" aria-hidden="true">
          {split.icon}
        </span>
      </Show>
      <div data-slot="notice-body">{split.children}</div>
      <Show when={split.action}>
        <div data-slot="notice-action">{split.action}</div>
      </Show>
    </div>
  )
}
