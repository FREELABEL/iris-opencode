import { describe, expect, test } from "bun:test"
import { cleanOcrText, mimeForImage, ocrMessages, sizeRefusal } from "./ocr-core"

/**
 * `iris ocr <file>` — read the text out of a local image (#186355).
 *
 * Asked for 2026-09-20 to chain `iris browser check` (which writes screenshots) into Atlas. Vision
 * already existed twice and neither took a local file: `data-sources sync --include-images` reads a
 * CLOUD FOLDER, and POST /ai/analyze-image requires `image_url: required|url`. So a screenshot on
 * your own disk could not be read at all.
 *
 * The call goes to the IRIS provider's OpenAI-compatible gateway (/api/v6/openai) — the same auth
 * the CLI already has, and the same lane that falls through to OpenRouter. Measured that day
 * against a rendered invoice: iris/gpt-4o-mini and iris/gpt-4.1-nano both read every line in ~2s,
 * and BOTH wrapped the answer in a <think> block.
 */

describe("what we send", () => {
  test("the image goes as a data URI with the right type, next to the instruction", () => {
    const m = ocrMessages(Buffer.from("PNGDATA"), "shot.png", { prompt: "Read all text." })
    expect(m).toHaveLength(1)
    const parts = m[0].content as any[]
    expect(parts[0]).toEqual({ type: "text", text: "Read all text." })
    expect(parts[1].image_url.url).toBe(`data:image/png;base64,${Buffer.from("PNGDATA").toString("base64")}`)
  })

  test("the file's type comes from its extension, case-insensitively", () => {
    expect(mimeForImage("a.png")).toBe("image/png")
    expect(mimeForImage("A.JPG")).toBe("image/jpeg")
    expect(mimeForImage("b.jpeg")).toBe("image/jpeg")
    expect(mimeForImage("c.webp")).toBe("image/webp")
    expect(mimeForImage("d.gif")).toBe("image/gif")
  })

  test("a PDF is refused by name, with what to do instead — vision takes images", () => {
    expect(() => mimeForImage("scan.pdf")).toThrow(/pdf/i)
    expect(() => mimeForImage("scan.pdf")).toThrow(/page|image|convert/i)
  })

  test("an unknown extension is refused rather than sent as the wrong type", () => {
    expect(() => mimeForImage("notes.txt")).toThrow(/txt/)
  })
})

describe("what comes back", () => {
  test("a reasoning model's <think> block is not part of the text", () => {
    const raw = "<think>The user wants me to read the image.</think>\n\nINVOICE 2026-0917\nTotal due: $4,633.10"
    expect(cleanOcrText(raw)).toBe("INVOICE 2026-0917\nTotal due: $4,633.10")
  })

  test("a fenced block is unwrapped, because the page text is not code", () => {
    expect(cleanOcrText("```\nTotal due: $4,633.10\n```")).toBe("Total due: $4,633.10")
  })

  test("ordinary text passes through untouched, including blank lines inside it", () => {
    expect(cleanOcrText("A\n\nB")).toBe("A\n\nB")
  })

  test("a reply that is ONLY thinking reads as empty, not as text", () => {
    expect(cleanOcrText("<think>still thinking</think>")).toBe("")
  })
})

describe("refusing a file that cannot work", () => {
  test("too big to send: says the size, the limit, and that base64 inflates it", () => {
    const msg = sizeRefusal(9 * 1024 * 1024, 8 * 1024 * 1024)
    expect(msg).toMatch(/9(\.0)? MB/)
    expect(msg).toMatch(/8 MB/)
    expect(msg).toMatch(/base64|33%|larger/i)
  })

  test("within the limit: nothing to say", () => {
    expect(sizeRefusal(1024, 8 * 1024 * 1024)).toBeNull()
  })
})
