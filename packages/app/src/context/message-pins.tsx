/**
 * Pinned messages (#193406): the pin beside Copy and Read aloud on each message, listed under the
 * chat's "..." menu. Pins are per chat (keyed by session id) and persisted, so they survive a
 * restart. Each pin keeps the message id, the id of the turn's user message (what the timeline
 * scrolls to), the message's first line and its time, so the list renders without the message
 * having been loaded.
 */
import { configureMessagePins, type MessagePinTarget } from "@opencode-ai/session-ui/message-pins"
import { createSimpleContext } from "@opencode-ai/ui/context"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import type { Platform } from "@/context/platform"
import { Persist, persisted } from "@/utils/persist"

export type MessagePin = {
  /** The pinned message. */
  id: string
  /** The user message that starts its turn; the timeline scrolls here. */
  turn: string
  /** First line of the message, for the list. */
  text: string
  /** When the message was created (ms); 0 when unknown. */
  time: number
}

export type MessagePinState = { sessions: Record<string, MessagePin[] | undefined> }

export const MESSAGE_PINS_KEY = "message-pins.v1"
const FIRST_LINE_MAX = 80

/** The first line a person would recognise: markdown markers stripped, clipped to 80 chars. */
export function pinFirstLine(text: string) {
  const line =
    text
      .split(/\r?\n/)
      .filter((l) => !/^\s*(```|~~~)/.test(l))
      .map((l) =>
        l
          .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/, "")
          .replace(/\*\*|__|~~|`/g, "")
          .trim(),
      )
      .find((l) => l) ?? ""
  if (line.length <= FIRST_LINE_MAX) return line
  return `${line.slice(0, FIRST_LINE_MAX - 1).trimEnd()}…`
}

/** Pin if absent, unpin if present. Returns a new list ordered by message time. */
export function togglePin(list: readonly MessagePin[], target: MessagePinTarget): MessagePin[] {
  if (list.some((pin) => pin.id === target.messageID)) return list.filter((pin) => pin.id !== target.messageID)
  const next: MessagePin = {
    id: target.messageID,
    turn: target.turnID || target.messageID,
    text: pinFirstLine(target.text),
    time: target.time ?? 0,
  }
  return [...list, next].sort((a, b) => a.time - b.time)
}

export function createMessagePinStore(platform?: Platform) {
  const [store, setStore, , ready] = persisted(
    Persist.global(MESSAGE_PINS_KEY),
    createStore<MessagePinState>({ sessions: {} }),
    platform,
  )

  const list = (sessionID: string): MessagePin[] => store.sessions[sessionID] ?? []
  const isPinned = (sessionID: string, messageID: string) => list(sessionID).some((pin) => pin.id === messageID)
  const toggle = (target: MessagePinTarget) => {
    const next = togglePin(list(target.sessionID), target)
    setStore("sessions", target.sessionID, next.length ? next : undefined)
  }
  const unpin = (sessionID: string, messageID: string) => {
    if (!isPinned(sessionID, messageID)) return
    toggle({ sessionID, messageID, turnID: messageID, text: "" })
  }

  return { ready, list, isPinned, toggle, unpin }
}

export const { use: useMessagePins, provider: MessagePinsProvider } = createSimpleContext({
  name: "MessagePins",
  gate: false,
  init: () => {
    const pins = createMessagePinStore()
    // The pin button on each message (session-ui) reads and toggles through this.
    configureMessagePins({ isPinned: pins.isPinned, toggle: pins.toggle })
    onCleanup(() => configureMessagePins(undefined))
    return pins
  },
})
