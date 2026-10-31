/**
 * #191960. Every setup here is a fixture in a temp folder and every path is injected, so no test
 * can read or write a real OBS config. The secret values below are planted and fake.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { applyBundle, EXIT_PROBLEMS, EXIT_REFUSED, exportBundle, mapPath, parseBundle, parseMapMedia, writeBundle, type Bundle, type Host } from "./app-config-engine"
import { obsAdapter, scrubUrl } from "./app-config-obs"

const STREAM_KEY = "live_FIXTURE_STREAM_KEY_abc123"
const WS_PASSWORD = "FIXTURE-WS-PASSWORD-xyz"
const OAUTH_TOKEN = "FIXTURE-TWITCH-OAUTH-555"
const OLD_INI_PASSWORD = "FIXTURE-OLD-INI-PASSWORD"
const BROWSER_TOKEN = "FIXTURE-QUERY-TOKEN-777"
const URL_PATH_TOKEN = "a1B2c3D4e5F6g7H8i9J0k1L2"
const PLUGIN_SECRET = "FIXTURE-PLUGIN-API-KEY-999"
const AWS_SHAPED = "AKIA" + "ABCDEFGHIJKLMNOP"
const PLANTED = [STREAM_KEY, WS_PASSWORD, OAUTH_TOKEN, OLD_INI_PASSWORD, BROWSER_TOKEN, URL_PATH_TOKEN, PLUGIN_SECRET, AWS_SHAPED]

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "app-config-191960-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function put(dir: string, rel: string, text: string) {
  const p = join(dir, rel)
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, text)
}

function host(over: Partial<Host> = {}): Host {
  return {
    platform: "linux",
    arch: "x64",
    hostname: "fixture-host",
    home: join(root, "home"),
    env: {},
    processNames: () => ["bash", "obsidian"],
    ...over,
  }
}

function mediaSource(path: string) {
  return { id: "ffmpeg_source", name: "Intro clip", settings: { local_file: path }, filters: [] }
}

/** A real-shaped setup: every secret location and every machine-bound field is populated. */
function sourceSetup(mediaPath: string, extraSources: any[] = []): string {
  const dir = join(root, "source")
  put(dir, "global.ini", `[General]\nLastVersion=${(33 << 24) | 1}\n[OBSWebSocket]\nServerPassword=${OLD_INI_PASSWORD}\n[BasicWindow]\nGeometry=AAAA\n`)
  put(dir, "user.ini", "[Basic]\nProfile=Show\nProfileDir=Show\nSceneCollection=Main\nSceneCollectionFile=Main\n")
  put(
    dir,
    "basic/profiles/Show/basic.ini",
    `[General]\nName=Show\n[Video]\nBaseCX=5120\nBaseCY=2880\nOutputCX=1920\nOutputCY=1080\nFPSCommon=60\nColorFormat=NV12\nColorSpace=709\n` +
      `[AdvOut]\nEncoder=obs_x264\nRecFilePath=/Users/alex/Movies\nTrackIndex=1\n[Audio]\nMonitoringDeviceId=hw-123\n` +
      `[Twitch]\nToken=${OAUTH_TOKEN}\nName=alex\n`,
  )
  put(dir, "basic/profiles/Show/service.json", JSON.stringify({ type: "rtmp_common", settings: { service: "Twitch", server: "auto", key: STREAM_KEY, bwtest: false } }))
  put(dir, "basic/profiles/Show/streamEncoder.json", JSON.stringify({ bitrate: 6000 }))
  put(dir, "plugin_config/obs-websocket/config.json", JSON.stringify({ auth_required: true, server_enabled: true, server_password: WS_PASSWORD, server_port: 4455 }))
  put(dir, "plugin_config/text-freetype2/font_data.bin", "binary")
  put(
    dir,
    "basic/scenes/Main.json",
    JSON.stringify({
      name: "Main",
      current_scene: "Live",
      sources: [
        { id: "scene", name: "Live", settings: { items: [{ name: "Intro clip" }] }, hotkeys: { "OBSBasic.SelectScene": [{ key: "OBS_KEY_1" }] } },
        mediaSource(mediaPath),
        { id: "browser_source", name: "Alerts", settings: { url: `https://alerts.example.com/box/${URL_PATH_TOKEN}?token=${BROWSER_TOKEN}&theme=dark`, css: `/* ${STREAM_KEY} */` } },
        { id: "browser_source", name: "Site", settings: { url: "https://heyiris.io/live?theme=dark" } },
        { id: "coreaudio_input_capture", name: "Mic", settings: { device_id: "AppleUSBAudio:4", other: 1 } },
        { id: "fixture_plugin_source", name: "Plugin", settings: { api_key: PLUGIN_SECRET, note: AWS_SHAPED } },
        ...extraSources,
      ],
      transitions: [],
    }),
  )
  put(dir, "basic/scenes/Main.json.bak", `{"key":"${STREAM_KEY}"}`)
  return dir
}

function allBytes(bundle: Bundle) {
  return JSON.stringify(bundle)
}

function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out[p.slice(dir.length + 1)] = createHash("sha256").update(readFileSync(p)).digest("hex")
    }
  }
  if (existsSync(dir)) walk(dir)
  return out
}

/** What OBS 33 leaves behind on first launch, as measured on iris-hive-002. */
function freshTarget(): string {
  const dir = join(root, "target")
  put(dir, "user.ini", "[General]\nFirstRun=true\n")
  put(dir, "basic/profiles/Untitled/basic.ini", "[General]\nName=Untitled\n[Video]\nBaseCX=1920\nBaseCY=1080\n")
  put(dir, "basic/profiles/Untitled/service.json", JSON.stringify({ type: "rtmp_common", settings: {} }))
  put(dir, "basic/scenes/Untitled.json", JSON.stringify({ name: "Untitled", sources: [{ id: "scene", name: "Scene", settings: { items: [] } }] }))
  return dir
}

function apply(bundle: Bundle, configDir: string, over: Partial<Parameters<typeof applyBundle>[2]> = {}) {
  return applyBundle(obsAdapter, bundle, { configDir, host: host(), force: false, maps: [], ...over })
}

function exported(dir: string, includeSecrets = false) {
  return exportBundle(obsAdapter, { configDir: dir, host: host(), includeSecrets })
}

describe("acceptance 1: nothing references a missing path, or every miss is named", () => {
  test("mapped media on a fresh install: zero missing paths", () => {
    const media = join(root, "newmedia/intro.mp4")
    put(root, "newmedia/intro.mp4", "video")
    const bundle = exported(sourceSetup("/Users/alex/Videos/intro.mp4"))
    const result = apply(bundle, freshTarget(), { maps: [{ from: "/Users/alex/Videos", to: join(root, "newmedia") }] })
    expect(result.status).toBe("applied")
    expect(result.problems.filter((p) => p.kind === "missing-path")).toEqual([])
    expect(readFileSync(join(root, "target/basic/scenes/Main.json"), "utf8")).toContain(media)
  })

  test("read-back fails on a missing source and names it", () => {
    const result = apply(exported(sourceSetup("/Users/alex/Videos/gone.mp4")), freshTarget())
    expect(result.status).toBe("applied")
    expect(result.exitCode).toBe(EXIT_PROBLEMS)
    const missing = result.problems.filter((p) => p.kind === "missing-path").map((p) => p.message)
    expect(missing).toEqual(["Main / Intro clip: /Users/alex/Videos/gone.mp4"])
  })

  test("read-back reads the written file, not the plan", () => {
    const media = join(root, "m.mp4")
    put(root, "m.mp4", "video")
    const bundle = exported(sourceSetup(media))
    const target = freshTarget()
    expect(apply(bundle, target).problems.filter((p) => p.kind === "missing-path")).toEqual([])
    rmSync(media)
    expect(apply(bundle, target).problems.filter((p) => p.kind === "missing-path")).toHaveLength(1)
  })

  test("sees paths in filters, slideshows, stingers and scripts", () => {
    const bundle = exported(
      sourceSetup("/nope/a.mp4", [
        { id: "image_source", name: "Masked", settings: {}, filters: [{ id: "mask_filter", name: "Mask", settings: { image_path: "/nope/mask.png" } }] },
        { id: "slideshow", name: "Slides", settings: { files: [{ value: "/nope/slide.png" }] } },
        { id: "browser_source", name: "Local", settings: { local_file: "file:///nope/page%20one.html" } },
        { id: "text_ft2_source", name: "Title", settings: { text: "/not/a/path" } },
      ]),
    )
    bundle.files["basic/scenes/Main.json"] = JSON.stringify({
      ...JSON.parse(bundle.files["basic/scenes/Main.json"]),
      transitions: [{ id: "obs_stinger_transition", name: "Stinger", settings: { path: "/nope/sting.mov" } }],
      modules: { "scripts-tool": [{ path: "/nope/script.lua", settings: {} }] },
    })
    const result = apply(bundle, freshTarget())
    const text = result.problems.map((p) => p.message).join("\n")
    for (const needle of ["/nope/mask.png", "/nope/slide.png", "/nope/page one.html", "/nope/sting.mov", "/nope/script.lua"]) expect(text).toContain(needle)
    expect(text).not.toContain("/not/a/path")
    expect(result.notes.join("\n")).toContain("/nope/script.lua")
  })

  test("points OBS at the restored profile and collection", () => {
    apply(exported(sourceSetup("/x")), freshTarget())
    const ini = readFileSync(join(root, "target/user.ini"), "utf8")
    for (const line of ["Profile=Show", "ProfileDir=Show", "SceneCollection=Main", "SceneCollectionFile=Main", "FirstRun=true"]) expect(ini).toContain(line)
  })
})

describe("acceptance 2: idempotent", () => {
  test("second run changes nothing and is byte-identical", () => {
    const bundle = exported(sourceSetup("/Users/alex/a.mp4"))
    const target = freshTarget()
    expect(apply(bundle, target).status).toBe("applied")
    const before = snapshot(target)
    const backupsBefore = readdirSync(root).filter((n) => n.includes("iris-backup"))
    const second = apply(bundle, target)
    expect(second.status).toBe("unchanged")
    expect(second.written).toEqual([])
    expect(snapshot(target)).toEqual(before)
    expect(apply(bundle, target, { force: true }).status).toBe("unchanged")
    expect(readdirSync(root).filter((n) => n.includes("iris-backup"))).toEqual(backupsBefore)
  })

  test("idempotent with maps and with this machine's own carried values", () => {
    const bundle = exported(sourceSetup("/Users/alex/a.mp4"))
    const target = freshTarget()
    put(target, "basic/profiles/Show/basic.ini", "[Video]\nBaseCX=1280\n[AdvOut]\nEncoder=apple_h264\n")
    put(target, "basic/profiles/Show/service.json", JSON.stringify({ settings: { key: "target-own-key" } }))
    const maps = [{ from: "/Users/alex", to: join(root, "m") }]
    expect(apply(bundle, target, { force: true, maps }).status).toBe("applied")
    const before = snapshot(target)
    expect(apply(bundle, target, { maps }).status).toBe("unchanged")
    expect(snapshot(target)).toEqual(before)
  })
})

describe("acceptance 3: refuses without --force, and safety around writes", () => {
  function existing() {
    const dir = join(root, "target")
    put(dir, "basic/profiles/Mine/basic.ini", "[General]\nName=Mine\n")
    put(dir, "basic/scenes/Mine.json", JSON.stringify({ sources: [{ id: "image_source", name: "Logo", settings: {} }] }))
    put(dir, "user.ini", "[Basic]\nProfile=Mine\n")
    return dir
  }

  test("refuses, writes nothing, exits non-zero", () => {
    const target = existing()
    const bundle = exported(sourceSetup("/x"))
    const before = snapshot(target)
    const rootBefore = readdirSync(root)
    const result = apply(bundle, target)
    expect(result.status).toBe("refused")
    expect(result.exitCode).toBe(EXIT_REFUSED)
    expect(snapshot(target)).toEqual(before)
    expect(readdirSync(root)).toEqual(rootBefore)
  })

  test("a real source in the default Untitled collection counts as an existing setup", () => {
    const target = freshTarget()
    put(target, "basic/scenes/Untitled.json", JSON.stringify({ sources: [{ id: "scene", name: "Scene", settings: { items: [{ name: "Cam" }] } }] }))
    expect(apply(exported(sourceSetup("/x")), target).status).toBe("refused")
  })

  test("a stream key in Untitled counts as an existing setup", () => {
    const target = freshTarget()
    put(target, "basic/profiles/Untitled/service.json", JSON.stringify({ settings: { key: "k" } }))
    expect(apply(exported(sourceSetup("/x")), target).status).toBe("refused")
  })

  test("--force backs up first, outside the config dir, and keeps other profiles", () => {
    const target = existing()
    const iniBefore = readFileSync(join(target, "user.ini"), "utf8")
    const result = apply(exported(sourceSetup("/x")), target, { force: true })
    expect(result.status).toBe("applied")
    expect(result.backup).not.toBeNull()
    expect(result.backup!.startsWith(target + "/")).toBe(false)
    expect(readFileSync(join(result.backup!, "user.ini"), "utf8")).toBe(iniBefore)
    expect(existsSync(join(target, "basic/scenes/Mine.json"))).toBe(true)
    expect(readFileSync(join(target, "user.ini"), "utf8")).toContain("Profile=Show")
  })

  test("refuses while OBS runs, even with --force, and never touches the process", () => {
    const target = existing()
    const before = snapshot(target)
    for (const name of ["obs", "/Applications/OBS.app/Contents/MacOS/OBS", "obs64.exe"]) {
      const result = apply(exported(sourceSetup("/x")), target, { force: true, host: host({ processNames: () => ["bash", name] }) })
      expect(result.status).toBe("refused")
      expect(result.reason).toContain("rewrites its config")
    }
    expect(snapshot(target)).toEqual(before)
  })

  test("refuses when it cannot tell whether OBS runs", () => {
    const result = apply(exported(sourceSetup("/x")), freshTarget(), { host: host({ processNames: () => null }) })
    expect(result.status).toBe("refused")
  })

  test("obsidian is not OBS", () => {
    expect(obsAdapter.runningProcess(["obsidian", "Obsidian Helper"])).toBeNull()
  })

  test("--dry-run writes nothing but still reports", () => {
    const target = freshTarget()
    const before = snapshot(target)
    const result = apply(exported(sourceSetup("/nope/a.mp4")), target, { dryRun: true })
    expect(result.status).toBe("dry-run")
    expect(result.written.length).toBeGreaterThan(0)
    expect(result.problems.some((p) => p.message.includes("/nope/a.mp4"))).toBe(true)
    expect(snapshot(target)).toEqual(before)
  })

  test("a bundle cannot write outside its allowed paths", () => {
    for (const rel of ["../evil.json", "basic/scenes/../../evil.json", "basic/profiles/../basic.ini", "global.ini", "basic/profiles/x/run.sh", "plugin_config/other/config.json"]) {
      expect(obsAdapter.isBundlePath(rel)).toBe(false)
    }
    const bundle = exported(sourceSetup("/x"))
    const text = "{}"
    const tampered = { manifest: { ...bundle.manifest, files: { "../evil.json": { sha256: createHash("sha256").update(text).digest("hex"), bytes: 2 } } }, files: { "../evil.json": text } }
    expect(() => parseBundle(obsAdapter, JSON.stringify(tampered))).toThrow("may not write")
  })

  test("a bundle whose bytes were changed is rejected", () => {
    const bundle = exported(sourceSetup("/x"))
    bundle.files["basic/scenes/Main.json"] += " "
    expect(() => parseBundle(obsAdapter, JSON.stringify(bundle))).toThrow("checksum")
  })

  test("a manifest pointer cannot inject ini lines", () => {
    const bundle = exported(sourceSetup("/x"))
    ;(bundle.manifest.info.active as any).collection = "x\n[OBSWebSocket]\nAuthRequired=false"
    apply(bundle, freshTarget())
    expect(readFileSync(join(root, "target/user.ini"), "utf8")).not.toContain("OBSWebSocket")
  })
})

describe("acceptance 4: secrets", () => {
  test("no planted value anywhere in the default bundle, file or memory", () => {
    const bundle = exported(sourceSetup("/x"))
    const path = join(root, "out/b.json")
    writeBundle(path, bundle)
    const onDisk = readFileSync(path, "utf8")
    for (const secret of PLANTED) {
      expect(allBytes(bundle).includes(secret)).toBe(false)
      expect(onDisk.includes(secret)).toBe(false)
    }
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test("the scan can fail: --include-secrets really carries them, flagged and warned", () => {
    const bundle = exported(sourceSetup("/x"), true)
    expect(allBytes(bundle).includes(STREAM_KEY)).toBe(true)
    expect(allBytes(bundle).includes(WS_PASSWORD)).toBe(true)
    expect(bundle.manifest.containsSecrets).toBe(true)
    expect(apply(bundle, freshTarget()).notes.join("\n")).toContain("--include-secrets")
    // Hardware fields are not credentials: still dropped.
    expect(bundle.files["basic/profiles/Show/basic.ini"]).not.toContain("BaseCX")
  })

  test("apply names each dropped credential, and output holds no value", () => {
    const result = apply(exported(sourceSetup("/x")), freshTarget())
    const paths = result.dropped.filter((d) => d.reason === "secret").map((d) => `${d.file}:${d.path}`)
    expect(paths).toContain("basic/profiles/Show/service.json:settings.key")
    expect(paths).toContain("plugin_config/obs-websocket/config.json:server_password")
    expect(paths).toContain("basic/profiles/Show/basic.ini:Twitch.Token")
    expect(paths).toContain("global.ini:OBSWebSocket.ServerPassword")
    const printed = JSON.stringify(result)
    for (const secret of PLANTED) expect(printed.includes(secret)).toBe(false)
  })

  test("nothing in the target gets a secret from the bundle", () => {
    const target = freshTarget()
    apply(exported(sourceSetup("/x")), target)
    for (const rel of Object.keys(snapshot(target))) {
      const text = readFileSync(join(target, rel), "utf8")
      for (const secret of PLANTED) expect(text.includes(secret)).toBe(false)
    }
    expect(existsSync(join(target, "plugin_config/obs-websocket/config.json"))).toBe(false)
  })

  test("--force keeps this machine's own stream key and login", () => {
    const target = freshTarget()
    put(target, "basic/profiles/Show/service.json", JSON.stringify({ settings: { key: "target-own-key" } }))
    put(target, "basic/profiles/Show/basic.ini", "[Twitch]\nToken=target-own-token\n")
    apply(exported(sourceSetup("/x")), target, { force: true })
    expect(JSON.parse(readFileSync(join(target, "basic/profiles/Show/service.json"), "utf8")).settings.key).toBe("target-own-key")
    expect(readFileSync(join(target, "basic/profiles/Show/basic.ini"), "utf8")).toContain("Token=target-own-token")
  })

  test("backup files and unlisted files never enter the bundle", () => {
    const files = Object.keys(exported(sourceSetup("/x")).files)
    expect(files.sort()).toEqual(["basic/profiles/Show/basic.ini", "basic/profiles/Show/service.json", "basic/scenes/Main.json"])
  })

  test("an unparseable config is left out, not shipped unscanned", () => {
    const dir = sourceSetup("/x")
    put(dir, "basic/scenes/Broken.json", `{ "key": "${STREAM_KEY}"`)
    const bundle = exported(dir)
    expect(bundle.files["basic/scenes/Broken.json"]).toBeUndefined()
    expect(bundle.manifest.dropped).toContainEqual({ file: "basic/scenes/Broken.json", path: "*", reason: "not-portable" })
  })

  test("scrubUrl keeps ordinary URLs byte-identical and strips credentials", () => {
    expect(scrubUrl("https://heyiris.io/live?theme=dark&x=1")).toBe("https://heyiris.io/live?theme=dark&x=1")
    expect(scrubUrl("not a url")).toBe("not a url")
    expect(scrubUrl("rtmp://user:hunter2@ingest.example.com/live")).not.toContain("hunter2")
    expect(scrubUrl("srt://ingest.example.com:9000?passphrase=hunter2")).not.toContain("hunter2")
    expect(scrubUrl(`rtmp://ingest.example.com/live/${URL_PATH_TOKEN}`)).not.toContain(URL_PATH_TOKEN)
  })

  test("hotkeys survive the scrub", () => {
    const scene = JSON.parse(exported(sourceSetup("/x")).files["basic/scenes/Main.json"])
    expect(scene.sources[0].hotkeys["OBSBasic.SelectScene"][0].key).toBe("OBS_KEY_1")
  })
})

describe("acceptance 5: a missing plugin is named", () => {
  test("named in the output with what uses it, non-zero exit", () => {
    const result = apply(exported(sourceSetup("/x")), freshTarget())
    const plugin = result.problems.filter((p) => p.kind === "missing-plugin").map((p) => p.message).join("\n")
    expect(plugin).toContain("fixture_plugin_source")
    expect(plugin).toContain("Main / Plugin")
    expect(result.exitCode).toBe(EXIT_PROBLEMS)
  })

  test("a filter from a plugin is named too", () => {
    const bundle = exported(sourceSetup("/x", [{ id: "image_source", name: "Img", settings: {}, filters: [{ id: "shader_filter", name: "Glow", settings: {} }] }]))
    const text = apply(bundle, freshTarget()).problems.map((p) => p.message).join("\n")
    expect(text).toContain("shader_filter")
    expect(text).toContain("Img / filter Glow")
  })

  test("an installed plugin of that name is not reported", () => {
    const target = freshTarget()
    put(target, "plugins/fixture-plugin-source.plugin/x", "bin")
    const text = apply(exported(sourceSetup("/x")), target).problems.map((p) => p.message).join("\n")
    expect(text).not.toContain("fixture_plugin_source")
  })

  test("a source kind from another OS is named, and builtins are not", () => {
    const bundle = exported(sourceSetup("/x"))
    const onLinux = apply(bundle, freshTarget()).problems.map((p) => p.message).join("\n")
    expect(onLinux).toContain("coreaudio_input_capture")
    expect(onLinux).not.toContain("ffmpeg_source")
    expect(onLinux).not.toContain("browser_source")
  })

  test("the manifest records the plugins the pack needs", () => {
    const required = (exported(sourceSetup("/x")).manifest.info.plugins as any).required
    expect(required).toContain("fixture_plugin_source")
  })
})

describe("machine-bound fields", () => {
  test("encoder, canvas, colour and devices leave the bundle and are listed", () => {
    const bundle = exported(sourceSetup("/x"))
    const ini = bundle.files["basic/profiles/Show/basic.ini"]
    for (const key of ["BaseCX", "BaseCY", "OutputCX", "OutputCY", "ColorFormat", "ColorSpace", "Encoder", "MonitoringDeviceId"]) expect(ini).not.toContain(`${key}=`)
    expect(ini).toContain("FPSCommon=60")
    expect(ini).toContain("TrackIndex=1")
    const listed = bundle.manifest.dropped.filter((d) => d.reason === "machine-bound").map((d) => d.path)
    expect(listed).toContain("Video.BaseCX")
    expect(listed).toContain("AdvOut.Encoder")
    const mic = JSON.parse(bundle.files["basic/scenes/Main.json"]).sources.find((s: any) => s.name === "Mic")
    expect(mic.settings).toEqual({ other: 1 })
    expect(listed.some((p) => p.endsWith("settings.device_id"))).toBe(true)
    expect(bundle.manifest.dropped).toContainEqual({ file: "basic/profiles/Show/streamEncoder.json", path: "*", reason: "machine-bound" })
  })

  test("the target keeps its own encoder and canvas", () => {
    const target = freshTarget()
    put(target, "basic/profiles/Show/basic.ini", "[Video]\nBaseCX=1280\nBaseCY=720\n[AdvOut]\nEncoder=apple_h264\n")
    apply(exported(sourceSetup("/x")), target, { force: true })
    const ini = readFileSync(join(target, "basic/profiles/Show/basic.ini"), "utf8")
    expect(ini).toContain("BaseCX=1280")
    expect(ini).toContain("Encoder=apple_h264")
    expect(ini).not.toContain("5120")
    expect(ini).not.toContain("obs_x264")
  })

  test("the manifest inventories the source machine", () => {
    const { manifest } = exported(sourceSetup("/x"))
    expect(manifest.info.obsVersion).toBe("33.0.1")
    expect(manifest.info.encoderClass).toBe("software-x264")
    expect(manifest.info.display).toEqual({ base: "5120x2880", output: "1920x1080" })
    expect(manifest.info.audio).toContainEqual({ source: "Mic", kind: "coreaudio_input_capture" })
    expect(manifest.host.fingerprint).toHaveLength(12)
    expect(allBytes({ manifest, files: {} })).not.toContain("fixture-host")
  })

  test("recording path: rewritten when mapped, dropped and listed when not", () => {
    const bundle = exported(sourceSetup("/x"))
    const dropped = apply(bundle, freshTarget())
    expect(dropped.dropped).toContainEqual({ file: "basic/profiles/Show/basic.ini", path: "AdvOut.RecFilePath", reason: "unmapped-path" })
    expect(readFileSync(join(root, "target/basic/profiles/Show/basic.ini"), "utf8")).not.toContain("RecFilePath")
    rmSync(join(root, "target"), { recursive: true })
    apply(bundle, freshTarget(), { maps: [{ from: "/Users/alex", to: "/home/alex" }] })
    expect(readFileSync(join(root, "target/basic/profiles/Show/basic.ini"), "utf8")).toContain("RecFilePath=/home/alex/Movies")
  })

  test("ini edits keep CRLF and BOM", () => {
    const dir = sourceSetup("/x")
    put(dir, "basic/profiles/Show/basic.ini", "\uFEFF[General]\r\nName=Show\r\n[Video]\r\nBaseCX=1\r\nFPSCommon=30\r\n")
    const ini = exported(dir).files["basic/profiles/Show/basic.ini"]
    expect(ini).toBe("\uFEFF[General]\r\nName=Show\r\n[Video]\r\nFPSCommon=30\r\n")
  })
})

describe("path mapping", () => {
  const maps = (from: string, to: string) => [{ from, to }]

  test("macOS user to another macOS user and to Linux", () => {
    expect(mapPath("/Users/alex/Movies/a b.mp4", maps("/Users/alex", "/Users/flo"))).toBe("/Users/flo/Movies/a b.mp4")
    expect(mapPath("/Users/alex/a.mp4", maps("/Users/alex", "/home/alex"))).toBe("/home/alex/a.mp4")
    expect(mapPath("/Volumes/Media/a.mp4", maps("/Volumes/Media/", "/mnt/media"))).toBe("/mnt/media/a.mp4")
  })

  test("whole segments only", () => {
    expect(mapPath("/Users/alexander/a.mp4", maps("/Users/alex", "/x"))).toBeNull()
    expect(mapPath("/Users/alex", maps("/Users/alex", "/x"))).toBe("/x")
  })

  test("Windows forward and back slashes, case-insensitive drive, to macOS", () => {
    expect(mapPath("C:/Users/Alex/Videos/a.mp4", maps("C:/Users/Alex", "/Users/alex"))).toBe("/Users/alex/Videos/a.mp4")
    expect(mapPath("C:\\Users\\Alex\\Videos\\a.mp4", maps("C:\\Users\\Alex", "/Users/alex"))).toBe("/Users/alex/Videos/a.mp4")
    expect(mapPath("c:/users/alex/a.mp4", maps("C:/Users/Alex", "/m"))).toBe("/m/a.mp4")
  })

  test("macOS to Windows", () => {
    expect(mapPath("/Users/alex/a.mp4", maps("/Users/alex", "D:\\Media"))).toBe("D:/Media/a.mp4")
  })

  test("file URLs keep their form", () => {
    expect(mapPath("file:///Users/alex/page%20one.html", maps("/Users/alex", "/home/a"))).toBe("file:///home/a/page%20one.html")
    expect(mapPath("file:///C:/Users/alex/p.html", maps("C:/Users/alex", "/home/a"))).toBe("file:///home/a/p.html")
  })

  test("longest prefix wins", () => {
    const both = [{ from: "/Users/alex", to: "/a" }, { from: "/Users/alex/Videos", to: "/b" }]
    expect(mapPath("/Users/alex/Videos/x.mp4", both)).toBe("/b/x.mp4")
  })

  test("--map-media parsing", () => {
    expect(parseMapMedia(["C:/a=/b=c"])).toEqual([{ from: "C:/a", to: "/b=c" }])
    expect(() => parseMapMedia(["nope"])).toThrow("<old>=<new>")
    expect(() => parseMapMedia(["=/x"])).toThrow()
    expect(() => parseMapMedia(["/x="])).toThrow()
  })

  test("a Windows scene restored on Linux resolves end to end", () => {
    put(root, "w/intro.mp4", "video")
    const bundle = exported(sourceSetup("C:\\Users\\Alex\\Videos\\intro.mp4"))
    const result = apply(bundle, freshTarget(), { maps: [{ from: "C:/Users/Alex/Videos", to: join(root, "w") }] })
    expect(result.problems.filter((p) => p.kind === "missing-path")).toEqual([])
  })

  test("unmapped Windows path is reported missing", () => {
    const result = apply(exported(sourceSetup("C:/Users/Alex/x.mp4")), freshTarget())
    expect(result.problems.map((p) => p.message).join("\n")).toContain("C:/Users/Alex/x.mp4")
  })
})

describe("default config locations and bundle file", () => {
  test("per platform", () => {
    expect(obsAdapter.defaultConfigDir(host({ platform: "darwin", home: "/Users/a" }))).toBe("/Users/a/Library/Application Support/obs-studio")
    expect(obsAdapter.defaultConfigDir(host({ platform: "win32", home: "/h", env: { APPDATA: "/h/Roaming" } }))).toBe("/h/Roaming/obs-studio")
    expect(obsAdapter.defaultConfigDir(host({ platform: "linux", home: "/h" }))).toBe("/h/.config/obs-studio")
  })

  test("export with no config errors out", () => {
    expect(() => exported(join(root, "absent"))).toThrow("no OBS config")
  })

  test("a bundle round-trips, and writeBundle never overwrites", () => {
    const bundle = exported(sourceSetup("/x"))
    const path = join(root, "b.json")
    writeBundle(path, bundle)
    expect(parseBundle(obsAdapter, readFileSync(path, "utf8")).manifest.app).toBe("obs")
    expect(() => writeBundle(path, bundle)).toThrow("already exists")
  })

  test("a bundle for another app or schema is rejected", () => {
    const bundle = exported(sourceSetup("/x"))
    expect(() => parseBundle(obsAdapter, JSON.stringify({ ...bundle, manifest: { ...bundle.manifest, app: "other" } }))).toThrow("for \"other\"")
    expect(() => parseBundle(obsAdapter, JSON.stringify({ ...bundle, manifest: { ...bundle.manifest, schema: 2 } }))).toThrow("schema")
    expect(() => parseBundle(obsAdapter, "nope")).toThrow("not valid JSON")
  })
})
