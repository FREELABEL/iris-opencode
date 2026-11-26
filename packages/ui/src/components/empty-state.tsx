import { type JSX, Show, splitProps, type ComponentProps } from "solid-js"

/**
 * What goes here, and the one thing to do next (#194369). A title that names the thing, one
 * sentence of explanation, and at most one action — never "Nothing in X › Y".
 */
export interface EmptyStateProps extends Omit<ComponentProps<"div">, "title"> {
  title: JSX.Element
  description?: JSX.Element
  /** The next step: usually one ui Button. */
  action?: JSX.Element
  icon?: JSX.Element
  size?: "small" | "normal"
}

export function EmptyState(props: EmptyStateProps) {
  const [split, rest] = splitProps(props, ["title", "description", "action", "icon", "size", "class", "classList"])
  return (
    <div
      {...rest}
      data-component="empty-state"
      data-size={split.size ?? "normal"}
      classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}
    >
      <Show when={split.icon}>
        <div data-slot="empty-state-icon" aria-hidden="true">
          {split.icon}
        </div>
      </Show>
      <p data-slot="empty-state-title">{split.title}</p>
      <Show when={split.description}>
        <p data-slot="empty-state-description">{split.description}</p>
      </Show>
      <Show when={split.action}>
        <div data-slot="empty-state-action">{split.action}</div>
      </Show>
    </div>
  )
}
