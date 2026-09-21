import { useSDK } from "@/context/sdk"
import { usePlatform } from "@/context/platform"
import { useServer } from "@/context/server"
import { createMemo, onCleanup } from "solid-js"
import { useSessionLayout } from "./session-layout"
import { useDialog } from "@opencode-ai/ui/context"
import { showToast } from "@opencode-ai/ui/toast"
import { noticeCopy, type ServerNotice } from "./allowance-notice"

/**
 * The "you are close to your weekly allowance" notice — #186456 / #186457.
 *
 * A TOAST, NOT A DIALOG, and that is the decision rather than a styling preference. The policy
 * says `surface: "chat"` because this fires while somebody is mid-flow and has done nothing
 * wrong; a modal stops them to deliver news they did not need stopping for. The refusal at the
 * wall is the modal. This is not that.
 *
 * WHEN IT ASKS. Once per session turn, when the session goes idle — never on an interval.
 * Fetching CONSUMES a pending notice: the server writes the row that makes "once per calendar
 * week" true as it answers, so a poll timer would eat somebody's only warning for the week and
 * nobody would ever see it. If this ever needs to be periodic, the server has to grow a
 * separate peek that does not consume, and that is a server change, not a client one.
 *
 * It holds NO policy. Not the threshold, not the amount, not the window. Every number is on
 * the wire; see bloq item #186459.
 */
export function useAllowanceNotice() {
  const sdk = useSDK()
  const dialog = useDialog()
  const platform = usePlatform()
  const server = useServer()
  const { params } = useSessionLayout()

  // The sidecar, not fl-iris-api. The webview cannot reach the platform directly — the bearer
  // token lives on disk in the sidecar process — which is the whole reason /iris/* exists.
  const base = createMemo(() => server.current?.http?.url?.replace(/\/$/, ""))

  let inFlight = false

  onCleanup(
    sdk().event.on("session.status", (evt) => {
      if (evt.properties.sessionID !== params.id) return
      // Idle means the turn finished. A notice delivered mid-stream competes with the thing
      // they are actually reading.
      if (evt.properties.status.type !== "idle") return
      // Never stack this on top of the wall's own dialog. Someone who has just been refused
      // does not also need to be told they are at 90%.
      if (dialog.active) return
      if (inFlight) return
      inFlight = true

      void (async () => {
        try {
          const url = base()
          if (!url) return
          const fetcher = platform.fetch ?? globalThis.fetch
          const res = (await (await fetcher(`${url}/iris/allowance`)).json()) as {
            measured?: boolean
            notice?: ServerNotice | null
          }
          // `measured: false` means we could not ask. It is NOT an account at 0%, and it is
          // certainly not a notice — say nothing rather than invent a reading.
          if (!res?.measured) return
          const copy = noticeCopy(res.notice as ServerNotice | null)
          if (!copy) return

          showToast({
            title: copy.title,
            description: copy.description,
            variant: "default",
            // Persistent: the server has already spent this account's one notice for the week
            // on this render. A toast that auto-dismisses while they are looking at a terminal
            // means the notice was delivered to nobody, and there is not another one coming.
            persistent: true,
            actions: copy.link
              ? [
                  { label: copy.label, onClick: () => window.open(copy.link!, "_blank") },
                  { label: "Dismiss", onClick: "dismiss" },
                ]
              : [{ label: "Dismiss", onClick: "dismiss" }],
          })
        } catch {
          // A notice we failed to fetch is silence. There is nothing useful to say to somebody
          // about a limit we could not read.
        } finally {
          inFlight = false
        }
      })()
    }),
  )
}
