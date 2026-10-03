/**
 * Atlas › Artifacts (epic #187717): the Atlas notes THIS session produced, derived from its
 * parts. Pure, so the rules are tested without a session.
 *
 * NO STORE (ADR-02). An Atlas note's content lives on heyiris.io; all the panel needs is the URL
 * and a title, and the session already holds both. Two sources:
 *
 *   tool   an `atlas_artifact` call that completed — the agent said "look at this"
 *   shell  a /n/ URL printed by a Shell run — `iris atlas:item publish`, `iris bloqs make-public`.
 *          These never drew a card, and without this row they would be in the transcript only.
 *
 * A note that came from both is ONE row, and the tool's title wins: it was chosen, the shell's
 * was not. Mirrors packages/opencode/src/iris/atlas-note.ts — the app cannot import the engine.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NOTE_IN_TEXT = /https:\/\/heyiris\.io\/n\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi

/** The canonical note URL, or undefined. Only these are framed with the LIVE sandbox. */
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

export function atlasNotesIn(text: string | undefined): string[] {
  if (!text) return []
  const out = new Set<string>()
  for (const m of text.matchAll(NOTE_IN_TEXT)) {
    const url = atlasNoteUrl(m[0])
    if (url) out.add(url)
  }
  return [...out]
}

export interface AtlasNote {
  /** The canonical URL doubles as the id: one note, one row. */
  url: string
  title: string
  summary?: string
  source: "tool" | "shell"
  /** Higher is newer. */
  order: number
}

interface PartLike {
  type?: string
  tool?: string
  state?: { status?: string; input?: any; output?: unknown; metadata?: any; title?: string }
}

const SHELL_TOOLS = new Set(["bash", "shell"])

/** The uuid, shortened — what a shell-found note is called until something names it. */
export function fallbackTitle(url: string): string {
  return `Atlas note ${url.slice(url.lastIndexOf("/") + 1, url.lastIndexOf("/") + 9)}`
}

/** Every note in the session, newest first. `parts` is the session's parts in message order. */
export function atlasNotes(parts: PartLike[]): AtlasNote[] {
  const byUrl = new Map<string, AtlasNote>()
  let order = 0
  for (const p of parts) {
    if (p?.type !== "tool" || !p.state) continue
    order++
    if (p.tool === "atlas_artifact") {
      if (p.state.status !== "completed") continue
      const meta = p.state.metadata ?? {}
      const url = atlasNoteUrl(meta.url ?? p.state.input?.url)
      if (!url) continue
      byUrl.set(url, {
        url,
        title: String(meta.title ?? p.state.input?.title ?? fallbackTitle(url)).slice(0, 200),
        summary: typeof meta.summary === "string" ? meta.summary : undefined,
        source: "tool",
        order,
      })
      continue
    }
    if (p.tool && SHELL_TOOLS.has(p.tool) && p.state.status === "completed") {
      const text = typeof p.state.output === "string" ? p.state.output : String(p.state.metadata?.output ?? "")
      for (const url of atlasNotesIn(text)) {
        const prev = byUrl.get(url)
        // A shell mention never demotes a named row; it only makes it newer.
        if (prev) byUrl.set(url, { ...prev, order })
        else byUrl.set(url, { url, title: fallbackTitle(url), source: "shell", order })
      }
    }
  }
  return [...byUrl.values()].sort((a, b) => b.order - a.order)
}
