/**
 * A quick dictation take, typed into the chat box while it is being spoken.
 *
 * The words are written as the prompt's REAL text — one plain text node at the end of the editor,
 * rewritten in place as they arrive, with the caller firing the editor's input event after each
 * write. So the placeholder goes away, the text is the editor's own colour, Send is enabled, and
 * what Send sends is what is on screen (#189543).
 *
 * A take is segments (#191998). Any edit, delete or Send closes the open segment: everything said
 * before that moment belongs to the person and the recording cannot bring it back. Only the open
 * segment, the words since, can still change. Deliberate deletion is a decision, not loss
 * (specs/voice/standard.md rule 2).
 */
export type LiveRegion = {
  /** The open segment's node. None between a close and the next new word. */
  node?: Text
  /** Exactly what was last written into `node`, leading space included. */
  shown: string
  /** The whole take as of the last write: every word the person has been shown. */
  said: string
  /** Words of `said` in closed segments. The open segment is what comes after them. */
  from: number
  /** The person has touched the text during this take. */
  touched: boolean
}

const words = (text: string) => text.trim().split(/\s+/).filter(Boolean)

/** Close the open segment: its words stay where they are, and are the person's from now on. */
export function closeLiveSegment(region: LiveRegion): LiveRegion {
  return { node: undefined, shown: "", said: region.said, from: words(region.said).length, touched: true }
}

/** Has the person touched this take's text? Sent or deleted words count: their node is gone. */
export function liveTouched(editor: HTMLElement, region: LiveRegion | undefined): boolean {
  return !!region && (region.touched || !locate(editor, region))
}

/** The region as it stands: a node gone or changed with no input event (a Send) is the same as a close. */
function current(editor: HTMLElement, region: LiveRegion): LiveRegion {
  const node = locate(editor, region)
  return region.node && !node ? closeLiveSegment(region) : { ...region, node }
}

/**
 * Show `text` (the whole take so far). Empty means nothing new to show. Undefined takes the open
 * segment back out (a take that moved to the background, or failed with its audio saved for Retry);
 * closed segments stay. Returns the region to keep and whether the editor changed — when it did, the
 * caller fires the editor's input event so the prompt reads the new text.
 *
 * New words always go at the end. The caret follows them if it was at the end, and otherwise stays.
 */
export function writeLiveText(
  editor: HTMLElement,
  region: LiveRegion | undefined,
  text: string | undefined,
): { region: LiveRegion | undefined; changed: boolean } {
  if (text === "") return { region, changed: false }
  const open = region && current(editor, region)
  const node = open?.node
  if (text === undefined) {
    if (!node) return { region: undefined, changed: false }
    node.remove()
    return { region: undefined, changed: true }
  }
  const from = open?.from ?? 0
  const fresh = from ? words(text).slice(from).join(" ") : text
  // Nothing past the closed segments yet, or the engine is mid-revision: wait for the next update.
  if (!fresh) return { region: open, changed: false }
  const follow = caretAtEnd(editor)
  const target = node ?? appendNode(editor)
  const shown = gapBefore(target) + fresh
  const changed = target.data !== shown
  rewrite(target, shown)
  if (follow && changed) caretToEnd(editor)
  return { region: { node: target, shown, said: text, from, touched: open?.touched ?? false }, changed }
}

/**
 * The take's final transcript; true when the editor changed. Never touched: it replaces the live
 * words. Touched: it only refines the open segment, and only when it lines up confidently. Otherwise
 * what is on screen stays — that is not a failure, and the caller keeps the transcript recoverable.
 */
export function settleLiveText(editor: HTMLElement, region: LiveRegion | undefined, text: string): boolean {
  const open = region && current(editor, region)
  const node = open?.node
  if (!open || (node && !open.touched)) {
    const target = node ?? appendNode(editor)
    rewrite(target, gapBefore(target) + text)
    return true
  }
  const refined = openSegmentOf(text, node ? node.data : "", words(open.said).slice(0, open.from))
  if (!refined) return false
  const target = node ?? appendNode(editor)
  const shown = gapBefore(target) + refined
  if (target.data === shown) return false
  rewrite(target, shown)
  return true
}

/**
 * What of `final` (the transcript of the whole recording) belongs to the open segment: from where
 * its live words sit to the end. With no live words, what follows the closed segments' last words.
 * Undefined when neither can be found; the caller then keeps what is on screen.
 */
function openSegmentOf(final: string, open: string, closed: string[]): string | undefined {
  const tokens = words(final)
  const keys = tokens.map(speechKey)
  const live = speechKey(open).split(" ").filter(Boolean)
  if (live.length) {
    const span = findSpan(live, keys)
    return span && tokens.slice(span.start).join(" ")
  }
  const span = findSpan(speechKey(closed.slice(-ANCHOR_WORDS).join(" ")).split(" ").filter(Boolean), keys)
  return span && tokens.slice(span.end).join(" ")
}

const ANCHOR_WORDS = 4
const MATCH_MIN = 0.6
/** How far a word may drift, and how many leading words may be revised, before it counts as a miss. */
const DRIFT = 2
const REVISED_LEAD = 2

/**
 * The place `want` best fits in `keys`: the most of its words in order, and the latest on a tie,
 * because the words being placed are the newest. A lone word matches only near the end, since a
 * common word is found everywhere and what follows it would bring deleted text back.
 */
function findSpan(want: string[], keys: string[]): { start: number; end: number } | undefined {
  let best: { start: number; end: number; matched: number } | undefined
  for (let at = 0; at < keys.length; at++) {
    for (let lead = 0; lead <= REVISED_LEAD && lead < want.length; lead++) {
      if (keys[at] !== want[lead]) continue
      let matched = 1
      let end = at + 1
      for (const word of want.slice(lead + 1)) {
        const found = keys.slice(end, end + DRIFT + 1).indexOf(word)
        if (found < 0) continue
        matched++
        end += found + 1
      }
      if (best && matched < best.matched) continue
      best = { start: Math.max(0, at - lead), end, matched }
    }
  }
  if (!best || best.matched / want.length < MATCH_MIN) return undefined
  if (best.matched < 2 && keys.length - best.end > DRIFT) return undefined
  return { start: best.start, end: best.end }
}

/** Is the person's caret at the very end of the editor? False when it is elsewhere, or a selection. */
export function caretAtEnd(editor: HTMLElement): boolean {
  const selection = window.getSelection()
  if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return false
  const rest = document.createRange()
  rest.setStart(selection.anchorNode!, selection.anchorOffset)
  rest.setEnd(editor, editor.childNodes.length)
  return rest.toString() === ""
}

/** Is the person's caret or selection in the editor, somewhere other than the end? */
export function caretMoved(editor: HTMLElement): boolean {
  return editor.contains(window.getSelection()?.anchorNode ?? null) && !caretAtEnd(editor)
}

export function caretToEnd(editor: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(editor)
  range.collapse(false)
  const selection = window.getSelection()
  selection?.removeAllRanges()
  selection?.addRange(range)
}

/** Change only what differs, because assigning `data` throws a caret inside the node back to its start. */
function rewrite(node: Text, next: string) {
  let same = 0
  while (same < node.length && same < next.length && node.data[same] === next[same]) same++
  node.replaceData(same, node.length - same, next.slice(same))
}

function appendNode(editor: HTMLElement): Text {
  // A browser leaves a lone <br> in a box emptied by hand; words after it would start on line two.
  if (!editor.textContent) editor.replaceChildren()
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
