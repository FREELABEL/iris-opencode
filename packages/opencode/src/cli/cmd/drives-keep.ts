/**
 * `iris drives keep <drive>:<file or folder> --vault <v> --why <reason>` (#193363).
 *
 * Pins a cataloged file, or a whole project folder, into a vault whose copies are on the user's
 * own drives and machines (iris vault create <v> --on …). The same rules as `iris drives get`:
 *
 *   - --why is required and goes on the record (one `drive-reads` row: the bytes were read).
 *   - A private folder is never opened — named directly, reached through a link, or inside a folder.
 *   - A sensitive file (credential, database dump) needs --confirm; in a folder, one is enough to ask.
 *   - The drive is read where it is plugged in: this machine, or another of the user's machines,
 *     over the Hive mesh (the remote-get path, sha256 checked at both ends). Never through our servers.
 *
 * Then each file is encrypted on THIS machine and put into the vault (vault-replicas.ts places the
 * copies), and one `drive-kept` row per file records where it came from, its content id, which
 * copies hold it and how many count — the numbers `iris drives copies` and `iris drives list` read.
 */

import fs from "fs"
import os from "os"
import path from "path"
import {
  walk, bundleMembers, bundleHashFromLines, sha256File, kindOf, SENSITIVE, APP_BUNDLES, BUNDLES, utcIso,
} from "./drives-core"
import { resolveRef, insidePrivate, formatSize, notConnected, type GetDeps } from "./platform-drives"
import type { RemoteGetArgs, RemoteGetResult } from "./drives-remote"
import { keptRowId, refreshDriveAlerts, type VaultCatalog } from "./vault-replicas"
import { effectiveCopies, splitList, type ReplicaRow } from "./vault-drives"

export type KeepVault = { id: string; name: string; replicas: number; targets?: unknown[] }
export type KeepPutReport = {
  results: Array<{ ok: boolean; path: string; vault_path?: string; size?: number; plain_sha256?: string; content_id?: string; held_by?: string[]; copies?: number; error?: string }>
  problems: string[]
  checks: Array<{ key: string; status: string; target: any; note?: string }>
}

export type KeepDeps = GetDeps & {
  /** the replicated vault by name, or a sentence saying why not */
  vault: (name: string) => Promise<KeepVault | string>
  put: (v: KeepVault, files: Array<{ src: string; as: string }>) => Promise<KeepPutReport>
  remoteGet: (a: RemoteGetArgs) => Promise<RemoteGetResult>
  /** the drive's cataloged files (from its encrypted list), for a folder kept from another machine */
  catalogFiles: (driveId: string) => Promise<Array<{ path: string; bytes: number; sha256?: string }> | null>
  catalog: VaultCatalog
}

export type KeepArgs = { ref: string; vault: string; why?: string; confirm?: boolean; from?: string; bloq: number }
export type KeepResult = { code: number; out: string[]; err: string[]; kept?: any[]; problems?: string[] }

/** A folder kept from another machine is fetched file by file over ssh; past this, keep it where it is plugged in. */
export const REMOTE_FOLDER_LIMIT = 200

type Member = { rel: string; abs: string; bytes: number }

/**
 * The files of a folder on a drive plugged in here: drives-core's walk (private folders are never
 * entered, system folders and app bundles skipped, links not followed), with project bundles
 * opened into their files.
 */
export function folderMembers(mount: string, relDir: string, excludes: readonly string[]): { files: Member[]; skipped: string[] } {
  const root = path.join(mount, relDir)
  const prefix = relDir ? relDir.replace(/\/+$/, "") + "/" : ""
  // Excludes are drive-relative; walk wants them relative to the folder.
  const inner = excludes
    .map((x) => x.replace(/^\/+|\/+$/g, ""))
    .filter((x) => x.toLowerCase().startsWith(prefix.toLowerCase()))
    .map((x) => x.slice(prefix.length))
    .filter(Boolean)
  const files: Member[] = []
  const skipped: string[] = []
  for (const e of walk(root, { excludes: inner, store: path.join(os.homedir(), ".iris", "drives") })) {
    const rel = prefix + e.rel
    if (insidePrivate(rel, excludes)) continue
    const lower = e.rel.toLowerCase()
    if (APP_BUNDLES.some((b) => lower.endsWith(b))) { skipped.push(`${rel} (installed app — listed, never opened)`); continue }
    if (BUNDLES.some((b) => lower.endsWith(b))) {
      for (const [r, abs] of bundleMembers(path.join(root, e.rel))) files.push({ rel: `${rel}/${r}`, abs, bytes: fs.statSync(abs).size })
      continue
    }
    files.push({ rel, abs: path.join(root, e.rel), bytes: e.bytes })
  }
  return { files: files.sort((a, b) => (a.rel < b.rel ? -1 : 1)), skipped }
}

export async function runKeep(a: KeepArgs, deps: KeepDeps): Promise<KeepResult> {
  const out: string[] = []
  const err: string[] = []
  const fail = (code: number, msg: string): KeepResult => { err.push(msg); return { code, out, err } }
  const why = String(a.why ?? "").trim()
  if (!why) return fail(1, '--why is required: say why you are keeping this, e.g. --why "the only copy of the master". It goes on the record.')

  const vault = await deps.vault(a.vault)
  if (typeof vault === "string") return fail(1, vault)

  let drives: any[]
  try {
    drives = await deps.drives()
  } catch (e: any) {
    return fail(1, `Could not read your drives from your account (${e?.message ?? e}). Nothing was kept.`)
  }
  const labels: Record<string, string> = Object.fromEntries(drives.map((d) => [String(d.external_id), String(d.label ?? d.external_id)]))
  const [driveId, rawRel] = resolveRef(String(a.ref), labels)
  const drive = drives.find((d) => String(d.external_id) === driveId)
  if (!drive) return fail(1, `${driveId} is not a cataloged drive. See your drives with: iris drives list`)
  const name = labels[driveId]
  const excludes = String(drive.private_excluded ?? "").split("\n").filter((x) => x.trim())
  const rel = path.posix.normalize(String(rawRel ?? "").replace(/^\/+/, "")).replace(/\/+$/, "")
  if (!rawRel || rel === "." || rel === ".." || rel.startsWith("../")) return fail(1, `Give a file or folder inside the drive: iris drives keep "${name}:<path>" --vault ${vault.name} --why "…"`)
  const privateMsg = (p: string) => `${p} is inside a private folder on ${name}. Private folders are never opened, so it cannot be kept.`
  if (insidePrivate(rel, excludes)) return fail(1, privateMsg(rel))
  let findings: any[]
  try {
    findings = await deps.findings(driveId)
  } catch (e: any) {
    return fail(1, `Could not check for sensitive files (${e?.message ?? e}). Nothing was kept.`)
  }
  const sensitive = (p: string) => {
    const f = findings.find((x) => x?.path === p && x?.status !== "moved")
    return f?.kind ?? (SENSITIVE.has(kindOf(p)) ? kindOf(p) : null)
  }
  const refuseSensitive = (list: Array<[string, string]>) =>
    fail(1, `${list.length === 1 ? `${list[0][0]} is a sensitive file (${list[0][1]})` : `${list.length} sensitive files are in ${rel}: ` + list.slice(0, 5).map(([p, k]) => `${p} (${k})`).join(", ") + (list.length > 5 ? ` … and ${list.length - 5} more` : "")} on ${name}.\n` +
      `Keeping it puts encrypted copies on every place the vault ${vault.name} names. If you mean to, add --confirm. It is recorded either way.`)

  const vaultPath = (p: string) => `${name}/${p}`
  const stage = fs.mkdtempSync(path.join(os.tmpdir(), "iris-drives-keep-"))
  const files: Array<{ rel: string; src: string; bytes: number; sha256: string }> = []
  let isFolder = false
  try {
    const mount = a.from ? null : (deps.resolveMount ?? (() => null))(driveId)
    if (mount) {
      // ── plugged in here ──
      let real: string
      try {
        real = fs.realpathSync(path.join(mount, rel))
      } catch {
        return fail(3, `${name} is connected at ${mount}, but ${rel} is not there (moved or deleted since the last scan)`)
      }
      const relReal = path.relative(fs.realpathSync(mount), real).split(path.sep).join("/")
      if (!relReal || relReal.startsWith("..") || path.isAbsolute(relReal)) return fail(1, `${rel} leads outside ${name}; not kept.`)
      if (insidePrivate(relReal, excludes)) return fail(1, privateMsg(relReal))
      const st = fs.statSync(real)
      let members: Member[]
      if (st.isDirectory()) {
        if (APP_BUNDLES.some((b) => relReal.toLowerCase().endsWith(b))) return fail(1, `${rel} is an installed app; apps are listed, never opened.`)
        isFolder = true
        const m = folderMembers(fs.realpathSync(mount), relReal, excludes)
        members = m.files
        for (const s of m.skipped.slice(0, 3)) out.push(`  skipped ${s}`)
        if (!members.length) return fail(1, `${rel} has no files to keep (private folders and apps are never opened).`)
      } else if (st.isFile()) {
        members = [{ rel: relReal, abs: real, bytes: st.size }]
      } else return fail(1, `${rel} is not a regular file or folder; not kept.`)
      const sens = members.map((m) => [m.rel, sensitive(m.rel)] as [string, string | null]).filter((x): x is [string, string] => !!x[1])
      if (sens.length && !a.confirm) return refuseSensitive(sens)
      for (const m of members) files.push({ rel: m.rel, src: m.abs, bytes: m.bytes, sha256: sha256File(m.abs) })
      // One read on the record — written BEFORE anything is put: not on the record → not kept.
      const at = utcIso(deps.now())
      const sha = isFolder ? bundleHashFromLines(files.map((f) => [f.rel.slice(relReal.length + 1), f.sha256])) : files[0].sha256
      const row = {
        external_id: `${driveId}:${relReal}:${at}`, drive_id: driveId, drive_label: name, path: relReal,
        bytes: files.reduce((n, f) => n + f.bytes, 0), sha256: sha,
        read_by: await deps.account().catch(() => "unknown"), read_on: deps.host, purpose: `kept in vault ${vault.name}: ${why}`, at,
      }
      try {
        await deps.ensureReadsDataset()
        const r = await deps.writeAudit([row])
        if (r.failed || r.created + r.updated !== 1) throw new Error(`created ${r.created} · updated ${r.updated} · failed ${r.failed}`)
      } catch (e: any) {
        return fail(1, `Could not record this read in your account (${e?.message ?? e}). Nothing was kept. Check your connection and try again.`)
      }
    } else {
      // ── plugged into another of your machines: the remote-get path, one file at a time ──
      const listed = await deps.catalogFiles(driveId).catch(() => null)
      const under = (listed ?? []).filter((f) => f.path.startsWith(rel + "/") && !insidePrivate(f.path, excludes))
      isFolder = under.length > 0
      const wanted = isFolder ? under.map((f) => f.path) : [rel]
      if (isFolder && wanted.length > REMOTE_FOLDER_LIMIT)
        return fail(1, `${rel} has ${wanted.length} files; from another machine keep folders of up to ${REMOTE_FOLDER_LIMIT}. Run iris drives keep on the machine ${name} is plugged into.`)
      const sens = wanted.map((p) => [p, sensitive(p)] as [string, string | null]).filter((x): x is [string, string] => !!x[1])
      if (sens.length && !a.confirm) return refuseSensitive(sens)
      for (const p of wanted) {
        const dir = fs.mkdtempSync(path.join(stage, "f-"))
        const r = await deps.remoteGet({ ref: `${driveId}:${p}`, to: dir, why: `kept in vault ${vault.name}: ${why}`, confirm: a.confirm, from: a.from, bloq: a.bloq })
        if (r.code !== 0 || !r.dest) {
          if (r.code === 2 && !a.from && !listed) err.push(notConnected(name))
          return { code: r.code || 1, out, err: [...err, ...r.err, ...(files.length ? [`Stopped after ${files.length} file(s); nothing was put in the vault.`] : [])] }
        }
        files.push({ rel: String(r.row?.path ?? p) + (r.row?.bundle ? ".zip" : ""), src: r.dest, bytes: Number(r.row?.bytes ?? 0), sha256: String(r.row?.file_sha256 ?? r.row?.sha256 ?? "") })
        if (r.served_by && files.length === 1) out.push(`  reading from ${name} on ${r.served_by} (over your Hive)`)
      }
    }

    // ── into the vault ──
    let report: KeepPutReport
    try {
      report = await deps.put(vault, files.map((f) => ({ src: f.src, as: vaultPath(f.rel) })))
    } catch (e: any) {
      return fail(1, `Could not put ${isFolder ? "the files" : rel} into vault ${vault.name}: ${e?.message ?? e}`)
    }
    const failed = report.results.filter((r) => !r.ok)
    const at = utcIso(deps.now())
    const account = await deps.account().catch(() => "unknown")
    const rows: any[] = []
    for (const f of files) {
      const r = report.results.find((x) => x.path === f.src && x.ok)
      if (!r) continue
      if (f.sha256 && r.plain_sha256 !== f.sha256) out.push(`  note: ${f.rel} changed while it was being kept — the vault has the newer content`)
      rows.push({
        external_id: keptRowId(vault.id, driveId, f.rel), drive_id: driveId, drive_label: name, path: f.rel,
        kept_from: isFolder ? `${name}:${rel}` : "", vault_id: vault.id, vault_name: vault.name, vault_path: r.vault_path,
        content_id: r.content_id, sha256: r.plain_sha256, bytes: r.size, target_copies: vault.replicas,
        copies: r.copies ?? 0, held_by: (r.held_by ?? []).join("\n"), status: (r.copies ?? 0) >= vault.replicas ? "safe" : "below",
        kept_by: account, kept_on: deps.host, purpose: why, at, checked_at: at,
      })
    }
    const problems = [...report.problems]
    if (rows.length) {
      try {
        await deps.catalog.ensure("drive-kept")
        const r = await deps.catalog.upsert("drive-kept", rows)
        if (r.failed) problems.push(`${r.failed} kept-file row(s) could not be saved`)
        const [kept, reps] = await Promise.all([deps.catalog.keptRows(), deps.catalog.replicaRows()])
        problems.push(...(await refreshDriveAlerts(deps.catalog, kept.map((x: any) => x?.data ?? x), reps.map((x: any) => x?.data ?? x), deps.now())))
      } catch (e: any) {
        problems.push(`could not save the kept files to your Drives catalog (${e?.message ?? e})`)
      }
    }
    const total = rows.reduce((n, r) => n + Number(r.bytes ?? 0), 0)
    const below = rows.filter((r) => r.status === "below")
    out.push(`Kept ${isFolder ? `${rows.length} file(s) from ${rel}` : rel} from ${name} in vault ${vault.name} · ${formatSize(total)}`)
    const copiesNow = [...new Set(rows.map((r) => r.copies))].sort().join("–")
    const state = !below.length ? `every file at ${vault.replicas}+ copies`
      : below.length === rows.length ? `${copiesNow} of ${vault.replicas} copies so far`
      : `${below.length} of ${rows.length} file(s) below ${vault.replicas} copies`
    out.push(`  ${state}: ` +
      report.checks.map((c) => `${c.target?.label ?? c.target?.name ?? c.key} ${c.status === "ok" ? "✓" : c.status}`).join(" · "))
    if (report.checks.some((c) => c.status === "pending")) out.push("  A copy on a drive that is not plugged in catches up when it is plugged into any of your machines (the IRIS daemon does it; or run iris vault sync there)")
    for (const f of failed) err.push(`${f.path}: ${f.error}`)
    for (const p of problems) err.push(`not recorded: ${p}`)
    return { code: failed.length || problems.length ? 1 : 0, out, err, kept: rows, problems }
  } finally {
    fs.rmSync(stage, { recursive: true, force: true })
  }
}

/** A kept file's copies as `iris drives copies` shows them: "+ 3 encrypted copies in vault studio (minimum 3)". */
export function vaultCopiesBySha(kept: any[], replicaRows: ReplicaRow[], now: Date): Map<string, Array<{ vault: string; copies: number; target: number; held: string[]; stale: string[] }>> {
  const out = new Map<string, Array<{ vault: string; copies: number; target: number; held: string[]; stale: string[] }>>()
  const label = (k: string) => (replicaRows as any[]).find((r) => r.target === k)?.target_label ?? k.replace(/^(drive|machine):/, "")
  for (const k of kept) {
    if (!k?.sha256 || k.status === "removed") continue
    const e = effectiveCopies(splitList(k.held_by), replicaRows, String(k.vault_id), now)
    const list = out.get(k.sha256) ?? []
    if (list.some((x) => x.vault === (k.vault_name ?? k.vault_id))) continue // one content, one count per vault
    list.push({ vault: String(k.vault_name ?? k.vault_id), copies: e.copies, target: Number(k.target_copies || 1), held: e.counted.map(label), stale: e.stale.map(label) })
    out.set(k.sha256, list)
  }
  return out
}
