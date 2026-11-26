import type { Component } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"

/**
 * A readable card for a command that CHANGED something (#194362). The commands row folds a turn's
 * shell and IRIS calls into "Ran 3 commands"; a write the person should know about — "Added Ethan
 * Okafor to Call today" — is drawn under it as a card, with the raw command behind a disclosure.
 *
 * The app registers what counts and how it reads (it knows IRIS's verbs and names); with nothing
 * registered the row is exactly what it was.
 */
export type ToolActionCardEntry = {
  accepts: (part: ToolPart) => boolean
  render: Component<{ part: ToolPart }>
}

let entry: ToolActionCardEntry | undefined

export function registerToolActionCard(e: ToolActionCardEntry | undefined) {
  entry = e
}

export function toolActionCard(): ToolActionCardEntry | undefined {
  return entry
}

/** The parts in a commands row that get a card, in order. Never throws: a bad describer shows nothing. */
export function actionParts(parts: ToolPart[]): ToolPart[] {
  const e = entry
  if (!e) return []
  return parts.filter((p) => {
    try {
      return e.accepts(p)
    } catch {
      return false
    }
  })
}
