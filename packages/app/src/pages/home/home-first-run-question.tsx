import { For, Show, createMemo, createSignal } from "solid-js"
import { senderName, type InboxThread } from "./home-first-run-inbox"

/**
 * "What do you want" → one question, in the shape of the session's question dock
 * (session-question-dock.tsx): checkboxes, three suggestions, "Type your own answer" always last.
 * Designed in the Genesis prototype first (iris-onboarding-prototype, Alex 2026-10-09).
 *
 * Order of truth: the GOAL decides; the suggestions are what IRIS can really do toward it (the
 * catalog plus `iris intent`, via /iris/onboarding/capabilities); the INBOX is only evidence under
 * a suggestion, never a suggestion itself.
 */

export type GoalId = "reply" | "admin" | "catchup" | "leads" | "custom"

/** What IRIS can do toward the goal — from /iris/onboarding/capabilities. */
export type Capability = {
  id: string
  title: string
  detail: string
  tool: string
  evidence: { kinds: Array<"person" | "action" | "fyi">; pattern?: string }
  source: "catalog" | "intent"
  primary?: boolean
}

export const EXAMPLES = [
  "Reply to the people waiting on me",
  "Catch me up on what I missed",
  "Turn my receipts into my books",
  "Follow up with my leads",
]

/** Their words → the nearest starter goal, so the catalog can answer; anything else is "custom" and goes to `iris intent`. */
export function goalOf(text: string): GoalId {
  const t = text.toLowerCase()
  if (/\b(repl(y|ies)|respond|answer|waiting|get back to|write back)\b/.test(t)) return "reply"
  if (/\b(receipts?|bills?|invoices?|books|bookkeeping|expenses?|alerts?|security|accounts?)\b/.test(t)) return "admin"
  if (/\b(catch( me)? up|missed|summar(y|ise|ize)|recap|what happened|while i was)\b/.test(t)) return "catchup"
  if (/\b(leads?|prospects?|customers?|clients?|sales|follow[- ]?up|deals?)\b/.test(t)) return "leads"
  return "custom"
}

type Kind = NonNullable<InboxThread["kind"]>
const kindOf = (t: InboxThread): Kind => t.kind ?? (t.automated ? "fyi" : "person")

/** The cross-check: which of their threads this capability would act on. */
export function evidenceFor(cap: Capability, threads: InboxThread[]): InboxThread[] {
  let re: RegExp | undefined
  try {
    re = cap.evidence.pattern ? new RegExp(`\\b(${cap.evidence.pattern})`, "i") : undefined
  } catch {
    re = undefined
  }
  return threads.filter((t) => cap.evidence.kinds.includes(kindOf(t)) && (!re || re.test(`${t.subject} ${t.snippet}`)))
}

/**
 * The one line under an option (Alex, 2026-10-09: title + one subtitle, no commands). Aimed at
 * people → who, from their own mail. Otherwise → what it does, and how much of their mail it covers.
 * The tool still reaches the session prompt; it is just not shown here.
 */
export function subline(cap: Capability, evidence: InboxThread[]): string {
  if (!evidence.length) return cap.detail
  const perPerson = cap.evidence.kinds.length === 1 && cap.evidence.kinds[0] === "person"
  if (perPerson) {
    const names = [...new Set(evidence.map((t) => senderName(t.from)))]
    return `e.g. ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` and ${names.length - 2} more` : ""}`
  }
  return `${cap.detail} · ${evidence.length} ${evidence.length === 1 ? "email" : "emails"} in your inbox`
}

export function GoalAsk(props: { initial?: string; onAsk: (text: string) => void }) {
  const [text, setText] = createSignal(props.initial ?? "")
  let ref: HTMLTextAreaElement | undefined
  const submit = (t = text()) => {
    const v = t.trim()
    if (v) props.onAsk(v)
  }
  return (
    <div class="flex flex-col gap-4">
      <form
        class="fr-ask"
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        <textarea
          ref={(el) => {
            ref = el
            queueMicrotask(() => el.focus())
          }}
          rows={2}
          placeholder="e.g. answer the people who've been waiting on me all week"
          value={text()}
          onInput={(e) => setText(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault()
              submit()
            }
          }}
        />
        <div class="flex items-center justify-between">
          <span class="text-[12px] text-v2-text-text-faint">Press Enter</span>
          <button class="fr-solid" type="submit" disabled={!text().trim()}>
            Go
          </button>
        </div>
      </form>
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[12.5px] text-v2-text-text-faint">Try:</span>
        <For each={EXAMPLES}>
          {(x) => (
            <button
              class="fr-example"
              onClick={() => {
                setText(x)
                ref?.blur()
                submit(x)
              }}
            >
              {x}
            </button>
          )}
        </For>
      </div>
    </div>
  )
}

export function QuestionCard(props: {
  goal: string
  capabilities: Capability[]
  threads: InboxThread[]
  onSubmit: (prompt: string, focus: InboxThread[]) => void
  onDismiss: () => void
}) {
  const caps = createMemo(() => props.capabilities.slice(0, 3))
  const evidence = createMemo(() => new Map(caps().map((c) => [c.id, evidenceFor(c, props.threads)])))
  // Ticked: what answers the goal. Nothing answers it (own words intent could not place) → their
  // own words are the answer, pre-filled, rather than quietly starting a different job.
  const nothing = () => !caps().some((c) => c.primary)
  const [picked, setPicked] = createSignal<Set<string>>(new Set(caps().filter((c) => c.primary).map((c) => c.id)))
  const [own, setOwn] = createSignal(nothing() ? props.goal : "")
  const [ownOn, setOwnOn] = createSignal(nothing())
  let ownRef: HTMLInputElement | undefined

  const toggle = (id: string) =>
    setPicked((p) => {
      const n = new Set(p)
      n.has(id) ? n.delete(id) : n.add(id)
      return n
    })
  const ready = () => picked().size > 0 || (ownOn() && !!own().trim())

  function submit() {
    if (!ready()) return
    const chosen = caps().filter((c) => picked().has(c.id))
    const focus = [...new Map(chosen.flatMap((c) => evidence().get(c.id) ?? []).map((t) => [t.id, t])).values()].slice(0, 15)
    const lines = chosen.map((c) => {
      const ev = (evidence().get(c.id) ?? []).slice(0, 5).map((t) => `${senderName(t.from)} ("${t.subject}")`)
      return `- ${c.title} — use \`${c.tool}\`${ev.length ? `. Relevant mail: ${ev.join("; ")}` : ""}`
    })
    if (ownOn() && own().trim()) lines.push(`- ${own().trim()} — work out the steps with me`)
    const prompt = `My goal: ${props.goal}\n\nDo these, with these IRIS tools:\n${lines.join("\n")}\n\nDraft everything for me to review. Don't send anything.`
    props.onSubmit(prompt, focus)
  }

  return (
    <div class="fr-qcard fr-rise">
      <div class="fr-qcard-head">
        <span>Question</span>
        <span>1 of 1</span>
      </div>
      <div class="px-4 pt-4">
        <div class="text-[15.5px] text-v2-text-text-base [font-weight:600]">What should IRIS do for “{props.goal}”?</div>
        <div class="mt-0.5 text-[12.5px] text-v2-text-text-faint">Select all answers that apply</div>
      </div>
      <div class="flex flex-col px-2 pb-2 pt-2">
        <For each={caps()}>
          {(c) => {
            const ev = () => evidence().get(c.id) ?? []
            return (
              <button class="fr-qopt" role="checkbox" aria-checked={picked().has(c.id)} data-on={picked().has(c.id) ? "" : undefined} onClick={() => toggle(c.id)}>
                <span class="fr-qbox" aria-hidden="true" />
                <span class="flex min-w-0 flex-1 flex-col">
                  <span class="text-[14.5px] text-v2-text-text-base [font-weight:500]">{c.title}</span>
                  <span class="mt-0.5 text-[12.5px] text-v2-text-text-muted">{subline(c, ev())}</span>
                </span>
              </button>
            )
          }}
        </For>
        <div
          class="fr-qopt"
          role="checkbox"
          aria-checked={ownOn()}
          data-on={ownOn() ? "" : undefined}
          onClick={(e) => {
            if (e.target === ownRef) return setOwnOn(true)
            setOwnOn(!ownOn())
            if (ownOn()) ownRef?.focus()
          }}
        >
          <span class="fr-qbox" aria-hidden="true" />
          <span class="flex min-w-0 flex-1 flex-col">
            <span class="text-[14.5px] text-v2-text-text-base [font-weight:500]">Type your own answer</span>
            <input
              ref={ownRef}
              class="fr-qown"
              placeholder="Type your answer..."
              value={own()}
              onInput={(e) => {
                setOwn(e.currentTarget.value)
                if (e.currentTarget.value.trim()) setOwnOn(true)
              }}
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
          </span>
        </div>
      </div>
      <div class="fr-qcard-foot">
        <button class="text-[13px] text-v2-text-text-muted hover:text-v2-text-text-base" onClick={props.onDismiss}>
          Dismiss
        </button>
        <button class="fr-solid" disabled={!ready()} onClick={submit}>
          Submit
        </button>
      </div>
    </div>
  )
}
