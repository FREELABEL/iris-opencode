import { For, Show, createMemo, createSignal } from "solid-js"
import { senderName, type InboxThread } from "./home-first-run-inbox"
import type { Intent } from "./home-first-run-intent"

/** What IRIS can do toward the goal — from /iris/onboarding/capabilities (catalog + `iris intent`). */
export type Capability = {
  id: string
  title: string
  detail: string
  tool: string
  evidence: { kinds: Array<"person" | "action" | "fyi">; pattern?: string }
  source: "catalog" | "intent"
  primary?: boolean
}

/**
 * Clarifying questions, after the read (EPIC #188210). The shape is Elon's ClarifyingQuestionsStep
 * — numbered questions, single or multi select, "Other" with its own words — because that flow
 * is the one that worked. The difference is where the options come from: not a model's guesses
 * about a workflow, but the person's own inbox, filtered by what they said they want.
 *
 * Order of truth (Alex, 2026-10-08): the GOAL decides; the options are what IRIS can really do
 * toward it (first-class CLI tools, via the catalog and `iris intent`); the INBOX only cross-checks
 * — evidence under an option, never an option itself. An option with no evidence still shows.
 */

type Kind = NonNullable<InboxThread["kind"]>
const kindOf = (t: InboxThread): Kind => t.kind ?? (t.automated ? "fyi" : "person")

type Option = { id: string; label: string; description?: string; cap?: Capability; evidence?: InboxThread[] }
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

const REPLIES = new Set(["draft-replies", "follow-up-leads"])

export function ClarifyStep(props: {
  intent: Intent
  threads: InboxThread[]
  capabilities: Capability[]
  onStart: (prompt: string, focus: InboxThread[]) => void
}) {
  // Capabilities lead; an empty answer from the engine still offers the goal itself, planned together.
  const caps = createMemo<Capability[]>(() =>
    props.capabilities.length
      ? props.capabilities
      : [
          {
            id: "plan-with-you",
            title: props.intent.text,
            detail: "IRIS works out the steps with you",
            tool: "iris session",
            evidence: { kinds: ["person", "action"] },
            source: "catalog",
            primary: true,
          },
        ],
  )
  const evidence = createMemo(() => new Map(caps().map((c) => [c.id, evidenceFor(c, props.threads)])))

  // Ticked by default: the primary answers to the goal. Evidence never ticks something on its own.
  const [picked, setPicked] = createSignal<Set<string>>(new Set(caps().filter((c) => c.primary).map((c) => c.id)))
  const [tone, setTone] = createSignal("warm")
  const [mode, setMode] = createSignal("draft")
  const [notes, setNotes] = createSignal("")

  const actions = (): Option[] =>
    caps().map((c) => ({
      id: c.id,
      label: c.title.charAt(0).toUpperCase() + c.title.slice(1),
      description: c.detail,
      cap: c,
      evidence: evidence().get(c.id) ?? [],
    }))
  const replying = () => [...picked()].some((id) => REPLIES.has(id))

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
    const focus = [...new Map(chosen.flatMap((o) => o.evidence ?? []).map((t) => [t.id, t])).values()].slice(0, 15)
    const lines = chosen
      .map((o) => {
        const ev = (o.evidence ?? []).slice(0, 5).map((t) => `${senderName(t.from)} ("${t.subject}")`)
        return `- ${o.label} — use \`${o.cap?.tool ?? "iris"}\`${ev.length ? `. Relevant mail: ${ev.join("; ")}` : ""}`
      })
      .join("\n")
    const prompt =
      `My goal: ${props.intent.text}\n\nDo these, with these IRIS tools:\n${lines}\n\n` +
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
                      <Show when={o.description}>
                        <span class="block text-[12.5px] text-v2-text-text-muted">{o.description}</span>
                      </Show>
                      <Show when={o.cap}>
                        <span class="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1">
                          <span class="fr-tool">{o.cap!.tool}</span>
                          <Show
                            when={o.evidence?.length}
                            fallback={<span class="text-[12px] text-v2-text-text-faint">Nothing for this in your recent mail</span>}
                          >
                            <span class="fr-evidence">
                              In your inbox: {o.evidence!.slice(0, 3).map((t) => senderName(t.from)).join(", ")}
                              {o.evidence!.length > 3 ? ` +${o.evidence!.length - 3}` : ""}
                            </span>
                          </Show>
                        </span>
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
