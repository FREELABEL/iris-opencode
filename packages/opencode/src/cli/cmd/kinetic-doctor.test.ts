/**
 * The five failures from #191869, each reproduced as machine state, plus the two ways a doctor
 * can lie: a pass for something it never measured, and a row with no way out.
 */
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { runDoctor, type DoctorIO, type Row, type RunResult } from "./kinetic-doctor"

const HOME = "/h"
const APP = `${HOME}/.iris/apps/IRIS Kinetic Camera v2.app`
const PY = `${HOME}/.iris/venvs/vision/bin/python`
const MODEL_BYTES = Buffer.from("weights")
const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" })
const ENV_OK = `IRIS_DOCTOR ${JSON.stringify({ versions: { torch: "2", ultralytics: "8", opencv: "4" }, device: "mps", nms: true })}\n`
const SPEC = [-130 * 3600, -90 * 3600, 130 * 3600, 90 * 3600]
const hex = (a: number, b: number) => {
  const buf = Buffer.alloc(8)
  buf.writeInt32LE(a, 0)
  buf.writeInt32LE(b, 4)
  return buf.toString("hex")
}

/** A healthy machine; each test breaks exactly one thing. */
function machine(over: { missing?: string[]; files?: Record<string, Buffer>; run?: Partial<Record<string, RunResult>>; status?: number | null } = {}) {
  const files: Record<string, Buffer> = {
    [PY]: Buffer.from(""),
    [APP]: Buffer.from(""),
    [`${APP}/Contents/MacOS/kinetic-camera`]: Buffer.from("cffaedfe00", "hex"),
    [`${APP}/Contents/Info.plist`]: Buffer.from("<key>NSCameraUsageDescription</key>"),
    [`${HOME}/.iris/models/yolo11n.pt`]: MODEL_BYTES,
    [`${HOME}/.iris/kinetic/uvcctl`]: Buffer.from(""),
    ...over.files,
  }
  for (const m of over.missing ?? []) delete files[m]
  const calls: string[] = []
  const io: DoctorIO = {
    platform: "darwin",
    home: HOME,
    exists: (p) => p in files,
    read: (p) => files[p]!,
    cameraStatus: () => (over.status === undefined ? 3 : over.status),
    run(cmd, args) {
      calls.push([cmd, ...args].join(" "))
      const custom = over.run?.[cmd]
      if (custom) return custom
      if (cmd === PY) return ok(ENV_OK)
      if (cmd === "system_profiler") return ok(JSON.stringify({ SPCameraDataType: [{ _name: "FaceTime HD Camera (Built-in)" }, { _name: "OBSBOT Tiny Camera" }] }))
      if (cmd.endsWith("uvcctl")) return ok(args[4] === "0x82" ? hex(SPEC[0]!, SPEC[1]!) : hex(SPEC[2]!, SPEC[3]!))
      return ok("Apple clang\n")
    },
  }
  return { io, calls }
}

const row = (rows: Row[], id: string) => rows.find((r) => r.id === id)!

describe("kinetic doctor", () => {
  test("a healthy machine passes every row but the checksum fixture, and names the real gimbal limits", () => {
    const rows = runDoctor(machine().io)
    expect(rows.filter((r) => r.status !== "pass").map((r) => r.id)).toEqual(["model"])
    expect(row(rows, "ptz-limits").detail).toBe("pan -130..130° · tilt -90..90°")
  })

  test("failure 1: no environment is loud, and names the first-run cost", () => {
    const r = row(runDoctor(machine({ missing: [PY] }).io), "env")
    expect(r.status).toBe("fail")
    expect(r.fix).toContain("iris scripts run vision")
  })

  test("failure 1: an environment that will not import fails with its error, not a traceback", () => {
    const r = row(runDoctor(machine({ run: { [PY]: { code: 1, stdout: "", stderr: "Traceback\n  x\nImportError: no cv2" } } }).io), "env")
    expect(r.status).toBe("fail")
    expect(r.detail).toContain("ImportError: no cv2")
    expect(r.detail).not.toContain("Traceback")
  })

  test("failure 2: uvcctl only in the installer's path fails BEFORE an upgrade kills it", () => {
    const r = row(runDoctor(machine({ missing: [`${HOME}/.iris/kinetic/uvcctl`], files: { [`${HOME}/.iris/bin/uvcctl`]: Buffer.from("") } }).io), "ptz-helper")
    expect(r.status).toBe("fail")
    expect(r.detail).toContain("next IRIS upgrade")
    expect(r.fix).toBe("cp ~/.iris/bin/uvcctl ~/.iris/kinetic/uvcctl")
  })

  test("failure 2: no helper fails the ptz row and names the repair — aim and zoom are never silently dead", () => {
    const withSource = row(runDoctor(machine({ missing: [`${HOME}/.iris/kinetic/uvcctl`], files: { [`${HOME}/.iris/kinetic/uvcctl.c`]: Buffer.from("") } }).io), "ptz-helper")
    expect(withSource.fix).toContain("clang")
    const without = row(runDoctor(machine({ missing: [`${HOME}/.iris/kinetic/uvcctl`] }).io), "ptz-helper")
    expect(without.status).toBe("fail")
    expect(without.fix).toBe("iris scripts run ptz-probe, then cp ~/.iris/bin/uvcctl ~/.iris/kinetic/uvcctl")
  })

  test("failure 3: a shell-script launcher fails, because TCC would blame Python.app", () => {
    const r = row(runDoctor(machine({ files: { [`${APP}/Contents/MacOS/kinetic-camera`]: Buffer.from("#!/bin/sh\nexec python") } }).io), "camera-app")
    expect(r.status).toBe("fail")
    expect(r.detail).toContain("not a native binary")
  })

  test("failure 4: a failed signature is surfaced, not swallowed", () => {
    const r = row(runDoctor(machine({ run: { codesign: { code: 1, stdout: "", stderr: "code object is not signed at all" } } }).io), "camera-app")
    expect(r.status).toBe("fail")
    expect(r.detail).toContain("not signed at all")
  })

  test("failure 5: nms failing on the device fails with the reason", () => {
    const out = `IRIS_DOCTOR ${JSON.stringify({ versions: {}, device: "mps", nms: false, nms_error: "torchvision::nms not implemented" })}\n`
    const r = row(runDoctor(machine({ run: { [PY]: ok(out) } }).io), "device")
    expect(r.status).toBe("fail")
    expect(r.detail).toContain("torchvision::nms")
  })

  test("#191866: never requested is not denied, and does not send anyone to an empty settings list", () => {
    const never = row(runDoctor(machine({ status: 0 }).io), "camera-permission")
    expect(never.status).toBe("fail")
    expect(never.detail).toContain("never requested")
    expect(never.fix).not.toContain("System Settings")
    const denied = row(runDoctor(machine({ status: 2 }).io), "camera-permission")
    expect(denied.detail).toContain("denied")
    expect(denied.fix).toContain("System Settings")
  })

  test("an unmeasured permission is unknown, never a pass", () => {
    expect(row(runDoctor(machine({ status: null }).io), "camera-permission").status).toBe("unknown")
  })

  test("only a built-in lens is not a camera, matching what a run will refuse", () => {
    const io = machine({ run: { system_profiler: ok(JSON.stringify({ SPCameraDataType: [{ _name: "FaceTime HD Camera" }, { _name: "OBS Virtual Camera" }] })) } }).io
    const rows = runDoctor(io)
    expect(row(rows, "camera").status).toBe("fail")
    expect(row(rows, "ptz-limits").status).toBe("skip")
  })

  test("a wrong model checksum fails", () => {
    const r = row(runDoctor(machine({ files: { [`${HOME}/.iris/models/yolo11n.pt`]: Buffer.from("tampered") } }).io), "model")
    expect(r.status).toBe("fail")
    expect(r.detail).toContain(createHash("sha256").update("tampered").digest("hex").slice(0, 12))
  })

  test("no gimbal command writes: only GET_MIN and GET_MAX reach the hardware", () => {
    const { io, calls } = machine()
    runDoctor(io)
    const gimbal = calls.filter((c) => c.includes("uvcctl"))
    expect(gimbal).toHaveLength(2)
    expect(gimbal.every((c) => c.includes(" in 0xa1 "))).toBe(true)
  })

  test("every failing row names its fix", () => {
    const rows = runDoctor(machine({ missing: [PY, APP, `${HOME}/.iris/models/yolo11n.pt`, `${HOME}/.iris/kinetic/uvcctl`], run: { "xcode-select": { code: 2, stdout: "", stderr: "" } } }).io)
    const fails = rows.filter((r) => r.status === "fail")
    expect(fails.length).toBeGreaterThan(3)
    for (const r of fails) expect(r.fix).toBeTruthy()
  })

  test("a pack filter runs that pack only", () => {
    const rows = runDoctor(machine().io, ["ptz"])
    expect([...new Set(rows.map((r) => r.pack))]).toEqual(["ptz"])
  })
})
