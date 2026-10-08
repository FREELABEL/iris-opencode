import { For, createSignal } from "solid-js"
import type { InboxThread } from "./home-first-run-inbox"

/**
 * "What do you want IRIS to take off your plate?" — asked BEFORE the inbox is read (EPIC #188210).
 *
 * The inbox scan used to come first and the question after, so what IRIS showed was whatever the
 * last forty messages happened to be. Asking first makes the scan a consequence of the answer:
 * the same inbox is ordered, filtered and turned into one concrete next action around what the
 * person said they want.
 */

export type IntentId = "reply" | "admin" | "catchup" | "leads" | "custom"
export type Intent = { id: IntentId; text: string }

type Kind = NonNullable<InboxThread["kind"]>
const kindOf = (t: InboxThread): Kind => t.kind ?? (t.automated ? "fyi" : "person")

/** Someone asking to buy, book or work together. Deliberately broad: a missed lead costs more than a false one. */
const LEAD = /\b(quote|pricing|price|rates?|interested|inquir(y|e)|enquir(y|e)|book(ing)?|availability|proposal|partner(ship)?|collab|hire|project|estimate|demo|meeting)\b/i

export const INTENTS: { id: Exclude<IntentId, "custom">; label: string; detail: string; icon: string }[] = [
  { id: "reply", label: "Reply to people waiting on me", detail: "Find who's waiting and draft the replies", icon: "M6.5 4L2.5 8l4 4M3 8h6.5a4 4 0 0 1 4 4v.5" },
  { id: "admin", label: "Deal with bills, receipts and alerts", detail: "The things your accounts are asking you to do", icon: "M8 2l5.5 2.5v3.5c0 3-2.3 5.6-5.5 6.5C4.8 13.6 2.5 11 2.5 8V4.5z" },
  { id: "catchup", label: "Catch me up on what I missed", detail: "A short summary of everything recent", icon: "M3 4h10M3 8h10M3 12h6" },
  { id: "leads", label: "Find leads and opportunities", detail: "People asking about prices, bookings or working together", icon: "M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8L2.5 6.5l3.8-.5z" },
]

/**
 * The scan, shaped by the answer: which threads lead, and the one action that does what they asked.
 * Returns `focus` (what the plan acts on) and `lead` (the order the list shows them in).
 */
export function planFor(intent: Intent, threads: InboxThread[]): { title: string; cta: string; prompt: string; focus: InboxThread[] } {
  const people = threads.filter((t) => kindOf(t) === "person")
  const actions = threads.filter((t) => kindOf(t) === "action")
  const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`
  switch (intent.id) {
    case "reply":
      return people.length
        ? {
            title: `${n(people.length, "person is", "people are")} waiting on a reply.`,
            cta: `Draft ${people.length === 1 ? "the reply" : `${Math.min(people.length, 5)} replies`}`,
            prompt: "Draft replies to the people waiting on me.",
            focus: people.slice(0, 5),
          }
        : {
            title: "Nobody's waiting on a reply right now.",
            cta: actions.length ? `Handle the ${n(actions.length, "thing", "things")} that need you instead` : "Catch me up instead",
            prompt: actions.length ? "Nobody is waiting on a reply. Help me deal with what my accounts are asking me to do." : "Catch me up on my recent mail.",
            focus: actions.length ? actions : threads.slice(0, 15),
          }
    case "admin":
      return actions.length
        ? {
            title: `${n(actions.length, "thing needs", "things need")} you.`,
            cta: `Handle ${actions.length === 1 ? "it" : `all ${actions.length}`}`,
            prompt: "Help me deal with these: what do I need to do for each, and can you do it?",
            focus: actions,
          }
        : {
            title: "No bills, receipts or alerts waiting.",
            cta: "Catch me up instead",
            prompt: "Catch me up on my recent mail.",
            focus: threads.slice(0, 15),
          }
    case "leads": {
      const leads = people.filter((t) => LEAD.test(`${t.subject} ${t.snippet}`))
      return leads.length
        ? {
            title: `${n(leads.length, "possible lead", "possible leads")} in your inbox.`,
            cta: `Follow up with ${leads.length === 1 ? "them" : `all ${leads.length}`}`,
            prompt: "These look like leads. Draft a follow-up to each that moves it toward a booking or a sale.",
            focus: leads,
          }
        : {
            title: people.length ? "No obvious leads, but people are waiting." : "No leads in your recent mail.",
            cta: people.length ? `Look through the ${n(people.length, "person", "people")} for opportunities` : "Catch me up instead",
            prompt: "Look through my recent mail for anything that could become business, and tell me what to do about it.",
            focus: people.length ? people : threads.slice(0, 15),
          }
    }
    case "catchup":
      return {
        title: "Here's what came in.",
        cta: "Summarise it for me",
        prompt: "Catch me up: summarise my recent mail, most important first, and tell me what needs me.",
        focus: [...people, ...actions, ...threads.filter((t) => kindOf(t) === "fyi")].slice(0, 15),
      }
    default:
      return {
        title: "Here's what I found for that.",
        cta: "Start",
        prompt: intent.text,
        focus: [...people, ...actions].slice(0, 8),
      }
  }
}

export function IntentPicker(props: { onPick: (i: Intent) => void }) {
  const [text, setText] = createSignal("")
  return (
    <div class="flex flex-col gap-3">
      <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <For each={INTENTS}>
          {(o) => (
            <button class="fr-tile fr-intent" onClick={() => props.onPick({ id: o.id, text: o.label })}>
              <span class="fr-intent-icon">
                <svg viewBox="0 0 16 16" aria-hidden="true">
                  <path d={o.icon} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </span>
              <span class="flex flex-col gap-0.5">
                <span class="text-[15px] text-v2-text-text-base [font-weight:600]">{o.label}</span>
                <span class="text-[13px] text-v2-text-text-muted">{o.detail}</span>
              </span>
            </button>
          )}
        </For>
      </div>
      <form
        class="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          const t = text().trim()
          if (t) props.onPick({ id: "custom", text: t })
        }}
      >
        <input
          class="fr-input flex-1"
          placeholder="Or tell IRIS in your own words…"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
        />
        <button class="fr-primary px-5" type="submit" disabled={!text().trim()}>
          Go
        </button>
      </form>
    </div>
  )
}
