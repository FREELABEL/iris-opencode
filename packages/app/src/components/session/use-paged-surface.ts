import { createMemo, createSignal } from "solid-js"

/**
 * The client half of the pagination contract in opencode's iris/pagination.ts.
 *
 * One hook so eight surfaces cannot each invent their own idea of "is there more". The server
 * already guarantees the envelope; this keeps the accumulated pages, the page cursor and the
 * footer text in one place, and preserves the distinction the server went to the trouble of
 * encoding.
 */
export interface PageEnvelope {
  measured: boolean
  reason?: string
  page: number
  perPage: number
  /** NULL means the upstream never said. It is not zero. */
  total: number | null
  totalIsExact: boolean
  hasMore: boolean
}

/**
 * What the footer says.
 *
 * Four cases, and the fourth is the one worth having a function for: a total of `null` on a
 * MEASURED response means we hold rows but nobody counted the whole set, so "12 of 0" and
 * "12 of 12" are both lies. It says "12 shown" and stops.
 */
/** `noun` names what is counted ("records"), so a complete count is not a bare number (#189770). */
export function pageSummary(input: { shown: number; env?: PageEnvelope; noun?: string }): string | null {
  const e = input.env
  if (!e || !e.measured) return null
  const n = input.noun ? ` ${input.noun}` : ""
  if (e.total == null) return `${input.shown}${n} shown`
  if (!e.totalIsExact) return `${input.shown} of ${e.total}+${n} so far`
  if (input.shown >= e.total) return `${e.total}${n}`
  return `${input.shown} of ${e.total}${n}`
}

/** The same contract for an fl-api list a pane reads directly, from Laravel's paginator numbers. */
export function envelopeOf(p: { page: number; perPage: number; total: number; lastPage: number }): PageEnvelope {
  return { measured: true, page: p.page, perPage: p.perPage, total: p.total, totalIsExact: true, hasMore: p.page < p.lastPage }
}

export function createPagedSurface(reset: () => unknown) {
  const [page, setPage] = createSignal(1)

  // Any change to what we are looking at starts the paging over. Without this, switching
  // surface on page 3 asks the next surface for its page 3 and silently skips its first 50 rows.
  const key = createMemo(() => {
    reset()
    return Symbol()
  })
  createMemo(() => {
    key()
    setPage(1)
  })

  return {
    page,
    next: () => setPage((p) => p + 1),
    reset: () => setPage(1),
  }
}
