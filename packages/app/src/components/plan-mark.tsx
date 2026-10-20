/**
 * The geometric mark on a plan card — the same language as the IRIS emails and recent marketing
 * (2026-10-16): flat, hard-edged circles, halves, quarters, rings and bars in the heyiris.io
 * colours. Never blurred blobs. One person reads as one shape; a team reads as a cluster.
 */
export const IRIS_COLORS = {
  fuchsia: "#d946ef",
  blue: "#3b82f6",
  cyan: "#22d3ee",
  violet: "#9333ea",
  emerald: "#10b981",
} as const

/** The plan KEY from a package slug (iris-<key>-monthly). Unknown slugs get the Pro mark. */
export function planMarkKey(slug: string): "personal" | "solo" | "team" | "other" {
  const m = /^iris-(personal|solo|team)-/.exec(slug)
  return (m?.[1] as "personal" | "solo" | "team") ?? "other"
}

export function PlanMark(props: { slug: string; size?: number }) {
  const s = props.size ?? 56
  const c = IRIS_COLORS
  const key = planMarkKey(props.slug)
  return (
    <svg width={s} height={s} viewBox="0 0 56 56" aria-hidden="true" data-slot="iris-plan-mark" data-mark={key}>
      {key === "personal" && (
        <>
          <circle cx="28" cy="28" r="20" fill={c.fuchsia} />
          <path d="M28 8 A20 20 0 0 1 48 28 L28 28 Z" fill={c.cyan} />
        </>
      )}
      {(key === "solo" || key === "other") && (
        <>
          <path d="M8 30 A20 20 0 0 1 48 30 Z" fill={c.blue} />
          <circle cx="28" cy="38" r="10" fill={c.fuchsia} />
          <rect x="8" y="46" width="40" height="4" fill={c.cyan} />
        </>
      )}
      {key === "team" && (
        <>
          <circle cx="16" cy="16" r="10" fill={c.fuchsia} />
          <path d="M30 26 L30 6 A20 20 0 0 1 50 26 Z" fill={c.blue} />
          <path d="M6 50 L26 50 L16 32 Z" fill={c.cyan} />
          <circle cx="40" cy="40" r="9" fill="none" stroke={c.violet} stroke-width="4" />
        </>
      )}
    </svg>
  )
}
