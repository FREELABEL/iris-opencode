import { For, Show, createMemo, createSignal } from "solid-js"
import { GmailLogo, OutlookLogo } from "./home-first-run-art"

/**
 * "Here's what I see", drawn as what it is: a triage list (EPIC #188210).
 *
 * The subject is an inbox, so the screen takes its language from one — sender, time, read state,
 * and something you can DO to each message — rather than a stack of identical text boxes. The
 * split between "needs you" and "updates" is real (Gmail's own categories plus sender), so it is
 * the one piece of structure; the accent marks only what needs a reply.
 */

export type InboxThread = {
  id: string
  subject: string
  from: string
  snippet: string
  date?: string
  unread?: boolean
  automated?: boolean
}

export type InboxAction = { text: string; focus: InboxThread[] }

export function senderName(from: string): string {
  const m = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(from)
  return (m ? m[1] : from).trim() || "Unknown sender"
}

function senderAddress(from: string): string {
  return (/<([^>]+)>/.exec(from)?.[1] ?? from).trim().toLowerCase()
}

function initials(name: string): string {
  const parts = name.replace(/[^\p{L}\p{N} ]/gu, " ").trim().split(/\s+/).filter(Boolean)
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase()
}

/** A stable hue per sender, so the same person is the same colour everywhere. */
function hue(seed: string): number {
  let h = 0
  for (const c of seed) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return h % 360
}

function parseDate(d?: string): Date | undefined {
  if (!d) return undefined
  const n = Number(d)
  const t = Number.isFinite(n) && n > 1e11 ? new Date(n) : new Date(d)
  return Number.isNaN(t.getTime()) ? undefined : t
}

function ago(d?: string): string {
  const t = parseDate(d)
  if (!t) return ""
  const mins = Math.round((Date.now() - t.getTime()) / 60000)
  if (mins < 1) return "now"
  if (mins < 60) return `${mins}m`
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h`
  if (mins < 60 * 24 * 6) return t.toLocaleDateString(undefined, { weekday: "short" })
  return t.toLocaleDateString(undefined, { month: "short", day: "numeric" })
}

function Avatar(props: { from: string; muted?: boolean }) {
  const name = () => senderName(props.from)
  return (
    <span
      class="fr-avatar"
      classList={{ "fr-avatar-muted": !!props.muted }}
      style={{ "--h": String(hue(senderAddress(props.from))) }}
      aria-hidden="true"
    >
      {initials(name())}
    </span>
  )
}

export function InboxTriage(props: {
  account?: string
  provider?: "gmail" | "outlook"
  threads: InboxThread[]
  onAct: (a: InboxAction) => void
}) {
  const mine = (t: InboxThread) => !!props.account && senderAddress(t.from) === props.account.toLowerCase()
  const needs = createMemo(() => props.threads.filter((t) => !t.automated && !mine(t)).slice(0, 5))
  const updates = createMemo(() => props.threads.filter((t) => t.automated))
  const [picked, setPicked] = createSignal<Set<string>>(new Set())
  const [open, setOpen] = createSignal<string | undefined>(needs()[0]?.id)
  const [showUpdates, setShowUpdates] = createSignal(false)

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const chosen = () => needs().filter((t) => picked().has(t.id))

  const draft = (t: InboxThread) =>
    props.onAct({ text: `Draft a reply to ${senderName(t.from)}'s email "${t.subject}".`, focus: [t] })
  const summarise = (t: InboxThread) =>
    props.onAct({ text: `Summarise ${senderName(t.from)}'s email "${t.subject}" and tell me what it needs from me.`, focus: [t] })

  const Logo = () => (props.provider === "outlook" ? <OutlookLogo /> : <GmailLogo />)

  return (
    <div class="fr-inbox" role="region" aria-label="Your inbox">
      <header class="fr-inbox-head">
        <span class="fr-inbox-logo">
          <Logo />
        </span>
        <span class="fr-mono truncate text-[12.5px] text-v2-text-text-muted">{props.account ?? "Inbox"}</span>
        <span class="flex-1" />
        <span class="fr-mono text-[12px]">
          <span class="fr-count-needs">{needs().length} need you</span>
          <Show when={updates().length}>
            <span class="text-v2-text-text-faint"> · {updates().length} updates</span>
          </Show>
        </span>
      </header>

      <Show
        when={needs().length}
        fallback={
          <p class="px-4 py-5 text-[14px] text-v2-text-text-muted">
            Nothing from a person is waiting on a reply. Ask IRIS to go through your updates below.
          </p>
        }
      >
        <ul class="fr-rows">
          <For each={needs()}>
            {(t) => {
              const isOpen = () => open() === t.id
              const isPicked = () => picked().has(t.id)
              return (
                <li class="fr-row" classList={{ "is-open": isOpen(), "is-picked": isPicked() }}>
                  <div class="fr-row-main">
                    <button
                      class="fr-check"
                      role="checkbox"
                      aria-checked={isPicked()}
                      aria-label={`Select ${senderName(t.from)}`}
                      onClick={() => toggle(t.id)}
                    >
                      <svg viewBox="0 0 16 16" aria-hidden="true">
                        <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                    <button class="fr-row-body" onClick={() => setOpen(isOpen() ? undefined : t.id)} aria-expanded={isOpen()}>
                      <Avatar from={t.from} />
                      <span class="min-w-0 flex-1">
                        <span class="flex items-baseline gap-2">
                          <span class="truncate text-[14px] text-v2-text-text-base" classList={{ "[font-weight:650]": t.unread !== false }}>
                            {senderName(t.from)}
                          </span>
                          <Show when={t.unread}>
                            <span class="fr-unread" aria-label="Unread" />
                          </Show>
                          <span class="flex-1" />
                          <span class="fr-mono shrink-0 text-[11.5px] text-v2-text-text-faint">{ago(t.date)}</span>
                        </span>
                        <span class="block truncate text-[13.5px] text-v2-text-text-base">{t.subject}</span>
                        <span class="block text-[13px] text-v2-text-text-muted" classList={{ truncate: !isOpen() }}>
                          {t.snippet}
                        </span>
                      </span>
                    </button>
                  </div>
                  <Show when={isOpen()}>
                    <div class="fr-row-actions">
                      <button class="fr-act fr-act-primary" onClick={() => draft(t)}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M6.5 4L2.5 8l4 4M3 8h6.5a4 4 0 0 1 4 4v.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                        </svg>
                        Draft reply
                      </button>
                      <button class="fr-act" onClick={() => summarise(t)}>
                        <svg viewBox="0 0 16 16" aria-hidden="true">
                          <path d="M3 4h10M3 8h10M3 12h6" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
                        </svg>
                        Summarise
                      </button>
                    </div>
                  </Show>
                </li>
              )
            }}
          </For>
        </ul>
      </Show>

      <Show when={updates().length}>
        <button class="fr-updates" onClick={() => setShowUpdates((v) => !v)} aria-expanded={showUpdates()}>
          <svg viewBox="0 0 16 16" class="fr-caret" classList={{ "is-open": showUpdates() }} aria-hidden="true">
            <path d="M6 4l4 4-4 4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          <span class="fr-mono">{updates().length}</span> updates, newsletters and reports
          <span class="flex-1" />
          <span
            class="fr-act"
            role="button"
            tabindex="0"
            onClick={(e) => {
              e.stopPropagation()
              props.onAct({
                text: `Go through my ${updates().length} updates and newsletters. Is there anything in them I actually need to act on?`,
                focus: updates(),
              })
            }}
          >
            Skim them for me
          </span>
        </button>
        <Show when={showUpdates()}>
          <ul class="fr-rows fr-rows-compact">
            <For each={updates()}>
              {(t) => (
                <li class="fr-row-compact">
                  <Avatar from={t.from} muted />
                  <span class="w-[30%] shrink-0 truncate text-[13px] text-v2-text-text-muted">{senderName(t.from)}</span>
                  <span class="min-w-0 flex-1 truncate text-[13px] text-v2-text-text-muted">{t.subject}</span>
                  <span class="fr-mono shrink-0 text-[11.5px] text-v2-text-text-faint">{ago(t.date)}</span>
                </li>
              )}
            </For>
          </ul>
        </Show>
      </Show>

      <Show when={chosen().length}>
        <div class="fr-bulk">
          <span class="fr-mono text-[12.5px] text-v2-text-text-muted">{chosen().length} selected</span>
          <span class="flex-1" />
          <button
            class="fr-act"
            onClick={() => props.onAct({ text: `Summarise these ${chosen().length} emails and what each needs from me.`, focus: chosen() })}
          >
            Summarise
          </button>
          <button
            class="fr-act fr-act-primary"
            onClick={() =>
              props.onAct({
                text: `Draft ${chosen().length === 1 ? "a reply" : `replies to these ${chosen().length} emails`}.`,
                focus: chosen(),
              })
            }
          >
            Draft {chosen().length === 1 ? "reply" : `${chosen().length} replies`}
          </button>
        </div>
      </Show>
    </div>
  )
}
