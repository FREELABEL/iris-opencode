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
  due_date: "Due",
  bloq_list_id: "List",
}

/** One field's value as words. A body is cut to its start; an empty value says so rather than showing nothing. */
export function heldValue(field: string, v: unknown, listName?: (id: number) => string | undefined): string {
  if (v === null || v === undefined || v === "") return "(empty)"
  if (field === "due_date" && typeof v === "string") return v.slice(0, 10)
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
