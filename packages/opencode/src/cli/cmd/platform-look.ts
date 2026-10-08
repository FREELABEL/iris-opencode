import { existsSync, readFileSync, statSync, unlinkSync } from "fs"
import { tmpdir } from "os"
import { join, resolve } from "path"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { dim, requireAuth, writeJson } from "./iris-api"
import { askVision, ocrMessages, sizeRefusal } from "./ocr-core"

/**
 * `iris look "<question>"` — drag over any part of the screen and ask about it (#188543).
 *
 * Headlined twice in two days (One's "point at it", Herald OS's "select any part of your screen
 * and ask Hermes"). It was deleted once as a desktop feature, and comes back smaller: the vision
 * half already existed (`iris ocr <image> --prompt`), and every OS already ships a region picker.
 * The only missing part was the step between them. No UI of ours, no new permission of ours —
 * the OS's own picker asks for whatever the OS asks for.
 *
 * Bind it to a key with the OS's own shortcut tool (macOS Shortcuts → Run Shell Script,
 * GNOME/KDE custom shortcut, Omarchy/Hyprland bind).
 */

export type CapturePlan = { steps: Array<{ cmd: string; args: string[]; geometryFromPrev?: boolean }> } | { error: string }

/**
 * Which picker to run, decided from the platform and what is installed. The FIRST usable one wins;
 * nothing is installed for you. `has` is injected so this is testable on any machine.
 */
export function regionCapturePlan(platform: string, env: Record<string, string | undefined>, has: (bin: string) => boolean, out: string): CapturePlan {
  if (platform === "darwin") {
    // -i interactive region (Space toggles window mode, Esc cancels), -x no shutter sound.
    return { steps: [{ cmd: "screencapture", args: ["-i", "-x", out] }] }
  }
  if (platform === "linux") {
    if (!env.WAYLAND_DISPLAY && !env.DISPLAY) return { error: "No screen here — this machine has no DISPLAY or WAYLAND_DISPLAY. Run it on the machine you are looking at, or ask about an image you already have: iris look --image <file> \"<question>\"" }
    if (env.WAYLAND_DISPLAY && has("slurp") && has("grim")) {
      return { steps: [{ cmd: "slurp", args: [] }, { cmd: "grim", args: ["-g", "", out], geometryFromPrev: true }] }
    }
    if (env.WAYLAND_DISPLAY && has("gnome-screenshot")) return { steps: [{ cmd: "gnome-screenshot", args: ["-a", "-f", out] }] }
    if (env.WAYLAND_DISPLAY && has("spectacle")) return { steps: [{ cmd: "spectacle", args: ["-r", "-b", "-n", "-o", out] }] }
    if (env.DISPLAY && has("maim")) return { steps: [{ cmd: "maim", args: ["-s", out] }] }
    if (has("gnome-screenshot")) return { steps: [{ cmd: "gnome-screenshot", args: ["-a", "-f", out] }] }
    if (env.DISPLAY && has("import")) return { steps: [{ cmd: "import", args: [out] }] } // ImageMagick: drag to select
    return {
      error: env.WAYLAND_DISPLAY
        ? "No region picker found. Install one: slurp + grim (sway/Hyprland/Omarchy), or gnome-screenshot."
        : "No region picker found. Install one: maim (sudo apt install maim), or ImageMagick (import).",
    }
  }
  if (platform === "win32") return { error: "Windows is not supported yet — snip with Win+Shift+S, save it, then: iris look --image <file> \"<question>\"" }
  return { error: `Unsupported platform: ${platform}` }
}

const MAX_BYTES = 8 * 1024 * 1024
const DEFAULT_MODEL = "gpt-4o-mini"

export const PlatformLookCommand = cmd({
  command: "look [question..]",
  describe: "drag over any part of your screen and ask about it",
  builder: (y: any) =>
    y
      .positional("question", { describe: "what to ask about it (default: what is this?)", type: "string", array: true })
      .option("image", { describe: "ask about an image you already have instead of capturing", type: "string" })
      .option("keep", { describe: "keep the capture and print its path (deleted by default)", type: "boolean", default: false })
      .option("model", { describe: `vision model (default ${DEFAULT_MODEL})`, type: "string", default: DEFAULT_MODEL })
      .option("json", { type: "boolean", default: false })
      .example('iris look "why is this test failing?"', "drag over the error, get an answer")
      .example('iris look --image shot.png "what does this chart say?"', "ask about an existing image"),
  async handler(args: any) {
    const isJson = Boolean(args.json)
    const fail = (msg: string, code = 2) => {
      if (isJson) writeJson({ ok: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = code
    }
    const question = (Array.isArray(args.question) ? args.question.join(" ") : String(args.question ?? "")).trim() ||
      "What is this? Answer briefly and concretely."

    let file: string
    let captured = false
    if (args.image) {
      file = resolve(String(args.image))
      if (!existsSync(file)) return fail(`No such file: ${file}`)
    } else {
      file = join(tmpdir(), `iris-look-${process.pid}-${Date.now()}.png`)
      const plan = regionCapturePlan(process.platform, process.env, (b) => Bun.which(b) !== null, file)
      if ("error" in plan) return fail(plan.error)
      if (!isJson) prompts.log.info(dim("Drag over what you want to ask about (Esc to cancel)…"))
      let prev = ""
      for (const step of plan.steps) {
        const argv = step.geometryFromPrev ? step.args.map((a, i) => (i === 1 && a === "" ? prev : a)) : step.args
        const p = Bun.spawnSync([step.cmd, ...argv], { stdout: "pipe", stderr: "pipe" })
        prev = new TextDecoder().decode(p.stdout).trim()
        if (p.exitCode !== 0 && !existsSync(file)) return fail("Cancelled — nothing was captured.", 1)
      }
      // Every picker's Esc leaves no file (or an empty one). That is a cancel, not an error.
      if (!existsSync(file) || statSync(file).size === 0) return fail("Cancelled — nothing was captured.", 1)
      captured = true
    }

    try {
      const tooBig = sizeRefusal(statSync(file).size, MAX_BYTES)
      if (tooBig) return fail(tooBig)
      let messages
      try {
        // Measured: asked plainly, gpt-4o-mini answered a one-line question about a failing test with
        // ~300 words and a visible "wait, let me re-read". The person is mid-task; ask for the short version.
        messages = ocrMessages(readFileSync(file), file, { prompt: `${question}\n\nAnswer in a few sentences, concretely. No preamble.` })
      } catch (e: any) {
        return fail(e.message)
      }
      const token = await requireAuth()
      if (!token) return fail("Not signed in — run `iris login`. The image is read by a model on your IRIS account.")
      const model = String(args.model || DEFAULT_MODEL)
      const spinner = isJson ? null : prompts.spinner()
      spinner?.start(`Looking with ${model}…`)
      const r = await askVision({ base: process.env.IRIS_API_URL ?? "https://freelabel.net", token, model, messages, maxTokens: 1200 })
      if (!r.ok) {
        spinner?.stop("No answer", 1)
        return fail(r.error)
      }
      spinner?.stop("Answered")
      if (isJson) return void writeJson({ ok: true, question, model, answer: r.text, image: args.keep || !captured ? file : null, usage: r.usage })
      console.log(r.text || dim("(the model had nothing to say about that region)"))
      if (captured && args.keep) console.log(dim(`  capture kept: ${file}`))
    } finally {
      // A screen capture can hold anything that was on screen. It does not outlive the question
      // unless asked to.
      if (captured && !args.keep) {
        try { unlinkSync(file) } catch {}
      }
    }
  },
})
