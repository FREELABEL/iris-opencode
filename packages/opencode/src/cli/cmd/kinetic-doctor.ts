/**
 * `iris kinetic doctor` — is this machine ready to run a Kinetic pack, measured, with the fix named.
 *
 * #191869. Getting one OBSBOT vision run working on a fresh Mac took five fixes and four of them
 * failed silently (#191866 is the one that was filed). Every row here is one of those failures.
 *
 * THE RULE, same as the daemon's permission probe: detect by attempting. An unmeasured thing is
 * `unknown`, never `pass`. Nothing here moves hardware or asks for a permission: the camera status
 * is read from inside the camera app without requesting access, and the gimbal is only asked for
 * its limits. `iris kinetic setup` does not exist yet, so every fix names a command that runs today.
 */

import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

export type RowStatus = "pass" | "fail" | "unknown" | "skip"
export type Row = { pack: string; id: string; status: RowStatus; detail: string; fix?: string }

export type RunResult = { code: number | null; stdout: string; stderr: string }
export type DoctorIO = {
  platform: string
  home: string
  run: (cmd: string, args: string[], opts?: { timeout?: number; env?: Record<string, string> }) => RunResult
  exists: (path: string) => boolean
  read: (path: string) => Buffer
  /** The camera authorization status, read inside the camera app: 0 undecided · 1 restricted · 2 denied · 3 allowed. */
  cameraStatus: (app: string, python: string) => number | null
}

/** One install format: a curated pack is a manifest. Fields join this type when a command reads them. */
export type PackManifest = { id: string; version: string; description: string; checks: CheckId[] }
export type CheckId = "env" | "device" | "clang" | "camera" | "camera-app" | "camera-permission" | "model" | "ptz-helper" | "ptz-limits"

export const PACKS: PackManifest[] = [
  {
    id: "core",
    version: "1",
    description: "python env, yolo11n, camera permission, MPS fallback",
    checks: ["env", "device", "clang", "camera", "camera-app", "camera-permission", "model"],
  },
  { id: "ptz", version: "1", description: "uvcctl (IOKit), pan/tilt limits", checks: ["ptz-helper", "ptz-limits"] },
]

const VENV_PYTHON = ".iris/venvs/vision/bin/python"
const CAMERA_APP = ".iris/apps/IRIS Kinetic Camera v2.app"
const MODEL = ".iris/models/yolo11n.pt"
const MODEL_SHA256 = "0ebbc80d4a7680d14987a577cd21342b65ecfd94632bd9a8da63ae6417644ee1"
const HELPER = ".iris/kinetic/uvcctl"
const HELPER_SOURCE = ".iris/kinetic/uvcctl.c"
const INSTALLER_HELPER = ".iris/bin/uvcctl"
const OBSBOT = { vid: "0x6e30", pid: "0xfef0", windex: "0x100" }

const RUN_VISION = "iris scripts run vision"
const MACHO = new Set(["cffaedfe", "feedfacf", "cefaedfe", "feedface", "cafebabe", "bebafeca"])
// The same names vision.py's camera=auto refuses, so doctor and the run agree on what counts.
const NOT_A_LENS = ["facetime", "macbook", "built-in", "virtual", "snap camera", "iphone", "ipad", "desk view"]

// Imports what a run imports, then runs the operation failure 5 died on, on the device a run uses.
const ENV_PROBE = `
import json, os
os.environ["PYTORCH_ENABLE_MPS_FALLBACK"] = "1"
out = {}
import cv2, torch, torchvision, ultralytics
out["versions"] = {"torch": torch.__version__, "ultralytics": ultralytics.__version__, "opencv": cv2.__version__}
device = "mps" if torch.backends.mps.is_available() else "cuda" if torch.cuda.is_available() else "cpu"
out["device"] = device
try:
    boxes = torch.tensor([[0.0, 0.0, 1.0, 1.0]], device=device)
    torchvision.ops.nms(boxes, torch.tensor([1.0], device=device), 0.5)
    out["nms"] = True
except Exception as e:
    out["nms"] = False
    out["nms_error"] = str(e)[:200]
print("IRIS_DOCTOR " + json.dumps(out))
`

type EnvProbe = { versions?: Record<string, string>; device?: string; nms?: boolean; nms_error?: string }
type Ctx = { io: DoctorIO; p: (rel: string) => string; env?: { result: EnvProbe | null; error: string }; camera?: string[] | null }

function envProbe(ctx: Ctx) {
  if (ctx.env) return ctx.env
  const r = ctx.io.run(ctx.p(VENV_PYTHON), ["-c", ENV_PROBE], { timeout: 120_000 })
  const line = r.stdout.split("\n").find((l) => l.startsWith("IRIS_DOCTOR "))
  ctx.env = line
    ? { result: JSON.parse(line.slice("IRIS_DOCTOR ".length)), error: "" }
    : { result: null, error: r.stderr.trim().split("\n").pop() ?? "" }
  return ctx.env
}

function cameras(ctx: Ctx): string[] | null {
  if (ctx.camera !== undefined) return ctx.camera
  const r = ctx.io.run("system_profiler", ["-json", "SPCameraDataType"], { timeout: 20_000 })
  try {
    ctx.camera = (JSON.parse(r.stdout).SPCameraDataType ?? []).map((c: { _name?: string }) => c._name ?? "?")
  } catch {
    ctx.camera = null
  }
  return ctx.camera ?? null
}

const obsbot = (names: string[]) => names.find((n) => /obsbot/i.test(n) && !/virtual/i.test(n))

const CHECKS: Record<CheckId, (ctx: Ctx) => Omit<Row, "pack" | "id">> = {
  env(ctx) {
    if (!ctx.io.exists(ctx.p(VENV_PYTHON))) {
      return { status: "fail", detail: "no vision environment on this machine", fix: `${RUN_VISION} — its first run builds it (several minutes, needs network)` }
    }
    const { result, error } = envProbe(ctx)
    if (!result) return { status: "fail", detail: `the environment does not import: ${error}`.trim(), fix: `rm -rf ~/.iris/venvs/vision, then ${RUN_VISION}` }
    const v = result.versions ?? {}
    return { status: "pass", detail: `torch ${v.torch} · ultralytics ${v.ultralytics} · opencv ${v.opencv}` }
  },
  device(ctx) {
    if (!ctx.io.exists(ctx.p(VENV_PYTHON))) return { status: "skip", detail: "needs the vision environment" }
    const { result } = envProbe(ctx)
    if (!result) return { status: "unknown", detail: "could not load torch, so the device was not tested" }
    if (!result.nms) return { status: "fail", detail: `detection's nms fails on ${result.device}: ${result.nms_error}`, fix: `the probe already sets the MPS fallback, so the install is broken: rm -rf ~/.iris/venvs/vision, then ${RUN_VISION}` }
    return { status: "pass", detail: `${result.device} · nms runs` }
  },
  clang(ctx) {
    // Not `clang --version`: without the tools, /usr/bin/clang is a shim that opens an install dialog.
    if (ctx.io.run("xcode-select", ["-p"], { timeout: 10_000 }).code !== 0) {
      return { status: "fail", detail: "Command Line Tools are not installed", fix: "xcode-select --install" }
    }
    const r = ctx.io.run("clang", ["--version"], { timeout: 20_000 })
    return r.code === 0
      ? { status: "pass", detail: r.stdout.split("\n")[0] ?? "clang" }
      : { status: "fail", detail: `clang does not run: ${r.stderr.trim().slice(0, 120)}`, fix: "xcode-select --install" }
  },
  camera(ctx) {
    const names = cameras(ctx)
    if (names === null) return { status: "unknown", detail: "system_profiler did not answer" }
    const pick = obsbot(names) ?? names.find((n) => !NOT_A_LENS.some((w) => n.toLowerCase().includes(w)))
    if (!pick) return { status: "fail", detail: `no OBSBOT or external webcam (saw: ${names.join(" · ") || "none"})`, fix: "plug the camera in with a data cable, not a charge-only one" }
    return { status: "pass", detail: pick }
  },
  "camera-app"(ctx) {
    const app = ctx.p(CAMERA_APP)
    if (!ctx.io.exists(app)) return { status: "fail", detail: "the camera app has not been built", fix: `${RUN_VISION} — a run builds it and macOS asks once` }
    const rebuild = `rm -rf "${app}", then ${RUN_VISION}`
    const exe = join(app, "Contents/MacOS/kinetic-camera")
    // A shell-script launcher hands TCC to Apple's Python.app: a silent denial and an empty list.
    if (!ctx.io.exists(exe) || !MACHO.has(ctx.io.read(exe).subarray(0, 4).toString("hex"))) {
      return { status: "fail", detail: "the launcher is not a native binary, so macOS will deny the camera without asking", fix: rebuild }
    }
    if (!ctx.io.read(join(app, "Contents/Info.plist")).includes("NSCameraUsageDescription")) {
      return { status: "fail", detail: "Info.plist has no NSCameraUsageDescription, so macOS will kill it on camera access", fix: rebuild }
    }
    const sig = ctx.io.run("codesign", ["--verify", app], { timeout: 20_000 })
    if (sig.code !== 0) return { status: "fail", detail: `not validly signed, so macOS denies it silently: ${sig.stderr.trim().slice(0, 160)}`, fix: rebuild }
    return { status: "pass", detail: "native launcher · usage string · signature valid" }
  },
  "camera-permission"(ctx) {
    const app = ctx.p(CAMERA_APP)
    const python = ctx.p(VENV_PYTHON)
    if (!ctx.io.exists(app) || !ctx.io.exists(python)) return { status: "skip", detail: "needs the camera app and the vision environment" }
    const status = ctx.io.cameraStatus(app, python)
    if (status === 3) return { status: "pass", detail: "allowed for IRIS Kinetic Camera" }
    if (status === 0) return { status: "fail", detail: "never requested — so IRIS Kinetic Camera is not in the Camera settings list yet", fix: `${RUN_VISION}, then click Allow when macOS asks` }
    if (status === 2) return { status: "fail", detail: "denied for IRIS Kinetic Camera", fix: "System Settings → Privacy & Security → Camera → turn on IRIS Kinetic Camera" }
    if (status === 1) return { status: "fail", detail: "restricted by a device policy", fix: "ask whoever manages this Mac to allow camera access" }
    return { status: "unknown", detail: "could not read the status from inside the camera app" }
  },
  model(ctx) {
    const path = ctx.p(MODEL)
    if (!ctx.io.exists(path)) return { status: "fail", detail: "yolo11n weights are not on this machine", fix: `${RUN_VISION} — it downloads them` }
    const sha = createHash("sha256").update(ctx.io.read(path)).digest("hex")
    if (sha !== MODEL_SHA256) return { status: "fail", detail: `yolo11n checksum does not match (${sha.slice(0, 12)}…)`, fix: `rm ~/.iris/models/yolo11n.pt, then ${RUN_VISION}` }
    return { status: "pass", detail: "yolo11n · checksum matches" }
  },
  "ptz-helper"(ctx) {
    if (ctx.io.exists(ctx.p(HELPER))) return { status: "pass", detail: "uvcctl in ~/.iris/kinetic" }
    const build = ctx.io.exists(ctx.p(HELPER_SOURCE))
      ? `clang -O2 -framework IOKit -framework CoreFoundation -o ~/.iris/kinetic/uvcctl ~/.iris/kinetic/uvcctl.c`
      // ptz-probe still builds into ~/.iris/bin, so its result has to be moved out of the installer's path.
      : "iris scripts run ptz-probe, then cp ~/.iris/bin/uvcctl ~/.iris/kinetic/uvcctl"
    if (ctx.io.exists(ctx.p(INSTALLER_HELPER))) {
      return { status: "fail", detail: "uvcctl is only in ~/.iris/bin, which the next IRIS upgrade replaces — aim and zoom would die", fix: "cp ~/.iris/bin/uvcctl ~/.iris/kinetic/uvcctl" }
    }
    return { status: "fail", detail: "no uvcctl — aim and zoom will not work", fix: build }
  },
  "ptz-limits"(ctx) {
    const names = cameras(ctx)
    if (names === null) return { status: "unknown", detail: "system_profiler did not answer" }
    if (!obsbot(names)) return { status: "skip", detail: "no OBSBOT attached" }
    const helper = [HELPER, INSTALLER_HELPER].map(ctx.p).find(ctx.io.exists)
    if (!helper) return { status: "skip", detail: "needs uvcctl" }
    const get = (req: string) => {
      const r = ctx.io.run(helper, [OBSBOT.vid, OBSBOT.pid, "in", "0xa1", req, "0x0d00", OBSBOT.windex, "8"], { timeout: 5_000 })
      return r.code === 0 && /^[0-9a-f]{16}/i.test(r.stdout.trim()) ? Buffer.from(r.stdout.trim().slice(0, 16), "hex") : { error: r.stderr.trim() }
    }
    const lo = get("0x82")
    const hi = get("0x83")
    if (!Buffer.isBuffer(lo) || !Buffer.isBuffer(hi)) {
      const error = (Buffer.isBuffer(lo) ? hi : lo) as { error: string }
      return { status: "fail", detail: `the gimbal did not answer: ${error.error.slice(0, 120) || "no data"}`, fix: "quit OBSBOT Center, replug the camera with a data cable, and run this again" }
    }
    const deg = (b: Buffer, at: number) => Math.round(b.readInt32LE(at) / 3600)
    return { status: "pass", detail: `pan ${deg(lo, 0)}..${deg(hi, 0)}° · tilt ${deg(lo, 4)}..${deg(hi, 4)}°` }
  },
}

export function runDoctor(io: DoctorIO, packIds?: string[]): Row[] {
  const packs = packIds ? PACKS.filter((p) => packIds.includes(p.id)) : PACKS
  const ctx: Ctx = { io, p: (rel) => join(io.home, rel) }
  return packs.flatMap((pack) => pack.checks.map((id) => ({ pack: pack.id, id, ...CHECKS[id](ctx) })))
}

/** Asks for the status only — this never shows a prompt, so a doctor run cannot change what it measures. */
function cameraStatusFromApp(app: string, python: string): number | null {
  const dir = mkdtempSync(join(tmpdir(), "iris-kinetic-doctor-"))
  try {
    const script = join(dir, "status.py")
    const log = join(dir, "out.log")
    writeFileSync(script, "from AVFoundation import AVCaptureDevice, AVMediaTypeVideo\nprint('IRIS_DOCTOR', AVCaptureDevice.authorizationStatusForMediaType_(AVMediaTypeVideo), flush=True)\n")
    writeFileSync(log, "")
    spawnSync("open", ["-n", "-W", "-a", app, "--stdout", log, "--stderr", log, "--env", `IRIS_VISION_PYTHON=${python}`, "--env", `IRIS_VISION_SCRIPT=${script}`], { timeout: 30_000 })
    const m = readFileSync(log, "utf-8").match(/IRIS_DOCTOR (\d)/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export const realIO = (): DoctorIO => ({
  platform: process.platform,
  home: homedir(),
  run(cmd, args, opts) {
    const r = spawnSync(cmd, args, { encoding: "utf-8", timeout: opts?.timeout, env: { ...process.env, ...opts?.env } })
    return { code: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? (r.error ? String(r.error) : "") }
  },
  exists: existsSync,
  read: (path) => readFileSync(path),
  cameraStatus: cameraStatusFromApp,
})
