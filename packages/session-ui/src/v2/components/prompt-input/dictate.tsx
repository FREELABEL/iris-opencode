import { createMemo, createSignal, createUniqueId, Index, onCleanup, Show } from "solid-js"
import { ButtonV2 } from "@opencode-ai/ui/v2/button-v2"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createDictation, MAX_SECONDS, type DictationControls } from "./dictation"
import { capProgress, formatClock, waveformBars } from "./dictate-visual"
import "./dictate.css"

const WAVE = { width: 128, height: 18, gap: 1.2 }
const RING_R = 12
const RING_C = 2 * Math.PI * RING_R

/**
 * Dictation control for the v2 composer.
 *
 * Two parts, and only one of them takes up room. The button is a fixed 32px square in the toolbar
 * whatever state it is in — it used to grow a timer, which pushed every control after it sideways.
 * Everything that varies (waveform, clock, hint, errors, saved recordings) lives in the strip,
 * which floats beside the button over the agent and model pickers. Nobody needs those mid-sentence,
 * and covering them moves nothing.
 *
 * Recording must still be unmissable: the button turns red, a ring fills toward the five-minute cap,
 * a halo breathes with the input level, and the strip draws the waveform live. An active
 * microphone nobody can see is the failure this control exists to prevent.
 */
export function PromptInputV2Dictate(props: {
  url: () => string
  disabled?: boolean
  insert: (text: string) => void
  onError?: (message: string | undefined) => void
  controls?: (controls: DictationControls | undefined) => void
  shortcut?: string
}) {
  const [error, setError] = createSignal<string>()
  const dictation = createDictation({
    url: props.url,
    onError: (message) => {
      setError(message)
      props.onError?.(message)
    },
    onTranscript: (text) => {
      setError(undefined)
      props.onError?.(undefined)
      props.insert(text)
    },
  })
  props.controls?.(dictation)
  onCleanup(() => props.controls?.(undefined))

  const phase = dictation.phase
  // Two composers can be mounted; a shared gradient id would make one paint with the other's.
  const fade = `dictate-fade-${createUniqueId()}`
  const level = createMemo(() => {
    const l = dictation.levels()
    // The newest few, smoothed, so the halo breathes instead of flickering.
    return (l[l.length - 1]! + l[l.length - 2]! + l[l.length - 3]!) / 3
  })
  const bars = createMemo(() => waveformBars(dictation.levels(), WAVE))
  const progress = createMemo(() => capProgress(dictation.seconds(), MAX_SECONDS))
  const strip = createMemo<"recording" | "transcribing" | "error" | "held" | undefined>(() => {
    if (phase() === "recording") return "recording"
    if (phase() === "transcribing") return "transcribing"
    if (error()) return "error"
    if (dictation.held().length > 0) return "held"
    return undefined
  })
  const hint = () => {
    if (dictation.holding()) return "Release to stop"
    return props.shortcut ? `${props.shortcut} to stop` : "Click to stop"
  }
  const label = () => {
    if (phase() === "recording") return "Stop and transcribe"
    if (phase() === "transcribing") return "Transcribing with Grok…"
    return props.shortcut
      ? `Dictate (transcribed by Grok) · ${props.shortcut}, hold to talk`
      : "Dictate (transcribed by Grok)"
  }
  const dismiss = () => {
    setError(undefined)
    props.onError?.(undefined)
  }

  return (
    <div data-slot="dictate" data-phase={phase()} style={{ "--dictate-level": String(level()) }}>
      <TooltipV2 placement="top" value={label()}>
        <button
          type="button"
          data-action="prompt-dictate"
          data-slot="dictate-button"
          aria-label={label()}
          aria-pressed={phase() === "recording"}
          disabled={props.disabled || phase() === "transcribing"}
          onClick={() => {
            if (error() && phase() === "idle") dismiss()
            dictation.toggle()
          }}
        >
          <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
            <circle data-slot="dictate-halo" cx="16" cy="16" r="11" />
            <circle data-slot="dictate-track" cx="16" cy="16" r={RING_R} />
            <circle
              data-slot="dictate-ring"
              cx="16"
              cy="16"
              r={RING_R}
              stroke-dasharray={`${RING_C} ${RING_C}`}
              stroke-dashoffset={phase() === "recording" ? RING_C * (1 - progress()) : RING_C * 0.72}
            />
            <g data-slot="dictate-mic">
              <rect x="13" y="8.5" width="6" height="10" rx="3" />
              <path d="M10.5 15.5a5.5 5.5 0 0 0 11 0M16 21v2.5" />
            </g>
            <rect data-slot="dictate-stop" x="12.25" y="12.25" width="7.5" height="7.5" rx="1.75" />
          </svg>
          <Show when={phase() === "idle" && dictation.held().length > 0}>
            <span data-slot="dictate-badge">{dictation.held().length}</span>
          </Show>
        </button>
      </TooltipV2>

      <Show when={strip()} keyed>
        {(kind) => (
          <div data-slot="dictate-strip" data-kind={kind} role="status" aria-live="polite">
            <Show when={kind === "recording" || kind === "transcribing"}>
              <svg
                data-slot="dictate-wave"
                viewBox={`0 0 ${WAVE.width} ${WAVE.height}`}
                width={WAVE.width}
                height={WAVE.height}
                aria-hidden="true"
              >
                <defs>
                  <linearGradient id={fade} x1="0" x2="1" y1="0" y2="0">
                    <stop offset="0" stop-color="currentColor" stop-opacity="0.15" />
                    <stop offset="0.55" stop-color="currentColor" stop-opacity="0.7" />
                    <stop offset="1" stop-color="currentColor" stop-opacity="1" />
                  </linearGradient>
                </defs>
                <g fill={`url(#${fade})`}>
                  <Index each={bars()}>
                    {(bar) => <rect x={bar().x} y={bar().y} width={bar().w} height={bar().h} rx={bar().w / 2} />}
                  </Index>
                </g>
              </svg>
              <span data-slot="dictate-clock">{formatClock(dictation.seconds())}</span>
              <span data-slot="dictate-hint">{kind === "recording" ? hint() : "Transcribing…"}</span>
              <span data-slot="dictate-cap" style={{ "--dictate-cap": String(progress()) }} aria-hidden="true" />
            </Show>
            <Show when={kind === "error"}>
              <span data-slot="dictate-dot" aria-hidden="true" />
              <span data-slot="dictate-message" title={error()}>
                {error()}
              </span>
              <button type="button" data-slot="dictate-dismiss" aria-label="Dismiss" onClick={dismiss}>
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </Show>
            <Show when={kind === "held"}>
              <span data-slot="dictate-message">
                {dictation.held().length === 1 ? "1 saved recording" : `${dictation.held().length} saved recordings`}
                {dictation.retrying()
                  ? " · retrying…"
                  : dictation.nextRetryIn() !== undefined
                    ? ` · retrying in ${dictation.nextRetryIn()}s`
                    : ""}
              </span>
              <ButtonV2
                type="button"
                size="small"
                variant="ghost"
                data-action="prompt-dictate-retry"
                disabled={dictation.retrying()}
                onClick={() => void dictation.retryHeld()}
              >
                Retry
              </ButtonV2>
              <ButtonV2
                type="button"
                size="small"
                variant="ghost-muted"
                data-action="prompt-dictate-discard"
                disabled={dictation.retrying()}
                onClick={() => {
                  dismiss()
                  void dictation.discardHeld()
                }}
              >
                Discard
              </ButtonV2>
            </Show>
          </div>
        )}
      </Show>
    </div>
  )
}
