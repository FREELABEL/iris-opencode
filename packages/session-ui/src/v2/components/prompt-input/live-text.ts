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
