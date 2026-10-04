import { createEffect, onCleanup } from "solid-js"
import { useLayout } from "@/context/layout"
import { usePlatform } from "@/context/platform"
import { useSessionLayout } from "@/pages/session/session-layout"
import { atlasNoteUrl } from "./iris-atlas-artifacts-model"
import { focusAtlasNote, requestIrisNav } from "./iris-nav"
import { linkAction, navigateWeb, WEB_TAB } from "./web-nav"

/**
 * Links in the chat open in the side panel's Browser tab (#187864) instead of leaving the app.
 *
 * Scoped to the chat timeline on purpose: a link in a dialog, the settings or the error page
 * keeps its old behaviour. Listens in the CAPTURE phase so it runs before tauri-plugin-opener's
 * window listener, which skips a click that is already defaultPrevented — see web-nav.ts.
 */
export function useLinksOpenInPanel(root: () => HTMLElement | undefined) {
  const layout = useLayout()
  const { tabs, view } = useSessionLayout()
  const platform = usePlatform()

  // The same three steps as opening a Genesis artifact from its chat card: the tab only renders
  // once it is in the list, and "other" is the source that does not close the panel.
  const showTab = (tab: string) => {
    view().reviewPanel.open("other")
    if (layout.fileTree.opened() && layout.fileTree.tab() !== "all") layout.fileTree.setTab("all")
    void tabs().open(tab)
    tabs().setActive(tab)
  }

  const openInPanel = (href: string) => {
    // An Atlas note (heyiris.io/n/<uuid>) opens in Atlas › Artifacts, exactly as its chat card
    // does: that pane knows the note's real title and explains a private one, which a bare frame
    // shows as a blank 404 with no reason.
    const note = atlasNoteUrl(href)
    if (note) {
      requestIrisNav({ surface: "atlas", sub: "artifacts" })
      focusAtlasNote(note)
      return showTab("iris")
    }
    navigateWeb(href)
    showTab(WEB_TAB)
  }

  createEffect(() => {
    const el = root()
    if (!el) return
    const onClick = (event: MouseEvent) => {
      const anchor = event
        .composedPath()
        .find((node): node is HTMLAnchorElement => node instanceof HTMLAnchorElement && !!node.href)
      if (!anchor) return
      const action = linkAction({
        href: anchor.href,
        button: event.button,
        meta: event.metaKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        alt: event.altKey,
        appOrigin: location.origin,
      })
      if (action === "default") return
      event.preventDefault()
      if (action === "system") return platform.openExternal(anchor.href)
      openInPanel(anchor.href)
    }
    el.addEventListener("click", onClick, true)
    onCleanup(() => el.removeEventListener("click", onClick, true))
  })
}
