import { Match, Show, Switch } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { DockPrompt } from "@opencode-ai/session-ui/dock-prompt"
import { Icon } from "@opencode-ai/ui/icon"
import {
  answerConfirm,
  askedSite,
  dismissAsked,
  grantSite,
  hostOf,
  setBrowserMode,
} from "@/components/session/browser-grants"

/**
 * The Browser's ask, in the place IRIS asks for everything else: above the message box (#193051).
 * The same decision as the gold strip in the Browser bar (browser-grants), so answering either one
 * answers both. Nothing here when the agent isn't waiting on the person.
 */
export function SessionBrowserAskDock() {
  const ask = () => askedSite()
  return (
    <Show when={ask()} keyed>
      {(a) => (
        <DockPrompt
          kind="permission"
          header={
            <div data-slot="permission-row" data-variant="header">
              <span data-slot="permission-icon">
                <Icon name="warning" size="normal" />
              </span>
              <div data-slot="permission-header-title">
                <Show when={a.kind === "confirm"} fallback={<>Let IRIS use {hostOf(a.origin)}?</>}>
                  Let IRIS click "{a.label}" on {hostOf(a.origin)}?
                </Show>
              </div>
            </div>
          }
          footer={
            <>
              <div />
              <div data-slot="permission-footer-actions">
                <Switch>
                  <Match when={a.kind === "confirm"}>
                    <Button variant="ghost" size="normal" onClick={() => answerConfirm(false)}>
                      Deny
                    </Button>
                    <Button variant="primary" size="normal" onClick={() => answerConfirm(true)}>
                      Allow once
                    </Button>
                  </Match>
                  <Match when={a.kind !== "confirm"}>
                    <Button variant="ghost" size="normal" onClick={dismissAsked}>
                      Not now
                    </Button>
                    <Button variant="secondary" size="normal" onClick={() => setBrowserMode("always")}>
                      Always allow
                    </Button>
                    <Button variant="primary" size="normal" onClick={() => grantSite(a.origin, true)}>
                      Allow
                    </Button>
                  </Match>
                </Switch>
              </div>
            </>
          }
        >
          <div data-slot="permission-row">
            <span data-slot="permission-spacer" aria-hidden="true" />
            <div data-slot="permission-hint">
              <Show
                when={a.kind === "confirm"}
                fallback="IRIS wants to read and click in the Browser. Always allow covers every site; it still asks before paying, ordering, sending or deleting."
              >
                This can't be undone. IRIS waits for you.
              </Show>
            </div>
          </div>
        </DockPrompt>
      )}
    </Show>
  )
}
