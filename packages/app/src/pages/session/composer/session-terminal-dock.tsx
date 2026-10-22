import { useParams } from "@solidjs/router"
import { createEffect, createSignal, For, on, onCleanup, Show } from "solid-js"
import { formatDuration, stripAnsi, TerminalMode, type TerminalEntry } from "@/components/prompt-input/terminal-mode"

/**
 * Terminal mode (#190530): the commands run from shell mode and their output, kept above the
 * composer while the terminal is open. Closing it puts the whole transcript into the chat as one
 * message (see TerminalMode.close); until then nothing here is a chat turn.
 */
export function SessionTerminalDock() {
  const params = useParams<{ id?: string }>()
  const sessionID = () => params.id
  const entries = () => TerminalMode.entries(sessionID())
  const [now, setNow] = createSignal(Date.now())
  let scroller: HTMLDivElement | undefined
  let pinned = true

  const timer = setInterval(() => {
    if (TerminalMode.running(sessionID())) setNow(Date.now())
  }, 500)
  onCleanup(() => clearInterval(timer))

  // Follow new output unless the reader scrolled up to look at something.
  createEffect(
    on(
      () => entries().map((entry) => entry.output.length + entry.status).join(),
      () => {
        if (!scroller || !pinned) return
        queueMicrotask(() => scroller && (scroller.scrollTop = scroller.scrollHeight))
      },
    ),
  )

  // Ctrl+C stops the running command, as in a terminal, unless the user is copying a selection.
  const onKey = (event: KeyboardEvent) => {
    const id = sessionID()
    if (!id || !TerminalMode.running(id)) return
    if (!event.ctrlKey || event.metaKey || event.altKey || event.key.toLowerCase() !== "c") return
    if (window.getSelection()?.toString()) return
    event.preventDefault()
    void TerminalMode.cancel(id)
  }
  document.addEventListener("keydown", onKey)
  onCleanup(() => document.removeEventListener("keydown", onKey))

  const close = () => {
    const id = sessionID()
    if (id) TerminalMode.requestClose(id)
  }

  return (
    <Show when={entries().length > 0}>
      <div
        data-component="session-terminal-dock"
        class="mb-2 w-full overflow-hidden rounded-xl border-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-01"
      >
        <div class="flex h-9 items-center gap-2 border-b-[0.5px] border-v2-border-border-base pl-4 pr-2">
          <span class="inline-block h-2 w-2 shrink-0 rounded-full bg-[#7c5cff]" />
          <span class="shrink-0 text-[12px] font-semibold text-v2-text-text-base">Terminal</span>
          <span class="min-w-0 flex-1 truncate font-mono text-[11px] text-v2-text-text-muted">
            {TerminalMode.directory(sessionID())}
          </span>
          <button
            type="button"
            data-action="terminal-close"
            aria-label="Close terminal"
            title="Close terminal"
            class="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-v2-text-text-muted hover:bg-v2-background-bg-layer-02 hover:text-v2-text-text-base"
            onClick={close}
          >
            ✕
          </button>
        </div>
        <div
          ref={scroller}
          data-slot="terminal-scroll"
          class="max-h-[40vh] overflow-y-auto px-4 py-2 font-mono text-[12px] leading-[18px]"
          onScroll={(event) => {
            const el = event.currentTarget
            pinned = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          }}
        >
          <For each={entries()}>
            {(entry) => <TerminalRow entry={entry} now={now()} sessionID={sessionID()!} />}
          </For>
        </div>
        <Show when={TerminalMode.confirming(sessionID())}>
          <div
            data-slot="terminal-confirm"
            class="flex items-center gap-2 border-t-[0.5px] border-v2-border-border-base bg-v2-background-bg-layer-02 px-4 py-2 text-[12px]"
          >
            <span class="min-w-0 flex-1 text-v2-text-text-base">
              A command is still running. Closing would leave it without a result.
            </span>
            <button
              type="button"
              data-action="terminal-wait"
              class="h-7 shrink-0 cursor-pointer rounded-md px-3 text-[12px] text-v2-text-text-base hover:bg-v2-background-bg-layer-01"
              onClick={() => TerminalMode.keepOpen(sessionID()!)}
            >
              Wait
            </button>
            <button
              type="button"
              data-action="terminal-stop-close"
              class="h-7 shrink-0 cursor-pointer rounded-md bg-[#d9473f] px-3 text-[12px] font-semibold text-white hover:opacity-90"
              onClick={() => TerminalMode.stopAndClose(sessionID()!)}
            >
              Stop and close
            </button>
          </div>
        </Show>
      </div>
    </Show>
  )
}

function TerminalRow(props: { entry: TerminalEntry; now: number; sessionID: string }) {
  const live = () => props.entry.status === "starting" || props.entry.status === "running"
  const elapsed = () => formatDuration((props.entry.ended ?? props.now) - props.entry.started)
  const failed = () =>
    props.entry.status === "error" || (props.entry.status === "exited" && (props.entry.exitCode ?? 0) !== 0)
  const label = () => {
    if (live()) return `running · ${elapsed()}`
    if (props.entry.status === "cancelled") return `stopped · ${elapsed()}`
    if (props.entry.status === "error") return `error · ${props.entry.error ?? "unknown"}`
    return `exit ${props.entry.exitCode ?? "?"} · ${elapsed()}`
  }
  return (
    <div data-slot="terminal-entry" data-status={props.entry.status} class="py-1">
      <div class="flex items-start gap-2">
        <span class="shrink-0 select-none text-[#7c5cff]">$</span>
        <span class="min-w-0 flex-1 whitespace-pre-wrap break-all font-semibold text-v2-text-text-base">
          {props.entry.command}
        </span>
        <span
          data-slot="terminal-status"
          class="shrink-0 rounded px-1.5 text-[11px]"
          classList={{
            "text-v2-text-text-muted": !failed() && !live(),
            "text-[#d9473f]": failed(),
            "text-[#c08a00]": live(),
          }}
        >
          {label()}
        </span>
        <Show when={live() && props.entry.runID}>
          <button
            type="button"
            data-action="terminal-stop"
            title="Stop (Ctrl+C)"
            class="shrink-0 cursor-pointer rounded px-1.5 text-[11px] text-v2-text-text-muted hover:text-[#d9473f]"
            onClick={() => void TerminalMode.cancel(props.sessionID, props.entry.key)}
          >
            Stop
          </button>
        </Show>
      </div>
      <Show when={props.entry.truncated}>
        <div class="pl-4 text-[11px] italic text-v2-text-text-muted">earlier output omitted</div>
      </Show>
      <Show when={props.entry.output}>
        <pre class="m-0 whitespace-pre-wrap break-all pl-4 text-v2-text-text-muted">
          {stripAnsi(props.entry.output).replace(/\s+$/, "")}
        </pre>
      </Show>
    </div>
  )
}
