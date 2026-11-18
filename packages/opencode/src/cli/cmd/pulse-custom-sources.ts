/**
 * Your own Pulse sources (#190626) — `~/.iris/pulse/sources/<id>.json`.
 *
 * The nine built-in sources cover a Mac with git, Claude Code, Messages and Gmail. Plenty of work
 * lives somewhere else: WhatsApp, Slack, a CRM export, a ticket system. pulse-core already lets a
 * script add a stop or replace one by id (`extend`); this file is what lets a PERSON do it without
 * changing the CLI — a JSON file that names a command, and the command prints what it found.
 *
 *   {
 *     "id": "whatsapp",
 *     "label": "WhatsApp",
 *     "command": ["python3", "~/bin/wa-search.py"],
 *     "timeout_ms": 20000
 *   }
 *
 * The command is run WITHOUT a shell, and gets the question in its environment:
 *
 *   PULSE_KEYWORD          the topic as typed
 *   PULSE_VARIANTS         JSON array of the spellings the built-ins also match
 *   PULSE_WINDOW_DAYS      the window
 *   PULSE_SINCE            ISO start of the window
 *   PULSE_PRIOR_SINCE      ISO start of the window before it (for hits_prior)
 *   PULSE_LIMIT            items the brief shows (count everything; list this many)
 *
 * It prints one JSON object on stdout:
 *
 *   { "items": [{ "when": "2026-10-20T14:00:00Z", "where": "chat: Vanguard", "text": "…" }],
 *     "hits": 14,            // optional — defaults to items.length; set it when you list fewer
 *     "hits_prior": 9,       // optional — leave it OUT if you cannot see the prior window
 *     "capped": false }      // optional — true when your search stopped at its own ceiling
 *
 * or, when it could not look: { "unavailable": "why" }.
 *
 * The built-ins' two rules hold here too (see pulse-check-sweep.ts): a command that fails, times
 * out or prints something that is not that object is NOT SEARCHED, with the reason — never zero
 * hits; and `hits_prior` is absent unless the command gave one, so no baseline is invented.
 *
 * Only the home directory is read. A repository's own `.iris/` is deliberately NOT: `iris pulse
 * check` runs inside whatever repo you are in, and a cloned repo must not be able to run a command
 * on your machine just because you checked a topic from inside it.
 */

import { execFile } from "child_process"
import { existsSync, readdirSync, readFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { extend, type Source, type Stop } from "../../pulse/core"
import {
  TOPIC_SOURCES,
  keywordVariants,
  markCapped,
  type Hit,
  type SourceSweep,
  type SweepOptions,
} from "./pulse-check-sweep"
import type { TopicReading } from "./pulse-topic-script"

export interface CustomSourceDef {
  id: string
  label: string
  command: string[]
  timeoutMs: number
  /** The file it came from, so a listing can say where to edit it. */
  file: string
  /** True when the id is a built-in's, i.e. this file replaces that source. */
  replaces: boolean
}

export interface CustomSourceLoad {
  sources: CustomSourceDef[]
  /** One entry per file that could not be used, with why. Never silently skipped. */
  errors: Array<{ file: string; error: string }>
}

export const CUSTOM_SOURCES_DIR = join(homedir(), ".iris", "pulse", "sources")
const ID = /^[a-z][a-z0-9_]{0,31}$/
const DEFAULT_TIMEOUT_MS = 20000
const MAX_TIMEOUT_MS = 120000

function expandHome(p: string): string {
  return p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p
}

/** Read every `*.json` in the directory. A bad file is reported, never fatal to the rest. */
export function loadCustomSources(dir: string = CUSTOM_SOURCES_DIR): CustomSourceLoad {
  const out: CustomSourceLoad = { sources: [], errors: [] }
  if (!existsSync(dir)) return out
  const seen = new Set<string>()
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    const file = join(dir, name)
    const bad = (error: string) => out.errors.push({ file, error })
    let raw: any
    try {
      raw = JSON.parse(readFileSync(file, "utf8"))
    } catch (e: any) {
      bad(`not valid JSON — ${String(e?.message ?? e).slice(0, 120)}`)
      continue
    }
    const id = typeof raw?.id === "string" ? raw.id.trim() : ""
    if (!ID.test(id)) {
      bad(`"id" must be lowercase letters, digits or _ (got ${JSON.stringify(raw?.id)})`)
      continue
    }
    if (seen.has(id)) {
      bad(`id "${id}" is already defined by another file`)
      continue
    }
    const command = raw?.command
    if (!Array.isArray(command) || !command.length || !command.every((c: unknown) => typeof c === "string" && c.length)) {
      bad(`"command" must be a non-empty array of strings, e.g. ["python3", "~/bin/search.py"] — it is run without a shell`)
      continue
    }
    const t = raw?.timeout_ms === undefined ? DEFAULT_TIMEOUT_MS : Number(raw.timeout_ms)
    if (!Number.isFinite(t) || t < 1000 || t > MAX_TIMEOUT_MS) {
      bad(`"timeout_ms" must be between 1000 and ${MAX_TIMEOUT_MS}`)
      continue
    }
    seen.add(id)
    out.sources.push({
      id,
      label: typeof raw?.label === "string" && raw.label.trim() ? raw.label.trim() : id,
      command: command.map(expandHome),
      timeoutMs: t,
      file,
      replaces: (TOPIC_SOURCES as readonly string[]).includes(id),
    })
  }
  return out
}

function runCommand(def: CustomSourceDef, env: Record<string, string>): Promise<{ stdout: string; error?: string }> {
  return new Promise((resolve) => {
    execFile(
      def.command[0],
      def.command.slice(1),
      { env: { ...process.env, ...env }, timeout: def.timeoutMs, maxBuffer: 16 * 1024 * 1024, encoding: "utf8" },
      (err, stdout, stderr) => {
        if (!err) return resolve({ stdout })
        const why = (err as any).killed
          ? `timed out after ${def.timeoutMs}ms`
          : (err as any).code === "ENOENT"
            ? `command not found: ${def.command[0]}`
            : `exited ${(err as any).code ?? "with an error"}${stderr ? ` — ${String(stderr).trim().slice(0, 160)}` : ""}`
        resolve({ stdout, error: why })
      },
    )
  })
}

/** What the command printed, as a sweep — or not searched, with why. Exported for the tests. */
export function parseCustomOutput(def: Pick<CustomSourceDef, "id" | "file">, stdout: string, limit: number): SourceSweep {
  const shut = (reason: string): SourceSweep => ({ source: def.id, searched: false, unavailableReason: reason, hits: 0, items: [] })
  let body: any
  try {
    body = JSON.parse(stdout.trim())
  } catch {
    return shut(`its command did not print JSON (${def.file})`)
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return shut(`its command printed JSON that is not an object (${def.file})`)
  if (typeof body.unavailable === "string" && body.unavailable.trim()) return shut(body.unavailable.trim().slice(0, 300))
  if (!Array.isArray(body.items)) return shut(`its command's JSON has no "items" array (${def.file})`)

  const items: Hit[] = body.items
    .filter((i: any) => i && typeof i === "object" && typeof i.where === "string" && i.where)
    .map((i: any) => ({
      where: i.where.slice(0, 300),
      ...(typeof i.when === "string" && !Number.isNaN(Date.parse(i.when)) ? { when: i.when } : {}),
      ...(typeof i.text === "string" && i.text ? { text: i.text.slice(0, 500) } : {}),
    }))
  const hits = Number.isInteger(body.hits) && body.hits >= items.length ? body.hits : items.length
  const prior = Number.isInteger(body.hits_prior) && body.hits_prior >= 0 ? body.hits_prior : undefined
  const epochs = items.map((i) => (i.when ? Math.floor(Date.parse(i.when) / 1000) : NaN)).filter((n) => !Number.isNaN(n))
  const sweep: SourceSweep = {
    source: def.id,
    searched: true,
    hits,
    ...(prior !== undefined ? { hitsPrior: prior } : {}),
    lastHitEpoch: epochs.length ? Math.max(...epochs) : undefined,
    items: items.slice(0, limit),
  }
  return markCapped(sweep, body.capped === true, hits)
}

export async function sweepCustom(def: CustomSourceDef, opts: SweepOptions, now = Date.now()): Promise<SourceSweep> {
  const day = 864e5
  const env = {
    PULSE_KEYWORD: opts.keyword,
    PULSE_VARIANTS: JSON.stringify(keywordVariants(opts.keyword)),
    PULSE_WINDOW_DAYS: String(opts.windowDays),
    PULSE_SINCE: new Date(now - opts.windowDays * day).toISOString(),
    PULSE_PRIOR_SINCE: new Date(now - 2 * opts.windowDays * day).toISOString(),
    PULSE_LIMIT: String(opts.limit),
  }
  const { stdout, error } = await runCommand(def, env)
  if (error) return { source: def.id, searched: false, unavailableReason: `${def.label}: ${error} (${def.file})`, hits: 0, items: [] }
  return parseCustomOutput(def, stdout, opts.limit)
}

export function customStop(def: CustomSourceDef): Stop<SweepOptions, TopicReading, SourceSweep> {
  const source: Source<SweepOptions, TopicReading> = {
    id: def.id,
    label: def.label,
    async read(q) {
      const sweep = await sweepCustom(def, q)
      return {
        sweep,
        hits: sweep.hits,
        items: sweep.items,
        measured: sweep.searched,
        reason: sweep.unavailableReason,
        floor: !!sweep.capped,
        provenance: [`${def.command.join(" ")} (${def.file})`],
      }
    },
  }
  return {
    id: def.id,
    source,
    extract: (r) => r.sweep,
    unavailable: (reason) => ({ source: def.id, searched: false, unavailableReason: reason, hits: 0, items: [] }),
  }
}

let registered: CustomSourceLoad | null = null

/**
 * Load the directory and add each source to the topic route. Cached for the process: the bare
 * `iris pulse <topic>` and `iris pulse sources` both call this, and one run should read the folder
 * once and report one consistent set. (A second `extend` would not duplicate stops — `scriptFor`
 * replaces by id — so the cache is about reading once, not about correctness of the route.)
 */
export function registerCustomSources(dir: string = CUSTOM_SOURCES_DIR): CustomSourceLoad {
  if (registered) return registered
  registered = loadCustomSources(dir)
  if (registered.sources.length) extend("topic", ...registered.sources.map(customStop))
  return registered
}

/** For tests: forget what was registered (pair with resetExtensions("topic")). */
export function resetCustomSources(): void {
  registered = null
}
