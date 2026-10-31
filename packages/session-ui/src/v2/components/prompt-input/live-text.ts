/**
 * A quick dictation take, typed into the chat box while it is being spoken.
 *
 * The words are written as the prompt's REAL text — one plain text node at the end of the editor,
 * rewritten in place as they arrive, with the caller firing the editor's input event after each
 * write. So the placeholder goes away, the text is the editor's own colour, Send is enabled, and
 * what Send sends is what is on screen (#189543). Until then they were a grey preview span the
 * parser skipped: on screen, never in the prompt.
 *
 * The node belongs to the take until the person touches it. Once they edit the words, or the words
 * leave the editor (sent, cleared), those words are theirs and are never rewritten or re-added — but
 * the take is still running, so what is said AFTER them keeps arriving, in a new node at the end of
 * the editor. Nothing said is lost (specs/voice/standard.md rule 2).
 */
export type LiveRegion = {
  /** The node this take is writing to. None between a takeover and the next new word. */
  node?: Text
  /** Exactly what was last written into `node`, leading space included. */
  shown: string
  /** The whole take as of the last write: every word the person has been shown. */
  said: string
  /** The take as of the person's last takeover. Only words after these are still the take's. */
  handed?: string
}

/**
 * Show `text` (the whole take so far) as the take's words. Empty means nothing new to show. Undefined
 * takes the words still owned by the take back out (a take that moved to the background, or failed
 * with its audio saved for Retry); what the person took over stays. Returns the region to keep and
 * whether the editor changed — when it did, the caller fires the editor's input event so the prompt
 * reads the new text.
 */
export function writeLiveText(
  editor: HTMLElement,
  region: LiveRegion | undefined,
  text: string | undefined,
): { region: LiveRegion | undefined; changed: boolean } {
  if (text === "") return { region, changed: false }
  const node = region?.node ? locate(editor, region) : undefined
  if (text === undefined) {
    if (!node) return { region: undefined, changed: false }
    node.remove()
    return { region: undefined, changed: true }
  }
  // No node left to write to means the person took the last words over: gone or edited.
  const handed = region && !node ? region.said : region?.handed
  const words = handed === undefined ? text : wordsAfter(handed, text)
  // Nothing past what they already have (or the engine is mid-revision): wait for the next update.
  if (!words) return { region: region && { ...region, node, shown: node ? region.shown : "", handed }, changed: false }
  const target = node ?? appendNode(editor)
  const shown = gapBefore(target) + words
  const changed = target.data !== shown
  target.data = shown
  return { region: { node: target, shown, said: text, handed }, changed }
}

/** What became of a take's final transcript. `held` means it could not be placed: keep it visibly. */
export type LiveSettled = { changed: boolean; held: boolean }

/**
 * The take's final transcript. It replaces the live words only when the person never touched them.
 * After a takeover, only the words said after it are placed — replacing the live words since then,
 * or appended — and the person's own text is left alone. If the transcript cannot be lined up with
 * what they were shown, nothing in the editor changes and the result says `held`: the caller keeps
 * the whole transcript where the person can see and recover it.
 */
export function settleLiveText(editor: HTMLElement, region: LiveRegion | undefined, text: string): LiveSettled {
  const node = region?.node ? locate(editor, region) : undefined
  if (!region || (node && region.handed === undefined)) {
    const target = node ?? appendNode(editor)
    target.data = gapBefore(target) + text
    return { changed: true, held: false }
  }
  const words = wordsAfter(node ? (region.handed ?? "") : region.said, text)
  if (words === undefined) return { changed: false, held: true }
  // Nothing new. Live words already on screen stay: they were heard, and are not the transcript's to remove.
  if (!words) return { changed: false, held: false }
  const target = node ?? appendNode(editor)
  target.data = gapBefore(target) + words
  return { changed: true, held: false }
}

const LINE_UP_MIN = 0.6
const LINE_UP_MAX_CELLS = 4_000_000

/**
 * The part of `full` (a later version of the same take) that comes after `said`. Undefined when the
 * two cannot be lined up. Live words and the final transcript differ in punctuation, case and the
 * odd word, so this lines them up word by word (longest common subsequence) rather than by prefix,
 * and a word still being revised when the person took over counts as already had.
 */
export function wordsAfter(said: string, full: string): string | undefined {
  const tokens = full.trim().split(/\s+/).filter(Boolean)
  const keys = tokens.map(speechKey)
  const had = speechKey(said).split(" ").filter(Boolean)
  let shared = 0
  while (shared < had.length && shared < keys.length && had[shared] === keys[shared]) shared++
  if (shared === had.length) return tokens.slice(shared).join(" ")

  const a = had.slice(shared)
  const b = keys.slice(shared)
  if (a.length * b.length > LINE_UP_MAX_CELLS) return undefined
  const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1))
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      table[i]![j] = a[i - 1] === b[j - 1] ? table[i - 1]![j - 1]! + 1 : Math.max(table[i - 1]![j]!, table[i]![j - 1]!)
  if ((shared + table[a.length]![b.length]!) / had.length < LINE_UP_MIN) return undefined

  // The last word of `said` that matched, at its earliest place in `full`, so a phrase repeated
  // later in the take is not skipped over.
  let i = a.length
  let j = b.length
  while (i > 0 && j > 0 && a[i - 1] !== b[j - 1]) {
    if (table[i]![j - 1] === table[i]![j]) j--
    else i--
  }
  if (i === 0 || j === 0) return tokens.slice(shared + a.length).join(" ")
  for (let k = 1; k < j; k++) {
    if (b[k - 1] === a[i - 1] && table[i]![k] === table[i]![j]) {
      j = k
      break
    }
  }
  // Words of `said` after that match were revised by the engine; each has a counterpart in `full`.
  return tokens.slice(shared + j + (a.length - i)).join(" ")
}

function appendNode(editor: HTMLElement): Text {
  const fresh = document.createTextNode("")
  editor.appendChild(fresh)
  return fresh
}

/**
 * The region's node, while it still holds exactly what was written. The editor can rebuild its DOM
 * from the prompt (a mention, a popover pick); then the words are found again at the end of the
 * last text node and split back out into a node of their own.
 */
function locate(editor: HTMLElement, region: LiveRegion): Text | undefined {
  const { node, shown } = region
  if (!node) return undefined
  if (editor.contains(node)) return node.data === shown ? node : undefined
  const last = lastText(editor)
  if (!last || !shown || !last.data.endsWith(shown)) return undefined
  return last.splitText(last.data.length - shown.length)
}

function lastText(editor: HTMLElement): Text | undefined {
  let node: Node | null = editor.lastChild
  while (node && !(node instanceof Text)) node = node.lastChild ?? node.previousSibling
  return node ?? undefined
}

function gapBefore(node: Text): string {
  let prev = node.previousSibling
  let before = ""
  while (prev && !before) {
    before = prev.textContent ?? ""
    prev = prev.previousSibling
  }
  return before.length > 0 && !/\s$/.test(before) ? " " : ""
}

/**
 * Comparable form of spoken text: case, punctuation and spacing ignored. Engines resend the same
 * words with a different comma or a leading space, and strict equality let those through (#189546).
 */
export function speechKey(text: string) {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim()
}

/**
 * Add a locked utterance to the live take. A final that repeats what is already shown is dropped;
 * one that restates the take so far, or extends its last utterance, replaces instead of appending.
 * Appending every final typed a spoken sentence twice (#189546).
 */
export function appendFinal(finals: readonly string[], text: string): string[] {
  const key = speechKey(text)
  if (!key) return [...finals]
  const shown = speechKey(finals.join(" "))
  const last = speechKey(finals.at(-1) ?? "")
  if (shown && (shown === key || shown.endsWith(key))) return [...finals]
  if (shown && key.startsWith(shown)) return [text]
  if (last && key.startsWith(last)) return [...finals.slice(0, -1), text]
  return [...finals, text]
}

/** The live take as one line: the locked utterances, then the one being spoken. */
export function composeLive(finals: readonly string[], partial: string): string {
  const locked = finals.join(" ")
  const lockedKey = speechKey(locked)
  const partialKey = speechKey(partial)
  // A partial that restates what is already locked (some engines send the whole take so far)
  // is shown on its own, not after a second copy of it.
  const text = lockedKey && partialKey.startsWith(lockedKey) ? partial : partialKey && lockedKey.endsWith(partialKey) ? locked : `${locked} ${partial}`
  return text.replace(/\s+/g, " ").trim()
}


/** The parts of a scroll container this needs — an element, or a plain object in a test. */
type Scrollable = { scrollTop: number; scrollHeight: number; clientHeight: number }

/**
 * Is the chat box scrolled to its bottom, within `slack` px? Asked BEFORE the live words grow, so a
 * person who scrolled up to reread is left where they are, and everyone else is followed (#189977).
 */
export function atBottom(el: Scrollable, slack = 24): boolean {
  return el.scrollHeight - el.scrollTop - el.clientHeight <= slack
}

/** Run `grow` (anything that adds content), then keep the view at the bottom if it was there before. */
export function growFollowing<T>(el: Scrollable, grow: () => T): T {
  const follow = atBottom(el)
  const result = grow()
  if (follow) el.scrollTop = el.scrollHeight
  return result
}
