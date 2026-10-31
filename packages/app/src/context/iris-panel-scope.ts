import { createComponent, createContext, createRoot, createSignal, useContext, type ParentProps } from "solid-js"

/**
 * THE SCOPE CHIP (#187130, option C): what the IRIS panel is scoped to — a project, the session, or
 * the account — shown on the side panel's product row. The IRIS tab knows what it says; the
 * panel's tab strip draws it.
 *
 * One per PANEL, not per window (#191484). It used to be a single module-level signal: with two
 * chats side by side, both panels wrote into it and both chips showed whichever wrote last — so
 * picking a project from one chip changed the other panel's project. A split column provides its
 * own; everything outside a split shares the window's, as before.
 */
export type IrisScopeChip = { scope: "project" | "session" | "account"; label: string; pick?: () => void }

/**
 * THE PRODUCT ON SCREEN, and the way to ask for another (#191484). Also once per window: the
 * product strip's click went out as one window-wide request that every IRIS tab obeyed, so
 * switching one panel to Genesis switched them all — and the panels, each mirroring its product
 * into the one shared signal, overwrote each other until the stack ran out. Per panel now.
 */
export type IrisSurfaceRequest = { surface: string; sub?: string }

function createIrisPanelScope(initialSurface?: string) {
  const [chip, setChip] = createSignal<IrisScopeChip | undefined>()
  const [surface, setSurfaceSig] = createSignal<string | undefined>(initialSurface)
  const [requested, setRequested] = createSignal<IrisSurfaceRequest | undefined>()
  let changedAt = 0
  return {
    chip,
    setChip,
    /** The product this panel shows; undefined until its IRIS tab first says. */
    surface,
    setSurface(id: string) {
      if (id !== surface()) changedAt = performance.now()
      setSurfaceSig(id)
    },
    /** When the product last changed — the strip times its "still loading" hint from it. */
    surfaceChangedAt: () => changedAt,
    /** Ask this panel's IRIS tab to show a product (and sub-view). Consumed once. */
    requested,
    request: (r: IrisSurfaceRequest) => setRequested(r),
    consumeRequest: () => setRequested(undefined),
  }
}

type IrisPanelScope = ReturnType<typeof createIrisPanelScope>

const windowScope = createRoot(() => createIrisPanelScope())
const Ctx = createContext<IrisPanelScope>()

export function IrisPanelScopeProvider(props: ParentProps) {
  // A new column opens on the product the window was showing.
  const value = createIrisPanelScope(windowScope.surface())
  return createComponent(Ctx.Provider, {
    value,
    get children() {
      return props.children
    },
  })
}

export const useIrisPanelScope = (): IrisPanelScope => useContext(Ctx) ?? windowScope

/** The window's scope, for its one-time opening product (session-iris-tab sets it at load). */
export const windowIrisPanelScope = windowScope
