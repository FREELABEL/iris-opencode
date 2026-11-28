/**
 * EDITS HELD FOR A PERSON (#190537 W3), at the top of the board.
 *
 * An edit made offline is sent when IRIS can be reached. If the card changed meanwhile in a
 * field this edit ALSO changed, neither value is picked by whichever was sent last: both are
 * shown here, side by side, and the person chooses. Fields that did not overlap have already
 * been sent — only the ones listed are waiting.
 *
 * A refusal (IRIS said no — the board's owner changed who can edit it) has nothing to choose
 * between: it says why, and can be dismissed.
 */
import { For, Show, createSignal } from "solid-js"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { IconButton } from "@opencode-ai/ui/icon-button"
import { Notice } from "@opencode-ai/ui/notice"
import { useLanguage } from "@/context/language"
import { PaneDialog, PaneDialogActions } from "./iris-pane-dialog"

export interface HeldField {
  field: string
  base?: unknown
  mine: unknown
  theirs: unknown
}
export interface HeldItem {
  opId: string
  itemId: number
  kind: "conflict" | "refused"
  message: string
  fields: HeldField[]
}

const FIELD_LABEL: Record<string, string> = {
  title: "Title",
  content: "Description",
  status: "Status",
  priority: "Priority",
  card_type: "Type",
  start_date: "Start",
  due_date: "Due",
  bloq_list_id: "List",
}

/** One field's value as words. A body is cut to its start; an empty value says so rather than showing nothing. */
export function heldValue(field: string, v: unknown, listName?: (id: number) => string | undefined): string {
  if (v === null || v === undefined || v === "") return "(empty)"
  if ((field === "due_date" || field === "start_date") && typeof v === "string") return v.slice(0, 10)
  if (field === "bloq_list_id") return listName?.(Number(v)) ?? `list ${v}`
  if (field === "status" && typeof v === "string") return v.replace(/_/g, " ")
  const s = typeof v === "string" ? v : JSON.stringify(v)
  return s.length > 160 ? `${s.slice(0, 160)}…` : s
}

export function IrisOutboxHeld(props: {
  items: HeldItem[]
  cardTitle: (itemId: number) => string | undefined
  listName?: (id: number) => string | undefined
  resolve: (opId: string, choice: "mine" | "theirs") => Promise<string | undefined>
}) {
  const [busy, setBusy] = createSignal<string | null>(null)
  const [error, setError] = createSignal<string | null>(null)
  const choose = async (opId: string, choice: "mine" | "theirs") => {
    setBusy(opId)
    setError(null)
    const reason = await props.resolve(opId, choice)
    setBusy(null)
    if (reason) setError(reason)
  }
  return (
    <Show when={props.items.length > 0}>
      <section class="iris-held" aria-label="Changes that need you">
        <For each={props.items}>
          {(h) => (
            <article class="iris-held__item" data-kind={h.kind}>
              <p class="iris-held__card">{props.cardTitle(h.itemId) ?? `Card #${h.itemId}`}</p>
              <p class="iris-held__msg">{h.message}</p>
              <Show when={h.fields.length > 0}>
                <table class="iris-held__table">
                  <thead>
                    <tr>
                      <th scope="col" />
                      <th scope="col">Yours</th>
                      <th scope="col">Now on IRIS</th>
                    </tr>
                  </thead>
                  <tbody>
                    <For each={h.fields}>
                      {(f) => (
                        <tr>
                          <th scope="row">{FIELD_LABEL[f.field] ?? f.field}</th>
                          <td>{heldValue(f.field, f.mine, props.listName)}</td>
                          <td>{heldValue(f.field, f.theirs, props.listName)}</td>
                        </tr>
                      )}
                    </For>
                  </tbody>
                </table>
              </Show>
              <div class="iris-held__actions">
                <Show
                  when={h.kind === "conflict"}
                  fallback={
                    <button type="button" class="iris-held__btn" disabled={busy() === h.opId} onClick={() => choose(h.opId, "theirs")}>
                      Dismiss
                    </button>
                  }
                >
                  <button
                    type="button"
                    class="iris-held__btn iris-held__btn--primary"
                    disabled={busy() === h.opId}
                    onClick={() => choose(h.opId, "mine")}
                  >
                    Keep mine
                  </button>
                  <button type="button" class="iris-held__btn" disabled={busy() === h.opId} onClick={() => choose(h.opId, "theirs")}>
                    Keep what's on IRIS
                  </button>
                </Show>
              </div>
            </article>
          )}
        </For>
        <Show when={error()}>{(e) => <p class="iris-held__error" role="alert">{e()}</p>}</Show>
      </section>
    </Show>
  )
}

/** What POST /iris/atlas-outbox/send answered, or why it could not be asked. */
export type OutboxSendResult = { sent: number; held: number; waiting: number; offline: boolean } | { error: string }

/** The result as one line of words, in the order a person reads it: sent, held, still waiting. */
export function outboxResultLine(r: OutboxSendResult, t: (key: string, params?: Record<string, string | number>) => string): {
  tone: "success" | "warning" | "critical"
  text: string
} {
  if ("error" in r) return { tone: "critical", text: t("iris.atlas.outbox.failed", { reason: r.error }) }
  if (r.offline) return { tone: "warning", text: t("iris.atlas.outbox.offline") }
  const parts = [
    r.sent > 0 ? t("iris.atlas.outbox.sent", { count: r.sent }) : "",
    r.held > 0 ? t("iris.atlas.outbox.held", { count: r.held }) : "",
    r.waiting > 0 ? t("iris.atlas.outbox.left", { count: r.waiting }) : "",
  ].filter(Boolean)
  if (!parts.length) return { tone: "success", text: t("iris.atlas.outbox.nothing") }
  return { tone: r.held > 0 || r.waiting > 0 ? "warning" : "success", text: parts.join(" · ") }
}

/**
 * EDITS WAITING TO BE SENT (#194509), above the held ones. They go out on their own every 20 s
 * once IRIS answers; "Send now" asks for that at once, after a confirm, because it sends.
 */
export function IrisOutboxWaiting(props: { waiting: number; send: () => Promise<OutboxSendResult> }) {
  const language = useLanguage()
  const t = (key: string, params?: Record<string, string | number>) => language.t(key as any, params as any)
  const [confirming, setConfirming] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [result, setResult] = createSignal<ReturnType<typeof outboxResultLine> | null>(null)
  const send = async () => {
    setBusy(true)
    const r = await props.send()
    setBusy(false)
    setConfirming(false)
    setResult(outboxResultLine(r, t))
  }
  return (
    <>
      <Show when={props.waiting > 0 && !result()}>
        <Notice
          class="iris-outbox-waiting"
          tone="info"
          role="status"
          data-slot="iris-outbox-waiting"
          icon={<Icon name="cloud-upload" size="small" />}
          action={
            <Button type="button" size="small" variant="secondary" disabled={busy()} onClick={() => setConfirming(true)}>
              {busy() ? t("iris.atlas.outbox.sending") : t("iris.atlas.outbox.send")}
            </Button>
          }
        >
          {t("iris.atlas.outbox.waiting", { count: props.waiting })}
        </Notice>
      </Show>
      <Show when={result()}>
        {(r) => (
          <Notice
            class="iris-outbox-waiting"
            tone={r().tone}
            role="status"
            data-slot="iris-outbox-result"
            icon={<Icon name={r().tone === "success" ? "circle-check" : "warning"} size="small" />}
            action={
              <IconButton icon="close-small" variant="ghost" aria-label={t("common.close")} onClick={() => setResult(null)} />
            }
          >
            {r().text}
          </Notice>
        )}
      </Show>
      <PaneDialog
        when={confirming()}
        onClose={() => setConfirming(false)}
        id="iris-outbox-send-confirm"
        title={() => t("iris.atlas.outbox.confirm.title")}
      >
        {() => (
          <>
            <p>{t("iris.atlas.outbox.confirm.body")}</p>
            <PaneDialogActions>
              <Button type="button" size="small" variant="secondary" onClick={() => setConfirming(false)}>
                {t("common.cancel")}
              </Button>
              <Button type="button" size="small" variant="primary" disabled={busy()} onClick={() => void send()}>
                {busy() ? t("iris.atlas.outbox.sending") : t("iris.atlas.outbox.send")}
              </Button>
            </PaneDialogActions>
          </>
        )}
      </PaneDialog>
    </>
  )
}
