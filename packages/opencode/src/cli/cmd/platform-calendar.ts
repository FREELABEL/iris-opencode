import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { requireAuth, printDivider, printKV, dim, bold, success } from "./iris-api"
import { executeIntegrationCall } from "./platform-run"

// Google Calendar integration via iris-api execute-direct endpoint
// Replaces the old bridge-based macOS Calendar.app implementation

async function calExec(action: string, params: Record<string, unknown>): Promise<any> {
  return executeIntegrationCall("google-calendar", action, params)
}

function formatTime(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })
  } catch {
    return iso
  }
}

function formatDate(iso: string): string {
  try {
    const d = new Date(iso)
    if (isNaN(d.getTime())) return iso
    return d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })
  } catch {
    return iso
  }
}

function printEvent(ev: any): void {
  const start = ev.start || ""
  const end = ev.end || ""
  const time = start.includes("T")
    ? `${formatTime(start)} – ${formatTime(end)}`
    : "All day"
  console.log(`  ${bold(time)}  ${ev.summary || "(no title)"}`)
  if (ev.location) console.log(`  ${dim("  " + ev.location)}`)
  if (ev.description) {
    const desc = ev.description.replace(/\n*___\ncreated by heyiris\.io/g, "").trim()
    if (desc) console.log(`  ${dim("  " + desc.slice(0, 120))}`)
  }
  console.log(`  ${dim("  id: " + (ev.id || "").slice(0, 30))}`)
  console.log()
}

// ── LIST ──────────────────────────────────────────────────────
const CalendarListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list upcoming calendar events",
  builder: (yargs) =>
    yargs
      .option("days", { type: "number", default: 7, describe: "look ahead N days" })
      .option("limit", { type: "number", default: 20, describe: "max events" })
      .option("calendar", { type: "string", alias: "c", describe: "calendar ID (default: primary)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro(`◈  Calendar — Next ${args.days} days`)

    const now = new Date()
    const end = new Date(now.getTime() + (args.days as number) * 86400000)
    const result = await calExec("get_events", {
      max_results: args.limit,
      time_min: now.toISOString(),
      time_max: end.toISOString(),
      ...(args.calendar ? { calendar_id: args.calendar } : {}),
    })

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to fetch events")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    const events: any[] = result.events ?? []
    if (events.length === 0) {
      prompts.log.info(`No events in the next ${args.days} days`)
      prompts.outro("Done")
      return
    }

    let lastDate = ""
    for (const ev of events) {
      const d = formatDate(ev.start)
      if (d !== lastDate) {
        printDivider()
        console.log(`  ${bold(d)}`)
        lastDate = d
      }
      printEvent(ev)
    }

    prompts.outro(`${success("✓")} ${events.length} event${events.length === 1 ? "" : "s"}`)
  },
})

// ── TODAY ──────────────────────────────────────────────────────
const CalendarTodayCommand = cmd({
  command: "today",
  aliases: ["now"],
  describe: "show today's calendar events",
  builder: (yargs) =>
    yargs
      .option("calendar", { type: "string", alias: "c" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Today")

    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(start.getTime() + 86400000)
    const result = await calExec("get_events", {
      max_results: 30,
      time_min: start.toISOString(),
      time_max: end.toISOString(),
      ...(args.calendar ? { calendar_id: args.calendar } : {}),
    })

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to fetch events")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    const events: any[] = result.events ?? []
    if (events.length === 0) {
      prompts.log.info("Nothing on your calendar today")
      prompts.outro("Done")
      return
    }

    for (const ev of events) printEvent(ev)
    prompts.outro(`${success("✓")} ${events.length} event${events.length === 1 ? "" : "s"} today`)
  },
})

// ── TOMORROW ──────────────────────────────────────────────────
const CalendarTomorrowCommand = cmd({
  command: "tomorrow",
  describe: "show tomorrow's calendar events",
  builder: (yargs) =>
    yargs
      .option("calendar", { type: "string", alias: "c" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Tomorrow")

    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const end = new Date(start.getTime() + 86400000)
    const result = await calExec("get_events", {
      max_results: 30,
      time_min: start.toISOString(),
      time_max: end.toISOString(),
      ...(args.calendar ? { calendar_id: args.calendar } : {}),
    })

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to fetch events")
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    const events: any[] = result.events ?? []
    if (events.length === 0) {
      prompts.log.info("Nothing on your calendar tomorrow")
      prompts.outro("Done")
      return
    }

    for (const ev of events) printEvent(ev)
    prompts.outro(`${success("✓")} ${events.length} event${events.length === 1 ? "" : "s"} tomorrow`)
  },
})

// ── ADD ───────────────────────────────────────────────────────
const CalendarAddCommand = cmd({
  command: "add <title>",
  aliases: ["create"],
  describe: "create a calendar event",
  builder: (yargs) =>
    yargs
      .positional("title", { type: "string", demandOption: true, describe: "event title" })
      .option("at", { type: "string", demandOption: true, describe: "start time (ISO: 2026-04-15T14:00:00)" })
      .option("end", { type: "string", describe: "end time (defaults to +1 hour)" })
      .option("location", { type: "string", alias: "l" })
      .option("description", { type: "string", alias: "d" })
      .option("calendar", { type: "string", alias: "c", describe: "calendar ID" })
      .option("repeat", { type: "string", describe: "DAILY, WEEKLY, MONTHLY, YEARLY" })
      .option("repeat-count", { type: "number", describe: "number of recurrences" })
      .option("recurrence", { type: "string", describe: "raw RRULE string (e.g. FREQ=WEEKLY;COUNT=4)" })
      .option("all-day", { type: "boolean", default: false })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro(`◈  Calendar — Add "${args.title}"`)

    const params: Record<string, unknown> = {
      title: args.title,
      start_time: args.at,
      timezone: "America/Chicago",
    }
    if (args.end) params.end_time = args.end
    if (args.location) params.location = args.location
    if (args.description) params.description = args.description
    if (args.calendar) params.calendar_id = args.calendar
    if (args.allDay || args["all-day"]) params.all_day = true
    if (args.repeat) params.repeat = args.repeat
    if (args.repeatCount ?? args["repeat-count"]) params.repeat_count = args.repeatCount ?? args["repeat-count"]
    if (args.recurrence) params.recurrence = args.recurrence

    const result = await calExec("create_event", params)

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to create event")
      prompts.outro("Done")
      return
    }

    printKV("Event", bold(result.summary || args.title))
    printKV("Start", result.start)
    printKV("End", result.end)
    if (result.event_url) printKV("URL", dim(result.event_url))
    if (result.event_id) printKV("ID", dim(result.event_id))
    prompts.outro(`${success("✓")} Event created`)
  },
})

// ── UPDATE ────────────────────────────────────────────────────
const CalendarUpdateCommand = cmd({
  command: "update <event-id>",
  describe: "update a calendar event",
  builder: (yargs) =>
    yargs
      .positional("event-id", { type: "string", demandOption: true, describe: "event ID from list/add" })
      .option("title", { type: "string" })
      .option("at", { type: "string", describe: "new start time" })
      .option("end", { type: "string", describe: "new end time" })
      .option("location", { type: "string", alias: "l" })
      .option("description", { type: "string", alias: "d" })
      .option("calendar", { type: "string", alias: "c" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    const eid = (args.eventId ?? args["event-id"] ?? "") as string
    prompts.intro(`◈  Calendar — Update ${eid.slice(0, 20)}`)

    const params: Record<string, unknown> = {
      event_id: eid,
      timezone: "America/Chicago",
    }
    if (args.title) params.title = args.title
    if (args.at) params.start_time = args.at
    if (args.end) params.end_time = args.end
    if (args.location) params.location = args.location
    if (args.description) params.description = args.description
    if (args.calendar) params.calendar_id = args.calendar

    const result = await calExec("update_event", params)

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to update event")
      prompts.outro("Done")
      return
    }

    if (result.event_url) printKV("URL", dim(result.event_url))
    prompts.outro(`${success("✓")} Event updated`)
  },
})

// ── DELETE ────────────────────────────────────────────────────
const CalendarDeleteCommand = cmd({
  command: "delete <event-id>",
  aliases: ["rm"],
  describe: "delete a calendar event",
  builder: (yargs) =>
    yargs
      .positional("event-id", { type: "string", demandOption: true })
      .option("calendar", { type: "string", alias: "c" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Delete")

    const params: Record<string, unknown> = {
      event_id: args.eventId ?? args["event-id"],
    }
    if (args.calendar) params.calendar_id = args.calendar

    const result = await calExec("delete_event", params)

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to delete event")
      prompts.outro("Done")
      return
    }

    prompts.outro(`${success("✓")} Event deleted`)
  },
})

// ── CALENDARS ─────────────────────────────────────────────────
const CalendarCalendarsCommand = cmd({
  command: "calendars",
  describe: "list all accessible calendars",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — All Calendars")

    const result = await calExec("get_calendars", {})

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to list calendars")
      prompts.outro("Done")
      return
    }

    const cals: any[] = result.calendars ?? []
    for (const cal of cals) {
      const primary = cal.primary ? ` ${success("* primary")}` : ""
      console.log(`  ${bold(cal.name || cal.id)}${primary}`)
      console.log(`  ${dim("ID: " + cal.id)}`)
      if (cal.timezone) console.log(`  ${dim("TZ: " + cal.timezone)}`)
      console.log()
    }
    prompts.outro(`${success("✓")} ${cals.length} calendar${cals.length === 1 ? "" : "s"}`)
  },
})

// ── FREE SLOTS ────────────────────────────────────────────────
const CalendarFreeCommand = cmd({
  command: "free",
  aliases: ["avail", "availability"],
  describe: "find free time slots (FreeBusy API)",
  builder: (yargs) =>
    yargs
      .option("from", { type: "string", demandOption: true, describe: "start of window (ISO)" })
      .option("to", { type: "string", demandOption: true, describe: "end of window (ISO)" })
      .option("calendar", { type: "array", string: true, alias: "c", describe: "calendar ID(s), repeatable" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Free Slots")

    const params: Record<string, unknown> = {
      start_time: args.from,
      end_time: args.to,
      timezone: "America/Chicago",
    }
    if (args.calendar && (args.calendar as string[]).length > 0) {
      params.calendar_ids = args.calendar
    }

    const result = await calExec("find_free_slots", params)

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      prompts.log.error(result?.error ?? "Failed to find free slots")
      prompts.outro("Done")
      return
    }

    const slots: any[] = result.free_slots ?? []
    if (slots.length === 0) {
      prompts.log.info("No free slots in that window — fully booked!")
      prompts.outro("Done")
      return
    }

    console.log(`  ${dim(`Window: ${formatDate(result.time_range?.start)} ${formatTime(result.time_range?.start)} → ${formatTime(result.time_range?.end)}`)}`)
    console.log()
    for (const slot of slots) {
      const dur = slot.duration_minutes
      const hrs = Math.floor(dur / 60)
      const mins = dur % 60
      const durStr = hrs > 0 ? `${hrs}h${mins > 0 ? ` ${mins}m` : ""}` : `${mins}m`
      console.log(`  ${success("●")} ${formatTime(slot.start)} – ${formatTime(slot.end)}  ${dim(`(${durStr} free)`)}`)
    }
    console.log()

    if (result.busy_times?.length > 0) {
      console.log(`  ${dim(`${result.busy_times.length} busy block${result.busy_times.length === 1 ? "" : "s"} found`)}`)
    }

    prompts.outro(`${success("✓")} ${slots.length} free slot${slots.length === 1 ? "" : "s"}`)
  },
})

// ── ROOT COMMAND ──────────────────────────────────────────────
export const PlatformCalendarCommand = cmd({
  command: "calendar",
  aliases: ["cal"],
  describe: "Google Calendar — events, availability, scheduling",
  builder: (yargs) =>
    yargs
      .command(CalendarListCommand)
      .command(CalendarTodayCommand)
      .command(CalendarTomorrowCommand)
      .command(CalendarAddCommand)
      .command(CalendarUpdateCommand)
      .command(CalendarDeleteCommand)
      .command(CalendarCalendarsCommand)
      .command(CalendarFreeCommand)
      .demandCommand(),
  async handler() {},
})
