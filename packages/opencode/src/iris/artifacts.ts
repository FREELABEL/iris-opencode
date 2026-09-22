import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "fs"
import { homedir } from "os"
import path from "path"

/**
 * THE ARTIFACT STORE (epic #186508, components 1 + 4).
 *
 * What the agent made — a page, a brief, a table — kept as files so the desktop's Artifacts tab
 * can show it without the user asking. On disk and not in the engine's database, deliberately
 * (ADR-02): the database is upstream's schema and we rebase on it; files survive that, are
 * readable by the CLI, and can be committed.
 *
 *   <root>/<session>/<id>/meta.json     { id, title, kind, revision, created, updated, filename }
 *   <root>/<session>/<id>/<filename>    the content
 *
 * <root> is `<project>/.iris/artifacts` when the session has a project, else
 * `~/.iris/artifacts` — the desktop's /iris routes run outside any instance, so the caller says
 * which (see memory: desktop-iris-routes-have-no-instance).
 *
 * THERE IS NO MANIFEST FILE. The list is derived from the meta.json files on every read. A
 * manifest would be a second record of the same facts, and two records of one fact drift: an
 * artifact written by a crashed process would be on disk and missing from the list, or listed
 * and gone.
 *
 * THIS MODULE NEVER SERVES HTML. It returns content as a string for the trusted panel to place
 * into a sandboxed `srcdoc` iframe (ADR-01). Nothing here, or in the routes over it, may become
 * a navigable document at an /iris URL: an iframe pointed at one is same-origin with the app,
 * and the sandbox would be decoration.
 */
export namespace Artifacts {
  export type Kind = "html" | "markdown" | "csv" | "code"
  export type Root = "project" | "user"

  export interface Meta {
    id: string
    title: string
    kind: Kind
    revision: number
    created: string
    updated: string
    filename: string
    language?: string
  }

  export const KINDS: readonly Kind[] = ["html", "markdown", "csv", "code"]

  /** Content larger than this is returned truncated, and says so. A preview, not a file server. */
  export const MAX_CONTENT_BYTES = 2 * 1024 * 1024
  /** Newest first, capped: a session that wrote 5,000 files does not get a 5,000-row pane. */
  export const MAX_LIST = 200

  const SEGMENT = /^[A-Za-z0-9_-]{1,80}$/
  const EXT: Record<Kind, string> = { html: "html", markdown: "md", csv: "csv", code: "txt" }

  /** A session or artifact id is one path SEGMENT: no dots, no slashes, nothing to climb with. */
  export function validSegment(s: unknown): s is string {
    return typeof s === "string" && SEGMENT.test(s)
  }

  export function rootFor(project: string | undefined, home = homedir()): { dir: string; root: Root } {
    return project
      ? { dir: path.join(project, ".iris", "artifacts"), root: "project" }
      : { dir: path.join(home, ".iris", "artifacts"), root: "user" }
  }

  function readMeta(dir: string): Meta | undefined {
    try {
      const m = JSON.parse(readFileSync(path.join(dir, "meta.json"), "utf8"))
      if (!validSegment(m?.id) || !KINDS.includes(m?.kind) || typeof m?.filename !== "string") return undefined
      // The filename is data from disk: it must name a file INSIDE this artifact's folder.
      if (path.basename(m.filename) !== m.filename || m.filename.startsWith(".")) return undefined
      return {
        id: m.id,
        title: String(m.title ?? m.id).slice(0, 200),
        kind: m.kind,
        revision: Number.isFinite(m.revision) ? m.revision : 1,
        created: String(m.created ?? ""),
        updated: String(m.updated ?? ""),
        filename: m.filename,
        ...(typeof m.language === "string" ? { language: m.language.slice(0, 40) } : {}),
      }
    } catch {
      return undefined
    }
  }

  /** Every artifact in one session, newest first. A session with none is `[]`, not an error. */
  export function list(rootDir: string, session: string): Meta[] {
    if (!validSegment(session)) return []
    const dir = path.join(rootDir, session)
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      return []
    }
    const out: Meta[] = []
    for (const name of names) {
      if (!validSegment(name)) continue
      const m = readMeta(path.join(dir, name))
      if (m && m.id === name) out.push(m)
    }
    return out.sort((a, b) => (a.updated < b.updated ? 1 : a.updated > b.updated ? -1 : 0)).slice(0, MAX_LIST)
  }

  /** One artifact with its content, or undefined. `truncated` says the preview is partial. */
  export function read(
    rootDir: string,
    session: string,
    id: string,
  ): { meta: Meta; content: string; truncated: boolean } | undefined {
    if (!validSegment(session) || !validSegment(id)) return undefined
    const dir = path.join(rootDir, session, id)
    const meta = readMeta(dir)
    if (!meta || meta.id !== id) return undefined
    try {
      const file = path.join(dir, meta.filename)
      const size = statSync(file).size
      const buf = readFileSync(file)
      const truncated = size > MAX_CONTENT_BYTES
      return { meta, content: (truncated ? buf.subarray(0, MAX_CONTENT_BYTES) : buf).toString("utf8"), truncated }
    } catch {
      return undefined
    }
  }

  function newId(): string {
    return "a" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
  }

  function writeAtomic(file: string, data: string) {
    const tmp = file + ".tmp-" + process.pid
    writeFileSync(tmp, data)
    renameSync(tmp, file)
  }

  /**
   * Create an artifact, or — given an existing id — write a new revision of it. Content first,
   * then meta, each atomically, so a reader never sees a revision whose content is not there.
   * This is what the artifact tool and PROMOTE will call; nothing else writes the store.
   */
  export function write(
    rootDir: string,
    input: { session: string; id?: string; title: string; kind: Kind; content: string; language?: string },
    now = new Date(),
  ): Meta {
    if (!validSegment(input.session)) throw new Error(`invalid session id: ${String(input.session).slice(0, 40)}`)
    if (input.id !== undefined && !validSegment(input.id)) throw new Error(`invalid artifact id: ${String(input.id).slice(0, 40)}`)
    if (!KINDS.includes(input.kind)) throw new Error(`unknown artifact kind: ${input.kind}`)
    const id = input.id ?? newId()
    const dir = path.join(rootDir, input.session, id)
    const prev = existsSync(dir) ? readMeta(dir) : undefined
    mkdirSync(dir, { recursive: true })
    const filename = prev && prev.kind === input.kind ? prev.filename : `content.${EXT[input.kind]}`
    const stamp = now.toISOString()
    const meta: Meta = {
      id,
      title: input.title.slice(0, 200) || id,
      kind: input.kind,
      revision: (prev?.revision ?? 0) + 1,
      created: prev?.created ?? stamp,
      updated: stamp,
      filename,
      ...(input.language ? { language: input.language.slice(0, 40) } : {}),
    }
    writeAtomic(path.join(dir, filename), input.content)
    writeAtomic(path.join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n")
    return meta
  }
}
