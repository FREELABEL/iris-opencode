/**
 * GLD-01 — local file provenance for `iris pages pull` / `iris pages push`.
 *
 * WHY THIS EXISTS
 *
 * `pages pull` wrote twelve keys and not one of them was a version, a hash or a timestamp,
 * and `pages push` sent an unconditional full-document PUT. So a stale local file silently
 * reverted a page and reported success — #183600, which on 2026-09-03 took a client
 * dashboard back through three newer versions. Every step told the truth about itself.
 *
 * `bloqs publish` refused to do exactly this, correctly, on the same account the same
 * evening, using a frontmatter marker. Same ingredients, opposite behaviour.
 *
 * THE DELIBERATE DEPARTURE FROM `bloqs publish`
 *
 * That guard compares TIMESTAMPS, client-side. This one compares the integer `version`, and
 * the authoritative comparison happens SERVER-side, atomic with the write. #181984 records
 * why: a stale-file guard whose two inputs share a failure mode is not a check. The previous
 * attempt compared a local value against `getBySlug()` — the same endpoint the pull had just
 * read — so when that read was wrong, both sides agreed and the guard went blind precisely
 * when it was needed. `page.current_version` is incremented by the transaction that writes,
 * so it cannot agree with a stale read.
 *
 * Pure and dependency-free so it is testable without the network — see page-base.test.ts.
 */

export type PageBase = {
  /** The page version this file was pulled from. The ONLY thing that is checked. */
  version: number
  /** The server's `json_hash`, stored verbatim. Diagnostic only — never recomputed here. */
  hash: string | null
  pulled_at: string
}

/** The wire contract's 409 body (CONTRACT §2). Every key is present; some may be null. */
export type VersionConflictBody = {
  error_code?: string
  expected_version?: number | null
  current_version?: number | null
  changed_by?: number | string | null
  changed_at?: string | null
  changed_components?: string[] | null
  /**
   * Whether the server could load the `expected_version` snapshot to diff against.
   *
   * Added by contract amendment 2026-09-04 because `changed_components: []` could not tell
   * "the change was page-level only" from "I could not compute the diff". Versions written
   * before database snapshotting carry a `db://` gcs_path with null json_content, and pruned
   * versions are gone. A value that cannot distinguish ABSENT from EQUAL is the exact defect
   * this epic exists to fix, so it gets its own flag.
   *
   * A boolean rather than `changed_components: null` on purpose: `if (!arr.length)` swallows
   * null and empty identically in JS, so the distinction would die at the first consumer.
   */
  base_available?: boolean | null
  message?: string | null
}

function isInteger(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && Number.isInteger(v)
}

/**
 * Build the `_base` marker `pull` stamps on `./pages/<slug>.json`, from the page the server
 * just returned.
 *
 * Returns null when the server exposes no `current_version` — which is the case until the
 * server half of the contract ships. No marker is strictly better than a marker we cannot
 * trust: `push` then sends no `expected_version` and behaves exactly as it does today.
 *
 * Reads `current_version` ONLY. It does not fall back to `page.version`, and it must never
 * reach into `json_content.version` — that is the Genesis SCHEMA version (`2`, `"1.0"`) and
 * is present on every page, so a fallback there would stamp a confident, wrong marker on
 * every single pull.
 */
export function baseFromPage(page: any, now: string = new Date().toISOString()): PageBase | null {
  const version = page?.current_version
  // `min:1` — the server validates `expected_version` that way, so a 0 comes back 422
  // (validation) rather than 409 (conflict). A data-loss guard that surfaces as "the
  // expected_version field is invalid" is a guard nobody can act on: the message names a
  // field, not a concurrent edit. There is also nothing to guard at v0 — no version row
  // exists to have been superseded.
  if (!isInteger(version) || version < 1) return null
  // Verbatim. The server hashes `json_encode($data, JSON_PRETTY_PRINT)` in PHP; reproducing
  // that byte-for-byte in JavaScript (`/` escaping, unicode escapes, float formatting) is a
  // bug farm, and a hash that disagrees for formatting reasons is worse than no hash.
  const hash = typeof page?.json_hash === "string" && page.json_hash ? page.json_hash : null
  return { version, hash, pulled_at: now }
}

/**
 * Read the `_base` marker off a local page file.
 *
 * TOP LEVEL ONLY. A `_base` inside `json_content` is deliberately ignored: `json_content`
 * renders, provenance is not content, and honouring one there would legitimise writing one
 * there.
 *
 * Returns null for a missing or malformed marker — a hand-written file or a first push. That
 * is the same call `bloqs publish` makes on a missing frontmatter marker: absence of a marker
 * is not evidence of safety, but refusing every new file is worse.
 */
export function readBase(local: any): PageBase | null {
  const raw = local?._base
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null
  let version = (raw as any).version
  // A hand-edited file may carry "89". Coercing an integral numeric string is safe; anything
  // else is not, and a wrong expected_version fails LOUDLY (409) rather than silently, so the
  // conservative reading here is to refuse.
  if (typeof version === "string" && /^\d+$/.test(version.trim())) version = Number(version.trim())
  if (!isInteger(version) || version < 0) return null
  const hash = typeof (raw as any).hash === "string" ? (raw as any).hash : null
  const pulledAt = typeof (raw as any).pulled_at === "string" ? (raw as any).pulled_at : ""
  return { version, hash, pulled_at: pulledAt }
}

/**
 * The document minus its `_base`, for sending. The server ignoring an unknown key is not a
 * licence to send it. Shallow clone — never mutates the caller's document.
 */
export function stripBase<T extends Record<string, any>>(doc: T): T {
  if (!doc || typeof doc !== "object") return doc
  const { _base, ...rest } = doc as any
  return rest as T
}

/**
 * `{ expected_version: n }` when the file carries a base, `{}` when it does not. Spread into
 * the PUT body.
 */
export function expectedVersionField(local: any): { expected_version?: number; expected_hash?: string } {
  const base = readBase(local)
  // Never send a falsy version: the server validates `min:1`, so 0 is a 422 rather than the
  // 409 the caller needs to see. Belt and braces alongside baseFromPage's own floor, because
  // this file can be hand-edited.
  if (!base || base.version < 1) return {}
  const field: { expected_version: number; expected_hash?: string } = { expected_version: base.version }
  // The hash rides along because THE VERSION NUMBER CANNOT SEE AN UNVERSIONED WRITE.
  // `Page::saveJsonToGcs` writes json_content, updates json_hash and rotates cache_key without
  // ever incrementing current_version — six artisan seed commands call it directly, and
  // `rollback` calls it too. So the live document can move while the version stands still, and
  // expected_version matches happily against content that is no longer what was pulled.
  //
  // It is the server's OWN json_hash, stored verbatim at pull time and never recomputed here:
  // the server hashes json_encode($data, JSON_PRETTY_PRINT) in PHP, and reproducing that
  // byte-for-byte in JavaScript (slash escaping, unicode, float formatting) is a bug farm that
  // would fail intermittently and look exactly like a real conflict.
  //
  // Only a real string travels. A page that has never been saved has json_hash = null, and
  // sending `expected_hash: null` would ask the server to compare against nothing — which is
  // the failure this whole epic is about, a check that cannot tell absent from equal.
  if (typeof base.hash === "string" && base.hash !== "") field.expected_hash = base.hash
  return field
}

/**
 * Turn a push response into a decision.
 *
 * The STATUS is the check, not the body: a 409 with an unparseable body still refuses. A
 * guard that needs a well-formed body to fire stops firing exactly when the server is having
 * the kind of day that makes conflicts likely.
 *
 * `exitCode` is 1, never 0. #181601: the shadow-copy guard correctly refused to clobber
 * /p/docs and then exited 0, so a script read the refusal as a successful push. A refusal
 * that exits 0 is the same defect the guard exists to stop.
 */
export function handleVersionConflictResponse(
  slug: string,
  status: number,
  body: VersionConflictBody | null | undefined,
): { conflicted: boolean; lines: string[]; exitCode: number } {
  if (status !== 409) return { conflicted: false, lines: [], exitCode: 0 }

  const expected = body?.expected_version
  const current = body?.current_version
  const who = body?.changed_by === null || body?.changed_by === undefined ? "unknown" : String(body.changed_by)
  const when = typeof body?.changed_at === "string" && body.changed_at ? body.changed_at : "unknown"
  const moved = Array.isArray(body?.changed_components) ? body!.changed_components! : []

  // A CONTENT conflict is the version standing still while the document moved — an
  // unversioned write (a seed command, a rollback). Printing "you pulled v7 / live now v7"
  // there reads as a bug in the tool rather than a finding about the page, and a refusal
  // nobody believes is a refusal nobody acts on.
  const contentOnly = body?.error_code === "content_conflict"

  const lines: string[] = []
  if (contentOnly) {
    lines.push(`Refusing to push — "${slug}" content changed since you pulled it, without a new version.`)
    lines.push(`  you pulled:  v${expected ?? "?"}`)
    lines.push(`  live now:    still v${current ?? "?"}, but the document underneath is different`)
    lines.push(`               (last recorded change by ${who} at ${when})`)
    lines.push(`               Something wrote the page without creating a version — a seed`)
    lines.push(`               command or a rollback does this.`)
  } else {
    lines.push(`Refusing to push — "${slug}" changed since you pulled it.`)
    lines.push(`  you pulled:  v${expected ?? "?"}`)
    lines.push(`  live now:    v${current ?? "?"}   (changed by ${who} at ${when})`)
  }
  if (moved.length > 0) {
    const shown = moved.slice(0, 8).join(", ")
    const more = moved.length > 8 ? ` … +${moved.length - 8} more` : ""
    lines.push(`  changed:     ${shown}${more}   (${moved.length} component${moved.length === 1 ? "" : "s"})`)
  } else if (body?.base_available === true) {
    // An empty list is a FINDING only when the server confirms it could load the base
    // snapshot to diff against.
    lines.push(`  changed:     page-level only (title / layout / siteNavigation) — no components moved`)
  } else {
    // base_available false, or absent (an older server, or a body we could not parse).
    // Reporting "page-level only" here would state as a finding something that was never
    // measured — the same shape of error as an empty log window read as a healthy one.
    lines.push(`  changed:     could not determine which components changed`)
    lines.push(`               (the v${expected ?? "?"} snapshot was not available to diff against)`)
  }
  lines.push("")
  lines.push(`  Merge the two:            iris pages merge ${slug}`)
  lines.push(`  Then push the result:     iris pages push ${slug}`)
  lines.push(`  Overwrite live anyway:    iris pages push ${slug} --force-version`)

  return { conflicted: true, lines, exitCode: 1 }
}

/**
 * The PUT body a CONTENT push is allowed to carry. #183667.
 *
 * An ALLOW-LIST, deliberately. `push` used to build this inline as a series of
 * `if (local.x) updateData.x = ...` lines, which is a deny-list by construction: every field
 * anyone thought to add got sent, and the only fields not sent were the ones someone had
 * already been burned by. This bug arrived as a field nobody had thought to ban.
 *
 * OWNERSHIP IS NOT CONTENT. `pull` writes owner_type/owner_id so the file is a complete
 * picture, `push` re-sent them, and fl-api's PageController::update refuses on their mere
 * PRESENCE unless the caller is in `config('genesis.trusted_user_ids', [193])`. 193 is the
 * operator account, so the one account that could not reproduce it is the one every internal
 * session runs as; measured as user 1, a pull followed by a push with NO edits returned 403.
 * It also shut the conflict-recovery path, because `pages merge` legitimately restores those
 * fields from live and the merged push was then refused too.
 *
 * ACCESS CONTROL IS NOT CONTENT EITHER — `requires_auth` and `status` stay off this list for
 * the reasons in #181984 and the publish-cycle note in `push`. Ownership changes go through
 * `pages reassign`, gates through `pages set` / `pages ungate`, publication through
 * `pages publish` / `unpublish`. Each is explicit about what it is doing; a content push is not.
 *
 * Adding a key here should require the same question every time: if this field decides who may
 * read, who may write, or whether the page is live, it does not belong in a content push.
 */
export function contentUpdatePayload(local: any, jsonContent: any): Record<string, unknown> {
  const payload: Record<string, unknown> = { json_content: stripBase(jsonContent) }
  if (local?.title) payload.title = local.title
  if (local?.seo_title) payload.seo_title = local.seo_title
  if (local?.seo_description) payload.seo_description = local.seo_description
  if (local?.og_image) payload.og_image = local.og_image
  // Safe to re-assert: visibility is orthogonal to the publish cycle and to authorization, and
  // re-sending the value we pulled can only preserve it. Dropping it is what let pages drift
  // silently to `unlisted`, which 404s on /p/{slug} and reads as deleted (#178609).
  if (local?.visibility) payload.visibility = local.visibility
  return payload
}

export type OwnershipDrift = {
  localType: string | null
  localId: number | string | null
  liveType: string | null
  liveId: number | string | null
}

/** Numeric-string tolerant, so a round-tripped `"1"` is not reported as a divergence. */
function sameOwnerId(a: any, b: any): boolean {
  const n = (v: any) =>
    typeof v === "string" && /^\d+$/.test(v.trim()) ? Number(v.trim()) : (v ?? null)
  return n(a) === n(b)
}

/**
 * Ownership divergence between the local file and the live page, or null when there is none.
 *
 * Reported, never synced — in either direction. The file is informational for these fields,
 * exactly as it is for `requires_auth`, and a reader who believes otherwise is the person the
 * warning is for. Tolerant of a numeric string because a warning that cries wolf on every push
 * gets tuned out, and that costs the instrument rather than the one incident.
 */
export function ownershipDrift(local: any, page: any): OwnershipDrift | null {
  if (local?.owner_type === undefined && local?.owner_id === undefined) return null
  const localType = local?.owner_type ?? null
  const liveType = page?.owner_type ?? null
  const localId = local?.owner_id ?? null
  const liveId = page?.owner_id ?? null
  if (localType === liveType && sameOwnerId(localId, liveId)) return null
  return { localType, localId, liveType, liveId }
}
