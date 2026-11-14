/**
 * Relative-time labels the heartbeats model renders with. Moved verbatim from the Desktop
 * app (packages/app/src/components/session/iris-hive-scripts-model.ts @ iris/1.18.23).
 */
/** The short age a list row carries: "now", "5m", "3h", "2d", "6w", "1y". */
export function shortAgo(iso: string | null | undefined, now: number): string {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t)) return ""
  const s = Math.max(0, (now - t) / 1000)
  if (s < 60) return "now"
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  const d = Math.floor(s / 86400)
  return d < 14 ? `${d}d` : d < 365 ? `${Math.floor(d / 7)}w` : `${Math.floor(d / 365)}y`
}

export function ago(iso: string | null | undefined, now: number): string {
  if (!iso) return "never"
  const s = (now - Date.parse(iso)) / 1000
  if (!Number.isFinite(s)) return "unknown"
  if (s < 120) return "just now"
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  const d = Math.floor(s / 86400)
  return d === 1 ? "yesterday" : d < 14 ? `${d} days ago` : `${Math.floor(d / 7)} weeks ago`
}
