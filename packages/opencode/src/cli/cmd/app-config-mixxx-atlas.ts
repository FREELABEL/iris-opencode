/**
 * A Mixxx rig as plain Atlas records (#193298) — so a person can move one by hand with the
 * commands they already have, and `iris app-config export|apply mixxx --bloq <id>` is only a
 * shortcut over the same three things:
 *
 *   the bytes     every controllers/ file as a bloq ATTACHMENT  iris atlas files list|download|upload
 *   the settings  rows in the dataset `mixxx-rig`              iris datasets export|import|records
 *   the page      one item "Mixxx rig — <rig>" with the rows   iris atlas pull|diff|push
 *                 in a fenced json block
 *
 * THE DATASET IS THE TRUTH. The page is generated from it and carries `generated_from`, the hash
 * of the rows it was generated from. That makes an edit on either side detectable:
 *
 *   page rows == dataset rows                   in sync
 *   page edited, dataset still at generated_from   the page wins; apply copies it into the dataset
 *   dataset edited, page still at generated_from   the dataset wins; apply regenerates the page
 *   both moved                                   refused — say which with --prefer page|dataset
 *
 * so there are never two copies quietly disagreeing. portAudioIndex is never stored: an audio
 * route names its device, and apply finds that name on the machine it runs on.
 */

import { createHash } from "crypto"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import os from "os"
import { join } from "path"
import { parseBundle, sha256, type Bundle } from "./app-config-engine"
import { controllerKey, mixxxAdapter, SETUP_FILE, type ControllerEntry, type MixxxSetup, type SoundDeviceEntry, type SoundIo } from "./app-config-mixxx"
import { irisFetch } from "./iris-api"
import { listBloqFiles, uploadFileVerified } from "./platform-atlas-files"

export const RIG_SCHEMA = "mixxx-rig"
export const RIG_LIST = "Rigs"
export const pageTitle = (rig: string) => `Mixxx rig — ${rig}`

/** The dataset's fields. Everything a person might change is its own column, not a JSON blob. */
export const RIG_FIELDS = [
  { key: "rig", label: "Rig", type: "text", required: true },
  { key: "kind", label: "Kind", type: "enum", options: ["controller", "controller_file", "audio_route", "audio_settings"], required: true },
  { key: "device_name", label: "Device name (as macOS lists it)", type: "text" },
  { key: "cfg_key", label: "mixxx.cfg key", type: "text" },
  { key: "mapping_file", label: "Mapping file", type: "text" },
  { key: "mapping_sha256", label: "Mapping sha256", type: "text" },
  { key: "mapping_file_id", label: "Mapping attachment id", type: "number" },
  { key: "location", label: "Mapping location", type: "enum", options: ["user", "system"] },
  { key: "enabled", label: "Enabled", type: "boolean" },
  { key: "io", label: "Direction", type: "enum", options: ["output", "input"] },
  { key: "type", label: "Route (Master, Headphones, Booth, Deck, …)", type: "text" },
  { key: "channel", label: "First channel", type: "number" },
  { key: "channel_count", label: "Channel count", type: "number" },
  { key: "index", label: "Route index (deck/mic number, not the device index)", type: "number" },
  { key: "api", label: "Sound API", type: "text" },
  { key: "samplerate", label: "Sample rate", type: "number" },
  { key: "latency", label: "Latency setting", type: "number" },
  { key: "sync_buffers", label: "Sync buffers", type: "number" },
  { key: "deck_count", label: "Deck count", type: "number" },
  { key: "force_network_clock", label: "Force network clock", type: "number" },
  { key: "extra", label: "Other attributes, kept verbatim", type: "object" },
]

export interface RigRow {
  external_id: string
  [field: string]: unknown
}

const SETTINGS_NUMERIC = ["samplerate", "latency", "sync_buffers", "deck_count", "force_network_clock"]
const IO_KNOWN = ["channel", "channel_count", "index", "type"]
const num = (v: string | undefined) => (v !== undefined && /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v)
const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v))

// ── setup ⇄ rows ────────────────────────────────────────────────────────────────────────────

export interface MappingRef {
  sha256: string
  fileId: number | null
}

/**
 * The rows for one rig. `mappings` is every file of the controllers dir (a mapping XML and the
 * scripts it loads) — one `controller_file` row each, so a script travels even though no cfg
 * entry names it. `midiNames` fills device_name for a controller plugged in at export, so a
 * person reading the dataset sees "PIONEER DDJ-T1", not only the cfg key.
 */
export function setupToRows(rig: string, setup: MixxxSetup, mappings: Record<string, MappingRef>, midiNames: string[] = []): RigRow[] {
  const rows: RigRow[] = []
  for (const [file, m] of Object.entries(mappings)) {
    rows.push({ external_id: `${rig}/file/${file}`, rig, kind: "controller_file", mapping_file: file, mapping_sha256: m.sha256, mapping_file_id: m.fileId })
  }
  for (const c of setup.controllers) {
    rows.push({
      external_id: `${rig}/controller/${c.key}`,
      rig,
      kind: "controller",
      device_name: midiNames.find((n) => controllerKey(n) === c.key) ?? "",
      cfg_key: c.key,
      mapping_file: c.mapping,
      location: c.location,
      enabled: c.enabled,
    })
  }
  if (setup.sound) {
    const { api, ...rest } = setup.sound.attrs
    const settings: RigRow = { external_id: `${rig}/audio-settings`, rig, kind: "audio_settings", api: api ?? "" }
    const extra: Record<string, string> = {}
    for (const [k, v] of Object.entries(rest)) {
      if (SETTINGS_NUMERIC.includes(k)) settings[k] = num(v)
      else extra[k] = v
    }
    if (Object.keys(extra).length) settings.extra = extra
    rows.push(settings)
    for (const d of setup.sound.devices) {
      for (const c of d.io) {
        const a = c.attrs
        const extraIo = Object.fromEntries(Object.entries(a).filter(([k]) => !IO_KNOWN.includes(k)))
        const row: RigRow = {
          external_id: `${rig}/${c.tag}/${a.type ?? "route"}/${a.index ?? "0"}`,
          rig,
          kind: "audio_route",
          device_name: d.name,
          io: c.tag,
          type: a.type ?? "",
          channel: num(a.channel),
          channel_count: num(a.channel_count),
          index: num(a.index),
        }
        if (Object.keys(d.attrs).length || Object.keys(extraIo).length) row.extra = { ...(Object.keys(d.attrs).length ? { device: d.attrs } : {}), ...(Object.keys(extraIo).length ? { io: extraIo } : {}) }
        rows.push(row)
      }
    }
  }
  return sortRows(rows)
}

export interface RigFromRows {
  setup: MixxxSetup
  /** mapping file name → where its bytes are and what they must hash to. */
  mappings: Record<string, MappingRef>
  errors: string[]
}

/** The inverse — and the place a hand-edited row takes effect. Bad rows are errors, never guesses. */
export function rowsToSetup(rows: RigRow[]): RigFromRows {
  const errors: string[] = []
  const controllers: ControllerEntry[] = []
  const mappings: Record<string, MappingRef> = {}
  let attrs: Record<string, string> | null = null
  const devices = new Map<string, SoundDeviceEntry>()

  for (const r of sortRows(rows)) {
    const id = r.external_id
    if (r.kind === "controller") {
      const key = str(r.cfg_key)?.trim() || (str(r.device_name) ? controllerKey(String(r.device_name)) : "")
      const file = str(r.mapping_file)?.trim() ?? ""
      if (!key || !file) {
        errors.push(`${id}: a controller needs cfg_key (or device_name) and mapping_file`)
        continue
      }
      const location = r.location === "system" ? "system" : "user"
      controllers.push({ key, mapping: file, location, enabled: r.enabled === true || r.enabled === 1 || r.enabled === "1" || r.enabled === "true" })
    } else if (r.kind === "controller_file") {
      const file = str(r.mapping_file)?.trim() ?? ""
      const sha = str(r.mapping_sha256)?.trim().toLowerCase() ?? ""
      if (!file || /[/\\]/.test(file)) errors.push(`${id}: a controller_file needs a plain mapping_file name`)
      else if (!/^[0-9a-f]{64}$/.test(sha)) errors.push(`${id}: mapping_sha256 must be the file's 64-hex sha256`)
      else {
        const fileId = r.mapping_file_id === null || r.mapping_file_id === undefined || r.mapping_file_id === "" ? null : Number(r.mapping_file_id)
        mappings[file] = { sha256: sha, fileId: Number.isFinite(fileId) ? fileId : null }
      }
    } else if (r.kind === "audio_settings") {
      attrs = { api: str(r.api) ?? "" }
      for (const k of SETTINGS_NUMERIC) if (str(r[k]) !== undefined) attrs[k] = String(r[k])
      for (const [k, v] of Object.entries((r.extra as Record<string, unknown>) ?? {})) attrs[k] = String(v)
    } else if (r.kind === "audio_route") {
      const name = str(r.device_name)?.trim()
      const io = r.io === "input" ? "input" : r.io === "output" ? "output" : null
      if (!name || !io || !str(r.type)) {
        errors.push(`${id}: an audio route needs device_name, io (output|input) and type`)
        continue
      }
      const extra = (r.extra as { device?: Record<string, unknown>; io?: Record<string, unknown> }) ?? {}
      const dev = devices.get(name) ?? { name, attrs: {}, io: [] }
      for (const [k, v] of Object.entries(extra.device ?? {})) dev.attrs[k] = String(v)
      const a: Record<string, string> = { type: String(r.type) }
      for (const k of ["channel", "channel_count", "index"]) if (str(r[k]) !== undefined) a[k] = String(r[k])
      for (const [k, v] of Object.entries(extra.io ?? {})) a[k] = String(v)
      dev.io.push({ tag: io, attrs: a } satisfies SoundIo)
      devices.set(name, dev)
    } else {
      errors.push(`${id}: unknown kind ${JSON.stringify(r.kind)}`)
    }
  }
  if (devices.size && !attrs) errors.push(`audio routes without an audio_settings row`)
  for (const c of controllers) {
    if (c.location === "user" && !mappings[c.mapping]) errors.push(`controller ${c.key}: no controller_file row for ${c.mapping}`)
  }
  const sound = attrs ? { attrs, devices: [...devices.values()] } : null
  return { setup: { schema: 1, controllers, sound }, mappings, errors }
}

// ── rows: canonical form, hash, which rig ───────────────────────────────────────────────────

const canon = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(canon)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v as object)
            .sort()
            .filter((k) => (v as any)[k] !== undefined)
            .map((k) => [k, canon((v as any)[k])]),
        )
      : v

export function sortRows(rows: RigRow[]): RigRow[] {
  return [...rows].sort((a, b) => (a.external_id < b.external_id ? -1 : a.external_id > b.external_id ? 1 : 0))
}

/** What "the same rows" means: key order, row order, and null-vs-absent are not edits. */
export function rowsSha(rows: RigRow[]): string {
  const clean = sortRows(rows).map((r) => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null && v !== "" && v !== undefined)))
  return createHash("sha256").update(JSON.stringify(canon(clean))).digest("hex").slice(0, 16)
}

/** Dataset records ({external_id, data}) as rows. */
export function recordsToRows(records: any[]): RigRow[] {
  return records.filter((r) => r?.external_id).map((r) => ({ external_id: String(r.external_id), ...(r.data ?? {}) }))
}

export function pickRig(rows: RigRow[], wanted: string | undefined, hostname: string): { rig: string } | { error: string } {
  const rigs = [...new Set(rows.map((r) => String(r.rig ?? "")).filter(Boolean))].sort()
  if (wanted) return rigs.includes(wanted) ? { rig: wanted } : { error: `no rig "${wanted}" in ${RIG_SCHEMA}; rigs here: ${rigs.join(", ") || "none"}` }
  if (rigs.length === 1) return { rig: rigs[0] }
  const host = shortHost(hostname)
  if (rigs.includes(host)) return { rig: host }
  return { error: rigs.length ? `${rigs.length} rigs here (${rigs.join(", ")}); say which with --rig <name>` : `no rig in ${RIG_SCHEMA} yet; export one first` }
}

export const shortHost = (h: string) => h.replace(/\.local$/i, "").trim() || "mixxx"

// ── the page ────────────────────────────────────────────────────────────────────────────────

const FENCE = "```json mixxx-rig"

export function renderRigPage(rig: string, rows: RigRow[], bloqId: number): string {
  const sorted = sortRows(rows)
  const routes = sorted.filter((r) => r.kind === "audio_route")
  const ctl = sorted.filter((r) => r.kind === "controller")
  const fileRows = sorted.filter((r) => r.kind === "controller_file")
  const block = JSON.stringify({ rig, generated_from: rowsSha(sorted), rows: sorted.map((r) => canon(r)) }, null, 2)
  return [
    `# ${pageTitle(rig)}`,
    "",
    `The Mixxx setup of **${rig}**: which controller mappings it loads and where its audio goes. ` +
      `Restore it on any Mac with \`iris app-config apply mixxx --bloq ${bloqId} --rig ${rig}\`, or by hand (below).`,
    "",
    "## Controllers",
    "",
    "| cfg key | device | mapping | enabled |",
    "|---|---|---|---|",
    ...ctl.map((r) => `| ${r.cfg_key} | ${r.device_name || "—"} | ${r.mapping_file}${r.location === "system" ? " (ships with Mixxx)" : ""} | ${r.enabled ? "yes" : "no"} |`),
    "",
    "| file | attachment | sha256 |",
    "|---|---|---|",
    ...fileRows.map((r) => `| ${r.mapping_file} | ${r.mapping_file_id ? `#${r.mapping_file_id}` : "—"} | \`${String(r.mapping_sha256).slice(0, 12)}…\` |`),
    "",
    "## Audio",
    "",
    "| route | device | channels |",
    "|---|---|---|",
    ...routes.map((r) => `| ${r.type}${r.io === "input" ? " (in)" : ""} | ${r.device_name} | ${Number(r.channel) + 1}–${Number(r.channel) + Number(r.channel_count)} |`),
    "",
    "## Where this lives",
    "",
    `- **The dataset \`${RIG_SCHEMA}\` on board #${bloqId} is the source of truth.** This page is generated from it.`,
    "- You can edit **either** the dataset or the block below — not both before an apply. The next apply takes whichever one changed (and copies it into the other), and refuses if both changed.",
    "- Devices are named, never numbered: apply finds each name in that Mac's audio device list.",
    "",
    "By hand:",
    "",
    "```bash",
    `iris atlas files download ${bloqId} --file <mapping_file_id> --out .   # prints sha256 — must equal mapping_sha256`,
    `iris datasets export -s ${RIG_SCHEMA} --bloq ${bloqId} --format json -o rig.json   # edit, then:`,
    `iris datasets import rig.json -s ${RIG_SCHEMA} --bloq ${bloqId}`,
    `iris atlas pull ${bloqId} ./board && iris atlas diff ./board && iris atlas push ./board   # or edit this page`,
    "```",
    "",
    "## Rows",
    "",
    FENCE,
    block,
    "```",
    "",
  ].join("\n")
}

export function parseRigPage(content: string): { rig: string; generatedFrom: string; rows: RigRow[] } | { error: string } {
  const start = content.indexOf(FENCE)
  if (start < 0) return { error: `the page has no ${FENCE} block` }
  const body = content.slice(start + FENCE.length)
  const end = body.indexOf("\n```")
  if (end < 0) return { error: "the rows block is not closed with ```" }
  try {
    const j = JSON.parse(body.slice(0, end))
    if (!Array.isArray(j.rows) || j.rows.some((r: any) => typeof r?.external_id !== "string")) return { error: "the rows block has no rows[] with external_id" }
    return { rig: String(j.rig ?? ""), generatedFrom: String(j.generated_from ?? ""), rows: j.rows }
  } catch (e: any) {
    return { error: `the rows block is not valid JSON: ${e?.message ?? e}` }
  }
}

export type Reconcile =
  | { action: "in-sync" | "no-page"; rows: RigRow[] }
  | { action: "page-edited"; rows: RigRow[]; changed: string[] }
  | { action: "dataset-edited"; rows: RigRow[]; changed: string[] }
  | { action: "conflict"; changed: string[]; reason: string }

/** external_ids whose content differs between two row sets. */
export function changedIds(a: RigRow[], b: RigRow[]): string[] {
  const byId = (rows: RigRow[]) => new Map(rows.map((r) => [r.external_id, rowsSha([r])]))
  const x = byId(a)
  const y = byId(b)
  return [...new Set([...x.keys(), ...y.keys()])].filter((id) => x.get(id) !== y.get(id)).sort()
}

export function reconcile(datasetRows: RigRow[], page: string | null, prefer?: "page" | "dataset"): Reconcile {
  if (page === null) return { action: "no-page", rows: datasetRows }
  const parsed = parseRigPage(page)
  if ("error" in parsed) {
    if (prefer === "dataset") return { action: "dataset-edited", rows: datasetRows, changed: [] }
    return { action: "conflict", changed: [], reason: `${parsed.error}. Fix the page, or pass --prefer dataset to regenerate it.` }
  }
  const ds = rowsSha(datasetRows)
  const pg = rowsSha(parsed.rows)
  if (ds === pg) return { action: "in-sync", rows: datasetRows }
  const changed = changedIds(datasetRows, parsed.rows)
  const pageMoved = pg !== parsed.generatedFrom
  const datasetMoved = ds !== parsed.generatedFrom
  if (prefer === "page" || (pageMoved && !datasetMoved)) return { action: "page-edited", rows: parsed.rows, changed }
  if (prefer === "dataset" || (datasetMoved && !pageMoved)) return { action: "dataset-edited", rows: datasetRows, changed }
  return {
    action: "conflict",
    changed,
    reason: `both the dataset ${RIG_SCHEMA} and the page "${pageTitle(parsed.rig)}" were edited since the page was generated (rows: ${changed.join(", ")}). Nothing was applied. Pass --prefer page or --prefer dataset.`,
  }
}

// ── rows → a bundle the engine already knows how to apply ───────────────────────────────────

/** Fetches a mapping's bytes; must be checked against the row's sha256 by the caller. */
export type FetchMapping = (name: string, ref: MappingRef) => Promise<Buffer>

export async function bundleFromRows(rows: RigRow[], fetchMapping: FetchMapping, now = new Date()): Promise<Bundle> {
  const { setup, mappings, errors } = rowsToSetup(rows)
  if (errors.length) throw new Error(`the rig's rows cannot be applied:\n    ${errors.join("\n    ")}`)
  const files: Record<string, string> = {}
  for (const [name, ref] of Object.entries(mappings)) {
    const bytes = await fetchMapping(name, ref)
    const got = sha256(bytes)
    if (got !== ref.sha256) throw new Error(`${name}: the attachment's sha256 is ${got}, the row says ${ref.sha256}; nothing was applied`)
    files[`controllers/${name}`] = bytes.toString("utf8")
  }
  files[SETUP_FILE] = JSON.stringify(setup, null, 2) + "\n"
  const sums: Bundle["manifest"]["files"] = {}
  for (const [rel, text] of Object.entries(files)) sums[rel] = { sha256: sha256(text), bytes: Buffer.byteLength(text) }
  const bundle: Bundle = {
    manifest: {
      schema: 1,
      app: "mixxx",
      createdAt: now.toISOString(),
      host: { fingerprint: "atlas", platform: "atlas", arch: "atlas" },
      containsSecrets: false,
      files: sums,
      dropped: [],
      info: { source: RIG_SCHEMA },
    },
    files,
  }
  // The same gate a downloaded bundle file goes through: paths and checksums.
  return parseBundle(mixxxAdapter, JSON.stringify(bundle))
}

// ── Atlas I/O ───────────────────────────────────────────────────────────────────────────────

async function api(path: string, init?: RequestInit): Promise<any> {
  const res = await irisFetch(path, init)
  const text = await res.text()
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path.split("?")[0]}: HTTP ${res.status} ${text.trim().slice(0, 200)}`)
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

export async function ensureRigSchema(bloqId: number): Promise<"exists" | "created"> {
  const res = await irisFetch(`/api/v1/atlas/schemas/${RIG_SCHEMA}?bloq_id=${bloqId}`)
  if (res.ok) {
    const j = (await res.json().catch(() => null)) as any
    const s = j?.data ?? j
    if (s && Number(s.bloq_id ?? bloqId) === bloqId) return "exists"
  }
  await api("/api/v1/atlas/schemas", {
    method: "POST",
    body: JSON.stringify({ name: "Mixxx rig", slug: RIG_SCHEMA, bloq_id: bloqId, fields: { fields: RIG_FIELDS } }),
  })
  return "created"
}

/** Every record in the dataset on this board, paging past the server's cap. */
export async function fetchRigRecords(bloqId: number): Promise<any[]> {
  const out: any[] = []
  for (let page = 1; page < 100; page++) {
    const j = await api(`/api/v1/atlas/datasets/${RIG_SCHEMA}?per_page=200&page=${page}&bloq_id=${bloqId}`)
    const recs = j?.data?.records
    const list: any[] = Array.isArray(recs?.data) ? recs.data : Array.isArray(recs) ? recs : []
    out.push(...list)
    const last = recs?.last_page ?? 1
    if (page >= last || list.length === 0) break
  }
  return out
}

/** Upserts on external_id; deletes only this rig's rows that are gone. Returns counts. */
export async function writeRigRows(bloqId: number, rig: string, rows: RigRow[]): Promise<{ created: number; updated: number; deleted: number }> {
  const records = rows.map(({ external_id, ...data }) => ({ external_id, data: Object.fromEntries(Object.entries(data).filter(([, v]) => v !== undefined)) }))
  const j = await api(`/api/v1/atlas/datasets/${RIG_SCHEMA}/import`, {
    method: "POST",
    body: JSON.stringify({ records, validate: true, bloq_id: bloqId }),
  })
  const d = j?.data ?? {}
  if (d.failed_count) throw new Error(`${d.failed_count} row(s) rejected by ${RIG_SCHEMA}: ${JSON.stringify(d.failed).slice(0, 300)}`)
  const keep = new Set(rows.map((r) => r.external_id))
  let deleted = 0
  for (const r of await fetchRigRecords(bloqId)) {
    if (r?.data?.rig === rig && !keep.has(String(r.external_id))) {
      await api(`/api/v1/atlas/datasets/${RIG_SCHEMA}/${r.id}?bloq_id=${bloqId}`, { method: "DELETE" })
      deleted++
    }
  }
  return { created: d.created ?? 0, updated: d.updated ?? 0, deleted }
}

export async function findRigPage(userId: number, bloqId: number, rig: string): Promise<{ id: number; content: string } | null> {
  const j = await api(`/api/v1/user/${userId}/bloqs/${bloqId}/items?per_page=500`)
  const d = j?.data
  const items: any[] = Array.isArray(d) ? d : Array.isArray(d?.data) ? d.data : Array.isArray(d?.items) ? d.items : []
  const hits = items.filter((i) => String(i?.title ?? "").trim() === pageTitle(rig)).sort((a, b) => Number(b.id) - Number(a.id))
  if (!hits.length) return null
  // The list endpoint may trim content; read the item itself.
  const one = await api(`/api/v1/user/bloqs/list/item/${hits[0].id}`)
  const item = one?.data ?? one
  return { id: Number(hits[0].id), content: String(item?.content ?? hits[0].content ?? "") }
}

/** Creates the page (in list "Rigs", made if missing) or updates it — only if its text changed. */
export async function writeRigPage(userId: number, bloqId: number, rig: string, content: string): Promise<{ id: number; action: "created" | "updated" | "unchanged" }> {
  const existing = await findRigPage(userId, bloqId, rig)
  if (existing) {
    if (existing.content.trim() === content.trim()) return { id: existing.id, action: "unchanged" }
    await api(`/api/v1/user/bloqs/list/item/${existing.id}`, { method: "PUT", body: JSON.stringify({ title: pageTitle(rig), content }) })
    return { id: existing.id, action: "updated" }
  }
  const lj = await api(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`)
  const lists: any[] = Array.isArray(lj?.data) ? lj.data : Array.isArray(lj) ? lj : []
  let list = lists.find((l) => String(l?.name ?? "").trim() === RIG_LIST)
  if (!list) list = (await api(`/api/v1/user/${userId}/bloqs/${bloqId}/lists`, { method: "POST", body: JSON.stringify({ name: RIG_LIST }) }))?.data
  if (!list?.id) throw new Error(`could not find or create the "${RIG_LIST}" list on bloq #${bloqId}`)
  const created = await api(`/api/v1/user/${userId}/bloqs/${bloqId}/lists/${list.id}/items`, {
    method: "POST",
    body: JSON.stringify({ title: pageTitle(rig), content }),
  })
  const id = Number(created?.data?.id ?? created?.id)
  if (!Number.isFinite(id)) throw new Error("the page was not created (no id came back)")
  return { id, action: "created" }
}

async function fetchBytes(url: string): Promise<Buffer> {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading ${url.split("?")[0]}`)
  return Buffer.from(await res.arrayBuffer())
}

/**
 * The attachment id holding exactly these bytes: an existing one with the same name and sha256
 * (newest first — #569 already holds older versions under the same names), else a new upload,
 * read back before it counts. Nothing is ever deleted or overwritten.
 */
export async function attachMapping(userId: number, bloqId: number, name: string, bytes: Buffer, rig: string): Promise<{ id: number; reused: boolean }> {
  const want = sha256(bytes)
  const listed = await listBloqFiles(userId, bloqId)
  if (!listed.ok) throw new Error(listed.error)
  for (const f of listed.files.filter((f) => f.name === name && f.url).sort((a, b) => b.id - a.id)) {
    if (f.size !== null && f.size !== bytes.length) continue
    if (sha256(await fetchBytes(String(f.url))) === want) return { id: f.id, reused: true }
  }
  const dir = mkdtempSync(join(os.tmpdir(), "iris-mixxx-"))
  try {
    const path = join(dir, name)
    writeFileSync(path, bytes)
    const r = await uploadFileVerified(userId, bloqId, path, { title: `${name} — ${rig} (sha256 ${want.slice(0, 12)})` })
    if (!r.ok) throw new Error(`upload of ${name} failed: ${r.error}`)
    return { id: r.id, reused: false }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** A mapping's bytes by attachment id, or — when a hand-written row has no id — by name and sha256. */
export function mappingFetcher(userId: number, bloqId: number): FetchMapping {
  let files: Awaited<ReturnType<typeof listBloqFiles>> | null = null
  return async (name, ref) => {
    files ??= await listBloqFiles(userId, bloqId)
    if (!files.ok) throw new Error(files.error)
    if (ref.fileId !== null) {
      const f = files.files.find((x) => x.id === ref.fileId)
      if (!f?.url) throw new Error(`${name}: attachment #${ref.fileId} is not on bloq #${bloqId}`)
      return fetchBytes(f.url)
    }
    for (const f of files.files.filter((x) => x.name === name && x.url).sort((a, b) => b.id - a.id)) {
      const bytes = await fetchBytes(String(f.url))
      if (sha256(bytes) === ref.sha256) return bytes
    }
    throw new Error(`${name}: no attachment on bloq #${bloqId} has sha256 ${ref.sha256}`)
  }
}
