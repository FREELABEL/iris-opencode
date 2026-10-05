import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, requireUserId, handleApiError, writeJson, dim, success, FL_API } from "./iris-api"
import { firstArray } from "../../util/array"
import { existsSync, readFileSync } from "fs"
import { basename } from "path"

// ============================================================================
// Review Studio ↔ Remotion: time-coded notes (#187928) + replace-in-place (#187929)
//
// The loop: reviewer leaves "logo too small" at 0:42 → `iris remotion notes <item>
// --revision` hands a Remotion agent timestamped instructions → it re-renders →
// `iris remotion replace <item> out.mp4` swaps the file under the SAME URL, so every
// published Genesis embed plays the new cut.
// ============================================================================

export interface ReviewNote {
  id: number
  body: string
  t: number | null
  resolved: boolean
  version_number?: number | null
  author_name?: string | null
  created_at?: string
}

/** 42 → "0:42", 3725.5 → "1:02:05". */
export function formatTimecode(t: number): string {
  const s = Math.max(0, Math.floor(t))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = String(s % 60).padStart(2, "0")
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`
}

/** "42", "42.5", "0:42", "1:02:05" → seconds; null if unparseable. */
export function parseTimecode(raw: string | number | undefined | null): number | null {
  if (raw === undefined || raw === null || raw === "") return null
  if (typeof raw === "number") return Number.isFinite(raw) && raw >= 0 ? raw : null
  const parts = String(raw).trim().split(":")
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  return parts.reduce((acc, p) => acc * 60 + Number(p), 0)
}

/** Timed notes in playback order, then untimed ones. */
export function sortNotes(notes: ReviewNote[]): ReviewNote[] {
  return [...notes].sort((a, b) => {
    if (a.t == null && b.t == null) return 0
    if (a.t == null) return 1
    if (b.t == null) return -1
    return a.t - b.t
  })
}

/** Revision instructions a render agent can act on line by line. */
export function formatRevisionNotes(notes: ReviewNote[]): string {
  const open = sortNotes(notes.filter((n) => !n.resolved))
  if (open.length === 0) return "No open revision notes."
  return [
    "Revision notes (seconds into the video in brackets; apply each at that point):",
    ...open.map((n) => `- [${n.t == null ? "whole video" : `${formatTimecode(n.t)} = ${n.t}s`}] ${n.body.trim()}`),
  ].join("\n")
}

function normalizeNote(n: any): ReviewNote {
  return {
    id: Number(n.id),
    body: String(n.body ?? ""),
    t: n.t == null ? null : Number(n.t),
    resolved: Boolean(n.resolved),
    version_number: n.version_number ?? null,
    author_name: n.author_name ?? null,
    created_at: n.created_at,
  }
}

const itemBase = (userId: number, itemId: number) => `/api/v1/user/${userId}/bloqs/list/item/${itemId}`

export const NotesCommand = cmd({
  command: "notes <item>",
  describe: "list a Review Studio item's review notes (time-coded on videos) — --json or --revision for agents",
  builder: (y: any) =>
    y
      .positional("item", { type: "number", demandOption: true, describe: "Review Studio item id" })
      .option("json", { type: "boolean", default: false, describe: "JSON array of { id, t, body, resolved, … } in playback order" })
      .option("revision", { type: "boolean", default: false, describe: "open notes as revision instructions for a re-render" })
      .option("user-id", { type: "number" }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return
    const res = await irisFetch(`${itemBase(userId, args.item)}/notes`, {}, FL_API)
    if (!(await handleApiError(res, "List notes"))) return
    const body = (await res.json()) as any
    const notes = sortNotes(firstArray(body?.data?.notes, body?.notes).map(normalizeNote))

    if (args.json) return writeJson(notes)
    if (args.revision) return void console.log(formatRevisionNotes(notes))
    if (notes.length === 0) return void prompts.log.info("No notes on this item.")
    for (const n of notes) {
      const at = n.t == null ? dim("  —  ") : formatTimecode(n.t).padStart(5)
      console.log(`  ${at}  ${n.resolved ? dim(`✓ ${n.body}`) : n.body}  ${dim(`#${n.id}${n.version_number ? ` · v${n.version_number}` : ""}`)}`)
    }
  },
})

export const NoteCommand = cmd({
  command: "note <item> <body>",
  describe: "add a review note to a Review Studio item, optionally at a timecode (--t 42 or --t 0:42)",
  builder: (y: any) =>
    y
      .positional("item", { type: "number", demandOption: true })
      .positional("body", { type: "string", demandOption: true })
      .option("t", { type: "string", describe: "seconds into the video: 42, 42.5, 0:42, 1:02:05" })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return
    const t = parseTimecode(args.t)
    if (args.t !== undefined && t === null) {
      prompts.log.error(`Not a timecode: ${args.t} (try 42 or 0:42)`)
      process.exitCode = 1
      return
    }
    const res = await irisFetch(`${itemBase(userId, args.item)}/notes`, {
      method: "POST",
      body: JSON.stringify({ body: args.body, ...(t === null ? {} : { t }) }),
    }, FL_API)
    if (!(await handleApiError(res, "Add note"))) return
    const note = normalizeNote(((await res.json()) as any)?.data ?? {})
    if (args.json) return writeJson(note)
    prompts.log.success(success(`Note #${note.id}${note.t == null ? "" : ` at ${formatTimecode(note.t)}`}`))
  },
})

export const ReplaceCommand = cmd({
  command: "replace <item> <file>",
  describe: "replace a Review Studio item's media with a re-render — same CDN URL, so published embeds play the new file",
  builder: (y: any) =>
    y
      .positional("item", { type: "number", demandOption: true })
      .positional("file", { type: "string", demandOption: true, describe: "the re-rendered file" })
      .option("target-url", { type: "string", describe: "which slide to replace (carousels); default: the item's media_url" })
      .option("json", { type: "boolean", default: false })
      .option("user-id", { type: "number" }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const userId = await requireUserId(args["user-id"])
    if (!userId) return
    if (!existsSync(args.file)) {
      prompts.log.error(`No such file: ${args.file}`)
      process.exitCode = 1
      return
    }
    const form = new FormData()
    form.append("file", new Blob([new Uint8Array(readFileSync(args.file))]), basename(args.file))
    if (args["target-url"]) form.append("target_url", args["target-url"])
    const res = await irisFetch(`${itemBase(userId, args.item)}/media/replace`, { method: "POST", body: form }, FL_API)
    if (!(await handleApiError(res, "Replace media"))) return
    const data = ((await res.json()) as any)?.data ?? {}
    if (args.json) return writeJson(data)
    prompts.log.success(success(`Replaced → revision ${data.revision}; URL unchanged`))
    console.log(`  ${dim("URL:")}      ${data.url}`)
    if (data.archived_url) console.log(`  ${dim("Previous:")} ${data.archived_url}`)
    // Honest about the cache: without a purge, an edge copy cached BEFORE this replace lives
    // out its original TTL; only later replaces of this key benefit from the 60s header.
    if (!data.purged) console.log(`  ${dim("CDN edge not purged (no Cloudflare zone configured) — old embeds update when the cached copy expires.")}`)
  },
})
