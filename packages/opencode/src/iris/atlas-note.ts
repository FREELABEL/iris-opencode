/**
 * Atlas › Artifacts (#187717): what counts as an Atlas note URL, and what a note's page says
 * about itself. Pure, so the rules are tested without the network.
 *
 * An Atlas note is a bloq item made public: `https://heyiris.io/n/<uuid>`. That is the only shape
 * accepted. The panel frames whatever passes here with the LIVE sandbox (same-origin allowed, so
 * the note's own scripts run), which is safe for heyiris.io and for nothing else.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTE_IN_TEXT = /https:\/\/heyiris\.io\/n\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** The canonical note URL (no query, no hash, lowercase uuid), or undefined if it is not one. */
export function atlasNoteUrl(input: string | undefined): string | undefined {
  if (!input) return undefined
  try {
    const u = new URL(input.trim())
    if (u.protocol !== "https:" || u.hostname !== "heyiris.io" || u.username || u.password || u.port) return undefined
    const m = /^\/n\/([^/]+)\/?$/.exec(u.pathname)
    if (!m || !UUID.test(m[1])) return undefined
    return `https://heyiris.io/n/${m[1].toLowerCase()}`
  } catch {
    return undefined
  }
}

/** Every distinct note URL in a block of text — e.g. what `iris atlas:item publish` printed. */
export function atlasNotesIn(text: string | undefined): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(NOTE_IN_TEXT)) {
    const url = atlasNoteUrl(m[0])
    if (url) out.add(url)
  }
  return [...out]
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'", apos: "'" }

/** The note's own title, from og:title or <title>; undefined when the page has neither. */
export function noteTitle(html: string): string | undefined {
  const raw =
    html.match(/<meta\s+[^>]*property\s*=\s*["']og:title["'][^>]*content\s*=\s*["']([^"']*)["']/i)?.[1] ??
    html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
  const t = raw
    ?.replace(/&(amp|lt|gt|quot|#39|apos);/g, (_, e) => ENTITIES[e])
    .replace(/\s+/g, " ")
    .trim()
  return t ? t.slice(0, 200) : undefined
}
