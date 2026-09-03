import { describe, expect, test } from "bun:test"
import { parseRabbitNote, renderRabbitTranscript, rabbitSessionId, type RabbitMeeting } from "./meetings-rabbit"

/**
 * The discriminator is the whole feature. rabbit@r1.rabbit.tech sends meeting notes AND
 * product mail from the same address ("Your Magic Gallery Photo" arrived here), so a filter
 * on sender files a photo notification as a meeting. These plant both shapes.
 *
 * The fixtures are the real mail's structure, converted to text exactly as the reader
 * converts it: title, sections, a bare `Transcript` line, then `[m:ss] Name: text`.
 */

const MEETING = `Iris Desktop Rollout

Meeting Title

Iris Desktop Rollout

Participants

- Alex: proposed the rollout

Purpose / Agenda

Plan the desktop rollout.

Transcript

[0:00] Alex: We should ship the desktop build this week.
[0:19] Clayton: Agreed — I'll prep onboarding material.
[1:02:33] Arthur: I'll handle the adapter side.

The audio file of this meeting can be downloaded from rabbithole.`

const NOT_A_MEETING = `Your Magic Gallery Photo

Your photo is ready. View it in rabbithole.`

const EMPTY_TRANSCRIPT = `Weekly Digest

Transcript

Nothing was recorded this week.`

describe("parseRabbitNote", () => {
  test("pulls out every transcript segment", () => {
    const parsed = parseRabbitNote(MEETING)
    expect(parsed).not.toBeNull()
    expect(parsed!.segments.length).toBe(3)
    expect(parsed!.segments[0].text).toBe("We should ship the desktop build this week.")
  })

  test("handles an hour-long timestamp", () => {
    expect(parseRabbitNote(MEETING)!.segments[2].timestamp).toBe("1:02:33")
  })

  test("keeps rabbit's speaker names as the label", () => {
    // rabbit names speakers rather than numbering them. The name is its GUESS, which is why
    // it is surfaced verbatim and never rewritten into a confident-looking id.
    expect(parseRabbitNote(MEETING)!.segments.map((s) => s.speakerLabel)).toEqual(["Alex", "Clayton", "Arthur"])
  })

  test("keeps the summary and drops the doubled title", () => {
    const { summary } = parseRabbitNote(MEETING)!
    expect(summary).toContain("Purpose / Agenda")
    expect(summary).not.toContain("[0:00]")
    // "Iris Desktop Rollout" appears as the h1 and again under Meeting Title.
    expect(summary.split("Iris Desktop Rollout").length - 1).toBeLessThan(2)
  })

  test("rejects mail that is not a meeting note", () => {
    expect(parseRabbitNote(NOT_A_MEETING)).toBeNull()
  })

  test("rejects a Transcript heading with no segments under it", () => {
    // Otherwise any mail using the word files itself as an empty meeting.
    expect(parseRabbitNote(EMPTY_TRANSCRIPT)).toBeNull()
  })
})

describe("renderRabbitTranscript", () => {
  const meeting = (): RabbitMeeting => {
    const parsed = parseRabbitNote(MEETING)!
    return {
      id: rabbitSessionId(380026),
      rowid: 380026,
      title: "Iris Desktop Rollout",
      receivedAt: new Date("2026-08-31T15:43:00Z"),
      summary: parsed.summary,
      segments: parsed.segments,
      duration: parsed.segments[parsed.segments.length - 1].timestamp,
      mailbox: "imap://X/INBOX",
    }
  }

  test("states rabbit's coverage, not Wispr's", () => {
    const { text } = renderRabbitTranscript(meeting(), {})
    expect(text).toContain("rabbit R1")
    // Wispr's header warns your own mic may be missing. On the R1 that is false, and a
    // false caveat filed onto a bloq outlives the session that wrote it.
    expect(text).not.toContain("YOUR OWN MIC MAY NOT BE CAPTURED")
  })

  test("warns that the speaker names are a guess", () => {
    expect(renderRabbitTranscript(meeting(), {}).text).toContain("GUESS")
  })

  test("relabels a speaker by name", () => {
    const { text } = renderRabbitTranscript(meeting(), { Arthur: "Arturo" })
    expect(text).toContain("Arturo: I'll handle the adapter side.")
    expect(text).not.toContain("Arthur:")
  })

  test("counts segments honestly", () => {
    expect(renderRabbitTranscript(meeting(), {}).segments).toBe(3)
  })
})

describe("rabbitSessionId", () => {
  test("prefixes so it can never collide with a Wispr UUID", () => {
    expect(rabbitSessionId(380098)).toBe("r380098")
  })
})
