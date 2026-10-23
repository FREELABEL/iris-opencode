/**
 * A quick dictation take, typed into the chat box while it is being spoken.
 *
 * One span at the end of the editor, rewritten in place as the words arrive. It is on screen and
 * NOT in the prompt: the editor's parser skips it (isLiveDictation), and the final transcript
 * replaces it. Reading it into the prompt would put the take there twice once the transcript lands.
 */
export const LIVE_SLOT = "dictate-live"

export function isLiveDictation(node: Node): boolean {
  return node instanceof HTMLElement && node.dataset.slot === LIVE_SLOT
}

/**
 * Show `text` as the live take, reusing `current` while it is still in the editor (the editor can
 * rebuild its DOM under it — typing, a mention). Undefined clears it. Returns the span to keep.
 */
export function showLiveText(
  editor: HTMLElement,
  current: HTMLElement | undefined,
  text: string | undefined,
): HTMLElement | undefined {
  if (text === undefined) {
    current?.remove()
    return undefined
  }
  let span = current
  if (!span || !span.isConnected || span.parentNode !== editor) {
    span?.remove()
    span = document.createElement("span")
    span.dataset.slot = LIVE_SLOT
    span.contentEditable = "false"
    editor.appendChild(span)
  }
  const before = span.previousSibling?.textContent ?? ""
  const gap = before.length > 0 && !/\s$/.test(before) ? " " : ""
  span.textContent = gap + text
  return span
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

/**
 * Show the live take and keep the newest words in view. Past the box's height the text kept
 * growing below the fold, under the waveform lane, until someone scrolled by hand (#189977).
 */
export function showLiveTextFollowing(
  editor: HTMLElement,
  current: HTMLElement | undefined,
  text: string | undefined,
): HTMLElement | undefined {
  return growFollowing(editor, () => showLiveText(editor, current, text))
}

/** Run `grow` (anything that adds content), then keep the view at the bottom if it was there before. */
export function growFollowing<T>(el: Scrollable, grow: () => T): T {
  const follow = atBottom(el)
  const result = grow()
  if (follow) el.scrollTop = el.scrollHeight
  return result
}
