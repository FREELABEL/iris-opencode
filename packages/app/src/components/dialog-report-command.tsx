import { Button } from "@opencode-ai/ui/button"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { Dialog } from "@opencode-ai/ui/dialog"
import type { CommandReportInput } from "@opencode-ai/session-ui/context"
import { createResource, createSignal, Show } from "solid-js"
import { showToast } from "@/utils/toast"

type Fetcher = (path: string, init?: RequestInit) => Promise<Response>
type Result = { ok: boolean; itemId?: number; reason?: string; title?: string; description?: string }

const post = async (doFetch: Fetcher, body: object): Promise<Result> => {
  const res = await doFetch("/iris/bug-report", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) return { ok: false, reason: `The app's local server answered ${res.status}.` }
  return (await res.json()) as Result
}

/**
 * Report a failed command (#189435). Shows exactly what will be sent (scrubbed of secrets by the
 * same code that sends it), lets the person add what they were doing, and only then files it.
 */
export function DialogReportCommand(props: { report: CommandReportInput; doFetch: Fetcher }) {
  const dialog = useDialog()
  const [note, setNote] = createSignal("")
  const [sending, setSending] = createSignal(false)
  const [preview] = createResource(() => post(props.doFetch, { ...props.report, preview: true }))

  const send = async () => {
    setSending(true)
    const r = await post(props.doFetch, { ...props.report, note: note() || undefined }).catch(
      (): Result => ({ ok: false, reason: "Could not reach the app's local server." }),
    )
    setSending(false)
    if (!r.ok) {
      showToast({ title: "Report not sent", description: r.reason ?? "Try again in a minute." })
      return
    }
    dialog.close()
    showToast({ title: "Thanks — reported", description: r.itemId ? `Filed as #${r.itemId}. We'll look at it.` : "We'll look at it." })
  }

  return (
    <Dialog title="Report this command" class="w-full max-w-[560px] mx-auto">
      <div class="flex flex-col gap-4 p-6 pt-0" data-component="report-command">
        <p class="text-14-regular text-text-weak">
          This sends the command, its result and the last lines of its output to the IRIS team. Anything that looks like a
          password or key is removed first. Nothing else from this chat is sent.
        </p>
        <label class="flex flex-col gap-1.5">
          <span class="text-13-medium text-text-base">What were you trying to do? (optional)</span>
          <textarea
            class="min-h-[64px] rounded-md border border-border-weak-base bg-background-base px-3 py-2 text-14-regular text-text-strong outline-none focus:border-border-strong-base"
            value={note()}
            onInput={(e) => setNote(e.currentTarget.value)}
            placeholder="e.g. setting up my agents folder"
          />
        </label>
        <details class="rounded-md border border-border-weak-base">
          <summary class="cursor-pointer px-3 py-2 text-13-medium text-text-base">What will be sent</summary>
          <Show when={preview()} fallback={<p class="px-3 pb-3 text-13-regular text-text-weak">Preparing…</p>}>
            {(p) => (
              <div class="px-3 pb-3 flex flex-col gap-2">
                <div class="text-13-medium text-text-strong">{p().title}</div>
                <pre class="max-h-[140px] overflow-auto whitespace-pre-wrap text-12-regular text-text-weak font-mono">{p().description}</pre>
              </div>
            )}
          </Show>
        </details>
        <div class="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="large" onClick={() => dialog.close()}>
            Cancel
          </Button>
          <Button type="button" variant="primary" size="large" disabled={sending()} onClick={send} data-action="send-report">
            {sending() ? "Sending…" : "Send report"}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
