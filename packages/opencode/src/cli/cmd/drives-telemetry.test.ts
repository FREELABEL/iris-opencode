import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  drivesUsageContext, DrivesRun, metered, DRIVES_NUMBER_KEYS, DRIVES_BOOLEAN_KEYS, DRIVES_ENUM_KEYS,
} from "./drives-telemetry"
import { getFacts, type GetResult } from "./platform-drives"
import { Beacon } from "../../telemetry/beacon"

/**
 * #193356 — drives usage events carry numbers, booleans and fixed words only. The strings below
 * stand for everything a person could type or own: a path, a drive label, a file name, a search
 * word, a folder name, the reason given to `get`. None may appear anywhere in what is sent.
 */
const SECRETS = [
  "/Volumes/Redwalrus/Clients/Acme/brief.pdf",
  "Redwalrus",
  "brief.pdf",
  "final mix stems",
  "Personal/Family",
  "send the brief to the client",
  "fs:4c7a1e80-b101-4b95-8fd2-5f7084e4c5d9",
]

function hostile(): Record<string, unknown> {
  return {
    files_count: 60072, bytes_cataloged: 2.98e12, manifest_bytes: 812_345, folders_rows: 216, findings_count: 292,
    sensitive_count: 292, encrypted: false, unreadable_folders_count: 3, kind: "media-drive", checksums: "default",
    // everything below must be dropped
    path: SECRETS[0], label: SECRETS[1], file: SECRETS[2], words: SECRETS[3], folder: SECRETS[4], why: SECRETS[5],
    drive_id: SECRETS[6], results_count: SECRETS[0], drives_count: -1, connected_count: Number.NaN,
    platform: SECRETS[1], dry_run: "yes",
  }
}

describe("drivesUsageContext — an allowlist, not a blocklist", () => {
  test("keeps the counts and enums, drops every string a person owns", () => {
    const ctx = drivesUsageContext(hostile())
    expect(ctx).toEqual({
      files_count: 60072, bytes_cataloged: 2.98e12, manifest_bytes: 812_345, folders_rows: 216, findings_count: 292,
      sensitive_count: 292, unreadable_folders_count: 3, encrypted: false, kind: "media-drive", checksums: "default",
    })
    const text = JSON.stringify(ctx)
    for (const s of SECRETS) expect(text).not.toContain(s)
  })

  test("every value is a number, a boolean, or a word from its closed list", () => {
    const ctx = drivesUsageContext({ ...hostile(), platform: "darwin" })
    const enums = DRIVES_ENUM_KEYS as Record<string, readonly string[]>
    for (const [k, v] of Object.entries(ctx)) {
      if (typeof v === "string") expect(enums[k]).toContain(v)
      else if (typeof v === "number") expect((DRIVES_NUMBER_KEYS as readonly string[]).includes(k)).toBe(true)
      else expect((DRIVES_BOOLEAN_KEYS as readonly string[]).includes(k)).toBe(true)
    }
  })
})

describe("DrivesRun — one event per command", () => {
  test("names the event drives_<op>, carries outcome + duration, and only allowlisted context", () => {
    const sent: Array<[string, Beacon.Usage]> = []
    let t = 1000
    const run = new DrivesRun("scan", (type, e) => sent.push([type, e]), () => t)
    run.set(hostile() as any)
    t = 1850
    run.finish("ok")
    run.finish("error") // idempotent: still one event
    expect(sent).toHaveLength(1)
    const [type, e] = sent[0]
    expect(type).toBe("drives_scan")
    expect(e.command).toBe("drives")
    expect(e.outcome).toBe("ok")
    expect(e.duration_ms).toBe(850)
    expect(["darwin", "linux", "win32", "other"]).toContain(e.context!.platform as string)
    for (const s of SECRETS) expect(JSON.stringify(e)).not.toContain(s)
  })

  test("an exit code rides along as a number", () => {
    const sent: Beacon.Usage[] = []
    const run = new DrivesRun("path", (_t, e) => sent.push(e))
    run.finish("error", 2)
    expect(sent[0].context!.exit_code).toBe(2)
  })

  test("a throwing emitter never breaks the command", () => {
    const run = new DrivesRun("list", () => { throw new Error("network") })
    expect(() => run.finish("ok")).not.toThrow()
  })

  test("metered: ok on return, error on throw — always exactly one event", async () => {
    const sent: Array<[string, string | undefined]> = []
    const emit = (type: Beacon.UsageType, e: Beacon.Usage) => { sent.push([type, e.outcome]) }
    await metered("find", async (_a: unknown, run) => { run.set({ results_count: 3 }) }, emit)({})
    await expect(metered("copies", async () => { throw new Error("boom") }, emit)({})).rejects.toThrow("boom")
    expect(sent).toEqual([["drives_find", "ok"], ["drives_copies", "error"]])
  })

  test("get: the event says how many bytes, never which file or why", () => {
    const r: GetResult = {
      code: 0, out: [], err: [], dest: "/Users/x/Desktop/brief.pdf", bundle: false, sensitive: true,
      row: { path: "Clients/Acme/brief.pdf", purpose: SECRETS[5], drive_label: SECRETS[1], bytes: 48213 },
    }
    const facts = getFacts(r)
    expect(facts).toEqual({ results_count: 1, bytes_copied: 48213, bundle: false, sensitive: true })
    expect(getFacts({ code: 2, out: [], err: [] })).toEqual({ results_count: 0, bytes_copied: 0, bundle: false, sensitive: false })
  })
})

// ── through the real Beacon: consent decides whether anything leaves ─────────────────

describe("drives events through the Beacon", () => {
  const saved = { ...process.env }
  const realFetch = globalThis.fetch
  let posts: Array<{ url: string; body: any }> = []

  beforeEach(() => {
    posts = []
    process.env.IRIS_API_KEY = "test-key"
    process.env.IRIS_API_URL = "http://telemetry.test"
    delete process.env.DO_NOT_TRACK
    delete process.env.IRIS_TELEMETRY
    globalThis.fetch = (async (url: any, init: any) => {
      posts.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) })
      return new Response("{}", { status: 200 })
    }) as any
  })
  afterEach(async () => {
    globalThis.fetch = realFetch
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]
    Object.assign(process.env, saved)
  })

  test("consent on: one POST, the drives event inside it, no person's strings", async () => {
    const run = new DrivesRun("scan")
    run.set(hostile() as any)
    run.finish("ok")
    expect(await Beacon.flush(1000)).toBe(true)
    expect(posts).toHaveLength(1)
    expect(posts[0].url).toBe("http://telemetry.test/api/v6/telemetry/errors")
    const ev = posts[0].body.events.find((e: any) => e.event_type === "drives_scan")
    expect(ev).toMatchObject({ severity: "info", command: "drives", outcome: "ok" })
    expect(ev.context.files_count).toBe(60072)
    const text = JSON.stringify(posts[0].body)
    for (const s of SECRETS) expect(text).not.toContain(s)
  })

  for (const [name, env] of [
    ["IRIS_TELEMETRY=0", { IRIS_TELEMETRY: "0" }],
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }],
  ] as const) {
    test(`consent off (${name}): nothing is sent`, async () => {
      Object.assign(process.env, env)
      const run = new DrivesRun("find")
      run.set({ results_count: 4 })
      run.finish("ok")
      await Beacon.flush(1000)
      expect(posts).toHaveLength(0)
    })
  }
})
