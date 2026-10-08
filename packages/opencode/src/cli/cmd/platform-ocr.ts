import { existsSync, readFileSync, statSync } from "fs"
import { resolve } from "path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { dim, requireAuth, writeJson } from "./iris-api"
import { askVision, ocrMessages, sizeRefusal } from "./ocr-core"

/**
 * `iris ocr <file>` — the text in a local image, on stdout (#186355).
 *
 * Vision already existed twice and neither took a file on your machine: `data-sources sync
 * --include-images` reads a CLOUD FOLDER into Atlas, and `POST /ai/analyze-image` wants
 * `image_url: required|url`. So the screenshots `iris browser check` writes, a photographed
 * receipt, a scan — none of them could be read without uploading them somewhere first, which is
 * the step that made chaining not worth doing.
 *
 * It calls the IRIS provider's OpenAI-compatible gateway with the CLI's own token — the same lane
 * the agents use, which falls through to OpenRouter when the licences are full. No second key.
 *
 * Plain text by default so it pipes; `--json` when the next thing wants the model and the usage.
 */

const DEFAULT_MODEL = "gpt-4o-mini"
const DEFAULT_PROMPT =
  "Read all text in this image, exactly as written, preserving line order. Reply with the text only — no description, no commentary."
const MAX_BYTES = 8 * 1024 * 1024

export const PlatformOcrCommand = cmd({
  command: "ocr <file>",
  describe: "read the text out of an image on this machine (screenshot, scan, photo)",
  builder: (y: any) =>
    y
      .positional("file", { describe: "path to a png, jpg, webp or gif", type: "string" })
      .option("model", { describe: `vision model to use (default ${DEFAULT_MODEL})`, type: "string", default: DEFAULT_MODEL })
      .option("prompt", { describe: "what to ask of the image (default: read all text)", type: "string" })
      .option("max-tokens", { describe: "reply budget", type: "number", default: 1500 })
      .option("json", { describe: "JSON output — text plus model and usage", type: "boolean", default: false }),
  async handler(args: any) {
    const isJson = Boolean(args.json)
    const fail = (msg: string) => {
      if (isJson) writeJson({ ok: false, measured: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = 2
    }

    const file = resolve(String(args.file))
    if (!existsSync(file)) return fail(`No such file: ${file}`)
    const bytes = statSync(file).size
    const tooBig = sizeRefusal(bytes, MAX_BYTES)
    if (tooBig) return fail(tooBig)

    let messages
    try {
      messages = ocrMessages(readFileSync(file), file, { prompt: String(args.prompt || DEFAULT_PROMPT) })
    } catch (e: any) {
      return fail(e.message)
    }

    const token = await requireAuth()
    if (!token) return fail("Not signed in — run `iris login`. The image is read by a model on your IRIS account.")

    const model = String(args.model || DEFAULT_MODEL).replace(/^iris\//, "")
    const base = process.env.IRIS_API_URL ?? "https://freelabel.net"
    const spinner = isJson ? null : prompts.spinner()
    spinner?.start(`Reading ${bytes > 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)}MB` : `${Math.round(bytes / 1024)}KB`} with ${model}…`)
    const r = await askVision({ base, token, model, messages, maxTokens: Number(args["max-tokens"]) || 1500 })
    if (!r.ok) {
      spinner?.stop("No reading", 1)
      return fail(r.error)
    }
    const text = r.text
    const body = { usage: r.usage }
    spinner?.stop(text ? `Read ${text.length} characters` : "No text found in that image")

    if (isJson) {
      writeJson({ ok: true, measured: true, file, model, text, usage: body?.usage ?? null })
      process.exitCode = text ? 0 : 1
      return
    }
    // Plain text on stdout so it pipes; anything about the run goes to the spinner above.
    if (text) console.log(text)
    else prompts.log.warn(dim("No text found in that image."))
    process.exitCode = text ? 0 : 1
  },
})
