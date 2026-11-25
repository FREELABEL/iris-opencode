import { cmd } from "./cmd"
import { productCommand } from "./product-command"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, dim, bold, FL_API, writeJson } from "./iris-api"

// ============================================================================
// `iris station` — live control of the FREELABEL Station (#194159).
//
// The iOS app plays whatever list `GET /api/v1/public/station/next` returns, in that order.
// Everything here changes that list on the server, so nothing needs an app update:
//   now      what the app would get right now (queued tracks marked ▶)
//   queue    put tracks at the head of the Station, pinned or in order, optionally in a window
//   hide     take a track off the air (status 0 — also hides it on profiles/Discover)
//   unhide   put it back
//   on/off   the app's Station switch (discover-config sections.station; app 2.1+)
// ============================================================================

/** Station tracks for the app's view: creator uploads only, like the iOS app asks for. */
async function stationNow(limit: number, uploadsOnly: boolean): Promise<any> {
  const q = new URLSearchParams({ limit: String(limit), t: String(Date.now()) })
  if (uploadsOnly) q.set("source", "uploads")
  const res = await fetch(`${FL_API}/api/v1/public/station/next?${q}`, { headers: { Accept: "application/json" } })
  if (!res.ok) throw new Error(`station/next answered ${res.status}`)
  return ((await res.json()) as any)?.data ?? {}
}

function owner(t: any): string {
  return t?.profile?.name ?? (t?.profile_id ? `profile ${t.profile_id}` : "?")
}

const NowCommand = cmd({
  command: "now",
  aliases: ["status", "ls"],
  describe: "what the Station plays right now (queued tracks first, marked ▶)",
  builder: (y: any) =>
    y
      .option("limit", { type: "number", default: 50, describe: "how many (max 50)" })
      .option("all-sources", { type: "boolean", default: false, describe: "include non-upload audio (the app asks for uploads only)" })
      .option("search", { type: "string", describe: "only titles containing this text" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    const data = await stationNow(Math.min(50, Math.max(1, args.limit)), !args["all-sources"])
    let tracks: any[] = Array.isArray(data.tracks) ? data.tracks : []
    if (args.search) tracks = tracks.filter((t) => String(t.title ?? "").toLowerCase().includes(String(args.search).toLowerCase()))
    if (args.json) return writeJson({ ...data, tracks })
    UI.empty()
    prompts.intro(bold("◈  The Station — on the air"))
    const queued = Number(data.queued ?? 0)
    tracks.forEach((t, i) => {
      const mark = i < queued && !args.search ? "▶" : " "
      console.log(`  ${mark} ${dim(String(i + 1).padStart(2, "0"))}  ${bold(`#${t.id}`)}  ${String(t.title ?? "").slice(0, 70)}  ${dim(owner(t))}`)
    })
    console.log()
    console.log(`  ${dim("returned")} ${data.count ?? tracks.length}  ${dim("queued")} ${queued}  ${dim("catalog")} ${data.catalog ?? "?"}${data.exhausted ? dim("  (whole catalog — the app loops it)") : ""}`)
    prompts.outro("Done")
  },
})

// --- queue -------------------------------------------------------------------

const QueueListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "the queue: live entries first, in play order",
  builder: (y: any) => y.option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const res = await irisFetch("/api/v1/station/queue")
    if (!(await handleApiError(res, "station queue"))) { process.exitCode = 1; return }
    const raw = ((await res.json()) as any)?.data?.entries
    const entries: any[] = Array.isArray(raw) ? raw : []
    if (args.json) return writeJson(entries)
    UI.empty()
    prompts.intro(bold("◈  Station queue"))
    if (!entries.length) console.log(`  ${dim("empty — the Station is a shuffle of the newest uploads")}`)
    for (const e of entries) {
      const when = [e.starts_at && `from ${e.starts_at}`, e.ends_at && `until ${e.ends_at}`].filter(Boolean).join(" ")
      console.log(`  ${e.live ? "▶" : dim("·")} ${dim(`entry ${e.id}`)}  ${bold(`#${e.track_id}`)} ${e.title ?? dim("(missing track)")}${e.pinned ? "  📌" : ""}  ${dim(`pos ${e.position}`)}${when ? "  " + dim(when) : ""}${e.note ? "  " + dim(`— ${e.note}`) : ""}`)
    }
    prompts.outro("Done")
  },
})

const QueueAddCommand = cmd({
  command: "add <tracks..>",
  describe: "put track(s) at the head of the Station, in the order given",
  builder: (y: any) =>
    y
      .positional("tracks", { type: "number", array: true, describe: "track id(s)" })
      .option("pin", { type: "boolean", default: false, describe: "ahead of every unpinned entry" })
      .option("position", { type: "number", describe: "explicit position (default: back of the queue)" })
      .option("from", { type: "string", describe: "start time (ISO, e.g. 2026-11-27T20:00)" })
      .option("until", { type: "string", describe: "end time (ISO)" })
      .option("note", { type: "string" })
      .option("json", { type: "boolean", default: false }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const out: any[] = []
    for (const [i, id] of (args.tracks as number[]).entries()) {
      const body: any = { track_id: id, pinned: !!args.pin }
      if (args.position !== undefined) body.position = args.position + i
      if (args.from) body.starts_at = args.from
      if (args.until) body.ends_at = args.until
      if (args.note) body.note = args.note
      const res = await irisFetch("/api/v1/station/queue", { method: "POST", body: JSON.stringify(body) })
      if (!(await handleApiError(res, `queue #${id}`))) { process.exitCode = 1; continue }
      out.push(((await res.json()) as any)?.data?.entry)
    }
    if (args.json) return writeJson(out)
    for (const e of out) console.log(`  ▶ queued ${bold(`#${e.track_id}`)} ${e.title ?? ""} ${dim(`(entry ${e.id}${e.pinned ? ", pinned" : ""})`)}`)
    console.log(dim("  Live on the app's next refresh. Check: iris station now"))
  },
})

const QueueRmCommand = cmd({
  command: "rm <entries..>",
  aliases: ["remove", "delete"],
  describe: "remove queue entries (entry ids from `iris station queue list`)",
  builder: (y: any) => y.positional("entries", { type: "number", array: true }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    for (const id of args.entries as number[]) {
      const res = await irisFetch(`/api/v1/station/queue/${id}`, { method: "DELETE" })
      if (await handleApiError(res, `remove entry ${id}`)) console.log(`  removed entry ${id}`)
      else process.exitCode = 1
    }
  },
})

const QueueClearCommand = cmd({
  command: "clear",
  describe: "empty the queue (the Station goes back to a pure shuffle)",
  builder: (y: any) => y.option("yes", { type: "boolean", default: false, describe: "skip the confirmation" }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    if (!args.yes) {
      const ok = await prompts.confirm({ message: "Empty the whole Station queue?" })
      if (ok !== true) return
    }
    const res = await irisFetch("/api/v1/station/queue", { method: "DELETE" })
    if (await handleApiError(res, "clear queue")) console.log(`  cleared ${((await res.json()) as any)?.data?.deleted ?? 0} entries`)
    else process.exitCode = 1
  },
})

const QueueCommand = cmd({
  command: "queue",
  describe: "what goes on the air first: list | add | rm | clear",
  builder: (y: any) => y.command(QueueListCommand).command(QueueAddCommand).command(QueueRmCommand).command(QueueClearCommand).demandCommand(),
  async handler() {},
})

// --- hide / unhide -----------------------------------------------------------

function statusCommand(name: "hide" | "unhide", status: 0 | 1, describe: string) {
  return cmd({
    command: `${name} <tracks..>`,
    describe,
    builder: (y: any) => y.positional("tracks", { type: "number", array: true }),
    async handler(args: any) {
      if (!(await requireAuth())) return
      for (const id of args.tracks as number[]) {
        const res = await irisFetch(`/api/v1/content/track/${id}`, { method: "PUT", body: JSON.stringify({ status }) })
        if (!(await handleApiError(res, `${name} #${id}`))) { process.exitCode = 1; continue }
        const body = (await res.json()) as any
        const c = body?.data?.content ?? body?.content ?? {}
        console.log(`  ${status ? "▶ on the air" : "■ off the air"}  ${bold(`#${id}`)} ${c.title ?? ""}`)
      }
      if (!status) console.log(dim("  Hidden tracks also disappear from profiles and Discover. Undo: iris station unhide <id>"))
    },
  })
}

// --- on / off (the app's Station switch) ---------------------------------------

function switchCommand(name: "on" | "off") {
  return cmd({
    command: name,
    describe: name === "on" ? "show the Station in the app" : "hide the Station in the app (app 2.1+)",
    async handler() {
      if (!(await requireAuth())) return
      const cur = await irisFetch("/api/v1/platform-config/discover.sections")
      const sections = cur.ok ? (((await cur.json()) as any)?.data?.value ?? {}) : {}
      sections.station = name === "on"
      const res = await irisFetch("/api/v1/platform-config/discover.sections", { method: "PUT", body: JSON.stringify({ value: sections }) })
      if (!(await handleApiError(res, `station ${name}`))) { process.exitCode = 1; return }
      console.log(`  Station ${name === "on" ? "ON" : "OFF"} in the app on next open ${dim("(builds before 2.1 ignore this switch)")}`)
    },
  })
}

export const PlatformStationCommand = productCommand({
  name: "station",
  aliases: ["radio"],
  purpose: "The Station — control the FREELABEL app's 24/7 radio live: what plays first, what's on the air",
  keywords: ["station", "radio", "queue", "pin", "now playing", "mixes", "sets", "noys"],
  playbooks: ["freelabel-ios-app"],
  subcommands: [
    NowCommand,
    QueueCommand,
    statusCommand("hide", 0, "take track(s) off the air"),
    statusCommand("unhide", 1, "put track(s) back on the air"),
    switchCommand("on"),
    switchCommand("off"),
  ],
})
