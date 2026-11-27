import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"

/**
 * A short status word in a tinted pill (#194364, #194372).
 *
 * The tone is semantic, never a hue: `neutral`, `info`, `accent`, `warning`, `success`, `critical`
 * read their colour from the theme. The pill is a tint fill with text in the tone — never a bar
 * on one edge (house rule).
 */
export type StatusTone = "neutral" | "info" | "accent" | "warning" | "success" | "critical"

export interface StatusBadgeProps extends ComponentProps<"span"> {
  tone?: StatusTone
  /** A leading mark: "dot" draws a small filled circle; a string is drawn as given (e.g. "✓"). */
  mark?: "dot" | JSX.Element
  size?: "small" | "normal"
}

export function StatusBadge(props: StatusBadgeProps) {
  const [split, rest] = splitProps(props, ["tone", "mark", "size", "class", "classList", "children"])
  return (
    <span
      {...rest}
      data-component="status-badge"
      data-tone={split.tone ?? "neutral"}
      data-size={split.size ?? "normal"}
      classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}
    >
      <Show when={split.mark}>
        <Show when={split.mark === "dot"} fallback={<span data-slot="status-badge-mark" aria-hidden="true">{split.mark}</span>}>
          <span data-slot="status-badge-dot" aria-hidden="true" />
        </Show>
      </Show>
      <span data-slot="status-badge-label">{split.children}</span>
    </span>
  )
}
