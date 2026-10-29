import { createComponent, createContext, useContext, type Accessor, type ParentProps } from "solid-js"

/**
 * What a session screen can ask of the split it sits in (#191484) — so a column's own ⋯ menu can
 * open a column beside it. Absent outside a session route (Home, a draft), where there is no split.
 */
export type SplitActions = {
  /** Open another session to the right of this one: the next open tab, or a new chat. */
  splitRight: (sessionId: string) => void
  /** False when the window cannot fit another column. */
  canSplit: Accessor<boolean>
  /**
   * The sessions in the columns on screen, empty with one column (#191772). An approval belongs to
   * the column showing the session that asked; a parent column must not show it too.
   */
  columns?: Accessor<readonly string[]>
}

const Ctx = createContext<SplitActions>()

export function SplitActionsProvider(props: ParentProps<{ actions: SplitActions }>) {
  return createComponent(Ctx.Provider, {
    value: props.actions,
    get children() {
      return props.children
    },
  })
}

export const useSplitActions = () => useContext(Ctx)
