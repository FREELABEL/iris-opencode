/**
 * Read a reply out loud: the speaker button on IRIS's replies.
 *
 * OFFLINE FIRST. It uses the system's own voices (Web Speech: macOS's built-in voices in the
 * desktop app), so it needs no network, no key and no download. Voices that run on the machine
 * (`localService`) are preferred; a network voice is used only if the person picks one.
 *
 * The person's choices (on/off, voice, speed) live in the app's settings store (Settings › Audio);
 * the app hands them here with `configureReadAloud`, so this package doesn't import the app.
 *
 * One reply speaks at a time: pressing another reply's speaker stops the first. Long replies are
 * spoken sentence by sentence (one utterance per chunk), so Stop is immediate and no engine limit
 * on utterance length is ever hit.
 */
import { createSignal } from "solid-js"

export type ReadAloudOptions = {
  /** Show the speaker button at all. */
  enabled: boolean
  /** A SpeechSynthesisVoice.voiceURI, or "" for the system default. */
  voice: string
  /** 0.5 – 2. 1 is normal. */
  rate: number
  /** 0 – 1. */
  volume: number
}

export const READ_ALOUD_DEFAULTS: ReadAloudOptions = { enabled: true, voice: "", rate: 1, volume: 1 }

let options: () => ReadAloudOptions = () => READ_ALOUD_DEFAULTS
/** The app calls this once with an accessor over its settings store. */
export function configureReadAloud(get: () => ReadAloudOptions) {
  options = get
}
export const readAloudOptions = () => options()

// ── Text: markdown → what a person would say ─────────────────────────────────────────────────

/** Markdown → plain speech. Code blocks and tables are summarised, links read as their words. */
export function speakableText(markdown: string): string {
  let t = markdown.replace(/\r\n/g, "\n")
  t = t.replace(/```[\s\S]*?```/g, " (code shown on screen) ")
  t = t.replace(/^\s*\|.*\|\s*$/gm, (row, offset, all) => {
    // Say "(table shown on screen)" once per table, not once per row.
    const before = all.slice(0, offset).split("\n").at(-2) ?? ""
    return /^\s*\|.*\|\s*$/.test(before) ? "" : " (table shown on screen) "
  })
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
  t = t.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
  t = t.replace(/https?:\/\/(?:www\.)?([^\s/)]+)[^\s)]*/g, "$1")
  t = t.replace(/`([^`]+)`/g, "$1")
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "")
  t = t.replace(/^\s*>\s?/gm, "")
  t = t.replace(/^\s*[-*+]\s+/gm, "")
  t = t.replace(/^\s*(\d+)[.)]\s+/gm, "$1. ")
  t = t.replace(/(\*\*|__)(.*?)\1/g, "$2").replace(/(\*|_)(\S.*?\S|\S)\1/g, "$2")
  t = t.replace(/~~(.*?)~~/g, "$1")
  t = t.replace(/^\s*(-{3,}|\*{3,}|_{3,})\s*$/gm, "")
  // Ranges and dashes read as words, not "minus".
  t = t.replace(/(\d)\s*[–-]\s*(\d)/g, "$1 to $2").replace(/\s[—–]\s/g, ", ")
  // A line that ends without punctuation still ends a thought: give the voice a pause.
  t = t
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/[.!?:;,)]$/.test(l) ? l : `${l}.`))
    .join(" ")
  return t.replace(/\s+/g, " ").replace(/\s+([.,;:!?])/g, "$1").trim()
}

/** Sentence-sized chunks, each under `max` characters (a long sentence is split at commas, then words). */
export function chunks(text: string, max = 220): string[] {
  const sentences = text.match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)?.map((s) => s.trim()).filter(Boolean) ?? []
  const out: string[] = []
  const push = (s: string) => {
    if (s.length <= max) return void out.push(s)
    let cur = ""
    for (const part of s.split(/(?<=,)\s+|\s+/)) {
      if ((cur + " " + part).trim().length > max && cur) {
        out.push(cur.trim())
        cur = part
      } else cur = `${cur} ${part}`
    }
    if (cur.trim()) out.push(cur.trim())
  }
  for (const s of sentences) push(s)
  return out
}

/** Which voice to use: the picked one; else the default local voice for the language; else any local one. */
export function pickVoice<V extends { voiceURI: string; lang: string; localService: boolean; default: boolean }>(
  voices: V[],
  wanted: string,
  lang = globalThis.navigator?.language ?? "en-US",
): V | undefined {
  if (wanted) {
    const v = voices.find((x) => x.voiceURI === wanted)
    if (v) return v
  }
  const local = voices.filter((v) => v.localService)
  const base = lang.split("-")[0]!.toLowerCase()
  const sameLang = local.filter((v) => v.lang.toLowerCase().startsWith(base))
  return sameLang.find((v) => v.default) ?? sameLang[0] ?? local.find((v) => v.default) ?? local[0]
}

// ── The player: one reply at a time ──────────────────────────────────────────────────────────

const synth = () => (typeof globalThis.speechSynthesis === "undefined" ? undefined : globalThis.speechSynthesis)
export const readAloudAvailable = () => !!synth()

const [speaking, setSpeaking] = createSignal<string>()
/** The id of the reply being read now, or undefined. */
export const readingId = speaking
let run = 0

export function stopReading() {
  run++
  synth()?.cancel()
  setSpeaking(undefined)
}

/** Read `markdown` aloud as reply `id`. Pressing again on the same reply stops it. */
export function toggleReading(id: string, markdown: string, opts: ReadAloudOptions = options()) {
  if (speaking() === id) return stopReading()
  const s = synth()
  if (!s) return
  stopReading()
  const mine = ++run
  const parts = chunks(speakableText(markdown))
  if (!parts.length) return
  const voice = pickVoice(s.getVoices(), opts.voice)
  setSpeaking(id)
  let i = 0
  const next = () => {
    if (mine !== run) return
    if (i >= parts.length) return setSpeaking(undefined)
    const u = new SpeechSynthesisUtterance(parts[i++]!)
    if (voice) {
      u.voice = voice as SpeechSynthesisVoice
      u.lang = voice.lang
    }
    u.rate = Math.min(2, Math.max(0.5, opts.rate || 1))
    u.volume = Math.min(1, Math.max(0, opts.volume ?? 1))
    u.onend = next
    u.onerror = () => (mine === run ? setSpeaking(undefined) : undefined)
    s.speak(u)
  }
  next()
}

/** "Hear this voice" in Settings › Audio. */
export function previewVoice(opts: ReadAloudOptions) {
  stopReading()
  toggleReading("__preview__", "Hi, I'm IRIS. This is how I'll read my replies to you.", opts)
}
