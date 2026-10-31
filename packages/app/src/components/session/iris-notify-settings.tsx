/**
 * What you hear about from Atlas (#189799): an email when you are assigned a card, mentioned in
 * a comment, or have a card due tomorrow — and a desktop notification for all three. Yours only;
 * nobody else's settings are read or changed. Each switch saves the moment it flips.
 */
import { Dialog } from "@opencode-ai/ui/dialog"
import { createResource, createSignal, For, Show } from "solid-js"

interface NotifySettings {
  emailAssign: boolean
  emailMention: boolean
  emailDue: boolean
  push: boolean
}
type Reply = { measured: boolean; reason?: string; settings: NotifySettings }

const ROWS: { key: keyof NotifySettings; label: string; hint: string }[] = [
  { key: "push", label: "Desktop notifications", hint: "Assigned to you, mentioned, or due tomorrow — while IRIS is open." },
  { key: "emailAssign", label: "Email when I'm assigned a card", hint: "Someone gives you a card." },
  { key: "emailMention", label: "Email when I'm mentioned", hint: "@you in a card comment." },
  { key: "emailDue", label: "Email the day before a card is due", hint: "Cards assigned to you that are not done." },
]

export function IrisNotifySettings(props: { doFetch: (path: string, init?: RequestInit) => Promise<Response> }) {
  const [data, { mutate }] = createResource(async () => (await (await props.doFetch(`/iris/notifications/settings`)).json()) as Reply)
  const [note, setNote] = createSignal<string | null>(null)
  async function flip(key: keyof NotifySettings, on: boolean) {
    const before = data.latest
    if (!before) return
    setNote(null)
    mutate({ ...before, settings: { ...before.settings, [key]: on } })
    try {
      const res = await props.doFetch(`/iris/notifications/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ [key]: on }),
      })
      const j = (await res.json()) as Reply
      if (!res.ok || !j.measured) throw new Error(j.reason ?? `request failed (${res.status})`)
      mutate(j)
    } catch (e) {
      mutate(before)
      setNote(`Not saved — ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return (
    <Dialog title="Notifications" description="What Atlas tells you about your cards">
      <div class="iris-notify">
        <Show when={data.latest && !data.latest.measured}>
          <p class="text-12-regular text-text-weak">Could not read your settings — {data.latest!.reason}.</p>
        </Show>
        <Show when={data.latest?.measured}>
          <For each={ROWS}>
            {(row) => (
              <label class="iris-notify__row">
                <input
                  type="checkbox"
                  checked={data.latest!.settings[row.key]}
                  onChange={(e) => void flip(row.key, e.currentTarget.checked)}
                />
                <span>
                  <span class="iris-notify__label">{row.label}</span>
                  <span class="iris-notify__hint">{row.hint}</span>
                </span>
              </label>
            )}
          </For>
          <p class="iris-notify__hint">Boards marked as holding health information never put a card's title or a comment's words in an email or notification.</p>
        </Show>
        <Show when={note()}>
          <p class="iris-quick__note" role="status">
            {note()}
          </p>
        </Show>
      </div>
    </Dialog>
  )
}
