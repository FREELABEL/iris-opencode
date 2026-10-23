/**
 * What the "N working in the background" chip lists (#189437).
 *
 * The chip counted every running session but this one, and clicking it did nothing. These rows are
 * that same set, so the number on the chip and the length of the list can never disagree.
 * Shaped after upstream OpenCode 2.0's running menu (session-running-menu.tsx): open on click, stop
 * from the row, so a later move to 2.x swaps the component instead of retraining people.
 */
export type BackgroundSession = { id: string; title?: string; parentID?: string; directory?: string }

export type BackgroundRow = {
  id: string
  title: string
  /** The parent chat's title when this is a sub-agent, so "which chat started this?" is answered. */
  parent?: string
  subagent: boolean
  retrying: boolean
}

export function backgroundRows(input: {
  status: Record<string, { type: string } | undefined>
  working: (id: string) => boolean
  info: (id: string) => BackgroundSession | undefined
  current?: string
  untitled: string
}): BackgroundRow[] {
  return Object.keys(input.status)
    .filter((id) => id !== input.current && input.working(id))
    .map((id) => {
      const session = input.info(id)
      const parent = session?.parentID ? input.info(session.parentID) : undefined
      return {
        id,
        title: session?.title?.trim() || input.untitled,
        parent: session?.parentID ? parent?.title?.trim() || input.untitled : undefined,
        subagent: !!session?.parentID,
        retrying: input.status[id]?.type === "retry",
      }
    })
    .sort((a, b) => Number(a.subagent) - Number(b.subagent) || a.title.localeCompare(b.title))
}
