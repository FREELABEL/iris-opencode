/**
 * `iris app-config` — move an app's setup to a new machine (#191960, OBS first; #191242).
 * This file is only the terminal: flags, Atlas transport and output. The rules are in
 * app-config-engine.ts and the OBS knowledge is in app-config-obs.ts.
 */

import { execFileSync } from "child_process"
import { mkdtempSync, readFileSync, rmSync, statSync } from "fs"
import os from "os"
import { join } from "path"
import { cmd } from "./cmd"
import { bold, dim, requireAuth, requireUserId, success, writeJson } from "./iris-api"
import {
  applyBundle,
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
import { obsAdapter } from "./app-config-obs"
import { listBloqFiles, uploadFileVerified } from "./platform-atlas-files"

const ADAPTERS: Record<string, AppConfigAdapter> = { obs: obsAdapter }
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
    console.log(`  ${bold("Credentials dropped")} ${dim("(set them again on this machine)")}`)
    for (const d of secrets) console.log(`    ${d.file}: ${d.path}`)
  }
  if (machine.length) {
    console.log(`  ${bold("Machine-bound fields dropped")} ${dim("(this machine's own values or OBS defaults apply)")}`)
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
      .positional("app", { type: "string", demandOption: true, describe: "app to export (obs)" })
      .option("to", { type: "string", describe: "bloq ID, or a new bundle file path (default: a new file here)" })
      .option("redact-secrets", { type: "boolean", describe: "remove credentials (always on unless --include-secrets)" })
      .option("include-secrets", { type: "boolean", default: false, describe: "keep credentials in the bundle; local files only" })
      .option("config-dir", { type: "string", describe: "the app's config directory, if not the default" })
      .option("user-id", { type: "number", describe: "user ID, for a bloq target" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    let workDir: string | null = null
    try {
      const adapter = adapterFor(String(args.app))
      if (args.redactSecrets === false && !args.includeSecrets) return fail(args.json, "to keep credentials, ask with --include-secrets")
      if (args.redactSecrets === true && args.includeSecrets) return fail(args.json, "--redact-secrets and --include-secrets contradict each other")
      const toBloq = args.to && /^\d+$/.test(args.to) ? Number(args.to) : null
      // Bloq attachments are served from a URL and bloqs can be shared.
      if (toBloq && args.includeSecrets) return fail(args.json, "--include-secrets cannot go to a bloq; write to a local file instead", EXIT_REFUSED)

      const host = realHost()
      const configDir = args.configDir ?? adapter.defaultConfigDir(host)
      const bundle = exportBundle(adapter, { configDir, host, includeSecrets: !!args.includeSecrets })
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
      .positional("app", { type: "string", demandOption: true, describe: "app to restore (obs)" })
      .option("from", { type: "string", demandOption: true, describe: "bundle file, or a bloq ID (newest bundle attached)" })
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
      const { bundle, origin } = await loadBundle(adapter, String(args.from), args.userId)
      const host = realHost()
      const configDir = args.configDir ?? adapter.defaultConfigDir(host)
      const result = applyBundle(adapter, bundle, { configDir, host, force: !!args.force, maps, dryRun: !!args.dryRun })
      process.exitCode = result.exitCode

      if (args.json) {
        console.log(JSON.stringify({ ok: result.exitCode === 0, origin, config_dir: configDir, ...result }))
        return
      }
      console.log()
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
      if (missing.length) {
        console.log(`  ${bold(`${missing.length} source path(s) do not exist here`)} ${dim("(copy the media, or use --map-media <old>=<new>)")}`)
        for (const p of missing) console.log(`    ${p.message}`)
      }
      if (plugins.length) {
        console.log(`  ${bold(`${plugins.length} source kind(s) may need a plugin`)}`)
        for (const p of plugins) console.log(`    ${p.message}`)
      }
      for (const p of readBack) console.log(`  ${bold("READ-BACK FAILED")}  ${p.message}`)
      if (result.status !== "refused" && result.problems.length === 0) console.log(`  ${success("✓")} read back: no source points at a missing path`)
      console.log()
    } catch (e: any) {
      fail(args.json, String(e?.message ?? e))
    }
  },
})

export const PlatformAppConfigCommand = cmd({
  command: "app-config",
  describe: "save an app's setup and restore it on a new machine (OBS profiles, scene collections)",
  builder: (y) => y.command(ExportCmd).command(ApplyCmd).demandCommand(1, "specify: export, apply"),
  async handler() {},
})
