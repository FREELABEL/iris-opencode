import { describe, expect, test } from "bun:test"
import { mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { Consent } from "./consent"

const home = () => mkdtempSync(join(tmpdir(), "iris-consent-"))

describe("Consent.status — any one opt-out wins (#186171)", () => {
  test("on by default", () => {
    expect(Consent.status({}, home())).toEqual({ enabled: true, reason: "default" })
  })
  test("IRIS_TELEMETRY=0 / off / false", () => {
    for (const v of ["0", "off", "false", "OFF"]) expect(Consent.status({ IRIS_TELEMETRY: v }, home()).enabled).toBe(false)
  })
  test("DO_NOT_TRACK=1 / true", () => {
    for (const v of ["1", "true"]) expect(Consent.status({ DO_NOT_TRACK: v }, home())).toEqual({ enabled: false, reason: "env:DO_NOT_TRACK" })
    expect(Consent.status({ DO_NOT_TRACK: "0" }, home()).enabled).toBe(true)
  })
  test("`iris telemetry off` persists, and `on` undoes it", () => {
    const h = home()
    Consent.setEnabled(false, h)
    expect(Consent.status({}, h)).toEqual({ enabled: false, reason: "iris telemetry off" })
    Consent.setEnabled(true, h)
    expect(Consent.status({}, h).enabled).toBe(true)
  })
  test("the environment beats a persisted `on`", () => {
    const h = home()
    Consent.setEnabled(true, h)
    expect(Consent.status({ IRIS_TELEMETRY: "0" }, h).enabled).toBe(false)
  })
})

describe("Consent.noticeOnce", () => {
  test("prints once, at a terminal, when on — and never when off or piped", () => {
    const h = home()
    const out: string[] = []
    const w = (s: string) => out.push(s)
    expect(Consent.noticeOnce({ isTTY: false, env: {}, home: h, write: w })).toBeNull()
    expect(Consent.noticeOnce({ isTTY: true, env: { DO_NOT_TRACK: "1" }, home: h, write: w })).toBeNull()
    expect(Consent.noticeOnce({ isTTY: true, env: {}, home: h, write: w })).toContain("iris telemetry off")
    expect(Consent.noticeOnce({ isTTY: true, env: {}, home: h, write: w })).toBeNull()
    expect(out).toHaveLength(1)
  })
})
