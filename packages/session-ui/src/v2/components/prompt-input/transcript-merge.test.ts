import { describe, expect, test } from "bun:test"
import { emptyTranscript, lockedText, mergeTranscript, transcriptText, type LiveTranscriptEvent } from "./transcript-merge"

// #189543: "I need to build a shopping list", said once, showed in the composer twice.
const run = (events: LiveTranscriptEvent[], from = emptyTranscript) =>
  events.reduce((state, event) => mergeTranscript(state, event), from)

const count = (haystack: string, needle: string) => haystack.split(needle).length - 1

const partial = (text: string): LiveTranscriptEvent => ({ type: "partial", text })
const final = (text: string): LiveTranscriptEvent => ({ type: "final", text })
const turn = (text: string): LiveTranscriptEvent => ({ type: "final", text, turn: true })

describe("live transcript merge", () => {
  test("interim → interim → final for one phrase: the phrase appears once, at every step", () => {
    const phrase = "I need to build a shopping list."
    // The exact sequence xAI sent for this phrase on 2026-10-15: partials, then is_final, then the
    // speech_final turn restating it.
    const steps = [partial("I need to build a shopping."), partial(phrase), final(phrase), turn(phrase)]
    let state = emptyTranscript
    for (const step of steps) {
      state = mergeTranscript(state, step)
      expect(count(transcriptText(state), "I need")).toBe(1)
    }
    expect(transcriptText(state)).toBe(phrase)
    expect(state.interim).toBe("")
  })

  test("a turn of several segments replaces them — measured on the wire, not imagined", () => {
    const a = "I need to build a shopping list for the week with eggs, milk, bread."
    const b = "No, no, also add coffee."
    const state = run([partial("I need to build"), final(a), partial("No, no."), partial(b), final(b), turn(`${a} ${b}`)])
    expect(transcriptText(state)).toBe(`${a} ${b}`)
    expect(count(transcriptText(state), "shopping list")).toBe(1)
    expect(count(transcriptText(state), "coffee")).toBe(1)
  })

  test("Keep recording continues the same take: earlier phrases stay once, new ones are added once", () => {
    const first = run([partial("I need to"), partial("I need to build a shopping list."), final("I need to build a shopping list."), turn("I need to build a shopping list.")])
    // "Keep recording" hands the running take to the background — same socket, same state.
    const kept = run([partial("Add"), partial("Add eggs and milk."), final("Add eggs and milk."), turn("Add eggs and milk.")], first)
    expect(transcriptText(kept)).toBe("I need to build a shopping list. Add eggs and milk.")
    expect(count(transcriptText(kept), "shopping list")).toBe(1)
    expect(count(transcriptText(kept), "eggs and milk")).toBe(1)
  })

  test("real repeats are kept: no text is ever compared", () => {
    expect(transcriptText(run([partial("No, no."), final("No, no."), turn("No, no.")]))).toBe("No, no.")
    // The same sentence said twice is two turns.
    const twice = run([final("Yes."), turn("Yes."), final("Yes."), turn("Yes.")])
    expect(transcriptText(twice)).toBe("Yes. Yes.")
  })

  test("committed and interim stay apart: a partial never touches locked words", () => {
    const state = run([final("Hello there."), turn("Hello there."), partial("How are")])
    expect(lockedText(state)).toBe("Hello there.")
    expect(state.interim).toBe("How are")
    expect(transcriptText(mergeTranscript(state, partial("How are you?")))).toBe("Hello there. How are you?")
  })

  test("a final replaces the interim it locks", () => {
    const state = run([partial("buy"), partial("buy bread"), final("Buy bread.")])
    expect(transcriptText(state)).toBe("Buy bread.")
    expect(state.interim).toBe("")
  })

  test("an empty turn keeps the segments it would have restated", () => {
    expect(transcriptText(run([final("Milk."), turn("")]))).toBe("Milk.")
  })
})
