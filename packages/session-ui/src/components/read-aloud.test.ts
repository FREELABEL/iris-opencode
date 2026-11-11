import { describe, expect, test } from "bun:test"
import { chunks, pickVoice, speakableText } from "./read-aloud"

describe("speakableText: a reply as a person would say it", () => {
  test("the jazz reply reads cleanly", () => {
    const md = `Tonight (Wed, Nov 11) in Austin — all three verified on the venues' own sites:

**Monks Jazz Club** — 310 E St Elmo Rd (South Austin)

- Jim Snidero Quartet "House of Trane" record release — doors 7:00 PM, show 7:30 PM
- $20–25 bar seats (tables 2+ are gone); live-taping, whisper policy`
    expect(speakableText(md)).toBe(
      `Tonight (Wed, Nov 11) in Austin, all three verified on the venues' own sites: Monks Jazz Club, 310 E St Elmo Rd (South Austin) Jim Snidero Quartet "House of Trane" record release, doors 7:00 PM, show 7:30 PM. $20 to 25 bar seats (tables 2+ are gone); live-taping, whisper policy.`,
    )
  })
  test("code, tables, links and headings", () => {
    expect(speakableText("# Plan\nSee [the docs](https://x.com/a) or https://www.heyiris.io/p/x\n```ts\nconst a = 1\n```")).toBe(
      "Plan. See the docs or heyiris.io. (code shown on screen)",
    )
    expect(speakableText("| a | b |\n|---|---|\n| 1 | 2 |")).toBe("(table shown on screen)")
    expect(speakableText("Use `iris run` *now*")).toBe("Use iris run now.")
  })
})

test("chunks: sentences, and long ones split under the limit", () => {
  expect(chunks("One. Two! Three?")).toEqual(["One.", "Two!", "Three?"])
  const long = Array.from({ length: 80 }, (_, i) => `word${i}`).join(" ") + "."
  const c = chunks(long, 100)
  expect(c.length).toBeGreaterThan(1)
  expect(c.every((x) => x.length <= 100)).toBe(true)
  expect(c.join(" ")).toBe(long)
})

test("pickVoice: the person's pick, else a LOCAL voice in their language (offline), never a network one by default", () => {
  const v = (voiceURI: string, lang: string, localService: boolean, d = false) => ({ voiceURI, lang, localService, default: d, name: voiceURI })
  const voices = [v("net-en", "en-US", false, true), v("Samantha", "en-US", true), v("Amelie", "fr-CA", true, true)]
  expect(pickVoice(voices, "", "en-US")?.voiceURI).toBe("Samantha")
  expect(pickVoice(voices, "Amelie", "en-US")?.voiceURI).toBe("Amelie")
  expect(pickVoice(voices, "gone", "fr-FR")?.voiceURI).toBe("Amelie")
  expect(pickVoice([v("net", "en-US", false)], "", "en-US")).toBeUndefined()
})
