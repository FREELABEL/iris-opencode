import type { Resource } from "solid-js"

/**
 * A resource's last RESOLVED value, read without suspending anything.
 *
 * `r.latest` is not that. Before a resource's first value lands, Solid's `latest` getter falls
 * through to `read()` (solid-js 1.9 `createResource`: `if (!resolved) return read()`), and that
 * read SUSPENDS the nearest <Suspense>. The IRIS panel read its board, board list and member list
 * that way from places that are always on screen, so the boundary round the whole panel sat in
 * "Loading…" — and Solid holds every effect under a suspended boundary, including the one that
 * applies a product-tab click. Clicking Hive while a board loaded did nothing until the board,
 * the board list and the members had ALL returned (#190230; measured on a preview build: each
 * held 4 s in turn → the click waited 4 s each time; with this, ~250 ms).
 *
 * Reading `state` never suspends. Errors still reach the nearest ErrorBoundary: an errored
 * resource is read the normal way so it throws, as before.
 */
export function settled<T>(r: Resource<T>): T | undefined {
  if (r.state === "errored") return r()
  return r.state === "ready" || r.state === "refreshing" ? r.latest : undefined
}
