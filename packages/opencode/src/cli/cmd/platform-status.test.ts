import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import {
  PlatformStatusCommand,
  dedupKeyFor,
  describeIncident,
  explainStatusError,
  groupIncidents,
  raiseBody,
  settingsChanges,
  settingsPath,
  statusApi,
} from "./platform-status"

/**
 * `iris status` (#191444) against a fake fl-api mirroring StatusIncidentController and
 * StatusSettingsController (fl-api #170). The CLI only ever sends scope=tenant; the fake refuses
 * anything else the way the server does for a signed-in user.
 */

function fakeFlApi() {
  const calls: { method: string; path: string; body?: any }[] = []
  const incidents: any[] = [
    { id: 1, scope: "platform", component: "models", severity: "major", status: "investigating", title: "Model provider down", summary: "One of our AI providers is unavailable.", open: true, opened_at: "2026-10-27T02:41:06+00:00", updates: [] },
  ]
  let userSettings: Record<string, any> = { emails: ["owner@acme.com"] }
  const bloqSettings: Record<number, Record<string, any>> = {}
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } })
  const describe = (bloq?: number) => {
    const project = bloq ? bloqSettings[bloq] ?? {} : undefined
    const effective: Record<string, any> = { min_severity: "minor", platform_notices: "affected", ...userSettings, ...(project ?? {}) }
    return { ...(bloq ? { bloq_id: bloq, project } : {}), user: userSettings, effective }
  }
  const fetcher = async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET"
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    calls.push({ method, path, body })
    if (method === "GET" && path.startsWith("/api/v1/status/incidents?")) {
      const open = new URLSearchParams(path.split("?")[1]).get("open") === "1"
      return json(200, { data: incidents.filter((i) => !open || i.open) })
    }
    if (method === "POST" && path === "/api/v1/status/incidents/raise") {
      if (body.scope !== "tenant") return json(403, { success: false, error: "forbidden", message: "Platform incidents are raised by the platform only." })
      if (body.bloq_id && body.bloq_id !== 550) return json(404, { success: false, error: "bloq_not_found" })
      const open = incidents.find((i) => i.open && i.dedup_key === body.dedup_key)
      if (open) return json(200, { success: true, incident_id: open.id, created: false, escalated: false, status: open.status, severity: open.severity })
      const i = { id: incidents.length + 1, scope: "tenant", user_id: 7, bloq_id: body.bloq_id ?? null, open: true, status: "investigating", ...body }
      incidents.push(i)
      return json(200, { success: true, incident_id: i.id, created: true, escalated: false, status: i.status, severity: i.severity })
    }
    let m = path.match(/^\/api\/v1\/status\/incidents\/(\d+)\/(update|resolve)$/)
    if (m && method === "POST") {
      const i = incidents.find((x) => x.id === Number(m![1]) && x.scope === "tenant")
      if (!i) return json(404, { success: false, error: "not_found" })
      if (m[2] === "resolve") {
        const was = i.open
        i.open = false
        return json(200, { success: true, incident_id: i.id, resolved: was })
      }
      Object.assign(i, { status: body.status ?? i.status, severity: body.severity ?? i.severity })
      return json(200, { success: true, incident_id: i.id, updated: true, resolved: false, status: i.status, severity: i.severity })
    }
    m = path.match(/^\/api\/v1\/users\/7(?:\/bloqs\/(\d+))?\/status-settings$/)
    if (m) {
      const bloq = m[1] ? Number(m[1]) : undefined
      if (bloq && bloq !== 550) return json(404, { success: false, error: "bloq_not_found" })
      if (method === "PUT") {
        if (body.min_severity && !["minor", "major", "critical"].includes(body.min_severity)) return json(422, { success: false, message: "Invalid settings.", errors: { min_severity: ["The selected min severity is invalid."] } })
        const target = bloq ? (bloqSettings[bloq] ??= {}) : userSettings
        for (const [k, v] of Object.entries(body)) v === null ? delete target[k] : (target[k] = v)
        if (!bloq) userSettings = target
        return json(200, { success: true, data: describe(bloq) })
      }
      return json(200, { data: describe(bloq) })
    }
    if (method === "POST" && path === "/api/v1/users/7/status-settings/test") {
      const eff = describe(body?.bloq_id).effective
      if (Array.isArray(eff.channels) && eff.channels.length === 0) return json(422, { success: false, error: "opted_out", message: "Nothing would be sent", results: [] })
      return json(200, { success: true, results: [{ type: "user", to: 7, channels: ["email", "in_app"], ok: true }, ...(eff.emails ?? []).map((e: string) => ({ type: "email", to: e, channels: ["email"], ok: true }))] })
    }
    return json(404, {})
  }
  return { fetcher, calls, incidents }
}

describe("raise", () => {
  test("builds a tenant-scoped body with a stable dedup key", () => {
    const r = raiseBody({ bloqId: 550, severity: "major", title: "Price feed is down!", summary: "Quotes delayed." })
    expect("body" in r && r.body).toEqual({
      scope: "tenant", component: "project", severity: "major", title: "Price feed is down!", summary: "Quotes delayed.",
      dedup_key: "cli:550:price-feed-is-down", source: "iris-cli", bloq_id: 550,
    })
    expect(dedupKeyFor("Price feed is down!", 550)).toBe(dedupKeyFor("price feed is down", 550))
  })
  test("bad input is a sentence before any network", () => {
    expect(raiseBody({ severity: "sev1", title: "x", summary: "y" })).toEqual({ error: "--severity must be one of: minor, major, critical." })
    expect(raiseBody({ severity: "minor", title: " ", summary: "y" })).toHaveProperty("error")
  })
  test("raise → raise again is one incident, then resolve", async () => {
    const api = fakeFlApi()
    const b = raiseBody({ bloqId: 550, severity: "major", title: "Feed down", summary: "Delayed." }) as { body: any }
    const first = await statusApi.raise(api.fetcher, b.body)
    expect(first.ok && (first.data as any).created).toBe(true)
    const again = await statusApi.raise(api.fetcher, b.body)
    expect(again.ok && (again.data as any)).toMatchObject({ created: false, incident_id: (first as any).data.incident_id })
    const id = (first as any).data.incident_id
    const up = await statusApi.update(api.fetcher, id, { body: "Restored, watching", status: "monitoring" })
    expect(up.ok && (up.data as any).status).toBe("monitoring")
    const res = await statusApi.resolve(api.fetcher, id, "Back since 14:05")
    expect(res.ok && (res.data as any).resolved).toBe(true)
    expect(api.calls.every((c) => c.body?.scope === undefined || c.body.scope === "tenant")).toBe(true)
  })
  test("a project that is not yours, and an incident that is not yours, read as next steps", async () => {
    const api = fakeFlApi()
    const r = await statusApi.raise(api.fetcher, (raiseBody({ bloqId: 999, severity: "minor", title: "x", summary: "y" }) as any).body)
    expect(r).toEqual({ ok: false, status: 404, error: "Project 999 isn't one of yours — check the id with: iris bloqs list" })
    const u = await statusApi.update(api.fetcher, 1, { body: "hi" })
    expect(u.ok).toBe(false)
    expect((u as any).error).toBe("No incident #1 on your account — see yours with: iris status list")
  })
})

describe("list", () => {
  test("open only by default; platform incidents grouped apart from yours", async () => {
    const api = fakeFlApi()
    await statusApi.raise(api.fetcher, (raiseBody({ bloqId: 550, severity: "critical", title: "Orders failing", summary: "Checkout errors." }) as any).body)
    const r = await statusApi.list(api.fetcher)
    expect(api.calls.at(-1)!.path).toContain("open=1")
    const g = groupIncidents((r as any).data.data)
    expect(g.mine.map((i) => i.title)).toEqual(["Orders failing"])
    expect(g.platform.map((i) => i.id)).toEqual([1])
    expect(groupIncidents((r as any).data.data, 551).mine).toEqual([])
  })
  test("an incident reads in plain words", () => {
    const lines = describeIncident({ id: 1, scope: "platform", component: "models", severity: "major", status: "investigating", title: "Model provider down", summary: "One of our AI providers is unavailable.", opened_at: "2026-10-27T02:41:06+00:00", updates: [{ body: "Switched to backup", internal: false }] })
    expect(lines).toEqual([
      "#1  MAJOR  Model provider down",
      "   IRIS platform · models — investigating since 2026-10-27 02:41",
      "   One of our AI providers is unavailable.",
      "   latest: Switched to backup",
    ])
  })
})

describe("settings", () => {
  test("--set parses channels, severity, notices; unknown fields and values are refused", () => {
    expect(settingsChanges({ set: ["channels=email,in_app", "min_severity=major", "platform_notices=all"] })).toEqual({
      changes: { channels: ["email", "in_app"], min_severity: "major", platform_notices: "all" },
    })
    expect(settingsChanges({ set: ["channels=none"] })).toEqual({ changes: { channels: [] } })
    expect(settingsChanges({ set: ["channels=pigeon"] })).toEqual({ error: "Unknown channel pigeon — use: email, in_app, sms (or none)." })
    expect(settingsChanges({ set: ["colour=red"] })).toHaveProperty("error")
    expect(settingsChanges({ set: ["min_severity=sev1"] })).toHaveProperty("error")
    expect(settingsChanges({ unset: ["emails"] })).toEqual({ changes: { emails: null } })
  })
  test("--add-email keeps inherited addresses; --remove-email of an absent one is a sentence", () => {
    expect(settingsChanges({ addEmail: ["ops@acme.com"] }, {}, { emails: ["owner@acme.com"] })).toEqual({ changes: { emails: ["owner@acme.com", "ops@acme.com"] } })
    expect(settingsChanges({ removeEmail: ["owner@acme.com"] }, { emails: ["owner@acme.com", "x@y.co"] })).toEqual({ changes: { emails: ["x@y.co"] } })
    expect(settingsChanges({ removeEmail: ["ghost@acme.com"] }, { emails: [] })).toEqual({ error: "ghost@acme.com isn't on the alert list here." })
    expect(settingsChanges({ addEmail: ["not-an-email"] })).toHaveProperty("error")
  })
  test("account vs project paths", () => {
    expect(settingsPath(7)).toBe("/api/v1/users/7/status-settings")
    expect(settingsPath(7, 550)).toBe("/api/v1/users/7/bloqs/550/status-settings")
  })
  test("project override round-trip, and a server 422 becomes field: message", async () => {
    const api = fakeFlApi()
    const got = await statusApi.getSettings(api.fetcher, 7, 550)
    const c = settingsChanges({ addEmail: ["ops@acme.com"], set: ["min_severity=major"] }, (got as any).data.data.project, (got as any).data.data.effective) as any
    const put = await statusApi.putSettings(api.fetcher, 7, 550, c.changes)
    expect((put as any).data.data.effective).toMatchObject({ emails: ["owner@acme.com", "ops@acme.com"], min_severity: "major" })
    const bad = await statusApi.putSettings(api.fetcher, 7, null, { min_severity: "sev1" })
    expect((bad as any).error).toBe("min_severity: The selected min severity is invalid.")
  })
})

describe("test alert", () => {
  test("sends to the effective contacts", async () => {
    const api = fakeFlApi()
    const r = await statusApi.test(api.fetcher, 7)
    expect((r as any).data.results.map((x: any) => x.to)).toEqual([7, "owner@acme.com"])
  })
  test("opted out explains how to turn alerts back on", async () => {
    const api = fakeFlApi()
    await statusApi.putSettings(api.fetcher, 7, null, { channels: [] })
    const r = await statusApi.test(api.fetcher, 7)
    expect((r as any).error).toContain("iris status settings --set channels=email,in_app")
  })
})

describe("explainStatusError", () => {
  test("never echoes a raw body", () => {
    expect(explainStatusError(500, { message: "SQLSTATE[HY000]" })).toBe("IRIS couldn't do that right now (server error 500). Try again in a minute.")
    expect(explainStatusError(401, {})).toContain("iris auth login")
    expect(explainStatusError(503, { error: "not_configured", message: "status_incidents table missing — run the migration." })).not.toContain("migration")
    expect(explainStatusError(429, {})).toContain("wait a minute")
  })
})

describe("help text", () => {
  async function help(argv: string): Promise<string> {
    let out = ""
    await yargs().scriptName("iris").wrap(null).command(PlatformStatusCommand as any).exitProcess(false).parse(argv, {}, (_e, _a, o) => { out = o })
    return out
  }
  test("every subcommand is listed with an example", async () => {
    const h = await help("status --help")
    for (const s of ["status list", "status raise", "status update <id>", "status resolve <id>", "status settings", "status test", "Examples:"]) expect(h).toContain(s)
  })
  test("each subcommand's help has its flags and an example", async () => {
    const want: Record<string, string[]> = {
      "status raise --help": ["--project", "--severity", "--title", "--summary", "iris status raise --project 550"],
      "status settings --help": ["--set", "--add-email", "--remove-email", "--unset", "iris status settings --project 550 --add-email"],
      "status test --help": ["--project", "iris status test"],
      "status list --help": ["--all", "iris status list"],
      "status update --help": ["--message", "--status", "iris status update 812"],
      "status resolve --help": ["--summary", "iris status resolve 812"],
    }
    for (const [argv, needles] of Object.entries(want)) {
      const h = await help(argv)
      for (const n of needles) expect(h).toContain(n)
    }
  })
})

describe("capability index (MCP iris_help / iris find discover these)", () => {
  const { readFileSync } = require("fs") as typeof import("fs")
  const { join } = require("path") as typeof import("path")
  const index = JSON.parse(readFileSync(join(import.meta.dir, "..", "..", "..", "capabilities.json"), "utf8"))
  const byName = new Map<string, any>((index.entries as any[]).map((e) => [e.name, e]))

  test("agents install / agents packs are indexed with how to run them", () => {
    expect(byName.get("agents install")?.run).toBe("iris agents install [pack]")
    expect(byName.get("agents packs")?.run).toBe("iris agents packs")
    expect(byName.get("agents install")?.haystack).toContain("dry-run")
  })

  test("every status subcommand is indexed, findable by the words a client would use", () => {
    for (const n of ["status", "status list", "status raise", "status update", "status resolve", "status settings", "status test"]) {
      expect(byName.get(n)?.kind).toBe("command")
    }
    expect(byName.get("status raise")?.haystack).toContain("incident")
    expect(byName.get("status settings")?.haystack).toContain("add-email")
    expect(byName.get("status test")?.haystack).toContain("test alert")
  })
})
