import { createEffect, createSignal, on, onCleanup, type JSX } from "solid-js"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import type { StatusTone } from "@opencode-ai/ui/status-badge"
import "./iris-pane-dialog.css"

/**
 * A pane's confirm or short form, on the app's one Dialog (#194375 W5) — focus trapped, Escape and
 * the overlay close it, the title is the dialog's label. It replaces the panes' hand-built scrims.
 *
 * Declarative on purpose, like `<Show when>`: a pane keeps its own "what is being confirmed"
 * signal and passes it as `when`. Closing from inside (Escape, the overlay, the close button)
 * calls `onClose`; the pane clearing `when` (the action landed) closes it. The last value is held
 * while the dialog animates out, so the body never reads a cleared signal.
 */
export function PaneDialog<T>(props: {
  when: T | undefined | null | false
  onClose: () => void
  title: (value: T) => JSX.Element
  size?: "small" | "normal" | "large"
  class?: string
  children: (value: () => T) => JSX.Element
  /** A hook for tests and screenshots, on the dialog body. */
  id?: string
}) {
  const dialog = useDialog()
  const [held, setHeld] = createSignal<T>()
  let shown = false
  const closed = () => {
    if (!shown) return
    shown = false
    props.onClose()
  }
  createEffect(
    on(
      () => props.when,
      (when) => {
        if (when) setHeld(() => when as T)
        if (when && !shown) {
          shown = true
          const value = () => held() as T
          void dialog.show(
            () => (
              <Dialog fit size={props.size ?? "small"} title={props.title(value())} class={`iris-pane-dialog ${props.class ?? ""}`}>
                <div data-slot="iris-pane-dialog-body" data-id={props.id}>
                  {props.children(value)}
                </div>
              </Dialog>
            ),
            closed,
          )
          return
        }
        if (!when && shown) {
          shown = false
          dialog.close()
        }
      },
    ),
  )
  onCleanup(() => {
    if (!shown) return
    shown = false
    dialog.close()
  })
  return null
}

/** The row of actions at the foot of a PaneDialog: Cancel, then the verb. */
export function PaneDialogActions(props: { children: JSX.Element }) {
  return <div data-slot="iris-pane-dialog-actions">{props.children}</div>
}

/** The panes' old tones (good / warn / bad / info / idle) as the library's StatusTone. */
export type PaneTone = "good" | "warn" | "bad" | "info" | "idle"
export function statusTone(tone: PaneTone | string | undefined): StatusTone {
  if (tone === "good") return "success"
  if (tone === "warn") return "warning"
  if (tone === "bad") return "critical"
  if (tone === "info") return "info"
  return "neutral"
}
