import { createHash } from "crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync, appendFileSync, unlinkSync, readdirSync } from "fs"
import { homedir } from "os"
import { dirname, join } from "path"

// ============================================================================
// THE LOCAL ATLAS STORE — cognition as a deployed artifact.
//
// Epic #184607. `iris atlas use --out ctx.md` already materialises ONE item as
// ONE flat file. That is a read, not a grant: nothing records what a machine is
// supposed to hold, nothing can tell you whether it still holds it, and nothing
// can tell two versions of "the same" item apart.
//
// This module is the difference between reading a document and BEING one.
//
//   store/<sha256>.md   immutable blobs, addressed by content
//   tree/<bloq>/<list>/ a human-readable mirror of the cloud structure
//   manifest.json       the DECLARED set — the grant, written down
//   log.jsonl           every pin/update/rollback, so "what did it know at 14:02?"
//                       has an answer that was recorded rather than reconstructed
//   policy.json         the seal (see isGranted)
//
// IDENTITY (ADR-01). A bare item id names a MUTABLE ROW. Two machines running
// "the same" id can hold different bytes and neither can tell. So every pin is
// addressed by a content hash, and the hash is computed over the canonical body —
// NOT over the rendered markdown, which carries a `source:` line and the pull
// timestamp and would therefore differ on every pull of an unchanged item.
//
// The public API exposes no monotonic version number. `revised` (the server's
// updated_at) is the server's CLAIM about version; `sha256` is ours. Keeping both
// is what lets `atlas update` distinguish "the content changed" from "someone
// re-saved it without changing anything" — a distinction one field cannot make.
// ============================================================================

export type Pin = {
  uuid: string
  title: string
  bloq: string | null
  list: string | null
  /** OUR identity: sha256 over the canonical body. */
  sha256: string
  /** The SERVER's claim about version (updated_at). May move when sha256 does not. */
  revised: string | null
  /** When this machine pulled it. Pin age is measured from here, never from `revised`. */
  pulled_at: string
  /** Path of the rendered file inside the tree, relative to the atlas home. */
  path: string
}

export type Manifest = {
  version: 1
  machine: string
  pins: Record<string, Pin>
}

export type LogEntry = {
  at: string
  op: "pin" | "update" | "rollback" | "unpin"
  uuid: string
  from?: string | null
  to?: string | null
  title?: string
}

export type Policy = {
  /** When true, this machine may only read what it was granted. */
  sealed: boolean
  sealed_at?: string
}

/** `IRIS_ATLAS_HOME` exists so tests never write to a developer's real store. */
export function atlasHome(): string {
  return process.env.IRIS_ATLAS_HOME || join(homedir(), ".iris", "atlas")
}

function ensureDir(p: string) {
  mkdirSync(p, { recursive: true })
}

// ── identity ────────────────────────────────────────────────────────────────

/**
 * The bytes that decide identity. Deliberately EXCLUDES updated_at: a cosmetic
 * re-save must not look like a content change, or every fleet update becomes a
 * rollout of nothing and operators learn to ignore the diff.
 */
export function canonicalize(item: any): string {
  const content = item?.content
  const body =
    typeof content === "string"
      ? content
      : content && typeof content === "object"
        ? JSON.stringify(content, Object.keys(content).sort())
        : ""
  return JSON.stringify({
    title: String(item?.title ?? ""),
    content_format: String(item?.content_format ?? "markdown").toLowerCase(),
    body,
  })
}

export function contentHash(item: any): string {
  return createHash("sha256").update(canonicalize(item), "utf8").digest("hex")
}

export function shortHash(h: string): string {
  return (h || "").slice(0, 12)
}

// ── paths ───────────────────────────────────────────────────────────────────

export function slug(s: string | null | undefined, fallback: string): string {
  const out = String(s ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
  return out || fallback
}

export function treeRelPath(item: any, uuid: string): string {
  const ctx = item?.context ?? {}
  return join(
    "tree",
    slug(ctx?.bloq?.name, "unfiled"),
    slug(ctx?.list?.name, "unlisted"),
    `${slug(item?.title, uuid.slice(0, 8))}--${uuid.slice(0, 8)}.md`,
  )
}

export function blobPath(home: string, sha: string): string {
  return join(home, "store", `${sha}.md`)
}

// ── manifest ────────────────────────────────────────────────────────────────

export function manifestPath(home: string): string {
  return join(home, "manifest.json")
}

export function readManifest(home: string): Manifest {
  const p = manifestPath(home)
  if (!existsSync(p)) return { version: 1, machine: process.env.HOSTNAME || "unknown", pins: {} }
  try {
    const m = JSON.parse(readFileSync(p, "utf8"))
    // A manifest that failed to parse is NOT an empty manifest. Returning {} there
    // would report "nothing granted" for a machine holding everything — the exact
    // absent-vs-equal confusion this epic exists to refuse.
    if (!m || typeof m !== "object" || typeof m.pins !== "object") throw new Error("malformed manifest")
    return { version: 1, machine: m.machine ?? "unknown", pins: m.pins ?? {} }
  } catch (e: any) {
    throw new Error(`Atlas manifest at ${p} is unreadable (${e?.message ?? e}). Refusing to treat it as empty.`)
  }
}

export function writeManifest(home: string, m: Manifest): void {
  ensureDir(home)
  writeFileSync(manifestPath(home), JSON.stringify(m, null, 2) + "\n", "utf8")
}

// ── log ─────────────────────────────────────────────────────────────────────

export function appendLog(home: string, entry: LogEntry): void {
  ensureDir(home)
  appendFileSync(join(home, "log.jsonl"), JSON.stringify(entry) + "\n", "utf8")
}

export function readLog(home: string): LogEntry[] {
  const p = join(home, "log.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l)
      } catch {
        return null
      }
    })
    .filter(Boolean) as LogEntry[]
}

/**
 * The hash this item held BEFORE its current one. Read from the log, not guessed
 * from the store: the store holds every blob this machine ever pulled, including
 * ones belonging to other items, so "the other file in store/" is not an answer.
 */
export function previousHash(home: string, uuid: string): string | null {
  const entries = readLog(home).filter((e) => e.uuid === uuid && (e.op === "update" || e.op === "rollback"))
  const last = entries[entries.length - 1]
  return last?.from ?? null
}

// ── policy / the seal ───────────────────────────────────────────────────────

export function readPolicy(home: string): Policy {
  const p = join(home, "policy.json")
  if (!existsSync(p)) return { sealed: false }
  try {
    const v = JSON.parse(readFileSync(p, "utf8"))
    return { sealed: !!v?.sealed, sealed_at: v?.sealed_at }
  } catch {
    // A policy file we cannot read must fail CLOSED. An unreadable seal that
    // silently means "open" is a control that disappears exactly when something
    // is wrong with the machine.
    return { sealed: true }
  }
}

export function writePolicy(home: string, p: Policy): void {
  ensureDir(home)
  writeFileSync(join(home, "policy.json"), JSON.stringify(p, null, 2) + "\n", "utf8")
}

/**
 * Deny-by-default, at the TOOL boundary only.
 *
 * This is one of the three layers named in #184612 (tool / runtime / network).
 * It stops `iris atlas use <unpinned>` on a sealed machine. It does NOT stop a
 * curl, another binary, or a process that already has the bytes. Every message
 * that reports this seal must say so — an overclaimed boundary loses more trust
 * than a documented partial one.
 */
export function isGranted(home: string, uuid: string): boolean {
  return !!readManifest(home).pins[uuid]
}

// ── pinning ─────────────────────────────────────────────────────────────────

export function pinItem(
  home: string,
  uuid: string,
  item: any,
  rendered: string,
  opts: { op?: "pin" | "update"; now?: Date } = {},
): { pin: Pin; sha: string; previous: string | null } {
  const now = opts.now ?? new Date()
  const sha = contentHash(item)
  const manifest = readManifest(home)
  const previous = manifest.pins[uuid]?.sha256 ?? null

  ensureDir(join(home, "store"))
  // Blobs are immutable and content-addressed, so re-pinning an unchanged item
  // writes nothing new and rollback is a pointer move rather than a refetch.
  const blob = blobPath(home, sha)
  if (!existsSync(blob)) writeFileSync(blob, rendered, "utf8")

  const rel = treeRelPath(item, uuid)
  const abs = join(home, rel)
  ensureDir(dirname(abs))
  writeFileSync(abs, rendered, "utf8")

  const pin: Pin = {
    uuid,
    title: String(item?.title ?? "Untitled"),
    bloq: item?.context?.bloq?.name ?? null,
    list: item?.context?.list?.name ?? null,
    sha256: sha,
    revised: item?.updated_at ?? null,
    pulled_at: now.toISOString(),
    path: rel,
  }
  manifest.pins[uuid] = pin
  writeManifest(home, manifest)
  appendLog(home, {
    at: now.toISOString(),
    op: opts.op ?? (previous ? "update" : "pin"),
    uuid,
    from: previous,
    to: sha,
    title: pin.title,
  })
  return { pin, sha, previous }
}

export function unpinItem(home: string, uuid: string, now = new Date()): Pin | null {
  const manifest = readManifest(home)
  const pin = manifest.pins[uuid]
  if (!pin) return null
  delete manifest.pins[uuid]
  writeManifest(home, manifest)
  try {
    const abs = join(home, pin.path)
    if (existsSync(abs)) unlinkSync(abs)
  } catch {
    /* the tree is a convenience mirror; the manifest is the grant */
  }
  appendLog(home, { at: now.toISOString(), op: "unpin", uuid, from: pin.sha256, to: null, title: pin.title })
  return pin
}

// ── status ──────────────────────────────────────────────────────────────────

/** `7d`, `36h`, `90m`, `30s`, or a bare number of days. Null when unparseable. */
export function parseDuration(s: string | undefined | null): number | null {
  if (s === undefined || s === null || s === "") return null
  const m = String(s)
    .trim()
    .match(/^(\d+(?:\.\d+)?)\s*([smhdw])?$/i)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = (m[2] || "d").toLowerCase()
  const mult: Record<string, number> = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3, w: 604800e3 }
  return n * mult[unit]
}

export function pinAgeMs(pin: Pin, now = new Date()): number {
  const t = Date.parse(pin.pulled_at)
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : now.getTime() - t
}

export function humanAge(ms: number): string {
  if (!Number.isFinite(ms)) return "unknown"
  const d = Math.floor(ms / 86400e3)
  if (d > 0) return `${d}d`
  const h = Math.floor(ms / 3600e3)
  if (h > 0) return `${h}h`
  const m = Math.floor(ms / 60e3)
  if (m > 0) return `${m}m`
  return "moments"
}

export type Drift = {
  /** In the manifest, absent from disk — the machine does not hold what it was granted. */
  declaredMissing: Pin[]
  /** On disk, absent from the manifest — the machine holds what it was not granted. */
  undeclaredFiles: string[]
}

/**
 * Two kinds of drift, in OPPOSITE directions, which a single "N items" count hides.
 * Reporting only the first says a leaked file is fine; reporting only the second
 * says a missing grant is fine.
 */
export function driftReport(home: string): Drift {
  const manifest = readManifest(home)
  const pins = Object.values(manifest.pins)
  const declaredMissing = pins.filter((p) => !existsSync(join(home, p.path)))

  const known = new Set(pins.map((p) => p.path))
  const undeclaredFiles: string[] = []
  const walk = (rel: string) => {
    const abs = join(home, rel)
    if (!existsSync(abs)) return
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const child = join(rel, e.name)
      if (e.isDirectory()) walk(child)
      else if (e.name.endsWith(".md") && !known.has(child)) undeclaredFiles.push(child)
    }
  }
  walk("tree")
  return { declaredMissing, undeclaredFiles }
}
