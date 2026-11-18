/**
 * THE CARD'S FACTS, AT THE TOP (#190269) — who is on it, what state it is in, when it is due.
 *
 * The card editor used to answer those with five stacked selects and a Save button below them:
 * a settings form, read top to bottom. A card is read at a glance, so the facts are chips under
 * the title and the people are faces in a row — each one a click away from changing, and each
 * change saved the moment it is made.
 *
 * Members are many: people and agents together, picked with checkboxes from one list, not one
 * select at a time that made a card look like it could hold only one.
 */
import { createMemo, createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { IRIS_COLORS } from "../plan-mark"
import { initials } from "./iris-atlas-view"

export interface MemberChoice {
  /** "u12" for a person, "a7" for an agent — the key the editor's assign call takes. */
  key: string
  label: string
  kind: "user" | "agent"
  /** The assignment row id when this one is already on the card. */
  assignedId?: number
  hint?: string
}

/**
 * Where a floating layer opened FROM `el` must live, and the offset to correct `position: fixed`
 * by. Inside a modal dialog it must be IN the dialog: the dialog turns pointer events off for
 * everything outside it, so a layer on document.body is visible and cannot be clicked. And the
 * dialog is transformed, which makes it the containing block for `fixed` — so the layer's
 * viewport coordinates are shifted by wherever that block starts (measured, not assumed).
 */
export function floatingLayer(el: Element | null | undefined): { mount: Element; dx: number; dy: number } {
  const mount = el?.closest('[role="dialog"]') ?? document.body
  if (mount === document.body) return { mount, dx: 0, dy: 0 }
  const probe = document.createElement("div")
  probe.style.cssText = "position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none"
  mount.appendChild(probe)
  const r = probe.getBoundingClientRect()
  probe.remove()
  return { mount, dx: r.left, dy: r.top }
}

/** People's colours. Never violet or blue: those are the agents', so a face is a person at a glance. */
const PALETTE = [IRIS_COLORS.fuchsia, IRIS_COLORS.cyan, IRIS_COLORS.emerald, "#f59e0b", "#f43f5e", "#14b8a6"]

/** The same person is the same colour everywhere: picked from their name, not their position. */
export function avatarColor(seed: string): string {
  let h = 0
  for (const ch of seed) h = (h * 31 + ch.charCodeAt(0)) >>> 0
  return PALETTE[h % PALETTE.length]
}

/**
 * A face. People are round, in a colour from their name. Agents are rounded squares in the IRIS
 * violet, with their own initials and a small spark — so three agents are three names, not three
 * copies of the same robot, and nobody mistakes an agent for a colleague.
 */
export function Avatar(props: { name: string; kind: "user" | "agent"; size?: number; title?: string }) {
  const size = () => props.size ?? 28
  return (
    <span
      class="iris-avatar2"
      data-kind={props.kind}
      title={props.title ?? `${props.name}${props.kind === "agent" ? " · agent" : ""}`}
      style={{
        width: `${size()}px`,
        height: `${size()}px`,
        "font-size": `${Math.round(size() * 0.38)}px`,
        background:
          props.kind === "agent"
            ? `linear-gradient(135deg, ${IRIS_COLORS.violet}, ${IRIS_COLORS.blue})`
            : avatarColor(props.name),
      }}
    >
      {initials(props.name)}
      <Show when={props.kind === "agent"}>
        <span class="iris-avatar2__spark" aria-hidden="true">✦</span>
      </Show>
    </span>
  )
}

/** One fact under the title: a label, a value, and a click that changes it. */
export function FactChip(props: {
  label: string
  value?: string
  placeholder?: string
  dot?: string
  tone?: "warn" | "danger" | "ok"
  onClick?: (e: MouseEvent & { currentTarget: HTMLButtonElement }) => void
  children?: JSX.Element
}) {
  return (
    <button
      type="button"
      class="iris-fact"
      data-tone={props.tone}
      data-empty={props.value ? undefined : ""}
      onClick={(e) => props.onClick?.(e)}
    >
      <span class="iris-fact__label">{props.label}</span>
      <Show when={props.dot}>
        <span class="iris-fact__dot" style={{ background: props.dot }} aria-hidden="true" />
      </Show>
      <span class="iris-fact__value">{props.value || props.placeholder || "Add"}</span>
      {props.children}
    </button>
  )
}

/** Status → a dot colour people learn once: grey waiting, blue moving, green finished, red stopped. */
export function statusDot(status: string | undefined): string {
  const s = (status ?? "").toLowerCase()
  if (["done", "completed", "approved"].includes(s)) return IRIS_COLORS.emerald
  if (["in_progress", "active", "doing"].includes(s)) return IRIS_COLORS.blue
  if (["rejected", "blocked"].includes(s)) return "#ef4444"
  if (s === "pending") return "#f59e0b"
  return "#94a3b8"
}

export function MembersRow(props: {
  choices: MemberChoice[]
  /** The top-bar form: no label, faces overlap, more than five fold into "+N". */
  compact?: boolean
  /** The sidebar form: one row per member with their name, like Elon's "Assigned" list. */
  list?: boolean
  loading?: boolean
  unavailable?: string
  note?: { ok: boolean; text: string } | null
  onAdd: (key: string) => Promise<void> | void
  onRemove: (assignedId: number) => Promise<void> | void
  onEmail: (email: string) => Promise<void> | void
}) {
  const [open, setOpen] = createSignal<{ left: number; top: number; mount: Element } | null>(null)
  const [query, setQuery] = createSignal("")
  const [email, setEmail] = createSignal("")
  const [busy, setBusy] = createSignal<string | null>(null)
  const on = createMemo(() => props.choices.filter((c) => c.assignedId != null))
  const MAX = 5
  const faces = createMemo(() => (props.compact ? on().slice(0, MAX) : on()))
  const extra = () => (props.compact ? Math.max(0, on().length - MAX) : 0)
  const shown = createMemo(() => {
    const q = query().trim().toLowerCase()
    return props.choices.filter((c) => !q || c.label.toLowerCase().includes(q) || (c.hint ?? "").toLowerCase().includes(q))
  })
  const people = () => shown().filter((c) => c.kind === "user")
  const agents = () => shown().filter((c) => c.kind === "agent")

  async function toggle(c: MemberChoice) {
    if (busy()) return
    setBusy(c.key)
    try {
      if (c.assignedId != null) await props.onRemove(c.assignedId)
      else await props.onAdd(c.key)
    } finally {
      setBusy(null)
    }
  }

  let pop: HTMLDivElement | undefined
  onMount(() => {
    const away = (e: MouseEvent) => {
      if (open() && pop && !pop.contains(e.target as Node) && !(e.target as HTMLElement).closest(".iris-members2__add")) setOpen(null)
    }
    const esc = (e: KeyboardEvent) => {
      if (e.key === "Escape" && open()) {
        e.preventDefault()
        e.stopImmediatePropagation()
        setOpen(null)
      }
    }
    // On the WINDOW, capturing: the card is a dialog that closes on Escape, and Escape here
    // must close only the picker.
    document.addEventListener("mousedown", away)
    window.addEventListener("keydown", esc, true)
    onCleanup(() => {
      document.removeEventListener("mousedown", away)
      window.removeEventListener("keydown", esc, true)
    })
  })

  const Row = (c: MemberChoice) => (
    <label class="iris-pick__row" data-on={c.assignedId != null ? "" : undefined}>
      <input type="checkbox" checked={c.assignedId != null} disabled={busy() !== null} onChange={() => void toggle(c)} />
      <Avatar name={c.label} kind={c.kind} size={22} />
      <span class="iris-pick__name">{c.label}</span>
      <Show when={c.hint}>
        <span class="iris-pick__hint">{c.hint}</span>
      </Show>
      <Show when={busy() === c.key}>
        <span class="iris-pick__hint">…</span>
      </Show>
    </label>
  )

  return (
    <div class="iris-members2" data-compact={props.compact ? "" : undefined}>
      <Show when={!props.compact && !props.list}>
        <span class="iris-fact__label">Members</span>
      </Show>
      <Show when={props.list}>
        <ul class="iris-members2__list">
          <For each={on()}>
            {(c) => (
              <li class="iris-members2__row">
                <Avatar name={c.label} kind={c.kind} size={24} />
                <span class="iris-members2__name">{c.label}</span>
                <span class="iris-members2__kind">{c.kind === "agent" ? "Agent" : "Person"}</span>
                <button
                  type="button"
                  class="iris-members2__rowx"
                  title={`Take ${c.label} off this card`}
                  aria-label={`Unassign ${c.label}`}
                  disabled={busy() !== null}
                  onClick={() => void toggle(c)}
                >
                  ×
                </button>
              </li>
            )}
          </For>
        </ul>
      </Show>
      <div class="iris-members2__faces" data-list={props.list ? "" : undefined}>
        <For each={props.list ? [] : faces()}>
          {(c) => (
            <span class="iris-members2__face">
              <Avatar name={c.label} kind={c.kind} />
              <button
                type="button"
                class="iris-members2__x"
                title={`Take ${c.label} off this card`}
                aria-label={`Unassign ${c.label}`}
                onClick={() => void toggle(c)}
              >
                ×
              </button>
            </span>
          )}
        </For>
        <Show when={extra() > 0}>
          <span class="iris-members2__more" title={on().slice(MAX).map((c) => c.label).join(", ")}>
            +{extra()}
          </span>
        </Show>
        <button
          type="button"
          class="iris-members2__add"
          title="Add people or agents"
          aria-label="Add people or agents"
          aria-expanded={!!open()}
          disabled={!!props.unavailable}
          onClick={(e) => {
            if (open()) return setOpen(null)
            const r = e.currentTarget.getBoundingClientRect()
            const layer = floatingLayer(e.currentTarget)
            setQuery("")
            setOpen({
              left: Math.max(8, Math.min(r.left, window.innerWidth - 328)) - layer.dx,
              top: r.bottom + 6 - layer.dy,
              mount: layer.mount,
            })
            queueMicrotask(() => pop?.querySelector<HTMLInputElement>("input[type=search]")?.focus())
          }}
        >
          {props.list ? "+ Assign person or agent" : "+"}
        </button>
        <Show when={on().length === 0 && !props.unavailable && !props.list}>
          <span class="iris-members2__empty">{props.compact ? "Add people or agents" : "Nobody yet"}</span>
        </Show>
        <Show when={props.unavailable}>
          <span class="iris-members2__empty">Not available — {props.unavailable}</span>
        </Show>
      </div>
      <Show when={props.note}>
        {(n) => (
          <span class="iris-members2__note" data-ok={n().ok ? "" : undefined} role="status">
            {n().text}
          </span>
        )}
      </Show>

      <Show when={open()}>
        {(at) => (
          <Portal mount={at().mount}>
            <div
              ref={pop}
              class="iris-pick"
              role="dialog"
              data-dismiss-first
              aria-label="Members of this card"
              data-prevent-autofocus
              style={{ left: `${at().left}px`, top: `${at().top}px` }}
              onKeyDown={(e) => e.stopPropagation()}
            >
              <input
                type="search"
                class="iris-pick__search"
                placeholder="Search people and agents"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
              />
              <div class="iris-pick__list">
                <Show when={people().length > 0}>
                  <div class="iris-pick__head">People</div>
                  <For each={people()}>{Row}</For>
                </Show>
                <Show when={agents().length > 0}>
                  <div class="iris-pick__head">Agents</div>
                  <For each={agents()}>{Row}</For>
                </Show>
                <Show when={shown().length === 0}>
                  <p class="iris-pick__hint iris-pick__none">{props.loading ? "Loading…" : "Nobody matches."}</p>
                </Show>
              </div>
              <form
                class="iris-pick__invite"
                onSubmit={async (e) => {
                  e.preventDefault()
                  const v = email().trim()
                  if (!v) return
                  await props.onEmail(v)
                  setEmail("")
                }}
              >
                <input
                  type="email"
                  class="iris-pick__search"
                  placeholder="Invite by email — they see only their cards"
                  value={email()}
                  onInput={(e) => setEmail(e.currentTarget.value)}
                />
              </form>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  )
}
