/**
 * `iris app-config` — move an app's setup to a new machine (#191960, OBS first; #191242).
 * This file is only the terminal: flags, Atlas transport and output. The rules are in
 * app-config-engine.ts and the OBS knowledge is in app-config-obs.ts.
 */

import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "fs"
import { createInterface } from "readline/promises"
import os from "os"
import { join } from "path"
import { cmd } from "./cmd"
import { bold, dim, isNonInteractive, requireAuth, requireUserId, success, writeJson } from "./iris-api"
import {
  applyBundle,
  EXIT_PROBLEMS,
  EXIT_REFUSED,
  exportBundle,
  parseBundle,
  parseMapMedia,
  writeBundle,
  type AppConfigAdapter,
  type Bundle,
  type Dropped,
  type Host,
} from "./app-config-engine"
import { mixxxAdapter, SETUP_FILE, type MixxxSetup } from "./app-config-mixxx"
import {
  attachMapping,
  bundleFromRows,
  ensureRigSchema,
  fetchRigRecords,
  findRigPage,
  mappingFetcher,
  pickRig,
  reconcile,
  recordsToRows,
  renderRigPage,
  RIG_SCHEMA,
  setupToRows,
  shortHost,
  writeRigPage,
  writeRigRows,
  type MappingRef,
} from "./app-config-mixxx-atlas"
import { coreAudioDevices, coreMidiDevices, mixxxRuntime } from "./app-config-mixxx-runtime"
import { obsAdapter } from "./app-config-obs"
import { listBloqFiles, uploadFileVerified } from "./platform-atlas-files"

const ADAPTERS: Record<string, AppConfigAdapter> = { obs: obsAdapter, mixxx: { ...mixxxAdapter, runtime: mixxxRuntime } }
const BUNDLE_SUFFIX = ".iris-config.json"

function listProcesses(): string[] | null {
  try {
    if (process.platform === "win32") {
      const out = execFileSync("tasklist", ["/FO", "CSV", "/NH"], { encoding: "utf8" })
      return out.split(/\r?\n/).map((l) => l.split('","')[0].replace(/^"/, ""))
    }
    return execFileSync("ps", ["-axo", "comm="], { encoding: "utf8" }).split("\n")
  } catch {
    return null
  }
}

function realHost(): Host {
  return {
    platform: process.platform,
    arch: process.arch,
    hostname: os.hostname(),
    home: os.homedir(),
    env: process.env,
    processNames: listProcesses,
    midiDevices: coreMidiDevices,
    audioDevices: coreAudioDevices,
  }
}

function adapterFor(id: string): AppConfigAdapter {
  const adapter = ADAPTERS[id]
  if (!adapter) throw new Error(`no adapter for "${id}"; available: ${Object.keys(ADAPTERS).join(", ")}`)
  return adapter
}

function fail(asJson: unknown, message: string, code = 1): void {
  if (asJson) console.log(JSON.stringify({ ok: false, error: message }))
  else console.error(`\n  ${bold("ERROR")}  ${message}\n`)
  process.exitCode = code
}

function printDropped(dropped: Dropped[]): void {
  const secrets = dropped.filter((d) => d.reason === "secret")
  const machine = dropped.filter((d) => d.reason === "machine-bound" || d.reason === "unmapped-path")
  const other = dropped.filter((d) => d.reason === "not-portable")
  if (secrets.length) {
    console.log(`  ${bold("Credentials dropped")} ${dim("(set them again on the machine you restore to)")}`)
    for (const d of secrets) console.log(`    ${d.file}: ${d.path}`)
  }
  if (machine.length) {
    console.log(`  ${bold("Machine-bound fields dropped")} ${dim("(this machine's own values or the app's defaults apply)")}`)
    for (const d of machine) console.log(`    ${d.file}: ${d.path}`)
  }
  if (other.length) {
    console.log(`  ${bold("Files left out")}`)
    for (const d of other) console.log(`    ${d.file}`)
  }
}

const ExportCmd = cmd({
  command: "export <app>",
  describe: "save an app's setup to a file or bloq, with secrets and machine-bound fields removed",
  builder: (y) =>
    y
      .positional("app", { type: "string", demandOption: true, describe: "app to export (obs, mixxx)" })
      .option("to", { type: "string", describe: "bloq ID, or a new bundle file path (default: a new file here)" })
      .option("bloq", { type: "number", describe: "attach the bundle to this bloq (same as --to <id>)" })
      .option("redact-secrets", { type: "boolean", describe: "remove credentials (always on unless --include-secrets)" })
      .option("include-secrets", { type: "boolean", default: false, describe: "keep credentials in the bundle; local files only" })
      .option("config-dir", { type: "string", describe: "the app's config directory, if not the default" })
      .option("user-id", { type: "number", describe: "user ID, for a bloq target" })
      .option("rig", { type: "string", describe: "mixxx: the rig's name on the board (default: this machine's name)" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    let workDir: string | null = null
    try {
      const adapter = adapterFor(String(args.app))
      if (args.redactSecrets === false && !args.includeSecrets) return fail(args.json, "to keep credentials, ask with --include-secrets")
      if (args.redactSecrets === true && args.includeSecrets) return fail(args.json, "--redact-secrets and --include-secrets contradict each other")
      if (args.bloq !== undefined && args.to !== undefined) return fail(args.json, "pass --to or --bloq, not both")
      const toBloq = args.bloq !== undefined ? Number(args.bloq) : args.to && /^\d+$/.test(args.to) ? Number(args.to) : null
      // Bloq attachments are served from a URL and bloqs can be shared.
      if (toBloq && args.includeSecrets) return fail(args.json, "--include-secrets cannot go to a bloq; write to a local file instead", EXIT_REFUSED)

      const host = realHost()
      const configDir = args.configDir ?? adapter.defaultConfigDir(host)
      const bundle = exportBundle(adapter, { configDir, host, includeSecrets: !!args.includeSecrets })
      if (toBloq && adapter.id === "mixxx") return await exportMixxxToAtlas(args, bundle, configDir, host, toBloq)
      const stamp = bundle.manifest.createdAt.replace(/[-:]/g, "").slice(0, 15)
      const fileName = `${adapter.id}-${stamp}${BUNDLE_SUFFIX}`

      let dest = args.to && !toBloq ? args.to : fileName
      if (!toBloq && args.to) {
        try {
          if (statSync(args.to).isDirectory()) dest = join(args.to, fileName)
        } catch {
          /* a new path: writeBundle creates it */
        }
      }
      if (toBloq) {
        workDir = mkdtempSync(join(os.tmpdir(), "iris-app-config-"))
        dest = join(workDir, fileName)
      }
      const written = writeBundle(dest, bundle)

      let attachment: { id: number } | null = null
      if (toBloq) {
        await requireAuth()
        const userId = await requireUserId(args.userId)
        if (!userId) return fail(args.json, "no user ID for the upload")
        const r = await uploadFileVerified(userId, toBloq, dest)
        if (!r.ok) return fail(args.json, `upload failed: ${r.error}`)
        attachment = { id: r.id }
      }

      if (args.json) {
        await writeJson({
          ok: true,
          path: toBloq ? null : dest,
          bloq_id: toBloq,
          file_id: attachment?.id ?? null,
          sha256: written.sha256,
          bytes: written.bytes,
          contains_secrets: bundle.manifest.containsSecrets,
          files: Object.keys(bundle.files),
          dropped: bundle.manifest.dropped,
        })
        return
      }
      console.log()
      if (args.includeSecrets) {
        console.log(`  ${bold("WARNING")}  this bundle contains credentials in plain text. Do not share or upload it.`)
      }
      console.log(`  ${success("✓")} ${toBloq ? `bloq #${toBloq}, file #${attachment?.id}` : bold(dest)}  ${dim(`${written.bytes} bytes, read back and matched`)}`)
      console.log(`  ${dim("sha256 " + written.sha256)}`)
      console.log(`  ${Object.keys(bundle.files).length} config file(s)`)
      printDropped(bundle.manifest.dropped)
      console.log()
    } catch (e: any) {
      fail(args.json, String(e?.message ?? e))
    } finally {
      // Only the directory this run created.
      if (workDir) rmSync(workDir, { recursive: true, force: true })
    }
  },
})

// ── Mixxx through Atlas: attachments + dataset + page (see app-config-mixxx-atlas.ts) ─────────

async function exportMixxxToAtlas(args: any, bundle: Bundle, configDir: string, host: Host, bloqId: number): Promise<void> {
  await requireAuth()
  const userId = await requireUserId(args.userId)
  if (!userId) return fail(args.json, "no user ID for the upload")
  const rig = String(args.rig ?? shortHost(host.hostname))
  const setup = JSON.parse(bundle.files[SETUP_FILE]) as MixxxSetup
  const mappings: Record<string, MappingRef> = {}
  const attached: { name: string; id: number; reused: boolean }[] = []
  for (const rel of Object.keys(bundle.files).filter((r) => r.startsWith("controllers/"))) {
    const name = rel.slice("controllers/".length)
    const bytes = Buffer.from(bundle.files[rel], "utf8")
    const a = await attachMapping(userId, bloqId, name, bytes, rig)
    mappings[name] = { sha256: bundle.manifest.files[rel].sha256, fileId: a.id }
    attached.push({ name, ...a })
  }
  const rows = setupToRows(rig, setup, mappings, host.midiDevices?.() ?? [])
  const schema = await ensureRigSchema(bloqId)
  const counts = await writeRigRows(bloqId, rig, rows)
  const page = await writeRigPage(userId, bloqId, rig, renderRigPage(rig, rows, bloqId))
  if (args.json) {
    await writeJson({ ok: true, bloq_id: bloqId, rig, attachments: attached, dataset: { slug: RIG_SCHEMA, schema, ...counts, rows: rows.length }, page, dropped: bundle.manifest.dropped })
    return
  }
  console.log()
  console.log(`  ${success("✓")} rig ${bold(rig)} on bloq #${bloqId}  ${dim(`(from ${configDir})`)}`)
  for (const a of attached) console.log(`    attachment #${a.id}  ${a.name}  ${dim(a.reused ? "already there, sha256 matched" : "uploaded, read back and matched")}`)
  console.log(`    dataset ${RIG_SCHEMA}  ${rows.length} row(s)  ${dim(`${schema === "created" ? "schema created, " : ""}${counts.created} new, ${counts.updated} merged, ${counts.deleted} removed`)}`)
  console.log(`    page #${page.id} "Mixxx rig — ${rig}"  ${dim(page.action)}`)
  printDropped(bundle.manifest.dropped)
  console.log(`  ${dim(`by hand: iris datasets export -s ${RIG_SCHEMA} --bloq ${bloqId} --format json · iris atlas pull ${bloqId} · iris atlas files list ${bloqId}`)}`)
  console.log()
}

async function loadMixxxFromAtlas(
  bloqId: number,
  args: any,
): Promise<{ bundle: Bundle; origin: string; afterApply: (() => Promise<string[]>) | null }> {
  await requireAuth()
  const userId = await requireUserId(args.userId)
  if (!userId) throw new Error("no user ID for the download")
  const all = recordsToRows(await fetchRigRecords(bloqId))
  const pick = pickRig(all, args.rig, os.hostname())
  if ("error" in pick) throw new Error(pick.error)
  const rig = pick.rig
  const rows = all.filter((r) => r.rig === rig)
  const page = await findRigPage(userId, bloqId, rig)
  const rec = reconcile(rows, page?.content ?? null, args.prefer)
  if (rec.action === "conflict") {
    const err: any = new Error(rec.reason)
    err.exitCode = EXIT_REFUSED
    throw err
  }
  const bundle = await bundleFromRows(rec.rows, mappingFetcher(userId, bloqId))
  const how = { "in-sync": "page and dataset agree", "no-page": "no page yet", "page-edited": "the page was edited — using it", "dataset-edited": "the dataset was edited — using it" }[rec.action]
  const afterApply = async () => {
    const notes: string[] = []
    if (rec.action === "page-edited") {
      const c = await writeRigRows(bloqId, rig, rec.rows)
      notes.push(`Copied the page's edits into dataset ${RIG_SCHEMA} (${rec.changed.join(", ")}; ${c.created} new, ${c.updated} merged, ${c.deleted} removed).`)
    }
    if (rec.action !== "in-sync") {
      const p = await writeRigPage(userId, bloqId, rig, renderRigPage(rig, rec.rows, bloqId))
      notes.push(`Page #${p.id} "Mixxx rig — ${rig}" ${p.action} from the dataset.`)
    }
    return notes
  }
  return { bundle, origin: `bloq #${bloqId}, dataset ${RIG_SCHEMA}, rig ${rig} (${how})`, afterApply }
}

async function loadBundle(adapter: AppConfigAdapter, from: string, userIdFlag?: number): Promise<{ bundle: Bundle; origin: string }> {
  if (!/^\d+$/.test(from)) return { bundle: parseBundle(adapter, readFileSync(from, "utf8")), origin: from }
  await requireAuth()
  const userId = await requireUserId(userIdFlag)
  if (!userId) throw new Error("no user ID for the download")
  const listed = await listBloqFiles(userId, Number(from))
  if (!listed.ok) throw new Error(listed.error)
  const newest = listed.files
    .filter((f) => f.name.startsWith(`${adapter.id}-`) && f.name.endsWith(BUNDLE_SUFFIX))
    .sort((a, b) => b.id - a.id)[0]
  if (!newest?.url) throw new Error(`bloq #${from} has no ${adapter.id} bundle attached`)
  const res = await fetch(newest.url)
  if (!res.ok) throw new Error(`HTTP ${res.status} downloading file #${newest.id}`)
  return { bundle: parseBundle(adapter, await res.text()), origin: `bloq #${from}, file #${newest.id} (${newest.name})` }
}

const ApplyCmd = cmd({
  command: "apply <app>",
  describe: "restore my setup on this machine from a bundle or bloq — rewrites paths, backs up, then checks the result",
  builder: (y) =>
    y
      .positional("app", { type: "string", demandOption: true, describe: "app to restore (obs, mixxx)" })
      .option("from", { type: "string", describe: "bundle file, or a bloq ID (newest bundle attached)" })
      .option("bloq", { type: "number", describe: "restore the newest bundle attached to this bloq (same as --from <id>)" })
      .option("quit-app", { type: "boolean", default: false, describe: "quit the app if it is running, without asking (it rewrites its config on quit)" })
      .option("launch", { type: "boolean", default: true, describe: "start the app afterwards and check its log (--no-launch to skip)" })
      .option("check-timeout", { type: "number", default: 360, describe: "seconds to wait for the app's log to confirm the setup" })
      .option("rig", { type: "string", describe: "mixxx: which rig on the board (default: the only one, or this machine's name)" })
      .option("prefer", { type: "string", choices: ["page", "dataset"], describe: "mixxx: when the rig's page and dataset were both edited, which one wins" })
      .option("force", { type: "boolean", default: false, describe: "replace an existing setup, after a backup" })
      .option("map-media", { type: "array", string: true, describe: "rewrite a path prefix: <old>=<new> (repeatable)" })
      .option("dry-run", { type: "boolean", default: false, describe: "report what would change and what is missing; write nothing" })
      .option("config-dir", { type: "string", describe: "the app's config directory, if not the default" })
      .option("user-id", { type: "number", describe: "user ID, for a bloq source" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    try {
      const adapter = adapterFor(String(args.app))
      const maps = parseMapMedia(((args.mapMedia as string[] | undefined) ?? []).map(String))
      if (args.from !== undefined && args.bloq !== undefined) return fail(args.json, "pass --from or --bloq, not both")
      const from = args.bloq !== undefined ? String(args.bloq) : args.from
      if (!from) return fail(args.json, "say where the setup comes from: --bloq <id> or --from <bundle file | bloq id>")
      const loaded =
        adapter.id === "mixxx" && /^\d+$/.test(String(from))
          ? await loadMixxxFromAtlas(Number(from), args)
          : { ...(await loadBundle(adapter, String(from), args.userId)), afterApply: null }
      const { bundle, origin } = loaded
      const host = realHost()
      const configDir = args.configDir ?? adapter.defaultConfigDir(host)
      const say = (line: string) => !args.json && console.log(`  ${dim(line)}`)

      const runtime = adapter.runtime
      if (runtime && !existsSync(configDir)) {
        return fail(args.json, `no ${adapter.label} profile at ${configDir}. Open ${adapter.label} once so it creates one, quit it, then run this again; nothing was written.`, EXIT_REFUSED)
      }
      const opts = { configDir, host, force: !!args.force, maps, dryRun: !!args.dryRun }
      let quitForApply = false
      if (runtime && !args.dryRun) {
        // Only an apply that will write anything is worth quitting the app for.
        const preview = applyBundle(adapter, bundle, { ...opts, dryRun: true })
        const names = host.processNames()
        const running = names && adapter.runningProcess(names)
        if (preview.written.length && running) {
          let yes = !!args.quitApp
          if (!yes && !args.json && !isNonInteractive()) {
            const rl = createInterface({ input: process.stdin, output: process.stdout })
            const answer = await rl.question(`\n  ${adapter.label} is running, and ${adapter.runningReason.charAt(0).toLowerCase()}${adapter.runningReason.slice(1)}\n  Quit ${adapter.label} now to apply ${preview.written.length} change(s)? [y/N] `)
            rl.close()
            yes = /^y(es)?$/i.test(answer.trim())
          }
          if (!yes) {
            return fail(args.json, `${adapter.label} is running; nothing was written. Quit it, or pass --quit-app to let iris quit it.`, EXIT_REFUSED)
          }
          say(`Quitting ${adapter.label}…`)
          if (!(await runtime.quit(host))) return fail(args.json, `${adapter.label} did not quit within a minute (is a dialog open?); nothing was written.`, EXIT_REFUSED)
          quitForApply = true
        }
      }

      const result = applyBundle(adapter, bundle, opts)
      if (runtime && result.status === "applied" && args.launch !== false) {
        const checked = await runtime.launchAndCheck(bundle, { configDir, host, maps }, { timeoutMs: Math.max(10, Number(args.checkTimeout)) * 1000, onProgress: say })
        result.notes.push(...checked.notes)
        result.problems.push(...checked.problems)
        if (checked.problems.length) result.exitCode = EXIT_PROBLEMS
      } else if (quitForApply && args.launch !== false) {
        say(`${adapter.label} was quit but nothing was written; start it again yourself.`)
      }
      // The rig's page and dataset are brought level only after the machine took the setup.
      if (loaded.afterApply && !args.dryRun && (result.status === "applied" || result.status === "unchanged")) {
        result.notes.push(...(await loaded.afterApply()))
      }
      process.exitCode = result.exitCode

      if (args.json) {
        console.log(JSON.stringify({ ok: result.exitCode === 0, origin, config_dir: configDir, ...result }))
        return
      }
      console.log()
      console.log(`  ${dim("from " + origin)}`)
      if (result.reason) console.log(`  ${bold(result.status.toUpperCase())}  ${result.reason}`)
      if (result.status === "unchanged") console.log(`  ${success("✓")} already applied; nothing changed`)
      if (result.status === "applied") console.log(`  ${success("✓")} wrote ${result.written.length} file(s) to ${configDir}`)
      if (result.status === "dry-run") console.log(`  ${bold("DRY RUN")}  would write ${result.written.length} file(s) to ${configDir}`)
      if (result.backup) console.log(`  ${dim("replaced files saved in " + result.backup)}`)
      printDropped(result.dropped)
      for (const note of result.notes) console.log(`  ${note}`)
      const missing = result.problems.filter((p) => p.kind === "missing-path")
      const plugins = result.problems.filter((p) => p.kind === "missing-plugin")
      const readBack = result.problems.filter((p) => p.kind === "read-back")
      const devices = result.problems.filter((p) => p.kind === "missing-device")
      if (devices.length) {
        console.log(`  ${bold(`${devices.length} device(s) not connected here`)}`)
        for (const p of devices) console.log(`    ${p.message}`)
      }
      if (missing.length) {
        console.log(`  ${bold(`${missing.length} source path(s) do not exist here`)} ${dim("(copy the media, or use --map-media <old>=<new>)")}`)
        for (const p of missing) console.log(`    ${p.message}`)
      }
      if (plugins.length) {
        console.log(`  ${bold(`${plugins.length} source kind(s) may need a plugin`)}`)
        for (const p of plugins) console.log(`    ${p.message}`)
      }
      for (const p of readBack) console.log(`  ${bold("READ-BACK FAILED")}  ${p.message}`)
      for (const p of result.problems.filter((p) => p.kind === "app-check")) console.log(`  ${bold("CHECK")}  ${p.message}`)
      if (result.status !== "refused" && result.problems.length === 0) {
        console.log(`  ${success("✓")} read back: ${adapter.runtime ? "every file matches and every device is here" : "no source points at a missing path"}`)
      }
      console.log()
    } catch (e: any) {
      fail(args.json, String(e?.message ?? e), typeof e?.exitCode === "number" ? e.exitCode : 1)
    }
  },
})

export const PlatformAppConfigCommand = cmd({
  command: "app-config",
  describe: "save an app's setup and restore it on a new machine (OBS profiles and scenes; Mixxx controller mappings and audio routing)",
  builder: (y) => y.command(ExportCmd).command(ApplyCmd).demandCommand(1, "specify: export, apply"),
  async handler() {},
})
