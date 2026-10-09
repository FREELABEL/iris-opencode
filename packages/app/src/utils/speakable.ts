/**
 * Turning a streaming markdown reply into speech, a sentence at a time.
 *
 * The assistant's text arrives as growing markdown. Speaking it raw would read out "asterisk",
 * URLs and whole code blocks, and speaking it token by token sounds broken. So text is released
 * only up to the last sentence boundary that is OUTSIDE an unfinished code fence, and each released
 * chunk is cleaned of markdown before it is spoken. When the reply is complete, the rest goes.
 */

/** Next piece of `raw` to speak, starting at `consumed` (an index into raw). */
export function nextSpeakable(raw: string, consumed: number, final: boolean): { text: string; consumed: number } {
  const end = final ? raw.length : safeEnd(raw, consumed)
  if (end <= consumed) return { text: "", consumed }
  return { text: speakable(raw.slice(consumed, end)), consumed: end }
}

/** Index just past the last sentence end in raw[from..] that is not inside an open ``` fence. */
function safeEnd(raw: string, from: number) {
  let fenced = false
  let end = from
  // Fence state must be computed from the start: a fence opened earlier may still be open.
  const fence = /```/g
  const fences: number[] = []
  for (let m = fence.exec(raw); m; m = fence.exec(raw)) fences.push(m.index)
  const sentence = /[.!?](?=\s)|\n\n/g
  sentence.lastIndex = from
  for (let m = sentence.exec(raw); m; m = sentence.exec(raw)) {
    const at = m.index + m[0].length
    fenced = fences.filter((f) => f < at).length % 2 === 1
    if (!fenced) end = at
  }
  return end
}

/** Markdown -> plain speakable text. Code blocks are skipped, not read. */
export function speakable(md: string): string {
  return md
    .replace(/```[\s\S]*?(```|$)/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "link")
    .replace(/^\s{0,3}#{1,6}\s+/gm, "")
    .replace(/^\s*>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^\s*\|?[\s:|-]+\|[\s:|-]*$/gm, "")
    .replace(/\|/g, ", ")
    .replace(/(\*\*|__|\*|_|~~)(\S(?:[\s\S]*?\S)?)\1/g, "$2")
    .replace(/\s+/g, " ")
    .trim()
}
