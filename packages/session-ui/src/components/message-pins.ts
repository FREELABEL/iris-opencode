/**
 * Pin a message: the pin button beside Copy and Read aloud on each message (#193406).
 *
 * The pins themselves live in the app (persisted per chat, so they survive a restart); the app
 * hands them here with `configureMessagePins`, the same way it hands over read-aloud settings,
 * so this package doesn't import the app. Until the app configures it, no pin button is shown.
 */

export type MessagePinTarget = {
  sessionID: string
  /** The message being pinned (user or assistant). */
  messageID: string
  /** The user message that starts its turn: what the timeline scrolls to. */
  turnID: string
  /** The message's text; the app keeps its first line for the pinned list. */
  text: string
  /** When the message was created (ms). */
  time?: number
}

export type MessagePins = {
  isPinned: (sessionID: string, messageID: string) => boolean
  toggle: (target: MessagePinTarget) => void
}

let pins: MessagePins | undefined

/** The app calls this once with its pin store. */
export function configureMessagePins(next: MessagePins | undefined) {
  pins = next
}

export const messagePins = () => pins
