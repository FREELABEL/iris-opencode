import { describe, expect, test } from "bun:test"
import { initialVoice, voiceReducer, type VoiceState } from "./voice-mode"

const run = (...events: Parameters<typeof voiceReducer>[1][]) =>
  events.reduce<VoiceState>((s, e) => voiceReducer(s, e), initialVoice)

describe("voice modes — quick takes go inline, background takes go to the panel", () => {
  test("starts idle, with no panel", () => {
    expect(initialVoice.mode).toBe("idle")
    expect(initialVoice.panel).toBe("hidden")
  })

  test("the mic or the shortcut starts a quick take", () => {
    expect(run({ type: "mic" }).mode).toBe("quick")
  })

  test("a quick take's transcript is inserted into the prompt, and the mode ends", () => {
    const s = run({ type: "mic" }, { type: "transcript", text: "hello" })
    expect(s.mode).toBe("idle")
    expect(s.effect).toEqual({ type: "insert", text: "hello" })
  })

  test("the menu starts a background take with the panel open", () => {
    const s = run({ type: "background" })
    expect(s.mode).toBe("background")
    expect(s.panel).toBe("open")
  })

  test("Keep recording hands a quick take to the background without stopping it", () => {
    const s = run({ type: "mic" }, { type: "keep" })
    expect(s.mode).toBe("background")
    expect(s.panel).toBe("open")
    expect(s.effect).toBeUndefined() // nothing stops, nothing is inserted
  })

  test("during a background take the mic and the shortcut fold the panel, they never start a second take", () => {
    const folded = run({ type: "background" }, { type: "mic" })
    expect(folded.mode).toBe("background")
    expect(folded.panel).toBe("collapsed")
    expect(voiceReducer(folded, { type: "mic" }).panel).toBe("open")
  })

  test("a background transcript waits in the panel; nothing reaches the prompt on its own", () => {
    const s = run({ type: "background" }, { type: "transcript", text: "meeting notes" })
    expect(s.mode).toBe("review")
    expect(s.panel).toBe("open")
    expect(s.result).toBe("meeting notes")
    expect(s.effect).toBeUndefined()
  })

  test("Insert puts the reviewed text in the prompt and closes the panel", () => {
    const s = run({ type: "background" }, { type: "transcript", text: "notes" }, { type: "insert" })
    expect(s.effect).toEqual({ type: "insert", text: "notes" })
    expect(s.mode).toBe("idle")
    expect(s.panel).toBe("hidden")
  })

  test("Copy hands the text to the clipboard and closes the panel", () => {
    const s = run({ type: "background" }, { type: "transcript", text: "notes" }, { type: "copy" })
    expect(s.effect).toEqual({ type: "copy", text: "notes" })
    expect(s.mode).toBe("idle")
  })

  test("Discard while recording cancels the take — it does not transcribe audio nobody wants", () => {
    const s = run({ type: "background" }, { type: "discard" })
    expect(s.effect).toEqual({ type: "cancel" })
    expect(s.mode).toBe("idle")
    expect(s.panel).toBe("hidden")
  })

  test("Discard after review drops the text", () => {
    const s = run({ type: "background" }, { type: "transcript", text: "x" }, { type: "discard" })
    expect(s.effect).toBeUndefined()
    expect(s.result).toBeUndefined()
    expect(s.mode).toBe("idle")
  })

  test("a transcript that arrives when idle (a retried saved recording) is inserted", () => {
    expect(run({ type: "transcript", text: "late" }).effect).toEqual({ type: "insert", text: "late" })
  })

  test("a failed take ends the mode and closes the panel — the error shows where every error shows", () => {
    expect(run({ type: "mic" }, { type: "failed" }).mode).toBe("idle")
    const bg = run({ type: "background" }, { type: "failed" })
    expect(bg.mode).toBe("idle")
    expect(bg.panel).toBe("hidden")
  })

  test("the menu cannot start a background take on top of a review the person has not dealt with", () => {
    const s = run({ type: "background" }, { type: "transcript", text: "unsaved" }, { type: "background" })
    expect(s.mode).toBe("review")
    expect(s.result).toBe("unsaved")
  })

  test("effects are one-shot: the next event clears them", () => {
    const s = run({ type: "mic" }, { type: "transcript", text: "a" }, { type: "noop" })
    expect(s.effect).toBeUndefined()
  })
})
