export type BubbleSegment = { text: string; type?: "file" | "agent" }

/**
 * #193703: blank lines typed before the first word or after the last showed as dead space in the
 * bubble (messages already saved keep them). Trim them, and show a run of blank lines inside the
 * message as one. Highlighted mentions are never changed.
 */
export function tidyBubbleSegments(segments: BubbleSegment[]): BubbleSegment[] {
  const out = segments.map((s) => (s.type ? s : { ...s, text: s.text.replace(/\n[ \t]*(?:\n[ \t]*){2,}/g, "\n\n") }))
  while (out.length && !out[0]!.type && !out[0]!.text.trim()) out.shift()
  while (out.length && !out[out.length - 1]!.type && !out[out.length - 1]!.text.trim()) out.pop()
  if (out[0] && !out[0].type) out[0] = { ...out[0], text: out[0].text.replace(/^\s*\n/, "") }
  const last = out.length - 1
  if (out[last] && !out[last]!.type) out[last] = { ...out[last]!, text: out[last]!.text.trimEnd() }
  return out
}
