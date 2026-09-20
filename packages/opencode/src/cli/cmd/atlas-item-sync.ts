/**
 * ATLAS ITEMS, ROUND TRIP — the half of the spine that was missing.
 *
 * Pages, agents, leads and workflows all have `pull` / `diff` / `push`. Atlas items had push only:
 * `atlas:item publish` sends a file up and `bloqs get-item` prints one, but nothing brought an item
 * DOWN as a file you can edit, diff and send back. So the item you had already written in the UI
 * could not be worked on locally without copying it out of a terminal by hand.
 *
 * This is the pure half: what a pulled file looks like, whether it is safe to overwrite, and what
 * differs between the copy on disk and the copy on the server.
 *
 * THE FRONTMATTER IS A CONTRACT, not decoration. `publish` already keys its update on
 * `iris_item_id` and refuses to overwrite UI edits by comparing the server's `updated_at` against
 * `atlas_published_at` (#154763). A pulled file therefore writes exactly those keys, so the file
 * this module produces is one `publish` already knows how to push — rather than a second, parallel
 * format that drifts from it.
 */

import { createHash } from "node:crypto"
import matter from "gray-matter"

export interface RemoteItem {
  id: number | string
  title?: string | null
  content?: string | null
  status?: string | null
  updated_at?: string | null
  public_url?: string | null
  list_name?: string | null
  bloq_list_id?: number | null
}

export interface LocalFile {
  fm: Record<string, any>
  body: string
}

export const contentSha = (s: string): string => createHash("sha256").update(String(s ?? "")).digest("hex").slice(0, 16)

/** Trailing whitespace and line endings are not edits. Compare what a person would call the text. */
export const normalizeBody = (s: string | null | undefined): string =>
  String(s ?? "").replace(/\r\n/g, "\n").replace(/[ \t]+$/gm, "").trim()

/**
 * The file a pull writes.
 *
 * `atlas_published_at` carries the server's `updated_at` AT THE MOMENT OF THE PULL, because that is
 * the marker push compares against. Pull it, edit it, push it — and if someone changed the item in
 * the UI in between, push refuses instead of silently overwriting them.
 *
 * `atlas_content_sha` is this module's own addition: it is what the body hashed to when it landed,
 * which is the only way a later pull can tell "unchanged since I pulled it" from "I have edits here
 * that are not on the server yet".
 */
export function renderItemFile(item: RemoteItem): string {
  const body = String(item.content ?? "")
  const data: Record<string, any> = {
    title: item.title ?? "",
    iris_item_id: Number(item.id),
    atlas_published_at: item.updated_at ?? null,
    atlas_content_sha: contentSha(normalizeBody(body)),
  }
  if (item.status) data.status = item.status
  if (item.public_url) data.iris_public_url = item.public_url
  if (item.list_name) data.atlas_list = item.list_name
  return matter.stringify(body.endsWith("\n") ? body : body + "\n", data)
}

export function parseItemFile(text: string): LocalFile {
  const parsed = matter(String(text ?? ""))
  return { fm: (parsed.data as Record<string, any>) || {}, body: parsed.content ?? "" }
}

export type PullAction = "write" | "identical" | "refuse-local-edits" | "refuse-no-item"

/**
 * May this pull overwrite what is on disk?
 *
 * A pull that clobbers unpushed local edits is the failure everyone hits once and never forgets, so
 * the default is to refuse and say what would be lost. `identical` exists so a re-pull is quiet
 * rather than pretending to have done work.
 */
export function pullDecision(args: {
  local: LocalFile | null
  remote: RemoteItem | null
  force?: boolean
}): { action: PullAction; reason: string } {
  if (!args.remote || args.remote.id === undefined || args.remote.id === null)
    return { action: "refuse-no-item", reason: "no such item" }

  if (!args.local) return { action: "write", reason: "new file" }

  const localBody = normalizeBody(args.local.body)
  const remoteBody = normalizeBody(args.remote.content)
  const sameTitle = String(args.local.fm?.title ?? "") === String(args.remote.title ?? "")
  if (localBody === remoteBody && sameTitle) return { action: "identical", reason: "already up to date" }

  // Edits on disk that were never pushed: the body no longer hashes to what the last pull recorded.
  const pulledSha = args.local.fm?.atlas_content_sha ? String(args.local.fm.atlas_content_sha) : null
  const hasLocalEdits = pulledSha !== null && contentSha(localBody) !== pulledSha
  if (hasLocalEdits && !args.force)
    return {
      action: "refuse-local-edits",
      reason: "this file has edits that are not on the server — push them first, or re-run with --force to discard them",
    }

  // No marker at all: a hand-written file we did not produce. Treated the same as local edits,
  // because "I cannot tell whether this is yours" must not resolve to "overwrite it".
  if (pulledSha === null && !args.force)
    return {
      action: "refuse-local-edits",
      reason: "this file was not produced by a pull (no atlas_content_sha), so its contents cannot be checked — re-run with --force to overwrite",
    }

  return { action: "write", reason: hasLocalEdits ? "overwriting local edits (--force)" : "server has newer content" }
}

export interface ItemDiff {
  changed: string[]
  /** true when the SERVER moved since this file was pulled — the thing push refuses on. */
  serverMovedSincePull: boolean
  lines: string[]
}

/** What differs, in the direction a person reads it: local → server. */
export function diffItem(local: LocalFile, remote: RemoteItem): ItemDiff {
  const changed: string[] = []
  const lines: string[] = []

  const lTitle = String(local.fm?.title ?? "")
  const rTitle = String(remote.title ?? "")
  if (lTitle !== rTitle) {
    changed.push("title")
    lines.push(`- title: ${rTitle}`, `+ title: ${lTitle}`)
  }

  const lStatus = local.fm?.status !== undefined ? String(local.fm.status) : null
  const rStatus = remote.status !== undefined && remote.status !== null ? String(remote.status) : null
  if (lStatus !== null && rStatus !== null && lStatus !== rStatus) {
    changed.push("status")
    lines.push(`- status: ${rStatus}`, `+ status: ${lStatus}`)
  }

  const l = normalizeBody(local.body).split("\n")
  const r = normalizeBody(remote.content).split("\n")
  if (l.join("\n") !== r.join("\n")) {
    changed.push("content")
    const max = Math.max(l.length, r.length)
    let shown = 0
    for (let i = 0; i < max && shown < 40; i++) {
      if ((l[i] ?? "") === (r[i] ?? "")) continue
      if (r[i] !== undefined) lines.push(`- ${r[i]}`)
      if (l[i] !== undefined) lines.push(`+ ${l[i]}`)
      shown++
    }
    if (shown >= 40) lines.push(`… more`)
  }

  const marker = local.fm?.atlas_published_at ? Date.parse(String(local.fm.atlas_published_at)) : NaN
  const server = remote.updated_at ? Date.parse(String(remote.updated_at)) : NaN
  const serverMovedSincePull = Number.isFinite(marker) && Number.isFinite(server) && server > marker

  return { changed, serverMovedSincePull, lines }
}

/**
 * After a push, did the server actually take it?
 *
 * A 2xx is not the answer — the read-back is. This is the same lesson as the release that was
 * "deployed" because the tag existed: confirm the thing you asked for is the thing that is there.
 */
export function verifyPush(sent: { title?: string | null; body: string }, readBack: RemoteItem): { ok: boolean; reason: string } {
  if (!readBack) return { ok: false, reason: "could not read the item back" }
  if (normalizeBody(readBack.content) !== normalizeBody(sent.body))
    return { ok: false, reason: "the content on the server does not match what was pushed" }
  if (sent.title !== undefined && sent.title !== null && String(readBack.title ?? "") !== String(sent.title))
    return { ok: false, reason: "the title on the server does not match what was pushed" }
  return { ok: true, reason: "server content matches the file" }
}

/**
 * Would pushing this file overwrite someone else's change?
 *
 * MEASURED 2026-09-20: this decision lived inline in the publish path and was guarded by
 * `fm.atlas_published_at && guardBloqId && !force` — so a file WITHOUT `iris_bloq_id` skipped the
 * check entirely and did a blind last-write-wins PUT. A pulled file has no bloq id (the item
 * endpoint does not return one), so the protection added in #154763 was silently absent exactly
 * where a round-trip workflow needs it. The bloq id was never part of the question; it was only
 * needed by the old way of reading the item back.
 *
 * Returns null when the push may proceed, including the honest "cannot tell" cases: no marker on
 * the file, or a timestamp neither side can parse. Those are unknown, not safe — but refusing on
 * unknown would block every legacy file, so they proceed and say nothing.
 */
export function divergenceRefusal(args: {
  itemId: number | string
  markerIso: string | null | undefined
  serverIso: string | null | undefined
  force?: boolean
}): string | null {
  if (args.force) return null
  if (!args.markerIso) return null
  const marker = Date.parse(String(args.markerIso))
  const server = args.serverIso ? Date.parse(String(args.serverIso)) : NaN
  if (!Number.isFinite(marker) || !Number.isFinite(server)) return null
  if (server <= marker) return null
  return `Item #${args.itemId} was modified after your last publish (server ${args.serverIso} > published ${args.markerIso}). Re-run with --force to overwrite those edits.`
}

/** A stable filename for a pulled item: readable, and keyed on the id so two items never collide. */
export function itemFilename(item: RemoteItem): string {
  const slug = String(item.title ?? "item")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
  return `${slug || "item"}-${item.id}.md`
}
