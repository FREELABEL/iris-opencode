/**
 * #193298 — a Mixxx rig as Atlas rows + attachments + a page. Pure parts only: no network.
 * The rig is iris-hive-002's real state on 2026-11-11 (Master → Built-in Output,
 * Headphones → PIONEER DDJ-T1 ch 2–3), which an export there must capture as it is.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { applyBundle, exportBundle, type AudioDevice, type Host } from "./app-config-engine"
import { mixxxAdapter, parseMixxxCfg, parseSoundConfig, SETUP_FILE, type MixxxSetup } from "./app-config-mixxx"
import {
  bundleFromRows,
  changedIds,
  pickRig,
  reconcile,
  recordsToRows,
  renderRigPage,
  parseRigPage,
  rowsSha,
  rowsToSetup,
  setupToRows,
  type RigRow,
} from "./app-config-mixxx-atlas"

const T1 = "PIONEER DDJ-T1"
const MAPPING = "Pioneer DDJ-T1.midi.xml"
const SCRIPT = "Pioneer-DDJ-T1-script.js"
const MAPPING_XML = `<?xml version="1.0"?>\n<MixxxControllerPreset><info><name>${T1}</name></info></MixxxControllerPreset>\n`
const SCRIPT_JS = "var DDJ = {};\nDDJ.init = function () {};\n"
const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex")
const AUDIO: AudioDevice[] = [
  { name: "Built-in Microphone", outputChannels: 0, inputChannels: 2 },
  { name: "Built-in Output", outputChannels: 2, inputChannels: 0 },
  { name: T1, outputChannels: 4, inputChannels: 2 },
]
const SOUND = `<!DOCTYPE SoundManagerConfig>
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
  root = mkdtempSync(join(tmpdir(), "mixxx-atlas-193298-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function host(): Host {
  return { platform: "darwin", arch: "x64", hostname: "iris-hive-002.local", home: join(root, "home"), env: {}, processNames: () => ["zsh"], midiDevices: () => [T1], audioDevices: () => AUDIO }
}

function profile(name: string, files: Record<string, string>): string {
  const dir = join(root, name)
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(join(dir, rel, ".."), { recursive: true })
    writeFileSync(join(dir, rel), text)
  }
  return dir
}

/** Export iris-hive-002's real setup and turn it into rows, as `export --bloq` does. */
function hive002Rows(): RigRow[] {
  const dir = profile("source", {
    [`controllers/${MAPPING}`]: MAPPING_XML,
    [`controllers/${SCRIPT}`]: SCRIPT_JS,
    "mixxx.cfg": `[ControllerPreset]\nPIONEER_DDJ-T1 ${root}/source/controllers/${MAPPING}\n\n[Controller]\nPIONEER_DDJ-T1 1\n`,
    "soundconfig.xml": SOUND,
  })
  const b = exportBundle(mixxxAdapter, { configDir: dir, host: host(), includeSecrets: false })
  const setup = JSON.parse(b.files[SETUP_FILE]) as MixxxSetup
  return setupToRows("iris-hive-002", setup, { [MAPPING]: { sha256: sha(MAPPING_XML), fileId: 1290 }, [SCRIPT]: { sha256: sha(SCRIPT_JS), fileId: 1291 } }, [T1])
}

/** Stands in for the bloq's attachments. */
const attachments: Record<number, string> = { 1290: MAPPING_XML, 1291: SCRIPT_JS }
const fetchMapping = async (_: string, ref: { fileId: number | null }) => Buffer.from(attachments[ref.fileId ?? -1] ?? "")

describe("rows", () => {
  test("one row per controller, per route and for the settings — routes keyed by route, never by device index", () => {
    const rows = hive002Rows()
    expect(rows.map((r) => r.external_id)).toEqual([
      "iris-hive-002/audio-settings",
      "iris-hive-002/controller/PIONEER_DDJ-T1",
      `iris-hive-002/file/${MAPPING}`,
      `iris-hive-002/file/${SCRIPT}`,
      "iris-hive-002/output/Headphones/0",
      "iris-hive-002/output/Master/0",
    ])
    const master = rows.find((r) => r.type === "Master")!
    expect(master).toMatchObject({ device_name: "Built-in Output", io: "output", channel: 0, channel_count: 2 })
    expect(rows.find((r) => r.type === "Headphones")).toMatchObject({ device_name: T1, channel: 2, channel_count: 2 })
    expect(rows.find((r) => r.kind === "controller")).toMatchObject({ device_name: T1, cfg_key: "PIONEER_DDJ-T1", mapping_file: MAPPING, enabled: true })
    expect(rows.filter((r) => r.kind === "controller_file").map((r) => [r.mapping_file, r.mapping_file_id, r.mapping_sha256])).toEqual([
      [MAPPING, 1290, sha(MAPPING_XML)],
      [SCRIPT, 1291, sha(SCRIPT_JS)],
    ])
    expect(JSON.stringify(rows)).not.toContain("portAudioIndex")
    expect(JSON.stringify(rows)).not.toContain(root)
  })

  test("rows → setup → rows is lossless", () => {
    const rows = hive002Rows()
    const back = rowsToSetup(rows)
    expect(back.errors).toEqual([])
    expect(rowsSha(setupToRows("iris-hive-002", back.setup, back.mappings, [T1]))).toBe(rowsSha(rows))
  })

  test("a bad hand-written row is an error, not a guess", () => {
    const rows = hive002Rows().map((r) => (r.mapping_file === SCRIPT ? { ...r, mapping_sha256: "nope" } : r.type === "Master" ? { ...r, device_name: "" } : r))
    const { errors } = rowsToSetup(rows)
    expect(errors.some((e) => e.includes("mapping_sha256"))).toBe(true)
    expect(errors.some((e) => e.includes("output/Master/0") && e.includes("device_name"))).toBe(true)
  })

  test("dataset records ({external_id, data}) become rows, and the rig is found", () => {
    const rows = recordsToRows(hive002Rows().map(({ external_id, ...data }, i) => ({ id: i + 1, external_id, data })))
    expect(rowsSha(rows)).toBe(rowsSha(hive002Rows()))
    expect(pickRig(rows, undefined, "anything")).toEqual({ rig: "iris-hive-002" })
    expect(pickRig([...rows, { external_id: "mbp/audio-settings", rig: "mbp", kind: "audio_settings" }], undefined, "mbp.local")).toEqual({ rig: "mbp" })
    expect("error" in pickRig([...rows, { external_id: "mbp/x", rig: "mbp" }], undefined, "elsewhere")).toBe(true)
  })
})

describe("apply honours a hand-edited dataset row", () => {
  test("moving Master to the T1 in the dataset moves it in soundconfig.xml, at this Mac's index", async () => {
    const edited = hive002Rows().map((r) => (r.type === "Master" ? { ...r, device_name: T1, channel: 0 } : r))
    const bundle = await bundleFromRows(edited, fetchMapping)
    const dir = profile("target", { "mixxx.cfg": "[Config]\nVersion 2.5.6\n" })
    const r = applyBundle(mixxxAdapter, bundle, { configDir: dir, host: host(), force: false, maps: [] })
    expect(r.status).toBe("applied")
    expect(r.problems).toEqual([])
    const sound = parseSoundConfig(readFileSync(join(dir, "soundconfig.xml"), "utf8"))!
    expect(sound.devices).toHaveLength(1)
    expect(sound.devices[0]).toMatchObject({ name: T1, portAudioIndex: "2" })
    expect(sound.devices[0].io.map((c) => [c.attrs.type, c.attrs.channel])).toEqual([
      ["Headphones", "2"],
      ["Master", "0"],
    ])
    expect(readFileSync(join(dir, `controllers/${MAPPING}`), "utf8")).toBe(MAPPING_XML)
    expect(readFileSync(join(dir, `controllers/${SCRIPT}`), "utf8")).toBe(SCRIPT_JS)
    expect(parseMixxxCfg(readFileSync(join(dir, "mixxx.cfg"), "utf8")).get("Controller")?.get("PIONEER_DDJ-T1")).toBe("1")
  })

  test("disabling the controller row keeps the mapping but does not enable it", async () => {
    const edited = hive002Rows().map((r) => (r.kind === "controller" ? { ...r, enabled: false } : r))
    const dir = profile("target", { "mixxx.cfg": "[Config]\nVersion 2.5.6\n" })
    applyBundle(mixxxAdapter, await bundleFromRows(edited, fetchMapping), { configDir: dir, host: host(), force: false, maps: [] })
    expect(parseMixxxCfg(readFileSync(join(dir, "mixxx.cfg"), "utf8")).get("Controller")).toBeUndefined()
  })

  test("a controller whose mapping has no file row is refused", async () => {
    const rows = hive002Rows().filter((r) => r.mapping_file !== MAPPING || r.kind !== "controller_file")
    await expect(bundleFromRows(rows, fetchMapping)).rejects.toThrow(/no controller_file row/)
  })

  test("an attachment that does not hash to the row's sha256 stops the apply", async () => {
    const tampered = async () => Buffer.from(MAPPING_XML + "<!-- changed -->")
    await expect(bundleFromRows(hive002Rows(), tampered)).rejects.toThrow(/sha256/)
  })
})

describe("the page — generated from the dataset, edits detected on either side", () => {
  test("renders and parses back to the same rows, with no device index in it", () => {
    const rows = hive002Rows()
    const page = renderRigPage("iris-hive-002", rows, 569)
    const parsed = parseRigPage(page)
    if ("error" in parsed) throw new Error(parsed.error)
    expect(rowsSha(parsed.rows)).toBe(rowsSha(rows))
    expect(parsed.generatedFrom).toBe(rowsSha(rows))
    expect(page).toContain("| Master | Built-in Output | 1–2 |")
    expect(page).toContain("| Headphones | PIONEER DDJ-T1 | 3–4 |")
    expect(page).not.toContain("portAudioIndex")
  })

  let rows: RigRow[]
  let page: string
  beforeEach(() => {
    rows = hive002Rows()
    page = renderRigPage("iris-hive-002", rows, 569)
  })
  const editPage = (from: string, to: string) => page.replace(from, to)

  test("in sync, or no page yet → the dataset", () => {
    expect(reconcile(rows, page).action).toBe("in-sync")
    expect(reconcile(rows, null).action).toBe("no-page")
  })

  test("page edited by hand (atlas pull → edit → push) → the page wins", () => {
    // Master's row in the block: Built-in Output → PIONEER DDJ-T1.
    const block = page.slice(page.indexOf("```json mixxx-rig"))
    const i = block.indexOf('"device_name": "Built-in Output"')
    expect(i).toBeGreaterThan(0)
    const edited = page.replace(block, block.slice(0, i) + `"device_name": "${T1}"` + block.slice(i + '"device_name": "Built-in Output"'.length))
    const r = reconcile(rows, edited)
    expect(r.action).toBe("page-edited")
    if (r.action !== "page-edited") return
    expect(r.changed).toEqual(["iris-hive-002/output/Master/0"])
    expect(r.rows.find((x) => x.type === "Master")?.device_name).toBe(T1)
  })

  test("dataset edited (datasets import) → the dataset wins and the page is stale", () => {
    const ds = rows.map((r) => (r.type === "Master" ? { ...r, device_name: T1 } : r))
    const r = reconcile(ds, page)
    expect(r.action).toBe("dataset-edited")
    if (r.action === "dataset-edited") expect(r.changed).toEqual(["iris-hive-002/output/Master/0"])
  })

  test("both edited → refused, with the rows named, until --prefer says which", () => {
    const ds = rows.map((r) => (r.type === "Headphones" ? { ...r, channel: 0 } : r))
    const block = page.slice(page.indexOf("```json mixxx-rig"))
    const edited = page.replace(block, block.replace('"type": "Master"', '"type": "Booth"'))
    const r = reconcile(ds, edited)
    expect(r.action).toBe("conflict")
    if (r.action === "conflict") expect(r.reason).toContain("--prefer")
    expect(reconcile(ds, edited, "dataset").action).toBe("dataset-edited")
    expect(reconcile(ds, edited, "page").action).toBe("page-edited")
  })

  test("a page whose block was broken is refused, not ignored", () => {
    const r = reconcile(rows, editPage("```json mixxx-rig", "```json"))
    expect(r.action).toBe("conflict")
    expect(reconcile(rows, editPage("```json mixxx-rig", "```json"), "dataset").action).toBe("dataset-edited")
  })

  test("key order, row order and null-vs-absent are not edits", () => {
    const shuffled = [...rows].reverse().map((r) => Object.fromEntries(Object.entries(r).reverse()) as RigRow)
    expect(rowsSha(shuffled)).toBe(rowsSha(rows))
    expect(changedIds(rows, rows.map((r) => ({ ...r, extra: undefined })))).toEqual([])
  })
})
