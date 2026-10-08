import { createEffect, createMemo, createSignal, Match, on, Show, Switch } from "solid-js"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { useServerSDK } from "@/context/server-sdk"
import { usePlatform } from "@/context/platform"
import { needsSystemBrowser,
  addressToUrl,
  knownEmbeddable,
  navigateWeb,
  webBack,
  webCanBack,
  webCanForward,
  webForward,
  webReload,
  webReloadKey,
  webUrl,
} from "./web-nav"
import "./session-web-tab.css"

/**
 * The side panel's Browser tab (#187864): a link from the chat, shown beside the chat.
 *
 * A frame cannot tell you it was refused — a blocked cross-origin frame fires `load` like one
 * that worked — so before showing a page that is not heyiris.io, the sidecar reads its framing
 * headers (/iris/frame-check). A refused page gets a message and "Open in browser", never a
 * white pane. When the check itself cannot answer (an older sidecar, no network) the page is
 * shown anyway: an unanswered check says nothing about the page.
 *
 * Not a createResource. A resource read inside the side panel suspends the panel's <Suspense>,
 * which is the bug that blanked every tab switch (bf98ec65c4). Plain signals cannot suspend.
 *
 * Known limit: links clicked INSIDE the framed page navigate the frame, and a cross-origin
 * frame's location is unreadable, so the address bar keeps the page you opened.
 */

/** The live sandbox, the same rule as Genesis › Artifacts' live frame (LIVE_SANDBOX): the page
 * gets its OWN origin, never the app's (linkAction never sends an app-origin URL here), and
 * top navigation is not granted, so a page cannot replace the app. */
const WEB_SANDBOX = "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"

type Check =
  | { state: "checking" }
  | { state: "embeddable" }
  | { state: "refused"; reason: string; opened?: boolean }
  | { state: "unknown" }

export function SessionWebTab() {
  const serverSDK = useServerSDK()
  const platform = usePlatform()
  const base = createMemo(() => serverSDK().url.replace(/\/$/, ""))
  const [check, setCheck] = createSignal<Check>({ state: "checking" })
  const [address, setAddress] = createSignal("")

  createEffect(
    on([webUrl, webReloadKey], ([url]) => {
      setAddress(url ?? "")
      if (!url) return
      if (knownEmbeddable(url)) return setCheck({ state: "embeddable" })
      // A sign-in page that reached the panel some other way (typed, pasted, opened by an agent)
      // goes to the browser too — it cannot complete in a frame (#188639).
      if (needsSystemBrowser(url)) {
        platform.openExternal(url)
        return setCheck({ state: "refused", reason: "sign-in pages open in your browser", opened: true })
      }
      setCheck({ state: "checking" })
      const q = `url=${encodeURIComponent(url)}&origin=${encodeURIComponent(location.origin)}`
      ;(platform.fetch ?? globalThis.fetch)(`${base()}/iris/frame-check?${q}`, {
        headers: { Accept: "application/json" },
      })
        .then((r) => (r.ok ? r.json() : undefined))
        .then((body: { state?: string; reason?: string } | undefined) => {
          if (webUrl() !== url) return // a later link won the race
          // A page that forbids framing is opened in the browser once, automatically: the only
          // thing the user could do from the refusal screen was click "Open in browser" (#188639).
          if (body?.state === "refused") {
            platform.openExternal(url)
            return setCheck({ state: "refused", reason: body.reason ?? "the site refuses", opened: true })
          }
          if (body?.state === "embeddable") return setCheck({ state: "embeddable" })
          setCheck({ state: "unknown" })
        })
        .catch(() => {
          if (webUrl() === url) setCheck({ state: "unknown" })
        })
    }),
  )

  const host = createMemo(() => {
    try {
      return new URL(webUrl() ?? "").host
    } catch {
      return ""
    }
  })
  const openOutside = () => {
    const url = webUrl()
    if (url) platform.openExternal(url)
  }
  const go = () => {
    const url = addressToUrl(address())
    if (url) navigateWeb(url)
  }

  return (
    <div data-component="session-web-tab" class="session-web">
      <div class="session-web__bar">
        <IconButton
          icon="chevron-left"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webCanBack()}
          onClick={webBack}
          aria-label="Back"
        />
        <IconButton
          icon="chevron-right"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webCanForward()}
          onClick={webForward}
          aria-label="Forward"
        />
        <IconButton
          icon="arrow-undo-down"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webUrl()}
          onClick={webReload}
          aria-label="Reload"
        />
        <input
          class="session-web__address"
          data-slot="web-address"
          value={address()}
          spellcheck={false}
          placeholder="Type an address, or click a link in the chat"
          onInput={(e) => setAddress(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") go()
            if (e.key === "Escape") setAddress(webUrl() ?? "")
          }}
          onFocus={(e) => e.currentTarget.select()}
        />
        <IconButton
          icon="square-arrow-top-right"
          variant="ghost"
          class="h-6 w-6"
          disabled={!webUrl()}
          onClick={openOutside}
          aria-label="Open in browser"
          title="Open in browser"
        />
      </div>
      <div class="session-web__body">
        <Switch>
          <Match when={!webUrl()}>
            <div class="session-web__note">
              Links you click in the chat open here. Cmd-click opens them in your browser.
            </div>
          </Match>
          <Match when={check().state === "checking"}>
            <div class="session-web__note">Loading {host()}…</div>
          </Match>
          <Match when={check().state === "refused" && (check() as { reason: string })}>
            {(refused) => (
              <div class="session-web__note" data-slot="web-refused">
                <div class="session-web__note-title">
                  {(refused() as { opened?: boolean }).opened ? `Opened ${host()} in your browser` : `${host()} can't be shown inside IRIS`}
                </div>
                <div>The site doesn't allow other apps to show it{(refused() as { opened?: boolean }).opened ? ", so it opened there instead." : "."}</div>
                <div class="session-web__reason">{refused().reason}</div>
                <button type="button" class="session-web__open" onClick={openOutside}>
                  {(refused() as { opened?: boolean }).opened ? "Open it again" : "Open in browser"}
                </button>
              </div>
            )}
          </Match>
          <Match when={webUrl()}>
            {(url) => (
              <Show when={`${url()}#${webReloadKey()}`} keyed>
                <iframe
                  class="session-web__frame"
                  title={host()}
                  src={url()}
                  sandbox={WEB_SANDBOX}
                  referrerpolicy="strict-origin-when-cross-origin"
                  data-testid="web-frame"
                />
              </Show>
            )}
          </Match>
        </Switch>
      </div>
    </div>
  )
}
