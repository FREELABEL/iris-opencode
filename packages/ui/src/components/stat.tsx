import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"

/**
 * A number with a label, and what changed (#194581).
 *
 *   12            ← value
 *   Open leads    ← label
 *   +3 since yesterday  ← change (green up, red down; `invert` when down is good)
 *
 * Never an icon-only number: the label is required. The same scale as the Home tiles.
 */
export interface StatProps extends Omit<ComponentProps<"div">, "children"> {
  label: JSX.Element
  value: JSX.Element
  /** The change as a number: +3, -2, 0. Rendered "+3", "−2", "No change". */
  change?: number
  /** What the change is measured against: "since yesterday", "this week". */
  since?: string
  /** A fall in this number is good news (e.g. failing runs): flips the tone. */
  invert?: boolean
  /** Replace the rendered change words entirely (e.g. "New"). */
  changeText?: JSX.Element
  size?: "small" | "normal" | "large"
}

/** "+3", "−2" (a real minus sign), "No change". */
export function formatChange(change: number): string {
  if (!Number.isFinite(change) || change === 0) return "No change"
  const n = Math.abs(change).toLocaleString()
  return change > 0 ? `+${n}` : `−${n}`
}

/** The tone of a change: up is good unless `invert`. Zero is neutral. */
export function changeTone(change: number, invert = false): "positive" | "negative" | "neutral" {
  if (!Number.isFinite(change) || change === 0) return "neutral"
  return change > 0 !== invert ? "positive" : "negative"
}

export function Stat(props: StatProps) {
  const [split, rest] = splitProps(props, ["label", "value", "change", "since", "invert", "changeText", "size", "class", "classList"])
  const hasChange = () => split.changeText !== undefined || split.change !== undefined
  const tone = () => (split.change === undefined ? "neutral" : changeTone(split.change, split.invert))
  const words = () => {
    if (split.changeText !== undefined) return split.changeText
    const c = formatChange(split.change!)
    return split.since && split.change !== 0 ? `${c} ${split.since}` : c
  }
  return (
    <div
      {...rest}
      data-component="stat"
      data-size={split.size ?? "normal"}
      classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}
    >
      <span data-slot="stat-value">{split.value}</span>
      <span data-slot="stat-label">{split.label}</span>
      <Show when={hasChange()}>
        <span data-slot="stat-change" data-tone={tone()}>
          {words()}
        </span>
      </Show>
    </div>
  )
}
