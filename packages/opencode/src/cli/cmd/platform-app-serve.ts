// iris app serve <folder> · iris app list --hive · iris app lint <folder>
//
// IRIS Hive Apps S1 (EPIC #188312, ADR-03 #189087). The pure decisions live in apps-serve.ts;
// this file moves bytes and runs commands. It talks to nodes over ssh/scp (hive-tailscale.ts),
// NOT the Hive task transport: that transport returns a PTY stream and is documented as unable
// to carry files or a clean exit code (#182004), and serve needs both.

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, printDivider, printKV, dim, bold, success, writeJson, irisFetch } from "./iris-api"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import { basename, join, resolve } from "path"
import { execFile } from "child_process"
import { promisify } from "util"
import { fetchNodes, resolveNode, type HiveNode } from "./platform-hive-nodes"
import {
  detectLocalNodeId,
  ensureSshUser,
  pushFile,
  resolveSshTarget,
  sshRun,
  type SshTarget,
} from "./hive-tailscale"
import {
  MANIFEST_FILE,
  SERVE_EXIT,
  buildHealthScript,
  buildListScript,
  buildServeScript,
  lintLocalApp,
  parseListOutput,
  resolveManifest,
  servedContainerName,
  shq,
  type ServedApp,
} from "./apps-serve"

const pexec = promisify(execFile)
const HIVE_APPS_BLOQ = 736
const HIVE_APPS_RUNNING_LIST = 2735
const MAX_APP_BYTES = 5 * 1024 * 1024
const SKIP = new Set([".git", "__pycache__", ".venv", "venv", "node_modules", ".DS_Store"])

interface Runner {
  label: string
  local: boolean
  run(script: string, timeoutMs?: number): Promise<{ code: number; stdout: string; stderr: string }>
  push(localPath: string, remoteDir: string): Promise<{ ok: boolean; error?: string }>
}

/** Read an app folder: top-level files only in S1, text read for manifest + lint. */
export function readAppFolder(dir: string): { files: Record<string, string>; paths: string[]; bytes: number; error?: string } {
  const files: Record<string, string> = {}
  const paths: string[] = []
  let bytes = 0
  for (const entry of readdirSync(dir)) {
    if (SKIP.has(entry) || entry.startsWith(".")) continue
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      const nested = readdirSync(full).some((f) => f.endsWith(".py"))
      if (nested) return { files, paths, bytes, error: `${entry}/ holds Python files — S1 serves flat folders only (put the app's .py files at the top level)` }
      continue
    }
    bytes += st.size
    paths.push(full)
    if (/\.(py|json|txt|md|html|toml|cfg)$/i.test(entry)) files[entry] = readFileSync(full, "utf8")
  }
  if (bytes > MAX_APP_BYTES) return { files, paths, bytes, error: `the folder is ${(bytes / 1048576).toFixed(1)} MB — over the ${MAX_APP_BYTES / 1048576} MB limit for an app folder` }
  return { files, paths, bytes }
}

async function localRunner(): Promise<Runner> {
  return {
    label: "this machine",
    local: true,
    async run(script, timeoutMs = 120_000) {
      try {
        const { stdout, stderr } = await pexec("sh", ["-c", script], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
        return { code: 0, stdout, stderr }
      } catch (err: any) {
        return { code: typeof err?.code === "number" ? err.code : 1, stdout: String(err?.stdout ?? ""), stderr: String(err?.stderr ?? err?.message ?? "") }
      }
    },
    async push(localPath, remoteDir) {
      try {
        await pexec("sh", ["-c", `mkdir -p ${shq(remoteDir)} && cp ${shq(localPath)} ${shq(remoteDir)}/`])
        return { ok: true }
      } catch (err: any) {
        return { ok: false, error: String(err?.stderr ?? err?.message ?? err) }
      }
    },
  }
}

async function sshRunner(node: HiveNode, opts: { host?: string; user?: string }): Promise<Runner | { error: string }> {
  const resolved = await resolveSshTarget(node.id, node.name, { host: opts.host, user: opts.user, advertised: (node as any).tailscale_ip ?? null })
  if ("error" in resolved) return { error: resolved.error }
  const t = await ensureSshUser(node.id, resolved)
  if ("error" in t) return { error: t.error }
  const target = t as SshTarget
  return {
    label: node.name,
    local: false,
    async run(script, timeoutMs = 120_000) {
      const r = await sshRun(target, `sh -c ${shq(script)}`, timeoutMs)
      return { code: r.code ?? (r.ok ? 0 : 1), stdout: r.stdout ?? "", stderr: r.stderr ?? "" }
    },
    async push(localPath, remoteDir) {
      const r = await pushFile(target, localPath, remoteDir)
      return r.ok ? { ok: true } : { ok: false, error: (r as any).error ?? "transfer failed" }
    },
  }
}

/** The machine to use: --node, else this machine if it is a Hive node. */
async function pickRunner(userId: number, nodeArg: string | undefined, opts: { host?: string; user?: string }): Promise<{ runner: Runner; node: HiveNode | null } | { error: string }> {
  const nodes = await fetchNodes(userId)
  const localId = await detectLocalNodeId(nodes as any).catch(() => null)
  if (!nodeArg || nodeArg === "local") {
    const local = localId ? nodes.find((n) => n.id === localId) ?? null : null
    return { runner: await localRunner(), node: local }
  }
  const node = await resolveNode(userId, nodeArg)
  if (!node) return { error: `No Hive node matches "${nodeArg}". Run: iris hive nodes list` }
  if (node.id === localId) return { runner: await localRunner(), node }
  const r = await sshRunner(node, opts)
  if ("error" in r) return { error: r.error }
  return { runner: r, node }
}

export const ServeCommand = cmd({
  command: "serve <folder>",
  describe: "serve a Python app folder from one of your machines — locked-down container, restarts on crash and reboot, 127.0.0.1 only",
  builder: (yargs) =>
    yargs
      .positional("folder", { describe: "the app folder (iris.app.json or a script with # iris: lines)", type: "string", demandOption: true })
      .option("node", { describe: "Hive machine to serve it on (default: this machine)", type: "string" })
      .option("port", { describe: "port on the machine (127.0.0.1 only; default 18000)", type: "number", default: 18000 })
      .option("entry", { describe: "which .py file runs, when the folder has several and no iris.app.json", type: "string" })
      .option("replace", { describe: "replace the running copy of this app", type: "boolean", default: false })
      .option("dry-run", { describe: "show the manifest and the exact command, run nothing", type: "boolean", default: false })
      .option("wait", { describe: "seconds to wait for the health check", type: "number", default: 120 })
      .option("skip-record", { describe: "do not record it on the Hive Apps board", type: "boolean", default: false })
      .option("host", { describe: "ssh address of the node (skip Tailscale lookup)", type: "string" })
      .option("user", { describe: "ssh user on the node", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    const json = !!args.json
    const say = (l = "") => { if (!json) console.log(l) }
    const fail = async (code: number, error: string, extra: Record<string, unknown> = {}, hints: string[] = []) => {
      if (json) await writeJson({ ok: false, error, ...extra })
      else { prompts.log.error(error); for (const h of hints) console.log(h) }
      process.exitCode = code
    }

    const dir = resolve(String(args.folder))
    if (!existsSync(dir) || !statSync(dir).isDirectory()) return fail(2, `${dir} is not a folder`)
    const folder = readAppFolder(dir)
    if (folder.error) return fail(2, folder.error)
    const { manifest, errors, source } = resolveManifest(basename(dir), folder.files, args.entry as string | undefined)
    if (!manifest) return fail(2, `The app's manifest has problems (${source}):`, { errors }, errors.map((e) => `  · ${e}`))
    const port = Number(args.port)
    if (!Number.isInteger(port) || port < 1024 || port > 65535) return fail(2, `--port ${args.port} must be 1024–65535`)

    if (manifest.data_class === "phi") {
      return fail(2, "data_class: phi — apps that handle patient data are not servable in S1. They need a BAA-covered machine and access logging first (#189083).")
    }

    // The lint for SERVED apps (container rules) — errors stop the serve; warnings are shown.
    const lint = lintLocalApp(folder.files, { served: true })
    const lintErrors = lint.filter((f) => f.severity === "error" && f.rule !== "require-token" && f.rule !== "check-host")
    // A served app is reached only through 127.0.0.1 on the machine and (later) the authenticated
    // relay, so the browser-console rules (token, Host) are advice here, not blockers.

    if (!json) { UI.empty(); prompts.intro(`◈  IRIS Hive Apps — serve ${manifest.name}`) }
    say(`  ${bold("Manifest")} ${source}  ${dim(`${manifest.entry} · listens on ${manifest.port} · health ${manifest.health}`)}`)
    if (manifest.secrets.length) say(`  ${bold("Secrets")}  ${manifest.secrets.join(", ")}  ${dim("(names only — the values come from the machine's environment)")}`)
    if (manifest.egress.length) say(`  ${bold("Egress")}   ${manifest.egress.join(", ")}  ${dim("(declared; not yet enforced on the machine)")}`)
    for (const f of lint) say(`  ${f.severity === "error" ? "✗" : "!"} ${f.file}: ${f.message}`)
    if (lintErrors.length) return fail(2, `${lintErrors.length} problem(s) must be fixed before this is served`, { lint })

    await requireAuth()
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) { process.exitCode = 1; return }

    const picked = await pickRunner(userId, args.node as string | undefined, { host: args.host as string | undefined, user: args.user as string | undefined })
    if ("error" in picked) return fail(1, picked.error)
    const { runner, node } = picked

    // Where the folder lives on the machine — absolute, because docker -v needs it.
    const home = await runner.run(`mkdir -p "$HOME/.iris/apps/${manifest.name}" && cd "$HOME/.iris/apps/${manifest.name}" && pwd`)
    const remoteDir = home.stdout.trim().split(/\r?\n/).pop() ?? ""
    if (home.code !== 0 || !remoteDir.startsWith("/")) return fail(1, `Could not prepare the app folder on ${runner.label}: ${home.stderr || home.stdout}`)

    const script = buildServeScript({ manifest, remoteDir, hostPort: port, replace: !!args.replace })
    say(`  ${bold("Machine")}  ${runner.label}  ${dim(`${remoteDir} → 127.0.0.1:${port}`)}`)

    if (args["dry-run"]) {
      if (json) { await writeJson({ ok: true, dry_run: true, manifest, source, machine: runner.label, remote_dir: remoteDir, script, lint }); return }
      say(); say(bold("─── would run on the machine ───")); say(script)
      prompts.outro("Dry run — nothing copied, nothing run")
      return
    }

    // ── copy ──
    const spinner = json ? null : prompts.spinner()
    spinner?.start(`Copying ${folder.paths.length} file(s) to ${runner.label}…`)
    for (const p of folder.paths) {
      const r = await runner.push(p, remoteDir)
      if (!r.ok) { spinner?.stop("Copy failed", 1); return fail(1, `Copying ${basename(p)} failed: ${r.error}`) }
    }
    spinner?.stop(`Copied ${folder.paths.length} file(s)${runner.local ? "" : " — sha256-verified on the machine"}`)

    // ── run ──
    spinner?.start(`Starting ${servedContainerName(manifest.name)}…`)
    const run = await runner.run(script, 300_000)
    if (run.code !== 0) {
      spinner?.stop("Did not start", 1)
      const out = `${run.stdout}\n${run.stderr}`.trim()
      const hints: string[] = []
      if (run.code === SERVE_EXIT.NO_DOCKER) hints.push(`  ${runner.label} has no Docker. Install Docker Desktop (Mac/Windows) or docker (Linux), then run this again.`)
      if (run.code === SERVE_EXIT.EXISTS) hints.push(`  Already served there. Replace it: --replace    Or serve a copy under another name in ${MANIFEST_FILE}.`)
      if (/port is already allocated|address already in use/i.test(out)) hints.push(`  Port ${port} is taken on ${runner.label} — pick another with --port.`)
      return fail(run.code === SERVE_EXIT.NO_DOCKER ? 3 : 1, `Serving ${manifest.name} on ${runner.label} failed (exit ${run.code}).`, { output: out }, [dim(out.split("\n").slice(-12).map((l) => `  ${l}`).join("\n")), ...hints])
    }
    spinner?.stop(`Started on ${runner.label}`)

    // ── health ──
    const waitSec = Math.max(10, Math.min(600, Number(args.wait) || 120))
    spinner?.start(`Waiting for ${manifest.health} to answer (up to ${waitSec}s)…`)
    const health = await runner.run(buildHealthScript(port, manifest.health, waitSec), (waitSec + 30) * 1000)
    const ready = /READY http=(\d+) after (\d+)s/.exec(health.stdout)
    if (!ready) {
      spinner?.stop("Started, but it does not answer", 1)
      return fail(1, `${manifest.name} started but ${manifest.health} did not answer within ${waitSec}s.`, { health: health.stdout.trim() }, [
        dim(`  Logs: iris hive run ${node?.name ?? "<node>"} "docker logs --tail 50 ${servedContainerName(manifest.name)}"`),
        dim(`  Inside the container the app must listen on 0.0.0.0:$PORT (PORT=${manifest.port}). The machine still exposes only 127.0.0.1:${port}.`),
      ])
    }
    spinner?.stop(`Healthy — HTTP ${ready[1]} after ${ready[2]}s`)

    // ── record ──
    let recordId: number | null = null
    if (!args["skip-record"]) {
      try {
        const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${HIVE_APPS_BLOQ}/items`, {
          method: "POST",
          body: JSON.stringify({
            title: `${manifest.name} — served on ${runner.label} · 127.0.0.1:${port}`.slice(0, 191),
            content: [`Served ${new Date().toISOString().slice(0, 16)}Z by iris app serve.`, `Machine: ${runner.label}`, `Container: ${servedContainerName(manifest.name)}`,
              `Local: http://127.0.0.1:${port}${manifest.health} (HTTP ${ready[1]})`, `Manifest: ${source}`, `Data class: ${manifest.data_class}`,
              `Stop: iris hive run ${node?.name ?? "<node>"} "docker rm -f ${servedContainerName(manifest.name)}"`].join("\n"),
            list_id: HIVE_APPS_RUNNING_LIST,
            type: "default",
          }),
        })
        if (res.ok) {
          const b = (await res.json().catch(() => null)) as any
          recordId = Number(b?.data?.id ?? b?.id) || null
        }
      } catch {}
    }

    if (json) {
      await writeJson({ ok: true, app: manifest.name, machine: runner.label, container: servedContainerName(manifest.name), local: `http://127.0.0.1:${port}`, health_http: Number(ready[1]), record_item_id: recordId })
      return
    }
    printDivider()
    printKV("Serving", `${manifest.name} on ${runner.label}`)
    printKV("Local", `http://127.0.0.1:${port}  (that machine only)`)
    printKV("Survives", "crashes and reboots (docker restart policy)")
    printKV("See it", "iris app list --hive")
    if (recordId) printKV("Recorded", `bloq #${HIVE_APPS_BLOQ} item #${recordId}`)
    printDivider()
    say(dim("  Reaching it from elsewhere goes through an authenticated <name>.t.heyiris.io address — not live yet (#189081)."))
    prompts.outro(success("Done"))
  },
})

/** Ask every online node (and this machine) what it serves. The machines are the registry. */
export async function listHiveApps(userId: number, opts: { node?: string } = {}): Promise<Array<{ machine: string; apps: ServedApp[]; error?: string; noDocker?: boolean }>> {
  const nodes = await fetchNodes(userId)
  const localId = await detectLocalNodeId(nodes as any).catch(() => null)
  const targets = opts.node
    ? nodes.filter((n) => n.name === opts.node || n.id.startsWith(opts.node!))
    : nodes.filter((n) => n.connection_status === "online" || n.id === localId)
  const out: Array<{ machine: string; apps: ServedApp[]; error?: string; noDocker?: boolean }> = []
  await Promise.all(targets.map(async (n) => {
    const r = n.id === localId ? await localRunner() : await sshRunner(n, {})
    if ("error" in r) { out.push({ machine: n.name, apps: [], error: r.error }); return }
    const res = await r.run(buildListScript(), 30_000)
    const parsed = parseListOutput(res.stdout)
    out.push({ machine: n.name, apps: parsed.apps, noDocker: parsed.noDocker, error: res.code !== 0 ? (res.stderr || `exit ${res.code}`).trim().slice(0, 200) : undefined })
  }))
  if (!localId && !opts.node) {
    const r = await localRunner()
    const res = await r.run(buildListScript(), 30_000)
    const parsed = parseListOutput(res.stdout)
    if (parsed.apps.length) out.push({ machine: "this machine (not a Hive node)", apps: parsed.apps })
  }
  return out.sort((a, b) => a.machine.localeCompare(b.machine))
}

export function printHiveApps(rows: Awaited<ReturnType<typeof listHiveApps>>): void {
  console.log(bold("  Running on your machines"))
  if (!rows.length) { console.log(dim("    No online Hive machines.")); return }
  for (const r of rows) {
    console.log(`  ${bold(r.machine)}`)
    if (r.error) { console.log(dim(`    could not ask it: ${r.error}`)); continue }
    if (r.noDocker) { console.log(dim("    no Docker on this machine")); continue }
    if (!r.apps.length) { console.log(dim("    nothing served")); continue }
    for (const a of r.apps) {
      const mark = a.healthy ? success("●") : a.state === "running" ? "◐" : "○"
      console.log(`    ${mark} ${a.app.padEnd(22)} ${dim(a.kind.padEnd(7))} ${a.port ? `127.0.0.1:${a.port}`.padEnd(17) : "".padEnd(17)} ${dim(a.state === "running" ? `HTTP ${a.http} · ${a.status}` : a.status)}`)
    }
  }
}

export const LintCommand = cmd({
  command: "lint [folder]",
  describe: "check an app folder for the holes a local console must not have (token, Host check, shell, bind address)",
  builder: (yargs) =>
    yargs
      .positional("folder", { describe: "app folder (default: current)", type: "string", default: "." })
      .option("served", { describe: "judge it as a served (container) app instead of a desktop console", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const dir = resolve(String(args.folder))
    const folder = readAppFolder(dir)
    const findings = lintLocalApp(folder.files, { served: !!args.served })
    const errors = findings.filter((f) => f.severity === "error").length
    if (args.json) { await writeJson({ ok: errors === 0, findings }); if (errors) process.exitCode = 1; return }
    if (!findings.length) { console.log(`  ${success("✓")} ${dir}: no findings`); return }
    for (const f of findings) console.log(`  ${f.severity === "error" ? "✗" : "!"} ${bold(f.file)} ${dim(`[${f.rule}]`)} ${f.message}`)
    console.log()
    console.log(`  ${errors} error(s), ${findings.length - errors} warning(s). The safe starting point: iris app create <name> --template local-console`)
    if (errors) process.exitCode = 1
  },
})
