import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, printDivider, printKV, dim, bold, success, resolveUserId } from "./iris-api"
import { executeIntegrationCall } from "./platform-run"

// Google Calendar integration via iris-api execute-direct endpoint
// Replaces the old bridge-based macOS Calendar.app implementation

type AccountOpts = { integrationId?: number; account?: string }

function addAccountOptions(yargs: any): any {
  return yargs
    .option("account", { type: "string", describe: "Google account email (multi-account)" })
    .option("integration-id", { type: "number", describe: "specific integration record ID" })
}

function getAccountOpts(args: any): AccountOpts {
  const opts: AccountOpts = {}
  if (args.integrationId ?? args["integration-id"]) opts.integrationId = Number(args.integrationId ?? args["integration-id"])
  if (args.account) opts.account = args.account as string
  return opts
}

export async function calExec(
  action: string,
  params: Record<string, unknown>,
  opts: AccountOpts = {},
): Promise<any> {
  return executeIntegrationCall("google-calendar", action, params, opts)
}

// ── FAILURE HANDLING (#155323) ───────────────────────────────
// A hard-failed calendar verb used to dump the raw Composio error JSON, still
// print the success-style "Done" footer, and exit 0 — so automation saw success
// while the event was never created. These helpers give a concise, actionable
// message, keep the raw payload at DEBUG only, and mark the process failed.

// Detects a Google auth/authorization problem inside a Composio failure payload.
function isCalendarAuthError(msg: string): boolean {
  return /revoked|invalid_grant|unauthorized|deauthoriz|not connected|no (active )?connection|reconnect|re-?authoriz|401|403|expired|invalid_credentials|token/i.test(
    msg,
  )
}

const RECONNECT_HINT = "Reconnect: iris integrations connect google-calendar"

// Report a failed calendar operation and set a non-zero exit code. Callers MUST
// `return` immediately after — the "Done" success footer is intentionally NOT
// printed on the failure path (that footer is what made failures look like wins).
function reportCalendarFailure(rawError: unknown, fallback: string): void {
  const raw =
    typeof rawError === "string"
      ? rawError
      : rawError instanceof Error
        ? rawError.message
        : rawError == null
          ? ""
          : (() => {
              try {
                return JSON.stringify(rawError)
              } catch {
                return String(rawError)
              }
            })()

  // Raw Composio JSON is noisy and leaks internals — keep it for --debug only.
  if (raw && (process.env.IRIS_DEBUG || process.env.DEBUG)) {
    prompts.log.error(dim(raw.slice(0, 1000)))
  }

  if (isCalendarAuthError(raw)) {
    prompts.log.error("Google Calendar is disconnected — its authorization was revoked or expired.")
    prompts.log.info(dim(RECONNECT_HINT))
  } else {
    // Non-auth hard failure: show a concise reason, never the full JSON blob.
    const looksLikeJson = /^[\s]*[[{]/.test(raw) || raw.includes('"error"') || /composio/i.test(raw)
    prompts.log.error(fallback)
    if (raw && !looksLikeJson) prompts.log.error(dim(raw.slice(0, 160)))
    else if (raw) prompts.log.info(dim("Run with IRIS_DEBUG=1 for the raw provider response."))
  }

  process.exitCode = 1 // signal failure to scripts/automation (#155323)
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
    addAccountOptions(yargs)
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
    let result: any
    try {
      result = await calExec("get_events", {
        max_results: args.limit,
        time_min: now.toISOString(),
        time_max: end.toISOString(),
        ...(args.calendar ? { calendar_id: args.calendar } : {}),
      }, getAccountOpts(args))
    } catch (err: any) {
      reportCalendarFailure(err, "Failed to fetch events")
      return
    }

    if (!result?.success) {
      reportCalendarFailure(result?.error, "Failed to fetch events")
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
    addAccountOptions(yargs)
      .option("calendar", { type: "string", alias: "c" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Today")

    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate())
    const end = new Date(start.getTime() + 86400000)
    let result: any
    try {
      result = await calExec("get_events", {
        max_results: 30,
        time_min: start.toISOString(),
        time_max: end.toISOString(),
        ...(args.calendar ? { calendar_id: args.calendar } : {}),
      }, getAccountOpts(args))
    } catch (err: any) {
      reportCalendarFailure(err, "Failed to fetch events")
      return
    }

    if (!result?.success) {
      reportCalendarFailure(result?.error, "Failed to fetch events")
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
    addAccountOptions(yargs)
      .option("calendar", { type: "string", alias: "c" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Tomorrow")

    const now = new Date()
    const start = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
    const end = new Date(start.getTime() + 86400000)
    let result: any
    try {
      result = await calExec("get_events", {
        max_results: 30,
        time_min: start.toISOString(),
        time_max: end.toISOString(),
        ...(args.calendar ? { calendar_id: args.calendar } : {}),
      }, getAccountOpts(args))
    } catch (err: any) {
      reportCalendarFailure(err, "Failed to fetch events")
      return
    }

    if (!result?.success) {
      reportCalendarFailure(result?.error, "Failed to fetch events")
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
      .option("account", { type: "string", describe: "Google account email (multi-account)" })
      .option("integration-id", { type: "number", describe: "specific integration record ID" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro(`◈  Calendar — Add "${args.title}"`)

    const params: Record<string, unknown> = {
      title: args.title,
      start_time: args.at,
      start_datetime: args.at,
      timezone: "America/Chicago",
    }
    if (args.end) { params.end_time = args.end; params.end_datetime = args.end }
    if (args.location) params.location = args.location
    if (args.description) params.description = args.description
    if (args.calendar) params.calendar_id = args.calendar
    if (args.allDay || args["all-day"]) params.all_day = true
    if (args.repeat) params.repeat = args.repeat
    if (args.repeatCount ?? args["repeat-count"]) params.repeat_count = args.repeatCount ?? args["repeat-count"]
    if (args.recurrence) params.recurrence = args.recurrence

    let result: any
    try {
      result = await calExec("create_event", params, getAccountOpts(args))
    } catch (err: any) {
      if (args.json) {
        console.log(JSON.stringify({ success: false, error: err?.message ?? String(err) }, null, 2))
        process.exitCode = 1
        return
      }
      reportCalendarFailure(err, "Failed to create event")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      if (!result?.success) process.exitCode = 1 // don't let automation read a failed create as success (#155323)
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      reportCalendarFailure(result?.error, "Failed to create event")
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
      .option("account", { type: "string", describe: "Google account email (multi-account)" })
      .option("integration-id", { type: "number", describe: "specific integration record ID" })
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

    let result: any
    try {
      result = await calExec("update_event", params, getAccountOpts(args))
    } catch (err: any) {
      if (args.json) {
        console.log(JSON.stringify({ success: false, error: err?.message ?? String(err) }, null, 2))
        process.exitCode = 1
        return
      }
      reportCalendarFailure(err, "Failed to update event")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      if (!result?.success) process.exitCode = 1 // (#155323)
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      reportCalendarFailure(result?.error, "Failed to update event")
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
      .option("account", { type: "string", describe: "Google account email (multi-account)" })
      .option("integration-id", { type: "number", describe: "specific integration record ID" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Delete")

    const params: Record<string, unknown> = {
      event_id: args.eventId ?? args["event-id"],
    }
    if (args.calendar) params.calendar_id = args.calendar

    let result: any
    try {
      result = await calExec("delete_event", params, getAccountOpts(args))
    } catch (err: any) {
      if (args.json) {
        console.log(JSON.stringify({ success: false, error: err?.message ?? String(err) }, null, 2))
        process.exitCode = 1
        return
      }
      reportCalendarFailure(err, "Failed to delete event")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      if (!result?.success) process.exitCode = 1 // (#155323)
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      reportCalendarFailure(result?.error, "Failed to delete event")
      return
    }

    prompts.outro(`${success("✓")} Event deleted`)
  },
})

// ── CALENDARS ─────────────────────────────────────────────────
const CalendarCalendarsCommand = cmd({
  command: "calendars",
  describe: "list all accessible calendars (with source labels)",
  builder: (yargs) =>
    addAccountOptions(yargs)
      .option("source", { type: "string", describe: "filter by source: primary|workspace|secondary|subscribed|shared" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — All Calendars")

    const opts = getAccountOpts(args)

    // Primary path: the normalized endpoint (single source of truth for source
    // labels — Owned / Workspace / Subscribed feed — shared with Elon + Genesis).
    let cals: any[] | null = null
    try {
      const uid = await resolveUserId()
      const qs = new URLSearchParams()
      if (uid) qs.set("user_id", String(uid))
      if (opts.integrationId) qs.set("integration_id", String(opts.integrationId))
      if (args.source) qs.set("source", args.source as string)
      const res = await irisFetch(`/api/v1/calendar/calendars?${qs.toString()}`)
      if (res.ok) {
        const data = await res.json()
        if (data?.success) cals = data.calendars ?? []
      }
    } catch {
      /* fall through to legacy path */
    }

    // Fallback: backend without the normalized endpoint yet — unlabeled list.
    if (cals === null) {
      let result: any
      try {
        result = await calExec("get_calendars", {}, opts)
      } catch (err: any) {
        reportCalendarFailure(err, "Failed to list calendars")
        return
      }
      if (!result?.success) {
        reportCalendarFailure(result?.error, "Failed to list calendars")
        return
      }
      cals = ((result.calendars ?? result.data?.calendars ?? []) as any[]).map((c: any) => ({
        ...c,
        name: c.name || c.summary || c.id,
      }))
      if (args.source) cals = cals.filter((c: any) => c.source === args.source)
    }

    if (!cals) {
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(cals, null, 2))
      prompts.outro("Done")
      return
    }

    for (const cal of cals) {
      const tag = cal.label
        ? `  ${dim(`[${cal.label}${cal.read_only ? " · read-only" : ""}]`)}`
        : cal.primary
          ? `  ${success("* primary")}`
          : ""
      console.log(`  ${bold(cal.name || cal.id)}${tag}`)
      console.log(`  ${dim("ID: " + cal.id)}`)
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
      .option("account", { type: "string", describe: "Google account email (multi-account)" })
      .option("integration-id", { type: "number", describe: "specific integration record ID" })
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

    let result: any
    try {
      result = await calExec("find_free_slots", params, getAccountOpts(args))
    } catch (err: any) {
      reportCalendarFailure(err, "Failed to find free slots")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(result, null, 2))
      if (!result?.success) process.exitCode = 1 // (#155323)
      prompts.outro("Done")
      return
    }

    if (!result?.success) {
      reportCalendarFailure(result?.error, "Failed to find free slots")
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

// ── DEFAULT CALENDAR ─────────────────────────────────────────
// Manages the default Google Calendar ID for the user/bloq.
// Calls fl-api: GET/PATCH /api/v1/calendar-sync/default

const CalendarDefaultGetCommand = cmd({
  command: "get",
  describe: "show your current default calendar",
  builder: (yargs) =>
    yargs
      .option("bloq", { type: "number", describe: "bloq ID to check (otherwise user-level)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Default")

    const qs = args.bloq ? `?bloq_id=${args.bloq}` : ""
    const res = await irisFetch(`/api/v1/calendar-sync/default${qs}`)
    const data = await res.json() as Record<string, any>

    if (!res.ok) {
      prompts.log.error(data?.error ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    printKV("Calendar ID", bold(data.calendar_id ?? "primary"))
    printKV("Resolved from", data.resolved_from ?? "fallback")
    if (data.user_default) printKV("User default", dim(data.user_default))
    if (data.bloq_default) printKV("Bloq default", dim(data.bloq_default))
    prompts.outro(`${success("✓")} Default calendar`)
  },
})

const CalendarDefaultSetCommand = cmd({
  command: "set <calendar-id>",
  describe: "set your default calendar",
  builder: (yargs) =>
    yargs
      .positional("calendar-id", { type: "string", demandOption: true, describe: "Google Calendar ID (use 'primary' for main)" })
      .option("bloq", { type: "number", describe: "set default for a specific bloq (otherwise user-level)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    const calId = (args.calendarId ?? args["calendar-id"]) as string
    prompts.intro(`◈  Calendar — Set Default → ${calId}`)

    const body: Record<string, any> = { calendar_id: calId }
    if (args.bloq) body.bloq_id = args.bloq

    const res = await irisFetch("/api/v1/calendar-sync/default", {
      method: "PATCH",
      body: JSON.stringify(body),
    })
    const data = await res.json() as Record<string, any>

    if (!res.ok) {
      prompts.log.error(data?.error ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    printKV("Calendar", bold(calId))
    if (args.bloq) printKV("Scope", `Bloq #${args.bloq}`)
    else printKV("Scope", "User-level (all projects)")
    prompts.outro(`${success("✓")} Default calendar updated`)
  },
})

const CalendarDefaultCommand = cmd({
  command: "default",
  describe: "manage your default calendar for sync",
  builder: (yargs) =>
    yargs
      .command(CalendarDefaultGetCommand)
      .command(CalendarDefaultSetCommand)
      .demandCommand(),
  async handler() {},
})

// ── SCHEDULE (Smart Scheduler) ───────────────────────────────
// Calls fl-api: POST /api/v1/scheduling/schedule-week

const CalendarScheduleCommand = cmd({
  command: "schedule",
  aliases: ["plan"],
  describe: "smart schedule — auto-place tasks & habits into your calendar",
  builder: (yargs) =>
    yargs
      .option("dry-run", { type: "boolean", default: true, describe: "preview without writing to calendar (default: true)" })
      .option("week", { type: "string", describe: "week start date YYYY-MM-DD (defaults to current week)" })
      .option("execute", { type: "boolean", default: false, describe: "actually write events to Google Calendar" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    const dryRun = args.execute ? false : (args.dryRun ?? args["dry-run"] ?? true)
    prompts.intro(`◈  Calendar — Smart Schedule${dryRun ? " (dry run)" : ""}`)

    const body: Record<string, any> = { dry_run: dryRun }
    if (args.week) body.week_start = args.week

    const spin = prompts.spinner()
    spin.start("Running smart scheduler...")

    const res = await irisFetch("/api/v1/scheduling/schedule-week", {
      method: "POST",
      body: JSON.stringify(body),
    })
    const data = await res.json() as Record<string, any>
    spin.stop("Schedule computed")

    if (!res.ok) {
      prompts.log.error(data?.error ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    // Header
    printKV("Week", data.week ?? "unknown")
    printKV("Timezone", data.timezone ?? "UTC")
    printKV("Mode", dryRun ? dim("dry run (use --execute to write to calendar)") : bold("LIVE — writing to Google Calendar"))
    console.log()

    // Placed items
    const placed: any[] = data.schedule ?? []
    if (placed.length > 0) {
      console.log(`  ${bold(`Placed: ${placed.length} items`)}`)
      printDivider()
      let lastDate = ""
      for (const item of placed) {
        const d = item.scheduled_date ?? ""
        if (d !== lastDate) {
          console.log(`  ${bold(formatDate(d + "T00:00:00"))}`)
          lastDate = d
        }
        const timeRange = `${item.scheduled_time} – ${item.scheduled_end}`
        const src = dim(`(${item.source}, ${item.duration}min)`)
        console.log(`    ${timeRange}  ${item.title} ${src}`)
      }
      console.log()
    }

    // Unplaced items
    const unplaced: any[] = data.could_not_place ?? []
    if (unplaced.length > 0) {
      console.log(`  ${bold(`Could not place: ${unplaced.length} items`)}`)
      for (const item of unplaced) {
        console.log(`    ${dim("✗")} ${item.title} (${item.duration}min) — ${dim(item.reason ?? "no slot")}`)
      }
      console.log()
    }

    // Analytics
    const a = data.analytics
    if (a) {
      printDivider()
      console.log(`  ${bold("Analytics")}`)
      printKV("  Available", `${a.total_available_hours ?? 0}h`)
      printKV("  Meetings", `${a.meetings_hours ?? 0}h`)
      printKV("  Tasks", `${a.tasks_hours ?? 0}h`)
      printKV("  Habits", `${a.habits_hours ?? 0}h`)
      const focusMet = a.focus_goal_met ? success("MET") : dim("NOT MET")
      printKV("  Focus", `${a.focus_hours_actual ?? 0}h / ${a.focus_hours_goal ?? 0}h goal (${focusMet})`)
      printKV("  Free", `${a.unscheduled_hours ?? 0}h`)
      printKV("  Utilization", `${a.utilization_pct ?? 0}%`)
    }

    const verb = dryRun ? "would be scheduled" : "scheduled"
    prompts.outro(`${success("✓")} ${placed.length} item${placed.length === 1 ? "" : "s"} ${verb}`)
  },
})

// ── PREFS (Scheduling Preferences) ───────────────────────────
// Calls fl-api: GET/PATCH /api/v1/scheduling/preferences

const CalendarPrefsShowCommand = cmd({
  command: "show",
  aliases: ["get"],
  describe: "show your scheduling preferences",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Scheduling Preferences")

    const res = await irisFetch("/api/v1/scheduling/preferences")
    const data = await res.json() as Record<string, any>

    if (!res.ok) {
      prompts.log.error(data?.error ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    const p = data.preferences ?? {}
    printKV("Work hours", `${p.work_hours_start ?? "09:00"} – ${p.work_hours_end ?? "17:00"}`)
    printKV("Working days", (p.working_days ?? ["mon-fri"]).join(", "))
    printKV("Energy peak", p.energy_peak ?? "morning")
    printKV("Focus goal", `${p.focus_hours_goal ?? 120} min/week`)
    printKV("Focus blocks", `${p.focus_block_min ?? 60}–${p.focus_block_max ?? 120} min`)
    printKV("Break duration", `${p.break_duration ?? 15} min`)
    printKV("Meeting buffer", `${p.meeting_buffer ?? 5} min`)
    printKV("Lunch", `${p.lunch_window_start ?? "12:00"} – ${p.lunch_window_end ?? "13:00"}`)
    if (p.max_meetings_per_day) printKV("Max meetings/day", String(p.max_meetings_per_day))
    printKV("Auto-schedule", p.auto_schedule_enabled ? success("ON") : dim("OFF"))
    prompts.outro(`${success("✓")} Preferences`)
  },
})

const CalendarPrefsSetCommand = cmd({
  command: "set",
  describe: "update scheduling preferences",
  builder: (yargs) =>
    yargs
      .option("work-hours", { type: "string", describe: "work hours range, e.g. '9am-6pm' or '09:00-18:00'" })
      .option("energy-peak", { type: "string", choices: ["morning", "afternoon", "evening"] as const })
      .option("focus-goal", { type: "number", describe: "weekly focus goal in minutes" })
      .option("break", { type: "number", describe: "break duration between tasks (minutes)" })
      .option("buffer", { type: "number", describe: "meeting buffer (minutes before/after)" })
      .option("lunch", { type: "string", describe: "lunch window, e.g. '12:00-13:00'" })
      .option("max-meetings", { type: "number", describe: "max meetings per day" })
      .option("auto-schedule", { type: "boolean", describe: "enable/disable auto-scheduling" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Update Preferences")

    const body: Record<string, any> = {}

    if (args.workHours ?? args["work-hours"]) {
      const wh = (args.workHours ?? args["work-hours"]) as string
      const parts = wh.split("-").map((s: string) => s.trim())
      if (parts.length === 2) {
        body.work_hours_start = parseTimeString(parts[0])
        body.work_hours_end = parseTimeString(parts[1])
      }
    }
    if (args.energyPeak ?? args["energy-peak"]) body.energy_peak = args.energyPeak ?? args["energy-peak"]
    if (args.focusGoal ?? args["focus-goal"]) body.focus_hours_goal = args.focusGoal ?? args["focus-goal"]
    if (args.break != null) body.break_duration = args.break
    if (args.buffer != null) body.meeting_buffer = args.buffer
    if (args.lunch) {
      const parts = (args.lunch as string).split("-").map((s: string) => s.trim())
      if (parts.length === 2) {
        body.lunch_window_start = parseTimeString(parts[0])
        body.lunch_window_end = parseTimeString(parts[1])
      }
    }
    if (args.maxMeetings ?? args["max-meetings"]) body.max_meetings_per_day = args.maxMeetings ?? args["max-meetings"]
    if (args.autoSchedule != null || args["auto-schedule"] != null) body.auto_schedule_enabled = args.autoSchedule ?? args["auto-schedule"]

    if (Object.keys(body).length === 0) {
      prompts.log.warn("No preferences specified. Use --work-hours, --energy-peak, --focus-goal, etc.")
      prompts.outro("Done")
      return
    }

    const res = await irisFetch("/api/v1/scheduling/preferences", {
      method: "PATCH",
      body: JSON.stringify(body),
    })
    const data = await res.json() as Record<string, any>

    if (!res.ok) {
      prompts.log.error(data?.error ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    for (const [k, v] of Object.entries(body)) {
      printKV(k, String(v))
    }
    prompts.outro(`${success("✓")} Preferences updated`)
  },
})

const CalendarPrefsCommand = cmd({
  command: "prefs",
  aliases: ["preferences"],
  describe: "manage scheduling preferences (work hours, energy, focus goals)",
  builder: (yargs) =>
    yargs
      .command(CalendarPrefsShowCommand)
      .command(CalendarPrefsSetCommand)
      .demandCommand(),
  async handler() {},
})

// ── HABITS ───────────────────────────────────────────────────
// Calls fl-api: /api/v1/scheduling/habits

const CalendarHabitsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your scheduling habits",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Habits")

    const res = await irisFetch("/api/v1/scheduling/habits")
    const data = await res.json() as Record<string, any>

    if (!res.ok) {
      prompts.log.error(data?.error ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    const habits: any[] = data.habits ?? []
    if (habits.length === 0) {
      prompts.log.info("No habits yet. Create one: iris calendar habits add \"Deep work\" --duration 90 --freq 5")
      prompts.outro("Done")
      return
    }

    for (const h of habits) {
      const status = h.is_active ? success("active") : dim("inactive")
      const window = h.window_start && h.window_end ? ` ${h.window_start}–${h.window_end}` : ""
      const days = h.preferred_days?.join(", ") ?? "any"
      console.log(`  ${bold(h.title)} ${status}`)
      console.log(`  ${dim(`${h.duration_minutes}min × ${h.frequency_per_week}/wk | ${h.category} | priority ${h.priority} | ${days}${window}`)}`)
      console.log(`  ${dim(`id: ${h.id}`)}`)
      console.log()
    }
    prompts.outro(`${success("✓")} ${habits.length} habit${habits.length === 1 ? "" : "s"}`)
  },
})

const CalendarHabitsAddCommand = cmd({
  command: "add <title>",
  aliases: ["create"],
  describe: "create a new scheduling habit",
  builder: (yargs) =>
    yargs
      .positional("title", { type: "string", demandOption: true })
      .option("duration", { type: "number", demandOption: true, describe: "duration in minutes" })
      .option("freq", { type: "number", default: 1, describe: "times per week (1-7)" })
      .option("category", { type: "string", choices: ["focus", "routine", "exercise", "admin", "break"] as const, default: "routine" as const })
      .option("days", { type: "array", string: true, describe: "preferred days (monday, tuesday, ...)" })
      .option("window", { type: "string", describe: "time window, e.g. '9am-12pm'" })
      .option("priority", { type: "number", default: 5, describe: "1-10 (10 = highest)" })
      .option("bloq", { type: "number", describe: "scope to a specific bloq/project" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro(`◈  Calendar — Add Habit "${args.title}"`)

    const body: Record<string, any> = {
      title: args.title,
      duration_minutes: args.duration,
      frequency_per_week: args.freq,
      category: args.category,
      priority: args.priority,
    }
    if (args.days) body.preferred_days = args.days
    if (args.bloq) body.bloq_id = args.bloq
    if (args.window) {
      const parts = (args.window as string).split("-").map((s: string) => s.trim())
      if (parts.length === 2) {
        body.window_start = parseTimeString(parts[0])
        body.window_end = parseTimeString(parts[1])
      }
    }

    const res = await irisFetch("/api/v1/scheduling/habits", {
      method: "POST",
      body: JSON.stringify(body),
    })
    const data = await res.json() as Record<string, any>

    if (!res.ok) {
      prompts.log.error(data?.error ?? data?.message ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    const h = data.habit ?? {}
    printKV("Title", bold(h.title))
    printKV("Duration", `${h.duration_minutes} min`)
    printKV("Frequency", `${h.frequency_per_week}x/week`)
    printKV("Category", h.category)
    printKV("Priority", String(h.priority))
    if (h.id) printKV("ID", dim(String(h.id)))
    prompts.outro(`${success("✓")} Habit created`)
  },
})

const CalendarHabitsRemoveCommand = cmd({
  command: "remove <id>",
  aliases: ["delete", "rm"],
  describe: "delete a scheduling habit",
  builder: (yargs) =>
    yargs.positional("id", { type: "number", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro(`◈  Calendar — Remove Habit #${args.id}`)

    const res = await irisFetch(`/api/v1/scheduling/habits/${args.id}`, { method: "DELETE" })
    if (!res.ok) {
      const data = await res.json() as Record<string, any>
      prompts.log.error(data?.error ?? data?.message ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }
    prompts.outro(`${success("✓")} Habit deleted`)
  },
})

const CalendarHabitsCommand = cmd({
  command: "habits",
  describe: "manage recurring scheduling habits (focus time, routines, exercise)",
  builder: (yargs) =>
    yargs
      .command(CalendarHabitsListCommand)
      .command(CalendarHabitsAddCommand)
      .command(CalendarHabitsRemoveCommand)
      .demandCommand(),
  async handler() {},
})

// ── ANALYTICS ────────────────────────────────────────────────
const CalendarAnalyticsCommand = cmd({
  command: "analytics",
  aliases: ["stats"],
  describe: "time distribution analytics for your calendar",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Calendar — Analytics")

    const res = await irisFetch("/api/v1/scheduling/analytics")
    const data = await res.json() as Record<string, any>

    if (!res.ok) {
      prompts.log.error(data?.error ?? `HTTP ${res.status}`)
      process.exitCode = 1 // signal failure to scripts/automation (#155323)
      prompts.outro("Done")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(data, null, 2))
      prompts.outro("Done")
      return
    }

    const a = data.analytics ?? {}
    printKV("Week", data.week ?? "current")
    printDivider()
    printKV("Available", `${a.total_available_hours ?? 0}h`)
    printKV("Meetings", `${a.meetings_hours ?? 0}h`)
    printKV("Tasks", `${a.tasks_hours ?? 0}h`)
    printKV("Habits", `${a.habits_hours ?? 0}h`)
    const focusMet = a.focus_goal_met ? success("MET") : dim("NOT MET")
    printKV("Focus", `${a.focus_hours_actual ?? 0}h / ${a.focus_hours_goal ?? 0}h (${focusMet})`)
    printKV("Free", `${a.unscheduled_hours ?? 0}h`)
    printKV("Utilization", `${a.utilization_pct ?? 0}%`)
    prompts.outro(`${success("✓")} Analytics`)
  },
})

// ── HELPER ───────────────────────────────────────────────────
function parseTimeString(s: string): string {
  // Convert "9am", "2pm", "14:30" → "HH:mm"
  s = s.trim().toLowerCase()
  const ampm = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)$/i)
  if (ampm) {
    let h = parseInt(ampm[1])
    const m = ampm[2] ? parseInt(ampm[2]) : 0
    if (ampm[3] === "pm" && h < 12) h += 12
    if (ampm[3] === "am" && h === 12) h = 0
    return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`
  }
  // Already HH:mm
  if (/^\d{2}:\d{2}$/.test(s)) return s
  return s
}

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
      .command(CalendarDefaultCommand)
      .command(CalendarScheduleCommand)
      .command(CalendarPrefsCommand)
      .command(CalendarHabitsCommand)
      .command(CalendarAnalyticsCommand)
      .demandCommand(),
  async handler() {},
})
