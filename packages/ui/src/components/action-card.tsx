import { type JSX, Show, splitProps, type ComponentProps } from "solid-js"

/**
 * What the agent just did, said as a sentence (#194362): an icon, "Added Ethan Okafor to Call
 * today", where it landed, and — behind a disclosure — the exact command it ran.
 */
export interface ActionCardProps extends Omit<ComponentProps<"div">, "title"> {
  icon?: JSX.Element
  title: JSX.Element
  /** Where it happened: "Atlas › Call today". */
  target?: JSX.Element
  /** The raw command, shown only when opened. */
  detail?: string
  /** The disclosure's label, e.g. "Command". */
  detailLabel?: string
  status?: "running" | "done" | "failed"
  /** Opens the target (e.g. in the side panel). Drawn as a link-styled button on the target. */
  onOpen?: () => void
  openLabel?: string
}

export function ActionCard(props: ActionCardProps) {
  const [split, rest] = splitProps(props, ["icon", "title", "target", "detail", "detailLabel", "status", "onOpen", "openLabel", "class", "classList"])
  return (
    <div {...rest} data-component="action-card" data-status={split.status ?? "done"} classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}>
      <div data-slot="action-card-main">
        <span data-slot="action-card-icon" aria-hidden="true">
          {split.icon}
        </span>
        <div data-slot="action-card-text">
          <span data-slot="action-card-title">{split.title}</span>
          <Show when={split.target}>
            <span data-slot="action-card-target">{split.target}</span>
          </Show>
        </div>
        <Show when={split.onOpen}>
          <button type="button" data-slot="action-card-open" onClick={() => split.onOpen?.()}>
            {split.openLabel ?? "Open"}
          </button>
        </Show>
      </div>
      <Show when={split.detail}>
        <details data-slot="action-card-detail">
          <summary>{split.detailLabel ?? "Command"}</summary>
          <pre>{split.detail}</pre>
        </details>
      </Show>
    </div>
  )
}
