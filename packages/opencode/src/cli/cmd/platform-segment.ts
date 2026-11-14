import { readFileSync } from "fs"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { irisFetch, requireAuth, bold, dim, warn, writeJson, isJsonMode, emitJsonError, handleApiError } from "./iris-api"
import {
  FilterError,
  mergeFilters,
  parseFilterArgs,
  renderBreakdown,
  renderMembers,
  watchSignature,
  FILTER_KEYS,
  type Breakdown,
  type Filters,
  type MemberRow,
} from "./segment-core"

// ─── iris segment — saved filters over a board's leads (#193484) ─────────────
//
// A segment is a named set of filters over one board's leads, owned by the board (fl-api
// SomSegment). A SOM campaign can target one instead of the whole board
// (`iris som campaign target`). Every count says how many leads had the field at all: a
// filter on a field nobody has filled is "unknown", never "0 match".

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

interface Segment {
  id: number
  bloq_id: number
  name: string
  filters: Filters
  created_by: number | null
  created_at: string | null
  updated_at: string | null
  breakdown: Breakdown | null
}

interface MembersPage {
  data: MemberRow[]
  meta: { total: number; per_page: number; current_page: number; last_page: number }
}

const FILTER_HELP = `filter key=value (repeatable). Keys: ${Object.keys(FILTER_KEYS).join(", ")}. Lists are comma-separated; counts take 5k/1.2m; a bare bool key means true`

/** Say it and set a non-zero exit — in JSON mode as one object on stdout. */
function fail(message: string, extra?: Record<string, unknown>): void {
  if (isJsonMode()) emitJsonError(message, extra)
  else prompts.log.error(message)
  process.exitCode = 1
}

/** --filter flags + --filters-file -> filters, or null after reporting why not. */
function filtersFromArgs(args: { filter?: unknown; "filters-file"?: unknown }): Filters | null {
  try {
    let base: Record<string, unknown> = {}
    const file = args["filters-file"] as string | undefined
    if (file) {
      const parsed = JSON.parse(readFileSync(file, "utf-8"))
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new FilterError(`${file} must hold a JSON object of filters`)
      base = (parsed.filters && typeof parsed.filters === "object" ? parsed.filters : parsed) as Record<string, unknown>
    }
    const flags = ([] as unknown[]).concat(args.filter ?? []).map(String)
    return parseFilterArgs(flags, base)
  } catch (e) {
    fail(e instanceof FilterError ? e.message : `Could not read filters: ${(e as Error).message}`)
    return null
  }
}

async function api<T>(path: string, init: RequestInit, action: string): Promise<T | null> {
  const res = await irisFetch(path, init, RAICHU)
  if (res.ok) return ((await res.json()) as { data: T }).data
  if (res.status === 401 || res.status === 403 || res.status === 402) {
    await handleApiError(res, action)
    return null
  }
  let message = `API ${res.status}`
  try {
    const body = (await res.json()) as { message?: string; errors?: Record<string, string[]> }
    const first = body.errors ? Object.values(body.errors).flat()[0] : undefined
    message = first ?? body.message ?? message
  } catch {}
  fail(res.status === 404 ? `Not found (or not yours): ${message}` : message, { status: res.status, action })
  return null
}

function printSegmentHead(s: Segment) {
  console.log("")
  console.log(bold(`Segment #${s.id} ${s.name}`) + dim(`  board ${s.bloq_id}`))
}

function printBreakdown(b: Breakdown | null) {
  if (!b) return
  for (const line of renderBreakdown(b)) console.log(line.startsWith("  !") ? warn(line) : line)
}

function printMembers(page: MembersPage | undefined, label = "members") {
  if (!page) return
  console.log("")
  console.log(bold(`${label} ${dim(`(page ${page.meta.current_page}/${page.meta.last_page}, ${page.meta.total} total)`)}`))
  for (const line of renderMembers(page.data)) console.log(line)
}

// ── list ──────────────────────────────────────────────────────────────────────
const ListCmd = cmd({
  command: "list <bloq>",
  describe: "list a board's segments with their counts",
  builder: (y) =>
    y.positional("bloq", { type: "number", demandOption: true, describe: "board (bloq) id" })
     .option("json", { type: "boolean", describe: "JSON output" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const data = await api<{ segments: Segment[] }>(`/api/v1/bloqs/${args.bloq}/segments`, {}, "segment list")
    if (!data) return
    if (args.json) return writeJson(data.segments)
    console.log("")
    console.log(bold(`Segments on board ${args.bloq} ${dim(`(${data.segments.length})`)}`))
    if (data.segments.length === 0) console.log(dim(`  none — iris segment create ${args.bloq} --name "…" --filter key=value`))
    for (const s of data.segments) {
      const b = s.breakdown
      const keys = Object.keys(s.filters ?? {}).join(", ") || "(no filters: whole board)"
      console.log(`  #${String(s.id).padEnd(5)} ${s.name.padEnd(32)} ${b ? `${b.matched.toLocaleString("en-US")} of ${b.of.toLocaleString("en-US")}` : "?"}  ${dim(keys)}`)
    }
    console.log("")
  },
})

// ── show (+ --watch) ──────────────────────────────────────────────────────────
const ShowCmd = cmd({
  command: "show <id>",
  describe: "a segment's filter-by-filter breakdown and first members",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true })
     .option("watch", { type: "boolean", describe: "re-poll every few seconds and redraw only when counts change" })
     .option("interval", { type: "number", default: 5, describe: "--watch poll interval, seconds" })
     .option("json", { type: "boolean", describe: "JSON output (with --watch: one line per change)" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const load = () => api<{ segment: Segment; members: MembersPage }>(`/api/v1/segments/${args.id}`, {}, "segment show")

    const draw = (d: { segment: Segment; members: MembersPage }) => {
      if (args.json) {
        if (args.watch) process.stdout.write(JSON.stringify({ at: new Date().toISOString(), ...d }) + "\n")
        return
      }
      if (args.watch && process.stdout.isTTY) process.stdout.write("\x1b[2J\x1b[H")
      printSegmentHead(d.segment)
      printBreakdown(d.segment.breakdown)
      printMembers(d.members, "first members")
      if (args.watch) console.log(dim(`\n  watching — redraws when counts change (polling every ${args.interval}s; Ctrl-C to stop) · ${new Date().toLocaleTimeString()}`))
      console.log("")
    }

    const first = await load()
    if (!first) return
    if (!args.watch) {
      if (args.json) return writeJson(first)
      return draw(first)
    }

    // The simplest honest "live" until the SegmentUpdated push event is consumed: poll, and
    // redraw only when the counts, filters or name actually change.
    let last = watchSignature(first.segment)
    draw(first)
    const everyMs = Math.max(1, Number(args.interval) || 5) * 1000
    for (;;) {
      await new Promise((r) => setTimeout(r, everyMs))
      const next = await load().catch(() => null)
      if (!next) { process.exitCode = 0; continue }
      const sig = watchSignature(next.segment)
      if (sig !== last) {
        last = sig
        draw(next)
      }
    }
  },
})

// ── create ────────────────────────────────────────────────────────────────────
const CreateCmd = cmd({
  command: "create <bloq>",
  describe: "save a segment on a board",
  builder: (y) =>
    y.positional("bloq", { type: "number", demandOption: true, describe: "board (bloq) id" })
     .option("name", { type: "string", demandOption: true })
     .option("filter", { type: "string", array: true, describe: FILTER_HELP })
     .option("filters-file", { type: "string", describe: "JSON file with a filters object (flags win)" })
     .option("json", { type: "boolean" }),
  async handler(args) {
    const filters = filtersFromArgs(args)
    if (!filters) return
    if (!(await requireAuth())) return
    const data = await api<{ segment: Segment }>(`/api/v1/bloqs/${args.bloq}/segments`, {
      method: "POST",
      body: JSON.stringify({ name: args.name, filters }),
    }, "segment create")
    if (!data) return
    if (args.json) return writeJson(data.segment)
    prompts.log.success(`Created segment #${data.segment.id} ${data.segment.name}`)
    printSegmentHead(data.segment)
    printBreakdown(data.segment.breakdown)
    console.log("")
  },
})

// ── update ────────────────────────────────────────────────────────────────────
const UpdateCmd = cmd({
  command: "update <id>",
  describe: "change a segment: --filter adds/replaces keys, --unset removes them, --replace starts from empty",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true })
     .option("name", { type: "string" })
     .option("filter", { type: "string", array: true, describe: FILTER_HELP })
     .option("filters-file", { type: "string" })
     .option("unset", { type: "string", array: true, describe: "filter key(s) to remove" })
     .option("replace", { type: "boolean", describe: "replace all filters instead of merging" })
     .option("json", { type: "boolean" }),
  async handler(args) {
    const changes = filtersFromArgs(args)
    if (!changes) return
    const unset = ([] as unknown[]).concat(args.unset ?? []).map(String)
    const touchesFilters = Object.keys(changes).length > 0 || unset.length > 0 || args.replace
    if (!touchesFilters && args.name === undefined) {
      fail("Nothing to update — pass --filter, --unset, --replace or --name")
      return
    }
    if (!(await requireAuth())) return

    const body: Record<string, unknown> = {}
    if (args.name !== undefined) body.name = args.name
    if (touchesFilters) {
      let current: Filters = {}
      if (!args.replace) {
        const now = await api<{ segment: Segment }>(`/api/v1/segments/${args.id}`, {}, "segment update")
        if (!now) return
        current = now.segment.filters ?? {}
      }
      try {
        body.filters = mergeFilters(current, changes, unset)
      } catch (e) {
        fail((e as Error).message)
        return
      }
    }

    const data = await api<{ segment: Segment }>(`/api/v1/segments/${args.id}`, {
      method: "PATCH",
      body: JSON.stringify(body),
    }, "segment update")
    if (!data) return
    if (args.json) return writeJson(data.segment)
    prompts.log.success(`Updated segment #${data.segment.id}`)
    printSegmentHead(data.segment)
    printBreakdown(data.segment.breakdown)
    console.log("")
  },
})

// ── preview ───────────────────────────────────────────────────────────────────
const PreviewCmd = cmd({
  command: "preview <bloq>",
  describe: "what a set of filters would match on a board — nothing is saved",
  builder: (y) =>
    y.positional("bloq", { type: "number", demandOption: true, describe: "board (bloq) id" })
     .option("filter", { type: "string", array: true, describe: FILTER_HELP })
     .option("filters-file", { type: "string" })
     .option("limit", { type: "number", default: 10, describe: "members to show (max 100)" })
     .option("json", { type: "boolean" }),
  async handler(args) {
    const filters = filtersFromArgs(args)
    if (!filters) return
    if (!(await requireAuth())) return
    const data = await api<{ filters: Filters; breakdown: Breakdown; members: MembersPage; saved: boolean }>(
      `/api/v1/bloqs/${args.bloq}/segments/preview`,
      { method: "POST", body: JSON.stringify({ filters, per_page: args.limit }) },
      "segment preview",
    )
    if (!data) return
    if (args.json) return writeJson(data)
    console.log("")
    console.log(bold(`Preview on board ${args.bloq}`) + dim("  (not saved)"))
    printBreakdown(data.breakdown)
    printMembers(data.members, "first members")
    console.log("")
  },
})

// ── members ───────────────────────────────────────────────────────────────────
const MembersCmd = cmd({
  command: "members <id>",
  describe: "a page of the leads in a segment",
  builder: (y) =>
    y.positional("id", { type: "number", demandOption: true })
     .option("page", { type: "number", default: 1 })
     .option("limit", { type: "number", default: 25, describe: "per page (max 100)" })
     .option("json", { type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const data = await api<{ segment_id: number } & MembersPage>(
      `/api/v1/segments/${args.id}/members?page=${args.page}&per_page=${args.limit}`, {}, "segment members",
    )
    if (!data) return
    if (args.json) return writeJson(data)
    printMembers(data, `Segment #${args.id} members`)
    if (data.meta.current_page < data.meta.last_page) console.log(dim(`\n  next: iris segment members ${args.id} --page ${data.meta.current_page + 1}`))
    console.log("")
  },
})

// ── delete ────────────────────────────────────────────────────────────────────
const DeleteCmd = cmd({
  command: "delete <id>",
  describe: "delete a segment (campaigns that targeted it go back to the whole board)",
  builder: (y) => y.positional("id", { type: "number", demandOption: true }).option("json", { type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const data = await api<{ deleted_id: number; campaigns_untargeted: number }>(`/api/v1/segments/${args.id}`, { method: "DELETE" }, "segment delete")
    if (!data) return
    if (args.json) return writeJson(data)
    prompts.log.success(`Deleted segment #${data.deleted_id}${data.campaigns_untargeted ? ` — ${data.campaigns_untargeted} campaign(s) now target the whole board` : ""}`)
  },
})

export const PlatformSegmentCommand = cmd({
  command: "segment",
  aliases: ["segments"],
  describe: "saved filters over a board's leads that SOM campaigns can target",
  builder: (y) =>
    y.command(ListCmd)
     .command(ShowCmd)
     .command(CreateCmd)
     .command(UpdateCmd)
     .command(PreviewCmd)
     .command(MembersCmd)
     .command(DeleteCmd)
     .demandCommand(1),
  handler: () => {},
})
