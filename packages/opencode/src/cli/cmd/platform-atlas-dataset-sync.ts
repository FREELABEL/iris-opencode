/**
 * `iris atlas:datasets pull | push | sync | status` (#189972) — a local copy of a dataset.
 *
 *   ~/.iris/atlas/datasets/<slug>/
 *     schema.json            the dataset's fields, as the server has them
 *     records/<id>.json      a record: { id, external_id, status, data } — edit `data` freely
 *     records/new-*.json     a record written here, not yet published: { data }
 *     .iris/base/<id>.json   the server's version as of the last sync (the merge base)
 *     .iris/state.json       feed cursor, unresolved conflicts, records deleted on the server
 *
 * The planning (what to merge, what to push, what is a conflict) is pure and tested in
 * atlas-dataset-sync.ts; this file only reads and writes. The Hive daemon keeps a copy in step in
 * the background by running `sync` — one implementation, not two.
 */
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, writeJson } from "./iris-api"
import * as fs from "fs"
import * as path from "path"
import * as os from "os"
import { planPull, planPush, recordState, type Base, type Change, type LocalRecord, type RecordState } from "./atlas-dataset-sync"

interface State {
  slug: string
  cursor: string | null
  pulled_at?: string
  pushed_at?: string
  /** record id → the fields both sides changed differently. Blocks that record's push. */
  conflicts: Record<string, string[]>
  /** ids deleted on the server while edited here — kept, and not pushed back */
  deleted_remotely: number[]
}

export function storeDir(slug: string, dir?: string): string {
  return dir ? path.resolve(dir) : path.join(os.homedir(), ".iris", "atlas", "datasets", slug)
}

const p = (root: string, ...parts: string[]) => path.join(root, ...parts)
const readJson = (f: string) => JSON.parse(fs.readFileSync(f, "utf8"))
function writeJsonFile(f: string, v: unknown) {
  fs.mkdirSync(path.dirname(f), { recursive: true })
  const tmp = `${f}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2) + "\n")
  fs.renameSync(tmp, f) // a crash never leaves half a record
}

export function readState(root: string, slug: string): State {
  try {
    return { conflicts: {}, deleted_remotely: [], ...readJson(p(root, ".iris", "state.json")), slug }
  } catch {
    return { slug, cursor: null, conflicts: {}, deleted_remotely: [] }
  }
}

export function readLocals(root: string): LocalRecord[] {
  const dir = p(root, "records")
  if (!fs.existsSync(dir)) return []
  const out: LocalRecord[] = []
  for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const j = readJson(p(dir, file))
    const id = file.startsWith("new-") ? null : Number(j.id ?? path.basename(file, ".json"))
    out.push({ id: Number.isFinite(id as number) ? id : null, file, status: String(j.status ?? "active"), data: (j.data ?? {}) as any })
  }
  return out
}

export function readBases(root: string): Base[] {
  const dir = p(root, ".iris", "base")
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readJson(p(dir, f)) as Base)
}

const ds = (slug: string) => `/api/v1/atlas/datasets/${encodeURIComponent(slug)}`

export async function pull(slug: string, root: string): Promise<{ written: number; merged: number; conflicts: Record<string, string[]>; removed: number; deletedRemotely: number[]; skipped: number } | null> {
  const state = readState(root, slug)
  const changes: Change[] = []
  let cursor = state.cursor
  for (let guard = 0; guard < 10_000; guard++) {
    const q = new URLSearchParams({ limit: "500", ...(cursor ? { cursor } : {}) })
    const res = await irisFetch(`${ds(slug)}/changes?${q}`)
    if (!(await handleApiError(res, `Read changes for ${slug}`))) return null
    const body = ((await res.json()) as any).data
    if (guard === 0) writeJsonFile(p(root, "schema.json"), body.schema)
    changes.push(...(body.changes as Change[]))
    cursor = body.cursor
    if (!body.more) break
  }

  const plan = planPull(changes, readLocals(root), readBases(root))
  const summary = { written: 0, merged: 0, conflicts: { ...state.conflicts }, removed: 0, deletedRemotely: [...state.deleted_remotely], skipped: 0 }
  for (const a of plan) {
    const rec = p(root, "records", `${a.id}.json`)
    const base = p(root, ".iris", "base", `${a.id}.json`)
    if (a.action === "skip") summary.skipped++
    else if (a.action === "write" || a.action === "merge") {
      writeJsonFile(rec, { id: a.id, status: a.status, data: a.local })
      writeJsonFile(base, a.base)
      if (a.action === "merge") {
        summary.merged++
        if (a.conflicts.length) summary.conflicts[String(a.id)] = a.conflicts
        else delete summary.conflicts[String(a.id)]
      } else {
        summary.written++
        delete summary.conflicts[String(a.id)]
      }
    } else if (a.action === "remove") {
      fs.rmSync(rec, { force: true })
      fs.rmSync(base, { force: true })
      summary.removed++
    } else if (a.action === "keep-deleted-remotely") {
      if (!summary.deletedRemotely.includes(a.id)) summary.deletedRemotely.push(a.id)
    }
  }
  writeJsonFile(p(root, ".iris", "state.json"), {
    ...state, cursor, pulled_at: new Date().toISOString(), conflicts: summary.conflicts, deleted_remotely: summary.deletedRemotely,
  })
  return summary
}

export async function push(slug: string, root: string, opts: { prune: boolean }): Promise<{ created: number; updated: number; deleted: number; refused: { id: number | string; reason: string }[] }> {
  const state = readState(root, slug)
  const conflicted = [...Object.keys(state.conflicts).map(Number), ...state.deleted_remotely]
  const plan = planPush(readLocals(root), readBases(root), { prune: opts.prune, conflicted })
  const out = { created: 0, updated: 0, deleted: 0, refused: [] as { id: number | string; reason: string }[] }
  const node = os.hostname().slice(0, 64)
  const keep = (r: any) => ({ id: Number(r.id), revision: Number(r.revision ?? 1), status: String(r.status ?? "active"), data: r.data ?? {} })

  for (const a of plan) {
    if (a.action === "blocked") {
      out.refused.push({ id: a.id, reason: state.deleted_remotely.includes(a.id) ? "deleted on the server while edited here" : `${a.reason}: ${(state.conflicts[String(a.id)] ?? []).join(", ")}` })
      continue
    }
    if (a.action === "create") {
      const res = await irisFetch(ds(slug), { method: "POST", body: JSON.stringify({ data: a.data, origin: "node", origin_node_id: node }) })
      if (!res.ok) { out.refused.push({ id: a.file, reason: `create failed: HTTP ${res.status}` }); continue }
      const r = keep(((await res.json()) as any).data)
      writeJsonFile(p(root, "records", `${r.id}.json`), { id: r.id, status: r.status, data: r.data })
      writeJsonFile(p(root, ".iris", "base", `${r.id}.json`), r)
      fs.rmSync(p(root, "records", a.file), { force: true })
      out.created++
    } else if (a.action === "update") {
      const res = await irisFetch(`${ds(slug)}/${a.id}`, { method: "PATCH", body: JSON.stringify({ data: a.data, base_revision: a.baseRevision }) })
      if (res.status === 409) { out.refused.push({ id: a.id, reason: "changed on the server since your copy — run pull (it merges), then push" }); continue }
      if (!res.ok) { out.refused.push({ id: a.id, reason: `update failed: HTTP ${res.status}` }); continue }
      const r = keep(((await res.json()) as any).data)
      // The server's result is the truth now — for both the copy and the base.
      writeJsonFile(p(root, "records", `${r.id}.json`), { id: r.id, status: r.status, data: r.data })
      writeJsonFile(p(root, ".iris", "base", `${r.id}.json`), r)
      out.updated++
    } else if (a.action === "delete") {
      const res = await irisFetch(`${ds(slug)}/${a.id}`, { method: "DELETE" })
      if (!res.ok && res.status !== 404) { out.refused.push({ id: a.id, reason: `delete failed: HTTP ${res.status}` }); continue }
      fs.rmSync(p(root, ".iris", "base", `${a.id}.json`), { force: true })
      out.deleted++
    }
  }
  writeJsonFile(p(root, ".iris", "state.json"), { ...readState(root, slug), pushed_at: new Date().toISOString() })
  return out
}

export function status(root: string, slug: string): Record<RecordState | "conflicted", number[]> {
  const state = readState(root, slug)
  const locals = readLocals(root)
  const bases = new Map(readBases(root).map((b) => [b.id, b]))
  const out: Record<string, number[]> = { "local-only": [], synced: [], modified: [], behind: [], diverged: [], "deleted-locally": [], conflicted: [] }
  for (const l of locals) {
    if (l.id !== null && state.conflicts[String(l.id)]) out.conflicted.push(l.id)
    else out[recordState(l, l.id !== null ? bases.get(l.id) : undefined)].push(l.id ?? -1)
  }
  const ids = new Set(locals.map((l) => l.id))
  for (const b of bases.values()) if (!ids.has(b.id)) out["deleted-locally"].push(b.id)
  return out as any
}

const common = (y: any) =>
  y.positional("slug", { describe: "dataset slug", type: "string", demandOption: true })
    .option("dir", { describe: "local copy folder (default ~/.iris/atlas/datasets/<slug>)", type: "string" })
    .option("json", { describe: "JSON output", type: "boolean", default: false })

function report(title: string, lines: [string, number | string][], args: any, json: unknown) {
  if (args.json) return writeJson(json)
  UI.empty()
  prompts.intro(`◈  ${title}`)
  for (const [k, v] of lines) prompts.log.info(`${bold(String(v))}  ${dim(k)}`)
}

export const DatasetPullCommand = cmd({
  command: "pull <slug>",
  describe: "bring a local copy of a dataset up to date — your edits are merged, never overwritten",
  builder: common,
  async handler(args: any) {
    if (!(await requireAuth())) { process.exitCode = 1; return }
    const root = storeDir(args.slug, args.dir)
    const s = await pull(args.slug, root)
    if (!s) { process.exitCode = 1; return }
    report(`pull ${args.slug} → ${root}`, [["new or updated", s.written], ["merged with your edits", s.merged], ["removed (deleted on the server)", s.removed], ["already current", s.skipped]], args, { dir: root, ...s })
    if (!args.json) {
      for (const [id, fields] of Object.entries(s.conflicts)) prompts.log.warn(`record ${id}: both sides changed ${fields.join(", ")} — your value kept; edit records/${id}.json, then run \`iris atlas:datasets resolve ${args.slug} ${id}\``)
      for (const id of s.deletedRemotely) prompts.log.warn(`record ${id} was deleted on the server but you edited it here — kept locally, not pushed`)
      prompts.outro(dim("edit records/*.json, add records/new-<anything>.json, then push"))
    }
  },
})

export const DatasetPushCommand = cmd({
  command: "push <slug>",
  describe: "send local changes — each edit names the revision it was made against; stale ones are refused",
  builder: (y: any) => common(y).option("prune", { describe: "also delete on the server the records whose files you removed", type: "boolean", default: false }),
  async handler(args: any) {
    if (!(await requireAuth())) { process.exitCode = 1; return }
    const root = storeDir(args.slug, args.dir)
    if (!fs.existsSync(root)) { prompts.log.error(`no local copy at ${root} — run pull first`); process.exitCode = 1; return }
    const s = await push(args.slug, root, { prune: !!args.prune })
    report(`push ${args.slug}`, [["created", s.created], ["updated", s.updated], ["deleted", s.deleted], ["refused", s.refused.length]], args, { dir: root, ...s })
    if (!args.json) {
      for (const r of s.refused) prompts.log.warn(`${r.id}: ${r.reason}`)
      prompts.outro(s.refused.length ? "some records were not sent" : "done")
    }
    if (s.refused.length) process.exitCode = 2
  },
})

export const DatasetSyncCommand = cmd({
  command: "sync <slug>",
  describe: "pull, then push — what the Hive daemon runs in the background",
  builder: (y: any) => common(y).option("prune", { type: "boolean", default: false, describe: "see push" }),
  async handler(args: any) {
    if (!(await requireAuth())) { process.exitCode = 1; return }
    const root = storeDir(args.slug, args.dir)
    const a = await pull(args.slug, root)
    if (!a) { process.exitCode = 1; return }
    const b = await push(args.slug, root, { prune: !!args.prune })
    report(`sync ${args.slug}`, [["pulled", a.written + a.merged + a.removed], ["pushed", b.created + b.updated + b.deleted], ["conflicts", Object.keys(a.conflicts).length], ["refused", b.refused.length]], args, { dir: root, pull: a, push: b })
    if (b.refused.length || Object.keys(a.conflicts).length) process.exitCode = 2
  },
})

export const DatasetStatusCommand = cmd({
  command: "status <slug>",
  describe: "where each record in the local copy stands — offline, from the files alone",
  builder: common,
  async handler(args: any) {
    const root = storeDir(args.slug, args.dir)
    const s = status(root, args.slug)
    report(`status ${args.slug} (${root})`, Object.entries(s).map(([k, v]) => [k, v.length]), args, { dir: root, ...s })
  },
})

export const DatasetResolveCommand = cmd({
  command: "resolve <slug> <id>",
  describe: "mark a record's conflict as resolved (after you edited its file) so it can be pushed",
  builder: (y: any) => common(y).positional("id", { type: "number", demandOption: true }),
  async handler(args: any) {
    const root = storeDir(args.slug, args.dir)
    const st = readState(root, args.slug)
    delete st.conflicts[String(args.id)]
    st.deleted_remotely = st.deleted_remotely.filter((x) => x !== Number(args.id))
    writeJsonFile(p(root, ".iris", "state.json"), st)
    if (!args.json) prompts.log.success(`record ${args.id} will be pushed as it is in records/${args.id}.json`)
  },
})
