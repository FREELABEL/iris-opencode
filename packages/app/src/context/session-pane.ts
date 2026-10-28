import { useParams, type Params } from "@solidjs/router"
import { createComponent, createContext, useContext, type Accessor, type ParentProps } from "solid-js"

/**
 * WHICH SESSION AM I (#191484). Session code used to read its session from the URL, which can
 * only name one — so a second column had no way to be a different session. A pane says which
 * session it holds; outside a pane (one column, every other page) the URL still answers, so the
 * single-column app reads exactly what it read before.
 *
 * Read session identity with `useSessionParams()`, never `useParams()`, anywhere under a session.
 * Window-level code (titlebar, tabs, sidebar) keeps `useParams()`: it means the focused session.
 */
export type SessionPaneParams = {
  serverKey?: string
  id?: string
  /** base64 directory, as the legacy `/:dir/session/:id` route carries it */
  dir?: string
}

export type SessionPane = {
  params: Accessor<SessionPaneParams>
  /** True for the pane the window's route points at — the one the user is working in. */
  focused: Accessor<boolean>
  /** Make this pane the focused one. */
  focus: () => void
}

const PaneContext = createContext<SessionPane>()

export function SessionPaneProvider(props: ParentProps<{ pane: SessionPane }>) {
  return createComponent(PaneContext.Provider, {
    value: props.pane,
    get children() {
      return props.children
    },
  })
}

export const useSessionPane = () => useContext(PaneContext)

/** The route's params, unless this code runs inside a pane — then the pane's. Reactive, like `useParams()`. */
export function useSessionParams<T extends Params = Params>(): T {
  return paneParams(useParams<T>(), useContext(PaneContext))
}

/** The session identity from the pane when there is one; everything else from the route. */
export function paneParams<T extends Params>(route: T, pane: SessionPane | undefined): T {
  if (!pane) return route
  return new Proxy(route, {
    get(target, key) {
      if (key === "serverKey" || key === "id" || key === "dir") return pane.params()[key]
      return Reflect.get(target, key)
    },
  })
}

/** True when not in a pane (one column) or when this pane is the focused one. */
export function usePaneFocused(): Accessor<boolean> {
  const pane = useContext(PaneContext)
  return pane ? pane.focused : () => true
}
