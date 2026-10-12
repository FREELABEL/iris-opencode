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
import { chooseRuntime } from "./apps-native"
import { findUv, hasDockerHere, installUv, listNativeHere, portInUse, serveNative, uvInstallCommand, waitHealthy } from "./platform-app-native"

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
  describe: "serve a Python app folder from one of your machines — restarts on crash and at login, 127.0.0.1 only; no Docker needed (native) or container-isolated (docker)",
  builder: (yargs) =>
    yargs
      .positional("folder", { describe: "the app folder (iris.app.json or a script with # iris: lines)", type: "string", demandOption: true })
      .option("node", { describe: "Hive machine to serve it on (default: this machine)", type: "string" })
      .option("runtime", { describe: "auto (Docker if installed, else native) · native (no Docker: uv + the OS supervisor) · docker (container isolation)", type: "string", default: "auto" })
      .option("install-uv", { describe: "native: install uv (the Python runtime manager) if it is missing", type: "boolean", default: false })
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

    // Native runs on THIS machine in S1 (Windows has no sh to drive over ssh); docker may be remote.
    const remote = !!args.node && args.node !== "local"
    const dockerHere = remote ? true : await hasDockerHere()
    const choice = chooseRuntime(args.runtime as string | undefined, dockerHere, manifest.data_class)
    if ("error" in choice) return fail(2, choice.error)
    if (manifest.data_class === "phi") {
      return fail(2, "data_class: phi — apps that handle patient data are not servable in S1. They need a BAA-covered machine and access logging first (#189083).")
    }
    if (choice.runtime === "native" && remote) {
      return fail(2, "--runtime native serves on THIS machine. Run iris app serve on the machine itself (remote native comes next).")
    }
    if (choice.runtime === "native") return serveNativeHere(args, manifest, source, folder, json, say, fail)

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
  // Native apps on this machine have no container — they are read from their own records.
  const native = await listNativeHere().catch(() => [])
  if (native.length) {
    const nativeRows: ServedApp[] = native.map((n) => ({ container: `native:${n.name}`, app: n.name, kind: "native", port: n.port, state: n.healthy ? "running" : "registered", status: `${n.supervisor} · since ${n.served_at.slice(0, 10)}`, http: n.http === null ? "000" : String(n.http), ports: `127.0.0.1:${n.port}`, healthy: n.healthy }))
    const mine = out.find((r) => localId && nodes.find((n) => n.id === localId)?.name === r.machine)
    if (mine) mine.apps.push(...nativeRows)
    else out.push({ machine: "this machine", apps: nativeRows })
  }
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

/** --runtime native on this machine: uv + the OS supervisor, no Docker (Windows, macOS, Linux). */
async function serveNativeHere(
  args: any,
  manifest: import("./apps-serve").AppManifest,
  source: string,
  folder: ReturnType<typeof readAppFolder>,
  json: boolean,
  say: (l?: string) => void,
  fail: (code: number, error: string, extra?: Record<string, unknown>, hints?: string[]) => Promise<void>,
): Promise<void> {
  const port = Number(args.port)
  // Desktop rules: it shares a machine (and a browser) with the person. 0.0.0.0 is an error;
  // token/Host are warnings — an API called by local programs may not want a browser token.
  const lint = lintLocalApp(folder.files, { served: false })
  const blocking = lint.filter((f) => f.severity === "error" && f.rule !== "require-token" && f.rule !== "check-host")

  if (!json) { UI.empty(); prompts.intro(`◈  IRIS Hive Apps — serve ${manifest.name} (native, no Docker)`) }
  say(`  ${bold("Manifest")} ${source}  ${dim(`${manifest.entry} · health ${manifest.health}`)}`)
  say(`  ${bold("Runs as")}  you, on this machine — without your IRIS login or shell credentials`)
  if (manifest.secrets.length) say(`  ${bold("Secrets")}  ${manifest.secrets.join(", ")}  ${dim("(stored for this app, owner-only)")}`)
  for (const f of lint) say(`  ${f.severity === "error" && blocking.includes(f) ? "✗" : "!"} ${f.file}: ${f.message}`)
  if (blocking.length) return fail(2, `${blocking.length} problem(s) must be fixed before this is served`, { lint }, [dim("  Listen on os.environ['HOST'] (127.0.0.1) and os.environ['PORT'] — the launcher sets both.")])

  let uv = await findUv()
  if (!uv) {
    const c = uvInstallCommand()
    if (!args["install-uv"]) return fail(3, "uv (the Python runtime manager) is not installed.", {}, [`  Install it once:  ${c.display}`, `  Or let IRIS do it: iris app serve ${args.folder} --install-uv`])
    say(dim(`  installing uv: ${c.display}`))
    const r = await installUv()
    uv = r.ok ? await findUv() : null
    if (!uv) return fail(3, "uv did not install.", { output: r.out.slice(-600) }, [dim(r.out.trim().split("\n").slice(-6).map((l) => `  ${l}`).join("\n"))])
  }
  say(`  ${bold("Python")}   uv ${dim(uv)}`)

  if (args["dry-run"]) {
    if (json) { await writeJson({ ok: true, dry_run: true, runtime: "native", manifest, uv, port }); return }
    prompts.outro("Dry run — nothing written, nothing started")
    return
  }

  // The port must be free — unless --replace is re-serving the SAME app on the same port.
  {
    const { homedir } = await import("os")
    let ownPort: number | null = null
    try { ownPort = Number(JSON.parse(readFileSync(join(homedir(), ".iris", "apps", manifest.name, "app.json"), "utf8")).port) || null } catch {}
    if (await portInUse(port) && !(args.replace && ownPort === port)) {
      return fail(2, `Port ${port} is already in use on this machine — another app answers there, so a health check would pass for the wrong app. Pick another: --port <n>`)
    }
  }

  const spinner = json ? null : prompts.spinner()
  spinner?.start("Installing it as a background service…")
  const res = await serveNative({ manifest, folder: resolve(String(args.folder)), filePaths: folder.paths, hostPort: port, uv, replace: !!args.replace })
  if (!res.ok) { spinner?.stop("Not started", 1); return fail(res.exists ? 4 : 1, res.error ?? "failed", {}, res.hint ? [`  ${res.hint}`] : []) }
  spinner?.stop(`Handed to ${res.supervisor}`)

  const waitSec = Math.max(10, Math.min(600, Number(args.wait) || 120))
  spinner?.start(`Waiting for ${manifest.health} (first start downloads Python — up to ${waitSec}s)…`)
  const h = await waitHealthy(port, manifest.health, waitSec)
  if (!h.ready) {
    spinner?.stop("Started, but it does not answer", 1)
    // Say WHY (the app's own last words) and how to undo it — a crash-looping service left behind
    // silently was the stress test's finding.
    let tail = ""
    try { tail = readFileSync(res.logs ?? "", "utf8").trim().split(/\r?\n/).slice(-12).join("\n") } catch {}
    return fail(1, `${manifest.name} is registered with ${res.supervisor} but ${manifest.health} did not answer within ${waitSec}s (last HTTP ${h.http ?? "none"}). It will keep restarting until you stop it.`, { logs: res.logs, log_tail: tail },
      [tail ? dim(tail.split("\n").map((l) => `  │ ${l}`).join("\n")) : dim(`  Log: ${res.logs} (empty)`), `  Stop it:  iris app stop ${manifest.name}`, dim(`  Log: ${res.logs}`)])
  }
  spinner?.stop(`Healthy — HTTP ${h.http} after ${h.afterSec}s`)

  if (json) { await writeJson({ ok: true, runtime: "native", app: manifest.name, supervisor: res.supervisor, local: `http://127.0.0.1:${port}`, health_http: h.http, home: res.home, logs: res.logs }); return }
  printDivider()
  printKV("Serving", `${manifest.name} on this machine (native)`)
  printKV("Local", `http://127.0.0.1:${port}  (this machine only)`)
  printKV("Survives", `crashes and restarts at login (${res.supervisor})`)
  printKV("Logs", res.logs ?? "")
  printKV("See it", "iris app list --hive")
  printDivider()
  prompts.outro(success("Done"))
}

export const StopCommand = cmd({
  command: "stop <name>",
  describe: "stop a served app and unregister it (native: the OS service; docker: the container) — its folder is kept unless --purge",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "the app name (iris app list --hive)", type: "string", demandOption: true })
      .option("node", { describe: "docker apps on another Hive machine", type: "string" })
      .option("purge", { describe: "also delete the app's folder, logs and stored secrets", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    const name = String(args.name)
    if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(name)) { prompts.log.error(`"${name}" is not an app name`); process.exitCode = 2; return }
    const done: string[] = []
    const { stopNative } = await import("./platform-app-native")
    const { homedir } = await import("os")
    const { rmSync } = await import("fs")
    const home = join(homedir(), ".iris", "apps", name)
    const nativeRecord = join(home, "app.json")
    if (!args.node && existsSync(nativeRecord)) {
      await stopNative(name)
      const { platform } = await import("os")
      if (platform() === "linux") { try { rmSync(join(homedir(), ".config", "systemd", "user", `iris-app-${name}.service`), { force: true }) } catch {} }
      if (platform() === "darwin") { try { rmSync(join(homedir(), "Library", "LaunchAgents", `io.heyiris.app.${name}.plist`), { force: true }) } catch {} }
      rmSync(nativeRecord, { force: true })
      done.push("native service stopped and unregistered")
    }
    // Docker: here, or on --node over ssh.
    let runner: Runner | null = null
    if (args.node) {
      await requireAuth()
      const userId = await requireUserId(args["user-id"] as number | undefined)
      if (!userId) { process.exitCode = 1; return }
      const picked = await pickRunner(userId, String(args.node), {})
      if ("error" in picked) { prompts.log.error(picked.error); process.exitCode = 1; return }
      runner = picked.runner
    } else runner = await localRunner()
    // inspect first: `docker rm -f` exits 0 for a container that never existed, which made stop
    // claim to remove things that were not there.
    const c = shq(servedContainerName(name))
    const r = await runner.run(`command -v docker >/dev/null 2>&1 || exit 0; if docker inspect ${c} >/dev/null 2>&1; then docker rm -f ${c} >/dev/null && echo REMOVED; fi`, 60_000)
    if (/REMOVED/.test(r.stdout)) done.push(`container ${servedContainerName(name)} removed`)
    if (args.purge && !args.node && existsSync(home)) { rmSync(home, { recursive: true, force: true }); done.push(`deleted ${home}`) }
    if (args.json) { await writeJson({ ok: done.length > 0, app: name, done }); if (!done.length) process.exitCode = 1; return }
    if (!done.length) { prompts.log.warn(`Nothing named ${name} is served ${args.node ? `on ${args.node}` : "on this machine"}.`); process.exitCode = 1; return }
    for (const d of done) console.log(`  ${success("✓")} ${d}`)
  },
})
