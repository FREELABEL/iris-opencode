import { For, Show, createMemo, createSignal } from "solid-js"
import { senderName, type InboxThread } from "./home-first-run-inbox"
import { planFor, type Intent } from "./home-first-run-intent"

/**
 * Clarifying questions, after the read (EPIC #188210). The shape is Elon's ClarifyingQuestionsStep
 * — numbered questions, single or multi select, "Other" with its own words — because that flow
 * is the one that worked. The difference is where the options come from: not a model's guesses
 * about a workflow, but the person's own inbox, filtered by what they said they want.
 *
 * The inbox is never shown as "here is everything I read". It appears only as the things IRIS can
 * do toward the answer they gave — which is the privacy line Alex drew (2026-10-08).
 */

type Kind = NonNullable<InboxThread["kind"]>
const kindOf = (t: InboxThread): Kind => t.kind ?? (t.automated ? "fyi" : "person")

type Option = { id: string; label: string; description?: string; thread?: InboxThread }
type Question = { id: string; question: string; type: "multi" | "single"; options: Option[]; hint?: string }

const TONES: Option[] = [
  { id: "warm", label: "Warm and friendly" },
  { id: "short", label: "Short and direct" },
  { id: "formal", label: "Formal" },
]
const MODES: Option[] = [
  { id: "draft", label: "Draft only", description: "I review and send" },
  { id: "simple", label: "Send the simple ones", description: "draft anything that needs a decision" },
]

function actionLabel(intent: Intent, t: InboxThread): string {
  const who = senderName(t.from)
  if (kindOf(t) === "action") return `Handle ${who}`
  if (intent.id === "leads") return `Follow up with ${who}`
  return `Reply to ${who}`
}

export function ClarifyStep(props: {
  intent: Intent
  threads: InboxThread[]
  onStart: (prompt: string, focus: InboxThread[]) => void
}) {
  const plan = createMemo(() => planFor(props.intent, props.threads))
  const candidates = createMemo(() => {
    const focus = plan().focus.filter((t) => kindOf(t) !== "fyi")
    const rest = props.threads.filter((t) => kindOf(t) !== "fyi" && !focus.some((f) => f.id === t.id))
    return [...focus, ...rest].slice(0, 7)
  })
  const updates = createMemo(() => props.threads.filter((t) => kindOf(t) === "fyi"))

  const [picked, setPicked] = createSignal<Set<string>>(
    new Set([
      ...plan()
        .focus.filter((t) => kindOf(t) !== "fyi")
        .slice(0, 5)
        .map((t) => t.id),
      ...(props.intent.id === "catchup" && updates().length ? ["updates"] : []),
    ]),
  )
  const [tone, setTone] = createSignal("warm")
  const [mode, setMode] = createSignal("draft")
  const [notes, setNotes] = createSignal("")

  const actions = (): Option[] => [
    ...candidates().map((t) => ({ id: t.id, label: actionLabel(props.intent, t), description: t.subject, thread: t })),
    ...(updates().length
      ? [{ id: "updates", label: `Summarise my ${updates().length} updates`, description: "newsletters, reports and notifications" }]
      : []),
  ]
  const replying = () => actions().some((o) => picked().has(o.id) && o.thread && kindOf(o.thread) === "person")

  const questions = (): Question[] => [
    { id: "do", question: "What should IRIS do?", type: "multi", hint: "Select all that apply", options: actions() },
    ...(replying() ? [{ id: "tone", question: "How should replies sound?", type: "single" as const, options: TONES }] : []),
    { id: "mode", question: "Before anything goes out", type: "single", options: MODES },
  ]

  const isOn = (q: Question, o: Option) =>
    q.id === "do" ? picked().has(o.id) : q.id === "tone" ? tone() === o.id : mode() === o.id
  const toggle = (q: Question, o: Option) => {
    if (q.id === "tone") return setTone(o.id)
    if (q.id === "mode") return setMode(o.id)
    setPicked((p) => {
      const n = new Set(p)
      n.has(o.id) ? n.delete(o.id) : n.add(o.id)
      return n
    })
  }

  const count = () => picked().size

  function go() {
    const chosen = actions().filter((o) => picked().has(o.id))
    const focus = chosen.flatMap((o) => (o.thread ? [o.thread] : o.id === "updates" ? updates() : []))
    const lines = chosen.map((o) => `- ${o.label}${o.description ? ` — ${o.description}` : ""}`).join("\n")
    const prompt =
      `${props.intent.text}\n\nDo these:\n${lines}\n\n` +
      (replying() ? `Replies should sound ${TONES.find((t) => t.id === tone())!.label.toLowerCase()}.\n` : "") +
      (mode() === "draft"
        ? "Draft everything for me to review. Don't send anything."
        : "Send only simple, low-risk replies (confirmations, thanks). Draft anything that needs a decision for me to review.") +
      (notes().trim() ? `\n\nAlso: ${notes().trim()}` : "")
    props.onStart(prompt, focus)
  }

  return (
    <div class="fr-clarify">
      <For each={questions()}>
        {(q, i) => (
          <section class="fr-q">
            <div class="flex items-start gap-2.5">
              <span class="fr-q-num">{i() + 1}</span>
              <div class="flex flex-col">
                <h3 class="text-[15px] text-v2-text-text-base [font-weight:600]">{q.question}</h3>
                <Show when={q.hint}>
                  <span class="text-[12px] text-v2-text-text-faint">{q.hint}</span>
                </Show>
              </div>
            </div>
            <div class="fr-q-options">
              <For each={q.options}>
                {(o) => (
                  <button class="fr-opt" classList={{ "is-on": isOn(q, o) }} onClick={() => toggle(q, o)} role={q.type === "multi" ? "checkbox" : "radio"} aria-checked={isOn(q, o)}>
                    <span class={q.type === "multi" ? "fr-box" : "fr-radio"} aria-hidden="true">
                      <Show when={isOn(q, o)}>
                        <Show when={q.type === "multi"} fallback={<span class="fr-radio-dot" />}>
                          <svg viewBox="0 0 16 16">
                            <path d="M3.5 8.5l3 3 6-7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
                          </svg>
                        </Show>
                      </Show>
                    </span>
                    <span class="min-w-0 flex-1">
                      <span class="text-[14px] text-v2-text-text-base">{o.label}</span>
                      <Show when={o.thread && kindOf(o.thread) === "action"}>
                        <span class="fr-tag-action ml-2">Action</span>
                      </Show>
                      <Show when={o.description}>
                        <span class="block truncate text-[12.5px] text-v2-text-text-muted">{o.description}</span>
                      </Show>
                    </span>
                  </button>
                )}
              </For>
            </div>
          </section>
        )}
      </For>

      <section class="fr-q">
        <div class="flex items-start gap-2.5">
          <span class="fr-q-num">{questions().length + 1}</span>
          <div class="flex flex-col">
            <h3 class="text-[15px] text-v2-text-text-base [font-weight:600]">Anything else IRIS should know?</h3>
            <span class="text-[12px] text-v2-text-text-faint">Optional</span>
          </div>
        </div>
        <div class="fr-q-options">
          <input
            class="fr-input"
            placeholder="e.g. we're closed Fridays, always offer the next opening"
            value={notes()}
            onInput={(e) => setNotes(e.currentTarget.value)}
          />
        </div>
      </section>

      <div class="fr-clarify-go">
        <span class="fr-mono text-[12.5px] text-v2-text-text-muted">
          {mode() === "draft" ? "Nothing is sent without you" : "Only simple replies are sent"}
        </span>
        <button class="fr-primary px-6" disabled={!count()} onClick={go}>
          Start · {count()} {count() === 1 ? "thing" : "things"}
        </button>
      </div>
    </div>
  )
}
