import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, writeJson, printDivider, printKV, dim, bold, success, warn, FL_API } from "./iris-api"
import { resolveBloqId } from "./platform-bloqs"

/**
 * `iris status` — Status & Emergency for clients (#191444, built on #191265 / fl-api #170).
 *
 * A client raises incidents for THEIR OWN projects, sees platform incidents that affect them in
 * plain words, and decides who gets told (email / in-app, minimum severity, extra addresses) at
 * the account level or per project. Everything is on FL_API behind flexible.auth:
 *
 *   GET  /api/v1/status/incidents?open=1&limit=        → {data: [incident…]}
 *   POST /api/v1/status/incidents/raise                 {scope: "tenant", bloq_id, component, severity, title, summary, dedup_key}
 *   POST /api/v1/status/incidents/{id}/update           {body, status?, severity?, title?, summary?}
 *   POST /api/v1/status/incidents/{id}/resolve          {summary?}
 *   GET|PUT /api/v1/users/{u}/status-settings           (account default)
 *   GET|PUT /api/v1/users/{u}/bloqs/{b}/status-settings (project override; project > user > default)
 *   POST /api/v1/users/{u}/status-settings/test         {bloq_id?}
 *
 * SCOPE: this command only ever sends scope=tenant. Platform incidents are raised by the platform
 * itself (the server refuses a signed-in user anyway); a client sees them, read-only.
 *
 * Errors are sentences, never the server's raw body — see explainStatusError.
 */

export const SEVERITIES = ["minor", "major", "critical"] as const
export const STATUSES = ["investigating", "identified", "monitoring", "resolved"] as const
export const CHANNELS = ["email", "in_app", "sms"] as const
export const PLATFORM_NOTICES = ["affected", "all", "none"] as const
export const SETTINGS_FIELDS = ["channels", "min_severity", "platform_notices", "emails", "user_ids"] as const

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>
const defaultFetcher: Fetcher = (path, init) => irisFetch(path, init ?? {}, FL_API)

// ── pure helpers ──────────────────────────────────────────────────────────────────────────

/** Turn any non-2xx from the status routes into what the client should do next. */
export function explainStatusError(status: number, body: any, ctx: { id?: number | string; project?: number | string } = {}): string {
  const code = body?.error
  if (status === 401) return "You're signed out. Run: iris auth login"
  if (status === 403) {
    const m = typeof body?.message === "string" ? body.message : ""
    return m || "That isn't yours to change — you can only manage incidents on your own projects."
  }
  if (status === 404) {
    if (code === "bloq_not_found") return `Project ${ctx.project ?? ""} isn't one of yours — check the id with: iris bloqs list`.replace("  ", " ")
    if (ctx.id !== undefined) return `No incident #${ctx.id} on your account — see yours with: iris status list`
    return "Status alerts aren't available on this server yet."
  }
  if (status === 422) {
    if (code === "opted_out") return "Nothing would be sent: alerts are turned off here. Turn them on with: iris status settings --set channels=email,in_app"
    const errs = body?.errors
    if (errs && typeof errs === "object") {
      const lines = Object.entries(errs).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((m) => `${k}: ${String(m)}`))
      if (lines.length) return lines.join("\n")
    }
    if (typeof body?.message === "string" && body.message) return body.message
    return "Some of those values weren't accepted — check them with --help."
  }
  if (status === 429) return "Too many requests in a row — wait a minute and try again."
  if (status === 503) return "Status alerts aren't switched on for this server yet. Nothing was sent."
  return `IRIS couldn't do that right now (server error ${status}). Try again in a minute.`
}

/** A stable dedup key from what the incident is about, so re-raising the same thing is one incident. */
export function dedupKeyFor(title: string, bloqId?: number | null): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "incident"
  return `cli:${bloqId ?? "account"}:${slug}`.slice(0, 150)
}

export function raiseBody(o: {
  bloqId?: number | null
  severity: string
  title: string
  summary: string
  component?: string
  key?: string
  detail?: string
}): { body: Record<string, unknown> } | { error: string } {
  if (!SEVERITIES.includes(o.severity as any)) return { error: `--severity must be one of: ${SEVERITIES.join(", ")}.` }
  if (!o.title?.trim()) return { error: "--title is required: one line saying what is wrong." }
  if (!o.summary?.trim()) return { error: "--summary is required: what people affected should know, in plain words." }
  const body: Record<string, unknown> = {
    scope: "tenant",
    component: (o.component || (o.bloqId ? "project" : "account")).slice(0, 120),
    severity: o.severity,
    title: o.title.trim(),
    summary: o.summary.trim(),
    dedup_key: o.key || dedupKeyFor(o.title, o.bloqId),
    source: "iris-cli",
  }
  if (o.bloqId) body.bloq_id = o.bloqId
  if (o.detail) body.detail = o.detail
  return { body }
}

/**
 * `--set k=v`, `--add-email`, `--remove-email`, `--unset k` → the PUT body.
 * `current` is the tier's own stored settings and `effective` what applies now; a list edit starts
 * from the tier's own list, or the inherited one when the tier has none, so adding an address
 * never silently drops the ones already being alerted.
 */
export function settingsChanges(
  o: { set?: string[]; unset?: string[]; addEmail?: string[]; removeEmail?: string[] },
  current: Record<string, any> = {},
  effective: Record<string, any> = {},
): { changes: Record<string, unknown> } | { error: string } {
  const changes: Record<string, unknown> = {}
  for (const raw of o.set ?? []) {
    const i = raw.indexOf("=")
    if (i <= 0) return { error: `--set needs field=value (got "${raw}"). Fields: ${SETTINGS_FIELDS.join(", ")}.` }
    const k = raw.slice(0, i).trim()
    const v = raw.slice(i + 1).trim()
    const list = v === "" ? [] : v.split(",").map((s) => s.trim()).filter(Boolean)
    switch (k) {
      case "channels": {
        if (["none", "off", "false"].includes(v.toLowerCase())) { changes.channels = []; break }
        const mapped = list.map((c) => (c === "database" || c === "inapp" ? "in_app" : c))
        const bad = mapped.filter((c) => !CHANNELS.includes(c as any))
        if (bad.length) return { error: `Unknown channel ${bad.join(", ")} — use: ${CHANNELS.join(", ")} (or none).` }
        changes.channels = mapped
        break
      }
      case "min_severity":
        if (!SEVERITIES.includes(v as any)) return { error: `min_severity must be one of: ${SEVERITIES.join(", ")}.` }
        changes.min_severity = v
        break
      case "platform_notices":
        if (!PLATFORM_NOTICES.includes(v as any)) return { error: `platform_notices must be one of: ${PLATFORM_NOTICES.join(", ")}.` }
        changes.platform_notices = v
        break
      case "emails":
        for (const e of list) if (!isEmail(e)) return { error: `${e} doesn't look like an email address.` }
        changes.emails = list
        break
      case "user_ids": {
        const ids = list.map(Number)
        if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return { error: "user_ids must be a comma list of user ids." }
        changes.user_ids = ids
        break
      }
      default:
        return { error: `Unknown setting ${k} — you can set: ${SETTINGS_FIELDS.join(", ")}.` }
    }
  }
  for (const k of o.unset ?? []) {
    if (!SETTINGS_FIELDS.includes(k as any)) return { error: `Unknown setting ${k} — you can unset: ${SETTINGS_FIELDS.join(", ")}.` }
    changes[k] = null
  }
  if ((o.addEmail?.length || o.removeEmail?.length) && "emails" in changes) {
    return { error: "Use either --set emails=… or --add-email/--remove-email, not both." }
  }
  if (o.addEmail?.length || o.removeEmail?.length) {
    const base: string[] = Array.isArray(current.emails) ? current.emails : Array.isArray(effective.emails) ? effective.emails : []
    const next = [...base]
    for (const e of o.addEmail ?? []) {
      if (!isEmail(e)) return { error: `${e} doesn't look like an email address.` }
      if (!next.some((x) => x.toLowerCase() === e.toLowerCase())) next.push(e)
    }
    for (const e of o.removeEmail ?? []) {
      const at = next.findIndex((x) => x.toLowerCase() === e.toLowerCase())
      if (at === -1) return { error: `${e} isn't on the alert list here.` }
      next.splice(at, 1)
    }
    if (next.length > 10) return { error: "At most 10 extra email addresses per account or project." }
    changes.emails = next
  }
  return { changes }
}

function isEmail(s: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)
}

/** One incident as a client reads it. */
export function describeIncident(i: any): string[] {
  const sev = String(i.severity ?? "").toUpperCase()
  const head = `#${i.id}  ${sev}  ${i.title ?? ""}`
  const state = i.open === false || i.resolved_at ? `resolved ${String(i.resolved_at ?? "").slice(0, 16).replace("T", " ")}` : `${i.status ?? "open"} since ${String(i.opened_at ?? "").slice(0, 16).replace("T", " ")}`
  const where = i.scope === "platform" ? `IRIS platform${i.component ? ` · ${i.component}` : ""}` : i.bloq_id ? `project #${i.bloq_id}` : "your account"
  const out = [head, `   ${where} — ${state}`]
  if (i.summary) out.push(`   ${i.summary}`)
  const last = (i.updates ?? []).find((u: any) => !u.internal)
  if (last?.body) out.push(`   latest: ${last.body}`)
  return out
}

/** Split into "your projects" and "platform, affecting you"; platform ones are already filtered server-side. */
export function groupIncidents(list: any[], bloqId?: number | null): { mine: any[]; platform: any[] } {
  const mine = list.filter((i) => i.scope !== "platform" && (!bloqId || Number(i.bloq_id) === bloqId))
  const platform = list.filter((i) => i.scope === "platform")
  return { mine, platform }
}

export function settingsPath(userId: number, bloqId?: number | null): string {
  return bloqId ? `/api/v1/users/${userId}/bloqs/${bloqId}/status-settings` : `/api/v1/users/${userId}/status-settings`
}

// ── IO ────────────────────────────────────────────────────────────────────────────────────

type Result<T> = { ok: true; data: T } | { ok: false; error: string; status: number }

async function call<T = any>(fetcher: Fetcher, path: string, init: RequestInit, ctx: { id?: number | string; project?: number | string } = {}): Promise<Result<T>> {
  let res: Response
  try {
    res = await fetcher(path, init)
  } catch {
    return { ok: false, status: 0, error: "Couldn't reach IRIS — check your connection and try again." }
  }
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { ok: false, status: res.status, error: explainStatusError(res.status, body, ctx) }
  return { ok: true, data: body as T }
}

export const statusApi = {
  list: (f: Fetcher, o: { all?: boolean; limit?: number } = {}) =>
    call<{ data: any[] }>(f, `/api/v1/status/incidents?${new URLSearchParams({ ...(o.all ? {} : { open: "1" }), limit: String(o.limit ?? 50) })}`, { method: "GET" }),
  raise: (f: Fetcher, body: Record<string, unknown>) =>
    call(f, "/api/v1/status/incidents/raise", { method: "POST", body: JSON.stringify(body) }, { project: body.bloq_id as number }),
  update: (f: Fetcher, id: number, body: Record<string, unknown>) =>
    call(f, `/api/v1/status/incidents/${id}/update`, { method: "POST", body: JSON.stringify(body) }, { id }),
  resolve: (f: Fetcher, id: number, summary?: string) =>
    call(f, `/api/v1/status/incidents/${id}/resolve`, { method: "POST", body: JSON.stringify(summary ? { summary } : {}) }, { id }),
  getSettings: (f: Fetcher, userId: number, bloqId?: number | null) =>
    call<{ data: any }>(f, settingsPath(userId, bloqId), { method: "GET" }, { project: bloqId ?? undefined }),
  putSettings: (f: Fetcher, userId: number, bloqId: number | null | undefined, changes: Record<string, unknown>) =>
    call<{ data: any }>(f, settingsPath(userId, bloqId), { method: "PUT", body: JSON.stringify(changes) }, { project: bloqId ?? undefined }),
  test: (f: Fetcher, userId: number, bloqId?: number | null) =>
    call<{ success: boolean; results: any[] }>(f, `/api/v1/users/${userId}/status-settings/test`, { method: "POST", body: JSON.stringify(bloqId ? { bloq_id: bloqId } : {}) }, { project: bloqId ?? undefined }),
}

// ── command plumbing ──────────────────────────────────────────────────────────────────────

async function fail(json: boolean, msg: string): Promise<void> {
  process.exitCode = 1
  if (json) return writeJson({ success: false, error: msg })
  for (const line of msg.split("\n")) prompts.log.error(line)
  prompts.outro("Done")
}

/** Auth + user id + optional --project (id or name). Null means a message was already shown. */
async function setup(args: any, title: string): Promise<{ json: boolean; userId: number; bloqId: number | null } | null> {
  const json = !!args.json
  if (!json) { UI.empty(); prompts.intro(`◈  ${title}`) }
  if (!(await requireAuth())) { if (!json) prompts.outro("Done"); return null }
  const userId = await requireUserId(args["user-id"])
  if (!userId) { await fail(json, "Could not work out your user id — pass --user-id or run iris auth login."); return null }
  let bloqId: number | null = null
  if (args.project !== undefined && args.project !== "") {
    const r = await resolveBloqId(String(args.project), userId, json)
    if (!r) { if (!json) prompts.outro("Done"); return null }
    bloqId = r
  }
  return { json, userId, bloqId }
}

const common = (y: any) =>
  y
    .option("json", { describe: "JSON output", type: "boolean", default: false })
    .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })

function parseId(raw: unknown): number | null {
  const n = Number(raw)
  return Number.isInteger(n) && n > 0 ? n : null
}

// ── subcommands ───────────────────────────────────────────────────────────────────────────

export const StatusListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "open incidents on your projects, plus IRIS platform incidents that affect you",
  builder: (yargs) =>
    common(yargs)
      .option("project", { describe: "only this project (id or name)", type: "string" })
      .option("all", { describe: "include resolved incidents", type: "boolean", default: false })
      .option("limit", { describe: "how many to fetch", type: "number", default: 50 })
      .example("iris status list", "what is wrong right now")
      .example("iris status list --project 550 --all", "every incident on project #550, resolved ones too"),
  async handler(args) {
    const s = await setup(args, "Status")
    if (!s) return
    const r = await statusApi.list(defaultFetcher, { all: !!args.all, limit: args.limit as number })
    if (!r.ok) return fail(s.json, r.error)
    const { mine, platform } = groupIncidents(r.data?.data ?? [], s.bloqId)
    if (s.json) return writeJson({ success: true, incidents: mine, platform })
    if (!mine.length && !platform.length) {
      prompts.log.success(args.all ? "No incidents on record." : "All clear — nothing is open on your projects or on IRIS.")
      prompts.outro(dim("iris status raise --project <id> --severity major --title … --summary …"))
      return
    }
    if (mine.length) {
      console.log(`  ${bold(s.bloqId ? `Project #${s.bloqId}` : "Your projects")}`)
      for (const i of mine) for (const l of describeIncident(i)) console.log(`  ${l}`)
      console.log("")
    }
    if (platform.length) {
      console.log(`  ${bold("IRIS platform — affecting you")}`)
      for (const i of platform) for (const l of describeIncident(i)) console.log(`  ${l}`)
      console.log("")
    }
    prompts.outro(dim("iris status update <id> --message …  ·  iris status resolve <id>"))
  },
})

export const StatusRaiseCommand = cmd({
  command: "raise",
  describe: "raise an incident on one of your projects — alerts the people in your status settings",
  builder: (yargs) =>
    common(yargs)
      .option("project", { describe: "project (bloq) id or name the incident is about", type: "string" })
      .option("severity", { describe: "minor | major | critical", type: "string", choices: [...SEVERITIES], demandOption: true })
      .option("title", { describe: "one line: what is wrong", type: "string", demandOption: true })
      .option("summary", { describe: "what affected people should know, in plain words", type: "string", demandOption: true })
      .option("component", { describe: "what part is affected (e.g. data-feed, checkout)", type: "string" })
      .option("key", { describe: "dedup key — raising the same key again updates the open incident instead of opening a second", type: "string" })
      .option("detail", { describe: "internal detail (only you see it)", type: "string" })
      .example(
        "iris status raise --project 550 --severity major --title \"Price feed is down\" --summary \"Quotes are delayed; trades are paused until it is back.\"",
        "page your on-call contacts about project #550",
      ),
  async handler(args) {
    const s = await setup(args, "Raise incident")
    if (!s) return
    const b = raiseBody({
      bloqId: s.bloqId,
      severity: String(args.severity),
      title: String(args.title ?? ""),
      summary: String(args.summary ?? ""),
      component: args.component as string | undefined,
      key: args.key as string | undefined,
      detail: args.detail as string | undefined,
    })
    if ("error" in b) return fail(s.json, b.error)
    const r = await statusApi.raise(defaultFetcher, b.body)
    if (!r.ok) return fail(s.json, r.error)
    const d: any = r.data
    if (s.json) return writeJson(d)
    if (d.created) prompts.log.success(`${success("✓")} Incident #${d.incident_id} raised (${d.severity}) — your alert contacts are being told.`)
    else prompts.log.info(`Already open as #${d.incident_id} — raised again${d.escalated ? `, escalated to ${d.severity}` : ""}. No duplicate was created.`)
    prompts.outro(dim(`iris status update ${d.incident_id} --message …  ·  iris status resolve ${d.incident_id}`))
  },
})

export const StatusUpdateCommand = cmd({
  command: "update <id>",
  describe: "post an update on one of your incidents (optionally change its status or severity)",
  builder: (yargs) =>
    common(yargs.positional("id", { describe: "incident id", type: "number", demandOption: true }))
      .option("message", { alias: "m", describe: "the update, in plain words", type: "string", demandOption: true })
      .option("status", { describe: "investigating | identified | monitoring | resolved", type: "string", choices: [...STATUSES] })
      .option("severity", { describe: "minor | major | critical", type: "string", choices: [...SEVERITIES] })
      .option("title", { describe: "new title", type: "string" })
      .option("summary", { describe: "new client-facing summary", type: "string" })
      .example("iris status update 812 -m \"Feed restored; watching for 30 minutes\" --status monitoring", "post progress on #812"),
  async handler(args) {
    const s = await setup(args, `Update incident #${args.id}`)
    if (!s) return
    const id = parseId(args.id)
    if (!id) return fail(s.json, `"${args.id}" isn't an incident id — expected a number (see: iris status list).`)
    const body: Record<string, unknown> = { body: String(args.message ?? "") }
    for (const k of ["status", "severity", "title", "summary"] as const) if (args[k]) body[k] = args[k]
    if (!String(body.body).trim()) return fail(s.json, "--message is required: what changed, in plain words.")
    const r = await statusApi.update(defaultFetcher, id, body)
    if (!r.ok) return fail(s.json, r.error)
    const d: any = r.data
    if (s.json) return writeJson(d)
    prompts.log.success(`${success("✓")} #${id} updated — ${d.resolved ? "resolved" : `${d.status}, ${d.severity}`}.`)
    prompts.outro("Done")
  },
})

export const StatusResolveCommand = cmd({
  command: "resolve <id>",
  describe: "resolve one of your incidents — tells the people who were alerted that it is fixed",
  builder: (yargs) =>
    common(yargs.positional("id", { describe: "incident id", type: "number", demandOption: true }))
      .option("summary", { describe: "what fixed it, in plain words", type: "string" })
      .example("iris status resolve 812 --summary \"Feed back since 14:05; no trades were lost.\"", "close #812"),
  async handler(args) {
    const s = await setup(args, `Resolve incident #${args.id}`)
    if (!s) return
    const id = parseId(args.id)
    if (!id) return fail(s.json, `"${args.id}" isn't an incident id — expected a number (see: iris status list).`)
    const r = await statusApi.resolve(defaultFetcher, id, args.summary as string | undefined)
    if (!r.ok) return fail(s.json, r.error)
    const d: any = r.data
    if (s.json) return writeJson(d)
    if (d.resolved) prompts.log.success(`${success("✓")} #${id} resolved — a resolved notice is going to everyone who was alerted.`)
    else prompts.log.info(`#${id} was already resolved — nothing changed.`)
    prompts.outro("Done")
  },
})

function printSettings(d: any, bloqId: number | null): void {
  const eff = d?.effective ?? {}
  const own = bloqId ? d?.project ?? {} : d?.user ?? {}
  const show = (v: any) => (Array.isArray(v) ? (v.length ? v.join(", ") : "none") : v === undefined || v === null ? dim("inherited") : String(v))
  console.log(`  ${bold(bloqId ? `Project #${bloqId} — overrides your account where set` : "Your account (default for every project)")}`)
  printDivider()
  printKV("Channels", Array.isArray(eff.channels) ? (eff.channels.length ? eff.channels.join(", ") : warn("off — nobody is alerted")) : "by severity (default)")
  printKV("Minimum severity", eff.min_severity ?? "minor")
  printKV("Platform notices", eff.platform_notices ?? "affected")
  printKV("Extra emails", show(eff.emails ?? []))
  printKV("Teammates (user ids)", show(eff.user_ids ?? []))
  printDivider()
  const set = Object.keys(own).filter((k) => own[k] !== null && own[k] !== undefined)
  console.log(`  ${dim(set.length ? `Set here: ${set.join(", ")} — everything else comes from ${bloqId ? "your account, then the default" : "the default"}.` : "Nothing set here — all inherited.")}`)
}

export const StatusSettingsCommand = cmd({
  command: "settings",
  describe: "who is alerted and how — account default, or per project with --project",
  builder: (yargs) =>
    common(yargs)
      .option("project", { describe: "project (bloq) id or name — omit for your account default", type: "string" })
      .option("set", { describe: "field=value (repeatable): channels=email,in_app|none · min_severity=minor|major|critical · platform_notices=affected|all|none · emails=a@x,b@y · user_ids=1,2", type: "string", array: true })
      .option("unset", { describe: "clear a field here so the next level applies (repeatable)", type: "string", array: true })
      .option("add-email", { describe: "add an address to the alert list (repeatable)", type: "string", array: true })
      .option("remove-email", { describe: "remove an address from the alert list (repeatable)", type: "string", array: true })
      .example("iris status settings", "show who is alerted for your account")
      .example("iris status settings --set channels=email,in_app --set min_severity=major", "email + in-app, major and critical only")
      .example("iris status settings --project 550 --add-email ops@acme.com", "also email ops@acme.com about project #550"),
  async handler(args) {
    const s = await setup(args, args.project ? "Status settings — project" : "Status settings")
    if (!s) return
    const editing = !!((args.set as string[] | undefined)?.length || (args.unset as string[] | undefined)?.length || (args["add-email"] as string[] | undefined)?.length || (args["remove-email"] as string[] | undefined)?.length)

    const got = await statusApi.getSettings(defaultFetcher, s.userId, s.bloqId)
    if (!got.ok) return fail(s.json, got.error)
    let data = got.data?.data ?? {}

    if (editing) {
      const own = (s.bloqId ? data.project : data.user) ?? {}
      const c = settingsChanges(
        { set: args.set as string[], unset: args.unset as string[], addEmail: args["add-email"] as string[], removeEmail: args["remove-email"] as string[] },
        own,
        data.effective ?? {},
      )
      if ("error" in c) return fail(s.json, c.error)
      const put = await statusApi.putSettings(defaultFetcher, s.userId, s.bloqId, c.changes)
      if (!put.ok) return fail(s.json, put.error)
      data = put.data?.data ?? data
      if (!s.json) prompts.log.success(`${success("✓")} Saved.`)
    }
    if (s.json) return writeJson({ success: true, ...data })
    printSettings(data, s.bloqId)
    prompts.outro(dim(`iris status test${s.bloqId ? ` --project ${s.bloqId}` : ""}  — send a test alert to check it reaches people`))
  },
})

export const StatusTestCommand = cmd({
  command: "test",
  describe: "send a test alert to everyone your settings would alert, and show who got it",
  builder: (yargs) =>
    common(yargs)
      .option("project", { describe: "use this project's settings (id or name)", type: "string" })
      .example("iris status test", "test your account's alert contacts")
      .example("iris status test --project 550", "test the contacts for project #550"),
  async handler(args) {
    const s = await setup(args, "Test alert")
    if (!s) return
    const r = await statusApi.test(defaultFetcher, s.userId, s.bloqId)
    if (!r.ok) return fail(s.json, r.error)
    const d: any = r.data
    if (s.json) return writeJson(d)
    for (const x of d.results ?? []) {
      const who = x.type === "user" ? `user #${x.to}` : String(x.to)
      const how = (x.channels ?? []).join(", ")
      if (x.ok) prompts.log.success(`${who} — sent (${how})`)
      else if (x.deduped) prompts.log.info(`${who} — already sent a test this minute`)
      else prompts.log.error(`${who} — not delivered (${how}). Check the address, or the channel in: iris status settings`)
    }
    prompts.outro(d.success ? "Test alert sent." : "Some test alerts did not go out — see above.")
  },
})

export const PlatformStatusCommand = cmd({
  command: "status",
  describe: "Status & emergency for your projects — list, raise, update and resolve incidents; choose who is alerted",
  builder: (yargs) =>
    yargs
      .command(StatusListCommand)
      .command(StatusRaiseCommand)
      .command(StatusUpdateCommand)
      .command(StatusResolveCommand)
      .command(StatusSettingsCommand)
      .command(StatusTestCommand)
      .example("iris status list", "what is wrong right now, yours and IRIS's")
      .example("iris status raise --project 550 --severity critical --title \"Orders failing\" --summary \"Checkout errors since 09:10.\"", "page your contacts")
      .demandCommand(),
  async handler() {},
})
