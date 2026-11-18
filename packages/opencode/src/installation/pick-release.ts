/**
 * Which GitHub release is the CLI's "latest"?
 *
 * #182693 follow-on, measured 2026-08-28. `Installation.latest()` asked GitHub for
 * `/releases/latest` and used `tag_name` directly. IRIS Desktop ships from the SAME
 * repository and releases far more often — eleven times on this day alone — so that call
 * resolved to `desktop-v1.18.35`, a release containing **zero** iris-* CLI binaries. The
 * version string became "desktop-v1.18.35" (the `^v` strip does nothing to it), so every
 * comparison against "1.3.213" was meaningless and there was nothing to download anyway.
 *
 * `iris update` was therefore broken for the whole fleet, silently, while working CLI
 * releases (v1.3.213, v1.3.214) sat a few rows down the same list.
 *
 * "Latest" has to mean "latest OF THIS PRODUCT". A release belongs to the CLI only if its
 * tag is a bare semver `vX.Y.Z` — desktop tags carry a `desktop-` prefix, and so does every
 * other satellite line in this repo.
 */
export interface ReleaseRow {
  tag_name?: string
  draft?: boolean
}

const CLI_TAG = /^v\d+\.\d+\.\d+$/

export function isCliReleaseTag(tag: string | undefined): boolean {
  return typeof tag === "string" && CLI_TAG.test(tag)
}

/**
 * The highest-versioned CLI release tag, or null when the page holds none.
 *
 * This was newest-first (recency) so a re-cut release could win. It cannot stay that way once
 * the v2 engine ships as 1.5.x (#188596): one more 1.3.x cut from main would be listed above it
 * and every user's `iris update` would leave v2 for it. A rollback is now a new, higher version.
 */
export function pickLatestCliTag(rows: ReleaseRow[] | null | undefined): string | null {
  if (!Array.isArray(rows)) return null
  return rows
    .filter((r) => !r?.draft && isCliReleaseTag(r?.tag_name))
    .map((r) => r.tag_name!)
    .reduce<string | null>((best, tag) => (best === null || compareTags(tag, best) > 0 ? tag : best), null)
}

function compareTags(a: string, b: string) {
  const [x, y] = [a, b].map((tag) => tag.slice(1).split(".").map(Number))
  return x[0] - y[0] || x[1] - y[1] || x[2] - y[2]
}
