import { createEffect, createMemo, createSignal, createUniqueId, For, Index, on, onCleanup, Show, type JSX } from "solid-js"
import { Portal } from "solid-js/web"
import { useI18n } from "@opencode-ai/ui/context/i18n"
import { TooltipV2 } from "@opencode-ai/ui/v2/tooltip-v2"
import { createDictation, MAX_SECONDS, type DictationControls } from "./dictation"
import { capProgress, formatClock, waveformBars } from "./dictate-visual"
import { initialVoice, voiceReducer, type VoiceEvent } from "./voice-mode"
import "./dictate.css"

const LANE = { width: 600, height: 10, gap: 1.6 }
const PANEL_WAVE = { width: 336, height: 26, gap: 1.6 }
const RING_R = 12
const RING_C = 2 * Math.PI * RING_R

export type DictateDevices = {
  /** Names of the inputs the recorder can open; "" is the system default. */
  list: () => Promise<string[]>
  current: () => string
  select: (name: string) => void
}

/**
 * Voice in the v2 composer: a quick take inline, or a background take in a corner panel.
 *
 * Nothing here takes up room in the toolbar except the 32px mic. Everything that varies is drawn
 * in layers the composer provides — the waveform lane under the text, the tag in the toolbar's
 * free space, the toasts — or portalled to the page (the mic menu, the background panel). The
 * composer reserves the lane's height all the time, so starting a take moves no text and grows
 * nothing.
 *
 * Which take is running, and where its words go, is decided by voiceReducer (voice-mode.ts); this
 * component only maps its effects onto the recorder, the editor and the clipboard.
 */
export function PromptInputV2Dictate(props: {
  url: () => string
  disabled?: boolean
  insert: (text: string) => void
  onError?: (message: string | undefined) => void
  controls?: (controls: DictationControls | undefined) => void
  shortcut?: string
  /** Overlay inside the composer form, for the lane and the toasts. */
  layer?: () => HTMLElement | undefined
  /** Overlay over the toolbar's flexible area, for the clock tag. */
  tagLayer?: () => HTMLElement | undefined
  devices?: DictateDevices
}) {
  const i18n = useI18n()
  const [error, setError] = createSignal<string>()
  const [voice, setVoice] = createSignal(initialVoice)
  const send = (event: VoiceEvent) => setVoice((s) => voiceReducer(s, event))
  let settled = false
  // Live preview from the streaming engine, for this take only. The batch transcript at the end
  // is still what gets inserted; these words are a preview it replaces.
  const [finals, setFinals] = createSignal<string[]>([])
  const [partial, setPartial] = createSignal("")

  const dictation = createDictation({
    url: props.url,
    onPartial: (text) => setPartial(text),
    onFinal: (text) => {
      setFinals((list) => [...list, text])
      setPartial("")
    },
    onError: (message) => {
      setError(message)
      props.onError?.(message)
      settled = true
      send({ type: "failed" })
    },
    onTranscript: (text) => {
      setError(undefined)
      props.onError?.(undefined)
      settled = true
      send({ type: "transcript", text })
    },
  })
  const phase = dictation.phase
  const mode = () => voice().mode

  // A take can end with neither words nor an error — stopped inside the probe, or a hold let go
  // before the recorder was up. Without this the mode would wait for a transcript forever.
  createEffect(
    on(phase, (now, before) => {
      if (now === "recording" && before !== "recording") {
        settled = false
        setFinals([])
        setPartial("")
      }
      if (now === "idle" && before && before !== "idle" && !settled && (mode() === "quick" || mode() === "background"))
        send({ type: "failed" })
    }),
  )

  createEffect(() => {
    const effect = voice().effect
    if (!effect) return
    if (effect.type === "insert") props.insert(effect.text)
    if (effect.type === "copy") void navigator.clipboard?.writeText(effect.text).catch(() => {})
    if (effect.type === "cancel") dictation.cancel()
    send({ type: "noop" })
  })

  // ----- input: the mic, the shortcut, the palette -----
  function micClick() {
    if (error() && phase() === "idle") dismiss()
    if (mode() === "background" || mode() === "review") return send({ type: "mic" })
    if (mode() === "idle") send({ type: "mic" })
    dictation.toggle()
  }
  const controls: DictationControls = {
    phase,
    toggle: micClick,
    press: () => {
      if (mode() === "background" || mode() === "review") return send({ type: "mic" })
      if (mode() === "idle" && phase() === "idle") send({ type: "mic" })
      dictation.press()
    },
    release: () => {
      if (mode() === "quick") dictation.release()
    },
  }
  props.controls?.(controls)
  onCleanup(() => props.controls?.(undefined))

  function startBackground() {
    setMenu(false)
    if (mode() === "quick") return keep()
    if (mode() !== "idle" || phase() !== "idle") return
    send({ type: "background" })
    void dictation.startBackground()
  }
  function keep() {
    dictation.extend()
    send({ type: "keep" })
  }
  const dismiss = () => {
    setError(undefined)
    props.onError?.(undefined)
  }

  // ----- the mic menu: background recording and the input device -----
  const [menu, setMenu] = createSignal(false)
  const [devices, setDevices] = createSignal<string[]>([])
  let caret: HTMLButtonElement | undefined
  let menuEl: HTMLDivElement | undefined
  const [anchor, setAnchor] = createSignal<{ left: number; bottom: number }>()
  function openMenu() {
    if (menu()) return setMenu(false)
    const r = caret?.getBoundingClientRect()
    if (r) setAnchor({ left: Math.max(8, r.left - 8), bottom: Math.max(8, window.innerHeight - r.top + 8) })
    setMenu(true)
    void props.devices?.list().then(setDevices).catch(() => setDevices([]))
  }
  const onDocDown = (event: PointerEvent) => {
    if (!menu()) return
    const target = event.target as Node
    if (menuEl?.contains(target) || caret?.contains(target)) return
    setMenu(false)
  }
  const onKey = (event: KeyboardEvent) => {
    if (event.key === "Escape" && menu()) setMenu(false)
  }
  document.addEventListener("pointerdown", onDocDown, true)
  document.addEventListener("keydown", onKey, true)
  onCleanup(() => {
    document.removeEventListener("pointerdown", onDocDown, true)
    document.removeEventListener("keydown", onKey, true)
  })

  // ----- what the visuals read -----
  const level = createMemo(() => {
    const l = dictation.levels()
    return (l[l.length - 1]! + l[l.length - 2]! + l[l.length - 3]!) / 3
  })
  const lane = createMemo(() => waveformBars(phase() === "transcribing" ? dictation.levels().map(() => 0.35) : dictation.levels(), LANE))
  const panelWave = createMemo(() => waveformBars(dictation.levels().slice(-80), PANEL_WAVE))
  const progress = createMemo(() => capProgress(dictation.seconds(), MAX_SECONDS))
  const quickLive = () => mode() === "quick" && phase() !== "idle"
  const deviceName = () => props.devices?.current() || i18n.t("ui.promptInput.dictate.systemDefault")
  const label = () => {
    if (mode() === "background" || mode() === "review") return i18n.t("ui.promptInput.dictate.background.open")
    if (phase() === "recording") return i18n.t("ui.promptInput.dictate.stop")
    if (phase() === "transcribing") return i18n.t("ui.promptInput.dictate.transcribing")
    return props.shortcut
      ? i18n.t("ui.promptInput.dictate.startHint", { shortcut: props.shortcut })
      : i18n.t("ui.promptInput.dictate.start")
  }
  const heldText = () => {
    const n = dictation.held().length
    const tail = dictation.retrying()
      ? i18n.t("ui.promptInput.dictate.retrying")
      : dictation.nextRetryIn() !== undefined
        ? i18n.t("ui.promptInput.dictate.retryIn", { seconds: String(dictation.nextRetryIn()) })
        : ""
    return `${i18n.plural("ui.promptInput.dictate.saved", n, { count: String(n) })}${tail ? ` · ${tail}` : ""}`
  }
  const fade = `dictate-fade-${createUniqueId()}`
  const Wave = (p: { bars: ReturnType<typeof waveformBars>; box: typeof LANE; class?: string }) => (
    <svg data-slot="dictate-wave" class={p.class} viewBox={`0 0 ${p.box.width} ${p.box.height}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id={fade} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stop-color="currentColor" stop-opacity="0.15" />
          <stop offset="0.55" stop-color="currentColor" stop-opacity="0.7" />
          <stop offset="1" stop-color="currentColor" stop-opacity="1" />
        </linearGradient>
      </defs>
      <g fill={`url(#${fade})`}>
        <Index each={p.bars}>{(bar) => <rect x={bar().x} y={bar().y} width={bar().w} height={bar().h} rx={Math.min(1, bar().w / 2)} />}</Index>
      </g>
    </svg>
  )
  const MicGlyph = (): JSX.Element => (
    <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true">
      <rect x="3" y="1" width="4" height="6.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.2" />
      <path d="M1.5 6a3.5 3.5 0 0 0 7 0M5 9.5V11" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
    </svg>
  )
  const DeviceButton = () => (
    <Show when={props.devices}>
      <button type="button" data-slot="dictate-device" title={i18n.t("ui.promptInput.dictate.microphone")} onClick={openMenu}>
        <MicGlyph />
        <span>{deviceName()}</span>
      </button>
    </Show>
  )
  // Layers are optional: without them the overlays fall back to sitting beside the mic.
  const InLayer = (p: { mount?: () => HTMLElement | undefined; children: JSX.Element }) => (
    <Show when={p.mount?.()} fallback={p.children}>
      {(el) => <Portal mount={el()}>{p.children}</Portal>}
    </Show>
  )

  return (
    <div
      data-slot="dictate"
      data-phase={phase()}
      data-mode={mode()}
      style={{ "--dictate-level": String(phase() === "recording" ? level() : 0) }}
    >
      <TooltipV2 placement="top" value={label()}>
        <button
          type="button"
          data-action="prompt-dictate"
          data-slot="dictate-button"
          aria-label={label()}
          aria-pressed={phase() === "recording"}
          disabled={props.disabled || (phase() === "transcribing" && mode() === "quick")}
          onClick={micClick}
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
        </button>
      </TooltipV2>
      <button
        type="button"
        data-slot="dictate-caret"
        ref={caret}
        aria-label={i18n.t("ui.promptInput.dictate.options")}
        aria-haspopup="menu"
        aria-expanded={menu()}
        disabled={props.disabled}
        onClick={openMenu}
      >
        <svg width="7" height="7" viewBox="0 0 8 8" aria-hidden="true">
          <path d="M1.5 3l2.5 2.5L6.5 3" stroke="currentColor" fill="none" stroke-width="1.3" />
        </svg>
      </button>
      <Show when={phase() === "idle" && mode() === "idle" && dictation.held().length > 0}>
        <span data-slot="dictate-badge">{dictation.held().length}</span>
      </Show>
      <Show when={mode() === "background" || mode() === "review"}>
        <span data-slot="dictate-bgmark" aria-hidden="true" />
      </Show>

      {/* quick take: the lane under the text, and the tag in the toolbar's free space */}
      <Show when={quickLive()}>
        <InLayer mount={props.layer}>
          <div data-slot="dictate-lane" data-phase={phase()}>
            <Wave bars={lane()} box={LANE} class={phase() === "transcribing" ? "sweep" : undefined} />
          </div>
        </InLayer>
        <InLayer mount={props.tagLayer}>
          <div data-slot="dictate-tag" role="status">
            <span data-slot="dictate-clock">{formatClock(dictation.seconds())}</span>
            <Show
              when={phase() === "recording"}
              fallback={<span>{i18n.t("ui.promptInput.dictate.transcribing")}</span>}
            >
              <Show
                when={!dictation.holding()}
                fallback={<span data-slot="dictate-holdpill">● {i18n.t("ui.promptInput.dictate.release")}</span>}
              >
                <button
                  type="button"
                  data-slot="dictate-keep"
                  title={i18n.t("ui.promptInput.dictate.keepHint")}
                  onClick={keep}
                >
                  <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M3 7l4-4M4 3h3v3" stroke="currentColor" fill="none" stroke-width="1.3" stroke-linecap="round" />
                  </svg>
                  {i18n.t("ui.promptInput.dictate.keep")}
                </button>
              </Show>
            </Show>
            <DeviceButton />
          </div>
        </InLayer>
      </Show>

      {/* errors and saved recordings */}
      <Show when={mode() === "idle" && !quickLive() && (error() || dictation.held().length > 0)}>
        <InLayer mount={props.layer}>
          <div data-slot="dictate-toast" data-kind={error() ? "error" : "held"} role="status" aria-live="polite">
            <Show
              when={error()}
              fallback={
                <>
                  <span data-slot="dictate-message">{heldText()}</span>
                  <button type="button" data-slot="dictate-mini" disabled={dictation.retrying()} onClick={() => void dictation.retryHeld()}>
                    {i18n.t("ui.promptInput.dictate.retry")}
                  </button>
                  <button type="button" data-slot="dictate-mini" data-muted disabled={dictation.retrying()} onClick={() => void dictation.discardHeld()}>
                    {i18n.t("ui.promptInput.dictate.discard")}
                  </button>
                </>
              }
            >
              <span data-slot="dictate-dot" aria-hidden="true" />
              <span data-slot="dictate-message" title={error()}>
                {error()}
              </span>
              <button type="button" data-slot="dictate-dismiss" aria-label={i18n.t("ui.promptInput.dictate.dismiss")} onClick={dismiss}>
                <svg viewBox="0 0 12 12" width="12" height="12" aria-hidden="true">
                  <path d="M3 3l6 6M9 3l-6 6" />
                </svg>
              </button>
            </Show>
          </div>
        </InLayer>
      </Show>

      {/* background take: the corner panel */}
      <Show when={mode() === "background" || mode() === "review"}>
        <Portal>
          <div
            data-slot="dictate-panel"
            data-state={voice().panel}
            data-mode={mode()}
            role="region"
            aria-label={i18n.t("ui.promptInput.dictate.background.title")}
            style={{ "--dictate-level": String(phase() === "recording" ? level() : 0) }}
          >
            <div data-slot="dictate-panel-head">
              <span data-slot="dictate-recdot" data-on={phase() === "recording"} aria-hidden="true" />
              <b>
                {mode() === "review"
                  ? i18n.t("ui.promptInput.dictate.background.review")
                  : phase() === "transcribing"
                    ? i18n.t("ui.promptInput.dictate.transcribing")
                    : i18n.t("ui.promptInput.dictate.background.title")}
              </b>
              <Show when={mode() === "background"}>
                <span data-slot="dictate-clock">{formatClock(dictation.seconds())}</span>
              </Show>
              <span data-slot="dictate-spacer" />
              <Show when={voice().panel === "open"}>
                <DeviceButton />
              </Show>
              <button
                type="button"
                data-slot="dictate-panel-fold"
                aria-label={
                  voice().panel === "open"
                    ? i18n.t("ui.promptInput.dictate.background.collapse")
                    : i18n.t("ui.promptInput.dictate.background.expand")
                }
                onClick={() => send({ type: "mic" })}
              >
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d={voice().panel === "open" ? "M3 4.5L6 7.5l3-3" : "M3 7.5L6 4.5l3 3"} stroke="currentColor" fill="none" stroke-width="1.3" />
                </svg>
              </button>
            </div>
            <Show when={voice().panel === "open"}>
              <div data-slot="dictate-panel-body">
                <Show
                  when={mode() === "review"}
                  fallback={
                    <Show
                      when={finals().length > 0 || partial()}
                      fallback={
                        <p data-slot="dictate-panel-hint">
                          {phase() !== "recording"
                            ? i18n.t("ui.promptInput.dictate.transcribing")
                            : dictation.live() === "streaming" || dictation.live() === "connecting"
                              ? i18n.t("ui.promptInput.dictate.background.listening")
                              : i18n.t("ui.promptInput.dictate.background.waiting")}
                        </p>
                      }
                    >
                      <p data-slot="dictate-panel-text">
                        {finals().join(" ")}
                        <Show when={partial()}>
                          <span data-slot="dictate-partial"> {partial()}</span>
                        </Show>
                      </p>
                    </Show>
                  }
                >
                  <p data-slot="dictate-panel-text">{voice().result}</p>
                </Show>
              </div>
              <Show when={mode() === "background"}>
                <Wave bars={panelWave()} box={PANEL_WAVE} class={phase() === "transcribing" ? "sweep" : undefined} />
              </Show>
              <div data-slot="dictate-panel-foot">
                <span data-slot="dictate-panel-note">{i18n.t("ui.promptInput.dictate.background.runs")}</span>
                <span data-slot="dictate-spacer" />
                <button type="button" data-slot="dictate-btn" onClick={() => send({ type: "discard" })} disabled={phase() === "transcribing"}>
                  {i18n.t("ui.promptInput.dictate.background.discard")}
                </button>
                <Show
                  when={mode() === "review"}
                  fallback={
                    <button type="button" data-slot="dictate-btn" data-primary disabled={phase() !== "recording"} onClick={() => dictation.toggle()}>
                      {i18n.t("ui.promptInput.dictate.background.stopButton")}
                    </button>
                  }
                >
                  <button type="button" data-slot="dictate-btn" onClick={() => send({ type: "copy" })}>
                    {i18n.t("ui.promptInput.dictate.background.copy")}
                  </button>
                  <button type="button" data-slot="dictate-btn" data-primary onClick={() => send({ type: "insert" })}>
                    {i18n.t("ui.promptInput.dictate.background.insert")}
                  </button>
                </Show>
              </div>
            </Show>
          </div>
        </Portal>
      </Show>

      {/* the mic menu */}
      <Show when={menu() && anchor()}>
        {(at) => (
          <Portal>
            <div
              data-slot="dictate-menu"
              role="menu"
              ref={menuEl}
              style={{ left: `${at().left}px`, bottom: `${at().bottom}px` }}
            >
              <Show
                when={mode() === "background"}
                fallback={
                  <button type="button" role="menuitem" data-slot="dictate-menu-item" disabled={mode() === "review"} onClick={startBackground}>
                    <span data-slot="dictate-menu-mark" data-rec>●</span>
                    <span>{i18n.t("ui.promptInput.dictate.background.start")}</span>
                  </button>
                }
              >
                <button
                  type="button"
                  role="menuitem"
                  data-slot="dictate-menu-item"
                  onClick={() => {
                    setMenu(false)
                    dictation.toggle()
                  }}
                >
                  <span data-slot="dictate-menu-mark">■</span>
                  <span>{i18n.t("ui.promptInput.dictate.background.stop")}</span>
                </button>
              </Show>
              <Show when={props.devices}>
                {(dev) => (
                  <>
                    <div data-slot="dictate-menu-sep" />
                    <div data-slot="dictate-menu-heading">{i18n.t("ui.promptInput.dictate.microphone")}</div>
                    <For each={["", ...devices()]}>
                      {(name) => (
                        <button
                          type="button"
                          role="menuitemradio"
                          aria-checked={dev().current() === name}
                          data-slot="dictate-menu-item"
                          onClick={() => {
                            dev().select(name)
                            setMenu(false)
                          }}
                        >
                          <span data-slot="dictate-menu-mark">{dev().current() === name ? "✓" : ""}</span>
                          <span data-slot="dictate-menu-label">{name || i18n.t("ui.promptInput.dictate.systemDefault")}</span>
                        </button>
                      )}
                    </For>
                  </>
                )}
              </Show>
            </div>
          </Portal>
        )}
      </Show>
    </div>
  )
}
