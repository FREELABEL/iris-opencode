import { createSignal } from "solid-js"

/**
 * Links open inside the app (#187864) — the side panel's Browser tab.
 *
 * Two halves. `linkAction` decides what a click on a chat link does; it is pure, so the rule is
 * tested without a DOM. The history below is what the Browser tab shows.
 *
 * WHY THE CLICK HAS TO BE CLAIMED IN THE CAPTURE PHASE. Chat links render as
 * `<a target="_blank">`, and the desktop app loads tauri-plugin-opener, whose injected script
 * listens for `click` on `window` (bubble phase) and hands any `_blank` http(s) link to the OS —
 * unless the event is already `defaultPrevented`. A capture listener runs first, so claiming the
 * click there is the whole mechanism; nothing in the plugin has to change.
 */

/** The side-panel tab id. A named panel tab like "context" and "iris" — never a file. */
export const WEB_TAB = "web"

export type LinkAction = "panel" | "system" | "default"

export function linkAction(input: {
  href: string | undefined
  button: number
  meta: boolean
  ctrl: boolean
  shift: boolean
  alt: boolean
  /** The app's own origin. A link back into the app is navigation, not a page to browse. */
  appOrigin: string
}): LinkAction {
  if (input.button !== 0 || !input.href) return "default"
  let url: URL
  try {
    url = new URL(input.href, input.appOrigin)
  } catch {
    return "default"
  }
  // mailto:, tel:, file:, custom schemes — exactly what they did before.
  if (url.protocol !== "http:" && url.protocol !== "https:") return "default"
  // Never frame the app inside itself: in the web preview a same-origin page with
  // allow-same-origin + allow-scripts could reach into the app.
  if (url.origin === input.appOrigin) return "default"
  // Cmd-click (Ctrl on Windows/Linux) is the way out to the real browser, as it always was.
  if (input.meta || input.ctrl) return "system"
  if (input.shift || input.alt) return "default"
  return "panel"
}

type History = { stack: string[]; index: number; reload: number }

const [history, setHistory] = createSignal<History>({ stack: [], index: -1, reload: 0 })

/** The page the Browser tab is on, or undefined before the first link. */
export const webUrl = () => {
  const h = history()
  return h.stack[h.index]
}
/** Changes on every reload, so the frame remounts even when the URL did not change. */
export const webReloadKey = () => history().reload
export const webCanBack = () => history().index > 0
export const webCanForward = () => {
  const h = history()
  return h.index < h.stack.length - 1
}

/** Open a page: drops any forward history, as a browser does. The same URL again is a reload. */
export function navigateWeb(url: string) {
  setHistory((h) => {
    if (h.stack[h.index] === url) return { ...h, reload: h.reload + 1 }
    const stack = [...h.stack.slice(0, h.index + 1), url]
    return { stack, index: stack.length - 1, reload: h.reload }
  })
}

export function webBack() {
  setHistory((h) => (h.index > 0 ? { ...h, index: h.index - 1 } : h))
}

export function webForward() {
  setHistory((h) => (h.index < h.stack.length - 1 ? { ...h, index: h.index + 1 } : h))
}

export function webReload() {
  setHistory((h) => ({ ...h, reload: h.reload + 1 }))
}

/** What the address bar turns typed text into: a bare host gets https://. */
export function addressToUrl(text: string): string | undefined {
  const t = text.trim()
  if (!t) return undefined
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(t) ? t : `https://${t}`
  try {
    const u = new URL(withScheme)
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined
    if (!u.hostname.includes(".") && u.hostname !== "localhost") return undefined
    return u.href
  } catch {
    return undefined
  }
}

/** heyiris.io frames itself for the app (frame-ancestors, fl-iris-api f4002920) — no check needed. */
export function knownEmbeddable(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === "https:" && u.hostname === "heyiris.io"
  } catch {
    return false
  }
}
