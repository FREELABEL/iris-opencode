import { Show } from "solid-js"

/**
 * Two rings, one glance (#194529): the outer arc is your WEEK, the inner one is THIS CHAT's context.
 * `week` null = no week to draw (uncapped, or not measured): only the faint track shows outside.
 */
export function UsageRings(props: {
  size: number
  /** 0–1 */
  week: number | null
  /** 0–100 */
  context: number | null
  color: string
  class?: string
}) {
  const big = () => props.size > 40
  const c = () => props.size / 2
  const outerW = () => (big() ? 7 : 2.2)
  const innerW = () => (big() ? 5 : 1.8)
  const outerR = () => (big() ? props.size / 2 - 4 : props.size / 2 - 1.2)
  const innerR = () => (big() ? props.size / 2 - 14 : props.size / 2 - 4.6)
  const len = (r: number) => 2 * Math.PI * r
  const clamp = (v: number) => Math.max(0, Math.min(1, v))
  return (
    <svg
      width={props.size}
      height={props.size}
      viewBox={`0 0 ${props.size} ${props.size}`}
      fill="none"
      class={props.class}
      style={{ transform: "rotate(-90deg)" }}
      aria-hidden="true"
      data-component="usage-rings"
    >
      <circle cx={c()} cy={c()} r={outerR()} stroke="var(--v2-background-bg-layer-04, var(--border-weak-base))" stroke-width={outerW()} />
      <Show when={props.week !== null && props.week > 0}>
        <circle
          data-slot="usage-ring-week"
          cx={c()}
          cy={c()}
          r={outerR()}
          stroke={props.color}
          stroke-width={outerW()}
          stroke-linecap="round"
          stroke-dasharray={String(len(outerR()))}
          stroke-dashoffset={len(outerR()) * (1 - clamp(props.week ?? 0))}
        />
      </Show>
      <circle cx={c()} cy={c()} r={innerR()} stroke="var(--v2-background-bg-layer-04, var(--border-weak-base))" stroke-width={innerW()} />
      <Show when={(props.context ?? 0) > 0}>
        <circle
          data-slot="usage-ring-context"
          cx={c()}
          cy={c()}
          r={innerR()}
          stroke="var(--v2-text-text-base, var(--icon-base))"
          stroke-width={innerW()}
          stroke-linecap="round"
          stroke-dasharray={String(len(innerR()))}
          stroke-dashoffset={len(innerR()) * (1 - clamp((props.context ?? 0) / 100))}
        />
      </Show>
    </svg>
  )
}
