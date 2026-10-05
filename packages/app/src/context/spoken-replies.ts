import { createEffect, on, onCleanup } from "solid-js"
import type { Message, Part } from "@opencode-ai/sdk/v2/client"
import { createSpeechPlayer, type SpeechPlayer } from "@opencode-ai/session-ui/v2/prompt-input/speech"
import { nextSpeakable } from "@/utils/speakable"

/**
 * Spoken replies: read the active session's newest assistant reply aloud while it streams.
 *
 * Only a reply first seen STILL STREAMING is read, so opening a session never reads its history,
 * and no clock comparison between window and server is needed. Speech stops when the person sends
 * another message, the reply is aborted, they switch session, or they start dictating
 * (stopSpokenReply, called by the composer).
 */

type Speaker = Pick<SpeechPlayer, "speak" | "finish" | "stop">

export function createReplyReader(speaker: Speaker) {
  let current: { id: string; consumed: number; done: boolean } | undefined
  let lastUser: string | undefined
  let primed = false

  const stop = () => {
    if (current && !current.done) speaker.stop()
    if (current) current.done = true
  }

  return {
    /** Forget everything (new session, or speech turned off/on). */
    reset() {
      stop()
      current = undefined
      lastUser = undefined
      primed = false
    },
    stop,
    update(messages: readonly Message[], parts: (messageID: string) => readonly Part[] | undefined) {
      const user = messages.findLast((m) => m.role === "user")
      // A message sent after the first look interrupts whatever is being said.
      if (primed && user && user.id !== lastUser) stop()
      lastUser = user?.id
      primed = true

      const reply = messages.findLast((m) => m.role === "assistant")
      if (!reply || reply.role !== "assistant") return
      if (current?.id !== reply.id) current = { id: reply.id, consumed: 0, done: !!reply.time.completed }
      if (current.done) return
      if (reply.error?.name === "MessageAbortedError") return stop()

      const raw = (parts(reply.id) ?? [])
        .flatMap((p) => (p.type === "text" && !p.synthetic && !p.ignored ? [p.text] : []))
        .join("\n\n")
      const final = !!reply.time.completed
      const next = nextSpeakable(raw, current.consumed, final)
      current.consumed = next.consumed
      if (next.text) speaker.speak(next.text)
      if (final) {
        speaker.finish()
        current.done = true
      }
    },
  }
}

let active: Pick<SpeechPlayer, "stop"> | undefined

/** Barge-in from outside the session view, e.g. the composer when dictation starts. */
export function stopSpokenReply() {
  active?.stop()
}

export function useSpokenReplies(opts: {
  enabled: () => boolean
  sessionID: () => string | undefined
  messages: (sessionID: string) => readonly Message[] | undefined
  parts: (messageID: string) => readonly Part[] | undefined
  base: () => string
  voice: () => string | undefined
  onUnavailable: (reason: string) => void
}) {
  let player: SpeechPlayer | undefined
  const speaker: Speaker = {
    speak: (text) => {
      player ??= createSpeechPlayer({
        base: opts.base,
        voice: opts.voice,
        onState: (state, reason) => {
          if (state === "unavailable") opts.onUnavailable(reason ?? "")
        },
      })
      active = player
      player.speak(text)
    },
    finish: () => player?.finish(),
    stop: () => player?.stop(),
  }
  const reader = createReplyReader(speaker)

  createEffect(on([opts.enabled, opts.sessionID], () => reader.reset()))
  createEffect(() => {
    const id = opts.sessionID()
    if (!opts.enabled() || !id) return
    reader.update(opts.messages(id) ?? [], opts.parts)
  })
  onCleanup(() => {
    reader.reset()
    player?.dispose()
    if (active === player) active = undefined
  })
}
