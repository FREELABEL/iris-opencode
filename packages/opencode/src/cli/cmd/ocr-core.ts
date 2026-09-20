import path from "path"

/**
 * The decisions behind `iris ocr <file>` (#186355), with no I/O.
 *
 * Reading a local image was the one thing vision could not do here: `data-sources sync
 * --include-images` reads a CLOUD FOLDER, and `POST /ai/analyze-image` requires `image_url:
 * required|url`, so a screenshot on your own disk had nowhere to go. That is the step that made
 * `iris browser check` → OCR → Atlas not worth chaining.
 */

const TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
}

/** The image type for a file, or a refusal that says what to do instead. */
export function mimeForImage(file: string): string {
  const ext = path.extname(file).toLowerCase()
  if (ext === ".pdf")
    throw new Error(
      "A PDF is not an image: vision reads pictures, a page at a time. Export the page you want as PNG and run it on that, or ingest the document with `iris data-sources sync <bloq> <source> <folder> --include-images`.",
    )
  const mime = TYPES[ext]
  if (!mime) throw new Error(`Cannot read "${ext || "a file with no extension"}" — images only: ${Object.keys(TYPES).join(", ")}.`)
  return mime
}

export interface OcrMessage {
  role: "user"
  content: ({ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } })[]
}

/** The request body's messages: the instruction, then the image itself as a data URI. */
export function ocrMessages(bytes: Buffer | Uint8Array, file: string, opts: { prompt: string }): OcrMessage[] {
  const mime = mimeForImage(file)
  const b64 = Buffer.from(bytes).toString("base64")
  return [
    {
      role: "user",
      content: [
        { type: "text", text: opts.prompt },
        { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
      ],
    },
  ]
}

/**
 * The text, without the model's thinking.
 *
 * Measured 2026-09-20 through the IRIS gateway: BOTH iris/gpt-4o-mini and iris/gpt-4.1-nano
 * returned the page's text wrapped in a <think> block. Printing that verbatim would put the
 * model's reasoning into whatever the next command in the pipe does with it.
 */
export function cleanOcrText(content: string): string {
  let text = String(content ?? "")
  if (text.includes("<think>")) {
    const end = text.lastIndexOf("</think>")
    text = end >= 0 ? text.slice(end + "</think>".length) : ""
  }
  text = text.trim()
  if (text.startsWith("```")) text = text.replace(/^```[a-z]*\s*/i, "").replace(/\s*```$/, "").trim()
  return text
}

const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`

/** Why this file cannot be sent, or null when it can. */
export function sizeRefusal(bytes: number, limit: number): string | null {
  if (bytes <= limit) return null
  return `That image is ${mb(bytes)} and the limit is ${mb(limit)} — it travels base64-encoded, which makes it ~33% larger again. Crop it, scale it down, or split the page.`
}
