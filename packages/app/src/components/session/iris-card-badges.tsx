/**
 * What a card FACE says at a glance (#189806), the same in List and Board view: labels, due
 * date, priority, checklist progress, attachments, and who it is assigned to.
 *
 * Every badge is drawn only when its fact is known. A count fl-api did not send (an older
 * fl-api with no ?summary=1) is absent, not "0" — a face that says "✓ 0/0" about a card with a
 * full checklist is worse than a face that says nothing.
 */
import { For, Show } from "solid-js"
import { dueLabel, dueState, initials } from "./iris-atlas-view"

export interface CardFace {
  startDate?: string
  dueDate?: string
  priority?: string
  labels?: string[]
  tasks?: { open: number; done: number; total: number }
  attachments?: number
  /** First image attachment, drawn above the title in Board view (#189797). Never on a PHI board. */
  cover?: string
  assignees?: { id: number; type: "user" | "agent"; name?: string }[]
  /** An edit made here with no connection (#190537 W3): waiting to be sent, or held for a person. */
  pending?: "waiting" | "held"
}

const LOUD = new Set(["urgent", "critical", "high", "p0", "p1"])

export function CardBadges(props: { item: CardFace; now: number; max?: number }) {
  const due = () => (props.item.dueDate ? dueState(props.item.dueDate, props.now) : undefined)
  const people = () => props.item.assignees ?? []
  const shown = () => people().slice(0, props.max ?? 3)
  const any = () =>
    !!(
      props.item.pending ||
      props.item.dueDate ||
      props.item.priority ||
      props.item.labels?.length ||
      props.item.tasks?.total ||
      props.item.attachments ||
      people().length
    )
  return (
    <Show when={any()}>
      <span class="iris-badges">
        <Show when={props.item.pending}>
          {(p) => (
            <span
              class="iris-badge iris-badge--pending"
              data-pending={p()}
              title={
                p() === "held"
                  ? "This card changed while you were offline, in a field you also changed. Choose which to keep at the top of the board."
                  : "Changed on this computer while offline — it will be sent when IRIS can be reached."
              }
            >
              {p() === "held" ? "Needs you" : "Waiting to send"}
            </span>
          )}
        </Show>
        <For each={props.item.labels ?? []}>{(l) => <span class="iris-badge iris-badge--label">{l}</span>}</For>
        <Show when={props.item.priority}>
          {(p) => (
            <span class="iris-badge" classList={{ "iris-badge--loud": LOUD.has(p().toLowerCase()) }} title="Priority">
              {p()}
            </span>
          )}
        </Show>
        <Show when={props.item.dueDate}>
          {(d) => (
            <span
              class="iris-badge iris-badge--due"
              data-due={due()}
              title={`Due ${d()}${due() === "overdue" ? " — overdue" : ""}`}
            >
              {dueLabel(d(), props.now)}
            </span>
          )}
        </Show>
        <Show when={props.item.tasks?.total}>
          <span
            class="iris-badge font-mono tabular-nums"
            classList={{ "iris-badge--complete": props.item.tasks!.open === 0 }}
            title={`${props.item.tasks!.done} of ${props.item.tasks!.total} checklist items done`}
          >
            ✓ {props.item.tasks!.done}/{props.item.tasks!.total}
          </span>
        </Show>
        <Show when={props.item.attachments}>
          <span class="iris-badge font-mono tabular-nums" title={`${props.item.attachments} attached`}>
            📎 {props.item.attachments}
          </span>
        </Show>
        <Show when={people().length}>
          <span class="iris-avatars" title={people().map((a) => a.name ?? (a.type === "agent" ? "agent" : "member")).join(", ")}>
            <For each={shown()}>
              {(a) => (
                <span class="iris-avatar" classList={{ "iris-avatar--agent": a.type === "agent" }}>
                  {initials(a.name)}
                </span>
              )}
            </For>
            <Show when={people().length > shown().length}>
              <span class="iris-avatar iris-avatar--more">+{people().length - shown().length}</span>
            </Show>
          </span>
        </Show>
      </span>
    </Show>
  )
}
