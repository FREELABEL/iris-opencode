/**
 * A quick dictation take, typed into the chat box while it is being spoken.
 *
 * The words are written as the prompt's REAL text — one plain text node at the end of the editor,
 * rewritten in place as they arrive, with the caller firing the editor's input event after each
 * write. So the placeholder goes away, the text is the editor's own colour, Send is enabled, and
 * what Send sends is what is on screen (#189543). Until then they were a grey preview span the
 * parser skipped: on screen, never in the prompt.
 *
 * The region belongs to the take until the person edits it. Once they type into the dictated words,
 * or the words leave the editor (sent, cleared), it is theirs: no later live update or final
 * transcript overwrites or re-adds them.
 */
export type LiveRegion = {
  node: Text
  /** Exactly what was last written into `node`, leading space included. */
  shown: string
  /** The person took the words over; nothing more is written for this take. */
  released?: boolean
}

/**
 * Show `text` as the take's words. Undefined takes them back out (a take that ended without a
 * transcript, or moved to the background). Returns the region to keep and whether the editor changed
 * — when it did, the caller fires the editor's input event so the prompt reads the new text.
 */
export function writeLiveText(
  editor: HTMLElement,
  region: LiveRegion | undefined,
  text: string | undefined,
): { region: LiveRegion | undefined; changed: boolean } {
  if (region?.released) return { region: text === undefined ? undefined : region, changed: false }
  const node = region ? locate(editor, region) : undefined
  if (region && !node) {
    // Gone from the editor or edited: theirs now.
    return { region: text === undefined ? undefined : { ...region, released: true }, changed: false }
  }
  if (text === undefined) {
    if (!node) return { region: undefined, changed: false }
    node.remove()
    return { region: undefined, changed: true }
  }
  if (node) {
    const shown = gapBefore(node) + text
    if (node.data === shown) return { region: { node, shown }, changed: false }
    node.data = shown
    return { region: { node, shown }, changed: true }
  }
  const fresh = document.createTextNode("")
  editor.appendChild(fresh)
  fresh.data = gapBefore(fresh) + text
  return { region: { node: fresh, shown: fresh.data }, changed: true }
}

/**
 * The take's final transcript. It replaces the live words where they still are; with no live words
 * (the live preview never ran) it is appended. When the person took the words over, nothing is
 * written. Returns true when the editor changed.
 */
export function settleLiveText(editor: HTMLElement, region: LiveRegion | undefined, text: string): boolean {
  if (region?.released) return false
  const node = region ? locate(editor, region) : undefined
  if (region && !node) return false
  if (node) {
    node.data = gapBefore(node) + text
    return true
  }
  const fresh = document.createTextNode("")
  editor.appendChild(fresh)
  fresh.data = gapBefore(fresh) + text
  return true
}

/**
 * The region's node, while it still holds exactly what was written. The editor can rebuild its DOM
 * from the prompt (a mention, a popover pick); then the words are found again at the end of the
 * last text node and split back out into a node of their own.
 */
function locate(editor: HTMLElement, region: LiveRegion): Text | undefined {
  const { node, shown } = region
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
