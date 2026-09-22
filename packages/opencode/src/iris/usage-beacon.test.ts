import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { UsageBeacon } from "./usage-beacon"

const home = () => mkdtempSync(join(tmpdir(), "iris-desk-"))
function capture() {
  const calls: any[] = []
  const fetchImpl = (async (url: any, init: any) => {
    calls.push({ url: String(url), body: JSON.parse(init.body), auth: init.headers.Authorization })
    return new Response("{}", { status: 202 })
  }) as any
  return { calls, fetchImpl }
}
const base = { token: "t", apiBase: "http://capture", version: "1.18.99" }

describe("desktop UsageBeacon (#186171)", () => {
  test("sends app_open as source=desktop with version and OS — nothing else", async () => {
    const { calls, fetchImpl } = capture()
    expect(await UsageBeacon.send("app_open", { ...base, env: {}, home: home(), fetchImpl })).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://capture/api/v6/telemetry/errors")
    expect(calls[0].body).toEqual({ cli_version: "1.18.99", os: process.platform, events: [{ source: "desktop", event_type: "app_open", severity: "info" }] })
  })

  test("every opt-out sends nothing: IRIS_TELEMETRY=0, DO_NOT_TRACK=1, `iris telemetry off`", async () => {
    const { calls, fetchImpl } = capture()
    await UsageBeacon.send("app_open", { ...base, env: { IRIS_TELEMETRY: "0" }, home: home(), fetchImpl })
    await UsageBeacon.send("app_open", { ...base, env: { DO_NOT_TRACK: "1" }, home: home(), fetchImpl })
    const h = home()
    mkdirSync(join(h, ".iris"), { recursive: true })
    writeFileSync(join(h, ".iris", "telemetry.json"), JSON.stringify({ enabled: false }))
    await UsageBeacon.send("app_open", { ...base, env: {}, home: h, fetchImpl })
    expect(calls).toEqual([])
  })

  test("no token, or a failing network, is a quiet false — never a throw", async () => {
    const { calls, fetchImpl } = capture()
    expect(await UsageBeacon.send("app_open", { ...base, token: null, env: {}, home: home(), fetchImpl })).toBe(false)
    expect(calls).toEqual([])
    const boom = (async () => { throw new Error("offline") }) as any
    expect(await UsageBeacon.send("app_open", { ...base, env: {}, home: home(), fetchImpl: boom })).toBe(false)
  })
})
