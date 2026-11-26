import { For, splitProps, type ComponentProps } from "solid-js"

/**
 * Placeholder rows in the shape of the list that is loading (#194371) — so a slow read shows the
 * layout arriving, not the word "Loading…". `label` is announced to screen readers.
 */
export interface SkeletonRowsProps extends ComponentProps<"div"> {
  rows?: number
  /** Draw a heading bar above the rows, as a list section has. */
  heading?: boolean
  /** Draw a value column on the right of each row. */
  trailing?: boolean
  label?: string
}

export function SkeletonRows(props: SkeletonRowsProps) {
  const [split, rest] = splitProps(props, ["rows", "heading", "trailing", "label", "class", "classList"])
  const widths = [62, 48, 70, 54, 40, 66, 58, 44]
  return (
    <div
      {...rest}
      data-component="skeleton-rows"
      role="status"
      aria-busy="true"
      aria-label={split.label}
      classList={{ ...split.classList, [split.class ?? ""]: !!split.class }}
    >
      {split.heading ? <div data-slot="skeleton-heading" data-component="skeleton" /> : null}
      <For each={Array.from({ length: split.rows ?? 6 }, (_, i) => i)}>
        {(i) => (
          <div data-slot="skeleton-row">
            <div data-slot="skeleton-lines">
              <div data-component="skeleton" style={{ width: `${widths[i % widths.length]}%` }} />
              <div data-component="skeleton" data-size="small" style={{ width: `${widths[(i + 3) % widths.length]! / 2}%` }} />
            </div>
            {split.trailing ? <div data-component="skeleton" data-slot="skeleton-trailing" /> : null}
          </div>
        )}
      </For>
    </div>
  )
}
