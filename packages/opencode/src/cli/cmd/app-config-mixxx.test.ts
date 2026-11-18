/**
 * #193298. Every Mixxx profile here is a fixture in a temp folder, and every device list is
 * injected through Host — no test reads the real Mixxx profile, CoreMIDI or CoreAudio.
 *
 * The device lists and log lines are copied from the DDJ-T1 setup verified by hand on
 * iris-hive-002 on 2026-11-11 (Mixxx 2.5.6). They are TYPED fakes of CoreMIDI/CoreAudio: they
 * prove the logic, not that macOS still answers this way — the launch-and-log check does that.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { dirname, join } from "path"
import { applyBundle, EXIT_PROBLEMS, EXIT_REFUSED, exportBundle, parseBundle, type AudioDevice, type Bundle, type Host } from "./app-config-engine"
import {
  controllerKey,
  mergeMixxxCfg,
  mixxxAdapter,
  parseMixxxCfg,
  parseSoundConfig,
  renderSoundConfig,
  resolveAudioDevices,
  sandboxDir,
  SETUP_FILE,
} from "./app-config-mixxx"
import { checkMixxxLog } from "./app-config-mixxx-runtime"

const T1 = "PIONEER DDJ-T1"
const MAPPING = "Pioneer DDJ-T1.midi.xml"
const SCRIPT = "Pioneer-DDJ-T1-script.js"
const MAPPING_XML = `<?xml version="1.0" encoding="utf-8"?>\n<MixxxControllerPreset mixxxVersion="2.5" schemaVersion="1">\n  <info><name>${T1}</name></info>\n  <controller id="DDJ-T1">\n    <scriptfiles>\n      <file filename="lodash.mixxx.js"/>\n      <file filename="midi-components-0.0.js"/>\n      <file filename="${SCRIPT}" functionprefix="DDJ"/>\n    </scriptfiles>\n  </controller>\n</MixxxControllerPreset>\n`
const SCRIPT_JS = "var DDJ = {};\nDDJ.init = function () { /* “curly quotes” survive */ };\nDDJ.shutdown = function () {};\n"

/** CoreAudio order on iris-hive-002, 2026-11-11 — PortAudio numbers devices in this order. */
const HIVE_002_AUDIO: AudioDevice[] = [
  { name: "Built-in Microphone", outputChannels: 0, inputChannels: 2 },
  { name: "Built-in Output", outputChannels: 2, inputChannels: 0 },
  { name: T1, outputChannels: 4, inputChannels: 2 },
  { name: "OBSBOT Tiny Microphone", outputChannels: 0, inputChannels: 1 },
]

/** soundconfig.xml exactly as Mixxx 2.5.6 wrote it on iris-hive-002. */
const HIVE_002_SOUNDCONFIG = `<!DOCTYPE SoundManagerConfig>
<SoundManagerConfig api="Core Audio" deck_count="4" force_network_clock="0" latency="5" samplerate="44100" sync_buffers="2">
 <SoundDevice name="PIONEER DDJ-T1" portAudioIndex="2">
  <output channel="2" channel_count="2" index="0" type="Headphones"/>
 </SoundDevice>
 <SoundDevice name="Built-in Output" portAudioIndex="1">
  <output channel="0" channel_count="2" index="0" type="Master"/>
 </SoundDevice>
</SoundManagerConfig>
`

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "app-config-193298-"))
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
    platform: "darwin",
    arch: "x64",
    hostname: "fixture-mac",
    home: join(root, "home"),
    env: {},
    processNames: () => ["/bin/zsh", "/Applications/Obsidian.app/Contents/MacOS/Obsidian"],
    midiDevices: () => [T1],
    audioDevices: () => HIVE_002_AUDIO,
    ...over,
  }
}

/** The setup as it stood on iris-hive-002 after tonight's hand setup. */
function sourceProfile(): string {
  const dir = join(root, "source/Mixxx")
  put(dir, `controllers/${MAPPING}`, MAPPING_XML)
  put(dir, `controllers/${SCRIPT}`, SCRIPT_JS)
  put(dir, "controllers/notes.txt", "not a mapping")
  put(
    dir,
    "mixxx.cfg",
    `[Config]\nVersion 2.5.6\nhide_menubar 1\n\n[ControllerPreset]\nPIONEER_DDJ-T1 ${dir}/controllers/${MAPPING}\n\n[Controller]\nPIONEER_DDJ-T1 1\n\n[Library]\nRescanOnStartup 0\n`,
  )
  put(dir, "soundconfig.xml", HIVE_002_SOUNDCONFIG)
  return dir
}

/** A profile Mixxx made on its first launch, before anyone touched it. */
function emptyProfile(): string {
  const dir = join(root, "target/Mixxx")
  put(dir, "mixxx.cfg", "[Config]\nVersion 2.5.6\n\n[Library]\nRescanOnStartup 0\n")
  put(
    dir,
    "soundconfig.xml",
    `<!DOCTYPE SoundManagerConfig>\n<SoundManagerConfig api="Core Audio" deck_count="4" force_network_clock="0" latency="5" samplerate="44100" sync_buffers="2">\n <SoundDevice name="Built-in Output" portAudioIndex="1">\n  <output channel="0" channel_count="2" index="0" type="Master"/>\n </SoundDevice>\n</SoundManagerConfig>\n`,
  )
  return dir
}

function exported(): Bundle {
  const b = exportBundle(mixxxAdapter, { configDir: sourceProfile(), host: host(), includeSecrets: false })
  // Through the same untrusted-input gate a downloaded bundle goes through.
  return parseBundle(mixxxAdapter, JSON.stringify(b))
}

const read = (dir: string, rel: string) => readFileSync(join(dir, rel), "utf8")

describe("controller key sanitization", () => {
  test("CoreMIDI's name becomes the mixxx.cfg key Mixxx itself wrote (2026-11-11)", () => {
    expect(controllerKey("PIONEER DDJ-T1")).toBe("PIONEER_DDJ-T1")
  })
  test("every space and path separator becomes _, other characters stay", () => {
    expect(controllerKey("Numark Mixtrack Pro 3")).toBe("Numark_Mixtrack_Pro_3")
    expect(controllerKey("A/B\\C D")).toBe("A_B_C_D")
    expect(controllerKey("  DJ-Tech 4Mix  ")).toBe("DJ-Tech_4Mix")
  })
})

describe("audio device name → portAudioIndex", () => {
  const routing = [
    { name: "Built-in Output", attrs: {}, io: [] },
    { name: T1, attrs: {}, io: [] },
  ]
  test("tonight's order gives tonight's indexes", () => {
    const r = resolveAudioDevices(routing, HIVE_002_AUDIO)
    expect(r.resolved.map((d) => [d.name, d.portAudioIndex])).toEqual([
      ["Built-in Output", 1],
      [T1, 2],
    ])
    expect(r.missing).toEqual([])
  })
  test("a different Mac's order gives that Mac's indexes, not the bundle's", () => {
    const other: AudioDevice[] = [
      { name: "MacBook Pro Microphone", outputChannels: 0, inputChannels: 1 },
      { name: "MacBook Pro Speakers", outputChannels: 2, inputChannels: 0 },
      { name: "ZoomAudioDevice", outputChannels: 2, inputChannels: 2 },
      { name: T1, outputChannels: 4, inputChannels: 2 },
      { name: "Built-in Output", outputChannels: 2, inputChannels: 0 },
    ]
    const r = resolveAudioDevices(routing, other)
    expect(r.resolved.map((d) => d.portAudioIndex)).toEqual([4, 3])
  })
  test("an unplugged device is missing, not guessed", () => {
    const r = resolveAudioDevices(routing, HIVE_002_AUDIO.filter((d) => d.name !== T1))
    expect(r.resolved.map((d) => d.name)).toEqual(["Built-in Output"])
    expect(r.missing).toEqual([T1])
  })
  test("two devices with one name: the first, and it says so", () => {
    const r = resolveAudioDevices([{ name: "USB Audio", attrs: {}, io: [] }], [
      { name: "USB Audio", outputChannels: 2, inputChannels: 0 },
      { name: "USB Audio", outputChannels: 2, inputChannels: 0 },
    ])
    expect(r.resolved[0].portAudioIndex).toBe(0)
    expect(r.ambiguous).toEqual(["USB Audio"])
  })
})

describe("mixxx.cfg merge", () => {
  const entries = [
    { section: "ControllerPreset", key: "PIONEER_DDJ-T1", value: "/x/controllers/Pioneer DDJ-T1.midi.xml" },
    { section: "Controller", key: "PIONEER_DDJ-T1", value: "1" },
  ]
  test("adds both sections to a cfg that has neither, leaving every other line alone", () => {
    const before = "[Config]\nVersion 2.5.6\n\n[Library]\nRescanOnStartup 0\n"
    const after = mergeMixxxCfg(before, entries)
    expect(after.startsWith(before)).toBe(true)
    expect(after).toContain("[ControllerPreset]\nPIONEER_DDJ-T1 /x/controllers/Pioneer DDJ-T1.midi.xml\n")
    expect(after).toContain("[Controller]\nPIONEER_DDJ-T1 1\n")
    expect(parseMixxxCfg(after).get("Library")?.get("RescanOnStartup")).toBe("0")
  })
  test("a second merge changes nothing — no duplicate sections, byte for byte", () => {
    const once = mergeMixxxCfg("[Config]\nVersion 2.5.6\n", entries)
    expect(mergeMixxxCfg(once, entries)).toBe(once)
    expect(once.match(/^\[Controller\]$/gm)).toHaveLength(1)
    expect(once.match(/^\[ControllerPreset\]$/gm)).toHaveLength(1)
  })
  test("updates a stale value in place, inside the existing section", () => {
    const before = "[ControllerPreset]\nPIONEER_DDJ-T1 /old/Pioneer DDJ-T1.midi.xml\nOTHER_DEVICE /y.midi.xml\n\n[Controller]\nPIONEER_DDJ-T1 0\nOTHER_DEVICE 1\n\n[Config]\nVersion 2.5.6\n"
    const after = mergeMixxxCfg(before, entries)
    expect(after).toBe(before.replace("/old/Pioneer DDJ-T1.midi.xml", "/x/controllers/Pioneer DDJ-T1.midi.xml").replace("PIONEER_DDJ-T1 0", "PIONEER_DDJ-T1 1"))
  })
  test("adds a key to an existing section rather than appending a second one", () => {
    const after = mergeMixxxCfg("[Controller]\nOTHER_DEVICE 1\n\n[Config]\nVersion 2.5.6\n", entries)
    expect(after.match(/^\[Controller\]$/gm)).toHaveLength(1)
    expect(after).toContain("[Controller]\nOTHER_DEVICE 1\nPIONEER_DDJ-T1 1\n\n[Config]")
  })
  test("collapses a key appended by hand twice (sections written twice) to the one Mixxx reads", () => {
    const handAppended = "[Controller]\nPIONEER_DDJ-T1 1\n\n[Config]\nVersion 2.5.6\n\n[Controller]\nPIONEER_DDJ-T1 1\n"
    const after = mergeMixxxCfg(handAppended, entries)
    expect(after.match(/^PIONEER_DDJ-T1 1$/gm)).toHaveLength(1)
    expect(parseMixxxCfg(after).get("Controller")?.get("PIONEER_DDJ-T1")).toBe("1")
  })
  test("creates a cfg from nothing", () => {
    expect(mergeMixxxCfg(null, entries)).toBe("[ControllerPreset]\nPIONEER_DDJ-T1 /x/controllers/Pioneer DDJ-T1.midi.xml\n\n[Controller]\nPIONEER_DDJ-T1 1\n")
  })
  test("keeps CRLF lines and a missing final newline as they were", () => {
    const before = "[Controller]\r\nPIONEER_DDJ-T1 1\r\n\r\n[ControllerPreset]\r\nPIONEER_DDJ-T1 /x/controllers/Pioneer DDJ-T1.midi.xml"
    expect(mergeMixxxCfg(before, entries)).toBe(before)
  })
})

describe("soundconfig.xml", () => {
  test("renders byte-identical to what Mixxx 2.5.6 wrote", () => {
    const parsed = parseSoundConfig(HIVE_002_SOUNDCONFIG)!
    const devices = parsed.devices.map((d) => ({ ...d, portAudioIndex: Number(d.portAudioIndex) }))
    expect(renderSoundConfig(parsed.attrs, devices)).toBe(HIVE_002_SOUNDCONFIG)
  })
  test("escapes names with XML characters and reads them back", () => {
    const out = renderSoundConfig({ api: "Core Audio" }, [{ name: `A&B "Pro" <2>`, attrs: {}, io: [{ tag: "output", attrs: { type: "Master" } }], portAudioIndex: 0 }])
    expect(parseSoundConfig(out)!.devices[0].name).toBe(`A&B "Pro" <2>`)
  })
})

describe("export", () => {
  test("carries the mappings with sha256, keys by file name, routing by device name — no index, no absolute path", () => {
    const b = exported()
    const sha = (s: string) => createHash("sha256").update(s).digest("hex")
    expect(Object.keys(b.files).sort()).toEqual([`controllers/${MAPPING}`, `controllers/${SCRIPT}`, SETUP_FILE].sort())
    expect(b.manifest.files[`controllers/${SCRIPT}`].sha256).toBe(sha(SCRIPT_JS))
    const setup = JSON.parse(b.files[SETUP_FILE])
    expect(setup.controllers).toEqual([{ key: "PIONEER_DDJ-T1", mapping: MAPPING, location: "user", enabled: true }])
    expect(setup.sound.devices.map((d: any) => d.name)).toEqual([T1, "Built-in Output"])
    expect(setup.sound.devices[1].io).toEqual([{ tag: "output", attrs: { channel: "0", channel_count: "2", index: "0", type: "Master" } }])
    const whole = JSON.stringify(b)
    expect(whole).not.toContain("portAudioIndex=")
    expect(b.files[SETUP_FILE]).not.toContain("portAudioIndex")
    expect(whole).not.toContain(join(root, "source"))
    expect(b.manifest.dropped.filter((d) => d.reason === "machine-bound")).toHaveLength(2)
  })
  test("a mapping that ships inside Mixxx is carried by name as a system mapping", () => {
    const dir = sourceProfile()
    put(dir, "mixxx.cfg", "[ControllerPreset]\nTRAKTOR_KONTROL_S2 /Applications/Mixxx.app/Contents/Resources/controllers/Traktor Kontrol S2 MK3.hid.xml\n\n[Controller]\nTRAKTOR_KONTROL_S2 0\n")
    const setup = JSON.parse(exportBundle(mixxxAdapter, { configDir: dir, host: host(), includeSecrets: false }).files[SETUP_FILE])
    expect(setup.controllers).toEqual([{ key: "TRAKTOR_KONTROL_S2", mapping: "Traktor Kontrol S2 MK3.hid.xml", location: "system", enabled: false }])
  })
  test("the default profile is the sandbox container when Mixxx is sandboxed, else Application Support", () => {
    const h = host()
    expect(mixxxAdapter.defaultConfigDir(h)).toBe(join(h.home, "Library/Application Support/Mixxx"))
    mkdirSync(sandboxDir(h.home), { recursive: true })
    expect(mixxxAdapter.defaultConfigDir(h)).toBe(sandboxDir(h.home))
  })
})

describe("apply", () => {
  test("an empty profile ends in tonight's working state, and a second run changes nothing", () => {
    const bundle = exported()
    const dir = emptyProfile()
    const first = applyBundle(mixxxAdapter, bundle, { configDir: dir, host: host(), force: false, maps: [] })
    expect(first.status).toBe("applied")
    expect(first.problems).toEqual([])
    expect(read(dir, `controllers/${MAPPING}`)).toBe(MAPPING_XML)
    expect(read(dir, `controllers/${SCRIPT}`)).toBe(SCRIPT_JS)
    const cfg = parseMixxxCfg(read(dir, "mixxx.cfg"))
    expect(cfg.get("ControllerPreset")?.get("PIONEER_DDJ-T1")).toBe(join(dir, "controllers", MAPPING))
    expect(cfg.get("Controller")?.get("PIONEER_DDJ-T1")).toBe("1")
    expect(cfg.get("Library")?.get("RescanOnStartup")).toBe("0")
    const sound = parseSoundConfig(read(dir, "soundconfig.xml"))!
    expect(sound.devices.map((d) => [d.name, d.portAudioIndex])).toEqual([
      [T1, "2"],
      ["Built-in Output", "1"],
    ])
    expect(first.backup).not.toBeNull()

    const second = applyBundle(mixxxAdapter, bundle, { configDir: dir, host: host(), force: false, maps: [] })
    expect(second.status).toBe("unchanged")
    expect(second.written).toEqual([])
    expect(second.problems).toEqual([])
  })

  test("Mixxx re-writing soundconfig.xml in another device order is still unchanged", () => {
    const bundle = exported()
    const dir = emptyProfile()
    applyBundle(mixxxAdapter, bundle, { configDir: dir, host: host(), force: false, maps: [] })
    const parsed = parseSoundConfig(read(dir, "soundconfig.xml"))!
    const reordered = [...parsed.devices].reverse().map((d) => ({ ...d, portAudioIndex: Number(d.portAudioIndex) }))
    writeFileSync(join(dir, "soundconfig.xml"), renderSoundConfig(parsed.attrs, reordered))
    expect(applyBundle(mixxxAdapter, bundle, { configDir: dir, host: host(), force: false, maps: [] }).status).toBe("unchanged")
  })

  test("on a Mac with another device order the routing follows the names", () => {
    const dir = emptyProfile()
    const audio = [{ name: "MacBook Pro Speakers", outputChannels: 2, inputChannels: 0 }, ...HIVE_002_AUDIO]
    applyBundle(mixxxAdapter, exported(), { configDir: dir, host: host({ audioDevices: () => audio }), force: false, maps: [] })
    const sound = parseSoundConfig(read(dir, "soundconfig.xml"))!
    expect(Object.fromEntries(sound.devices.map((d) => [d.name, d.portAudioIndex]))).toEqual({ [T1]: "3", "Built-in Output": "2" })
  })

  test("a controller that is not plugged in gets its mapping but is not enabled, and says so", () => {
    const dir = emptyProfile()
    const r = applyBundle(mixxxAdapter, exported(), {
      configDir: dir,
      host: host({ midiDevices: () => [], audioDevices: () => HIVE_002_AUDIO.filter((d) => d.name !== T1) }),
      force: false,
      maps: [],
    })
    expect(r.status).toBe("applied")
    expect(r.exitCode).toBe(EXIT_PROBLEMS)
    expect(existsSync(join(dir, `controllers/${MAPPING}`))).toBe(true)
    expect(parseMixxxCfg(read(dir, "mixxx.cfg")).get("Controller")).toBeUndefined()
    expect(r.problems.map((p) => p.kind)).toEqual(["missing-device", "missing-device"])
    expect(r.problems[0].message).toContain("PIONEER_DDJ-T1")
  })

  test("refuses while Mixxx is running — it would rewrite both files on quit", () => {
    const dir = emptyProfile()
    const r = applyBundle(mixxxAdapter, exported(), {
      configDir: dir,
      host: host({ processNames: () => ["/Applications/Mixxx.app/Contents/MacOS/Mixxx"] }),
      force: false,
      maps: [],
    })
    expect(r.status).toBe("refused")
    expect(r.exitCode).toBe(EXIT_REFUSED)
    expect(readdirSync(dir).sort()).toEqual(["mixxx.cfg", "soundconfig.xml"])
  })

  test("a profile that already has other mappings needs --force", () => {
    const dir = emptyProfile()
    put(dir, "controllers/Someone Else.midi.xml", "<x/>")
    const r = applyBundle(mixxxAdapter, exported(), { configDir: dir, host: host(), force: false, maps: [] })
    expect(r.status).toBe("refused")
    expect(applyBundle(mixxxAdapter, exported(), { configDir: dir, host: host(), force: true, maps: [] }).status).toBe("applied")
    expect(read(dir, "controllers/Someone Else.midi.xml")).toBe("<x/>")
  })

  test("a bundle naming a path outside controllers/ is refused before anything is read", () => {
    const b = exported() as any
    b.files["controllers/../mixxx.cfg"] = "x"
    b.manifest.files["controllers/../mixxx.cfg"] = { sha256: createHash("sha256").update("x").digest("hex"), bytes: 1 }
    expect(() => parseBundle(mixxxAdapter, JSON.stringify(b))).toThrow(/may not write/)
  })
})

describe("mixxx.log check", () => {
  // Real lines from iris-hive-002, 2026-11-11 21:10:13.
  const LOG = [
    '21:10:13.558 Debug [Main] PortAudio: Started stream successfully',
    '21:10:13.558 Debug [Main] Using "PIONEER DDJ-T1" as output sound device clock reference',
    "21:10:13.580 Info [Controller] PortMidiController: Opening PIONEER DDJ-T1 index 0 for input",
    "21:10:13.581 Info [Controller] PortMidiController: Opening PIONEER DDJ-T1 index 1 for output",
    "21:10:13.581 Info [Controller] Starting engine",
    '21:10:13.630 Warning [Controller] file:///Applications/Mixxx.app/Contents/Resources/controllers/lodash.mixxx.js:2391:19 Variable "isArray" is used before its declaration at 11278:9.',
  ].join("\n")
  const expect_ = { controllers: [T1], audio: [T1, "Built-in Output"] }

  test("tonight's log passes, and lodash's own warnings are not counted", () => {
    const v = checkMixxxLog(LOG, expect_)
    expect(v.missing).toEqual([])
    expect(v.scriptErrors).toEqual([])
    expect(v.seen).toHaveLength(4)
  })
  test("silence is reported as missing markers, not as success", () => {
    const v = checkMixxxLog("21:09:53 Debug [Main] Mixxx 2.5.6 is starting...", expect_)
    expect(v.missing).toHaveLength(4)
  })
  test("an error in the mapping's own script is caught", () => {
    const bad = LOG + `\n21:10:13.700 Warning [Controller] file:///x/controllers/${SCRIPT}:42:7 ReferenceError: foo is not defined`
    expect(checkMixxxLog(bad, expect_).scriptErrors).toHaveLength(1)
  })
})
