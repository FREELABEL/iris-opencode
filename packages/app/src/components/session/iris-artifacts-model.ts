/**
 * The pure half of Agents › Artifacts (epics #186508 / #186510): the sandbox, the author line,
 * and the CSV reader. Kept out of the component so the security-critical parts are tested
 * without a DOM.
 */

export type ArtifactAuthor = { agent: string; session?: string }
export type ArtifactMeta = {
  id: string
  title: string
  kind: "html" | "markdown" | "csv" | "code"
  revision: number
  created: string
  updated: string
  filename: string
  language?: string
  author?: ArtifactAuthor
  createdBy?: ArtifactAuthor
  published?: ArtifactPublished
}

export type Visibility = "public" | "unlisted" | "private"
export type ArtifactPublished = {
  pageId: number
  slug: string
  url: string
  visibility: Visibility
  requiresAuth: boolean
  revision: number
  at: string
}

/** The Publish button's words, and whether the page lags the artifact. */
export function publishState(m: Pick<ArtifactMeta, "revision" | "published">): { label: string; behind: boolean } {
  if (!m.published) return { label: "Publish…", behind: false }
  const behind = m.published.revision < m.revision
  return { label: behind ? "Update page…" : "Publish settings…", behind }
}

/** Mirrors the engine's slugify (artifact-publish.ts) so the suggested address is the one it accepts. */
export function slugify(title: string): string {
  return (
    title
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "artifact"
  )
}

/**
 * ADR-01 (#186508): the iframe's sandbox. `allow-scripts` and NOTHING else.
 *
 * The desktop's Tauri CSP is null, so this attribute is the whole boundary between an artifact
 * the model wrote (possibly from a web page) and the app, whose sidecar holds the user's IRIS
 * token. `allow-same-origin` would let the artifact read the parent document and call /iris/*
 * as the user. It renders perfectly and nothing looks wrong — which is why it is a constant with
 * a test, and not a string in JSX someone "just" edits when localStorage does not work.
 */
export const ARTIFACT_SANDBOX = "allow-scripts"

/**
 * The second lock, inside the document: even if the sandbox were loosened, the page may not
 * open connections (connect-src 'none'), submit forms, or load a frame. Inline script and style
 * run, because that is what a generated page is made of.
 */
export const ARTIFACT_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob: https:; " +
  "font-src data: https:; media-src data: blob: https:; connect-src 'none'; form-action 'none'; frame-src 'none'; base-uri 'none'"

/** The srcdoc for an html artifact: the CSP meta goes FIRST, before anything the page says. */
export function sandboxedDocument(html: string): string {
  const meta = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}">`
  const head = html.match(/<head(\s[^>]*)?>/i)
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length
    return html.slice(0, at) + meta + html.slice(at)
  }
  return `<!doctype html><html><head>${meta}</head><body>${html}</body></html>`
}

/** A rendered markdown body as a readable standalone page, for the sandboxed frame. */
export function markdownDocument(bodyHtml: string): string {
  return (
    `<!doctype html><html><head><style>` +
    `body{font:14px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;margin:16px;color:#1d1d1f}` +
    `pre,code{font-family:ui-monospace,Menlo,monospace;font-size:12px}pre{overflow:auto;background:#f5f5f7;padding:8px;border-radius:6px}` +
    `table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:2px 6px}img{max-width:100%}` +
    `</style></head><body>${bodyHtml}</body></html>`
  )
}

/** "rev 3 · researcher" — the pane's answer to "which agent made this". */
export function authorLine(m: Pick<ArtifactMeta, "revision" | "author" | "createdBy">): string {
  const who = m.author?.agent ?? "unknown"
  const started = m.createdBy && m.createdBy.agent !== m.author?.agent ? ` (started by ${m.createdBy.agent})` : ""
  return `rev ${m.revision} · ${who}${started}`
}

/** Minimal RFC-4180 reader: quoted fields, doubled quotes, commas and newlines inside quotes. */
export function parseCsv(text: string, maxRows = 500): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ""
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"'
        i++
      } else if (c === '"') quoted = false
      else field += c
      continue
    }
    if (c === '"') quoted = true
    else if (c === ",") {
      row.push(field)
      field = ""
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++
      row.push(field)
      rows.push(row)
      row = []
      field = ""
      if (rows.length >= maxRows) return rows
    } else field += c
  }
  if (field !== "" || row.length) {
    row.push(field)
    rows.push(row)
  }
  return rows
}

/**
 * Which rows changed since the pane last looked — by id AND revision, so an edit by another
 * agent is marked, not only a new artifact.
 */
export function changedSince(prev: ArtifactMeta[] | undefined, next: ArtifactMeta[]): Set<string> {
  if (!prev) return new Set()
  const before = new Map(prev.map((m) => [m.id, m.revision]))
  return new Set(next.filter((m) => before.get(m.id) !== m.revision).map((m) => m.id))
}
