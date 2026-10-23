import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  highlight,
  promptOrFail,
  MissingFlagError,
  isNonInteractive, writeJson } from "./iris-api"
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
} from "fs"
import { join, resolve, basename, relative } from "path"
import { fetchDatasetRecords } from "./platform-atlas-datasets"
import { dispatchTaskAndWait, fetchNodes, resolveNode, type HiveNode } from "./platform-hive-nodes"
import { buildTaskPayload } from "./hive-task-create"
import { describeUptime } from "./hive-uptime"
import { exitCodeForResult, fromHiveTask, type HiveTaskLike } from "./hive-script-result"
import {
  RUN_EXIT,
  buildRunScript,
  buildVerifyScript,
  containerName,
  kitSlug,
  matchKits,
  noKitAdvice,
  parsePort,
  parseVerifyOutput,
  reachHint,
  recordText,
  recordTitle,
  runnableReason,
  safeInstanceName,
  stopCommand,
  type Kit,
} from "./apps-kits"

// ============================================================================
// Templates (basic / react / vue)
// ============================================================================

const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".iris",
  "__pycache__",
  ".venv",
  "vendor",
  "dist",
  "build",
])

function basicTemplate(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <script src="https://cdn.heyiris.io/iris-bridge.js"></script>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; margin: 0; padding: 20px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; color: white; }
    .container { max-width: 800px; margin: 0 auto; text-align: center; }
    h1 { font-size: 3rem; margin-bottom: 0.5rem; }
    p { font-size: 1.2rem; opacity: 0.9; }
    .card { background: rgba(255,255,255,0.1); backdrop-filter: blur(10px); border-radius: 12px; padding: 20px; margin-top: 30px; }
    pre { text-align: left; background: rgba(0,0,0,0.2); padding: 15px; border-radius: 8px; overflow-x: auto; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Hello from ${name}!</h1>
    <p>Built with IRIS</p>
    <div class="card">
      <h3>IRIS Context</h3>
      <pre id="context">Loading...</pre>
    </div>
  </div>
  <script>
    window.iris?.getContext().then(ctx => {
      document.getElementById('context').textContent = JSON.stringify(ctx, null, 2);
    }).catch(() => {
      document.getElementById('context').textContent = 'No IRIS context available';
    });
  </script>
</body>
</html>
`
}

function reactTemplate(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <script src="https://unpkg.com/react@18/umd/react.development.js"></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.development.js"></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <script src="https://cdn.heyiris.io/iris-bridge.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
    .app { max-width: 800px; margin: 0 auto; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    function App() {
      const [context, setContext] = React.useState(null);
      React.useEffect(() => {
        window.iris?.getContext().then(setContext);
      }, []);
      return (
        <div className="app">
          <h1>Hello from ${name}!</h1>
          <p>Built with IRIS + React</p>
          {context && <pre>{JSON.stringify(context, null, 2)}</pre>}
        </div>
      );
    }
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>
`
}

function vueTemplate(name: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${name}</title>
  <script src="https://unpkg.com/vue@3/dist/vue.global.js"></script>
  <script src="https://cdn.heyiris.io/iris-bridge.js"></script>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 20px; }
    .app { max-width: 800px; margin: 0 auto; }
  </style>
</head>
<body>
  <div id="app">
    <h1>Hello from ${name}!</h1>
    <p>Built with IRIS + Vue</p>
    <pre v-if="context">{{ JSON.stringify(context, null, 2) }}</pre>
  </div>
  <script>
    const { createApp, ref, onMounted } = Vue;
    createApp({
      setup() {
        const context = ref(null);
        onMounted(async () => {
          if (window.iris) {
            context.value = await window.iris.getContext();
          }
        });
        return { context };
      }
    }).mount('#app');
  </script>
</body>
</html>
`
}

function readmeTemplate(name: string, template: string): string {
  const framework = template === "react" ? " + React" : template === "vue" ? " + Vue" : ""
  return `# ${name}

An IRIS-hosted web app${framework}.

## Development

Open \`index.html\` in your browser to preview.

## Deployment

Deploy to IRIS with:

\`\`\`bash
iris app deploy
\`\`\`

Your app will be available at \`https://apps.heyiris.io/{app-id}/\`

## IRIS Bridge

This app includes the IRIS bridge script for context sharing:
- \`window.iris.getContext()\` - Get app context from IRIS
- \`window.iris.sendMessage(msg)\` - Send messages to IRIS agent
`
}

function getTemplate(name: string, template: string): string {
  switch (template) {
    case "react":
      return reactTemplate(name)
    case "vue":
      return vueTemplate(name)
    default:
      return basicTemplate(name)
  }
}

// ============================================================================
// File collection (mirrors PHP collectFiles)
// ============================================================================

function collectFiles(dir: string): Record<string, Buffer> {
  const out: Record<string, Buffer> = {}
  const root = resolve(dir)

  function walk(current: string) {
    const entries = readdirSync(current, { withFileTypes: true })
    for (const entry of entries) {
      if (SKIP_DIRS.has(entry.name)) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        walk(full)
      } else if (entry.isFile()) {
        const rel = relative(root, full)
        try {
          out[rel] = readFileSync(full)
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(root)
  return out
}

// ============================================================================
// IRIS Hive Apps — `iris apps create "<need>" --node <node>` (EPIC #188312)
//
// Matches a kit from the public `hive-app-kits` dataset, runs it on one of the person's own
// Hive machines (127.0.0.1 only), proves it answers, and records it on bloq #736. Every
// decision that needs no network lives in apps-kits.ts, with its tests.
// ============================================================================

const HIVE_APPS_BLOQ = 736
const HIVE_APPS_RUNNING_LIST = 2735 // "In Progress" — what is running where
const HIVE_APP_KITS_SCHEMA = "hive-app-kits"
const DEFAULT_HIVE_APP_PORT = 8090

interface HiveAppArgs {
  name: string
  node?: string
  kit?: string
  port?: number
  as?: string
  replace?: boolean
  "dry-run"?: boolean
  wait?: number
  "skip-record"?: boolean
  json?: boolean
  "user-id"?: number
}

/**
 * Hive-app mode when any Hive flag is given, or when the "name" is a sentence. A bare
 * one-word name with no flags keeps meaning what it always meant: scaffold a directory.
 */
function isHiveAppRequest(args: Record<string, unknown>, name: string): boolean {
  if (/\s/.test(name.trim())) return true
  return ["node", "kit", "port", "as"].some((k) => args[k] !== undefined && args[k] !== "") ||
    args.replace === true || args["dry-run"] === true
}

async function createHiveApp(args: HiveAppArgs): Promise<void> {
  const need = String(args.name).trim()
  const json = !!args.json
  const say = (line = "") => { if (!json) console.log(line) }
  const fail = async (code: number, error: string, extra: Record<string, unknown> = {}, lines: string[] = []) => {
    if (json) await writeJson({ ok: false, error, ...extra })
    else {
      prompts.log.error(error)
      for (const l of lines) console.log(l)
    }
    process.exitCode = code
  }

  await requireAuth()
  const userId = await requireUserId(args["user-id"])
  if (!userId) { process.exitCode = 1; return }

  if (!json) { UI.empty(); prompts.intro(`◈  IRIS Hive Apps — ${need}`) }

  // ── match ────────────────────────────────────────────────────────────
  let kits: Kit[]
  try {
    const { records } = await fetchDatasetRecords(HIVE_APP_KITS_SCHEMA, { limit: 200, all: true })
    kits = records.map((r: any) => ({ external_id: r.external_id ?? undefined, ...(r.data ?? r) }))
  } catch (err) {
    return fail(1, `Could not read the kit catalogue (dataset ${HIVE_APP_KITS_SCHEMA}): ${err instanceof Error ? err.message : String(err)}`)
  }

  const matches = matchKits(need, kits, args.kit)
  if (matches.length === 0) {
    const lines = args.kit
      ? [`No kit is named "${args.kit}". Kits: ${kits.map((k) => k.name).join(", ")}`]
      : noKitAdvice(need, kits)
    if (json) {
      await writeJson({ ok: false, error: "no_kit", need, advice: lines })
      process.exitCode = 2
      return
    }
    for (const l of lines) console.log(`  ${l}`)
    prompts.outro("No kit — nothing was run")
    process.exitCode = 2
    return
  }

  const best = matches[0]!
  say(`  ${bold("Kit")}      ${best.kit.name}  ${dim(`matched: ${best.matched.join(", ")}`)}`)
  say(`  ${dim("replaces")} ${best.kit.replaces ?? "?"}`)
  say(`  ${dim("licence")}  ${best.kit.licence ?? "unknown"}`)
  if (matches.length > 1) say(`  ${dim("also:")}    ${matches.slice(1, 4).map((m) => m.kit.name).join(", ")}  ${dim("(pick one with --kit)")}`)

  const runnable = runnableReason(best.kit)
  if (!runnable.ok) {
    // Do NOT fall through to a lower-ranked kit that happens to be runnable — that would be
    // running the wrong app for the job. Say why and stop.
    return fail(1, `Not a one-command kit: ${runnable.reason}`, { kit: best.kit.name }, [
      dim(`  File it: iris bloqs add-item ${HIVE_APPS_BLOQ} 2734 --title "Make ${best.kit.name} a one-command kit"`),
    ])
  }

  const instance = safeInstanceName(args.as ?? kitSlug(best.kit))
  if (!instance) return fail(2, `--as "${args.as}" is not a usable name (lowercase letters, digits, - _ . only)`)
  const container = containerName(instance)
  const hostPort = parsePort(args.port ?? DEFAULT_HIVE_APP_PORT)
  if (!hostPort) return fail(2, `--port ${args.port} must be a whole number from 1024 to 65535`)

  // ── node ─────────────────────────────────────────────────────────────
  let node: HiveNode | null = null
  if (args.node) {
    node = await resolveNode(userId, args.node)
    if (!node) return fail(1, `No Hive node matches "${args.node}". Run: iris hive nodes list`)
  } else {
    const nodes = await fetchNodes(userId)
    // Online, has a container runtime, and is not crash-looping — a looping node accepts the
    // task and then hangs it to its timeout, which reads as "the app is slow".
    node = nodes.find((n) =>
      n.connection_status === "online" &&
      (n as any).permissions?.isolation?.available === true &&
      describeUptime(n as any, Date.now()).kind !== "looping",
    ) ?? null
    if (!node) return fail(1, "No online, stable Hive machine with a container sandbox. Bring one up (iris hive connect) or name one with --node.")
  }
  if (node.connection_status !== "online") {
    return fail(1, `Node "${node.name}" is ${node.connection_status} — it cannot run anything right now.`)
  }
  if (describeUptime(node as any, Date.now()).kind === "looping") {
    say(`  ${dim(`warning: ${node.name} is crash-looping — the run may hang to its timeout`)}`)
  }

  const runScript = buildRunScript({
    container,
    image: runnable.image,
    hostPort,
    containerPort: runnable.port,
    slug: kitSlug(best.kit),
    replace: !!args.replace,
  })
  const waitSec = Math.max(10, Math.min(900, Number(args.wait) || 120))
  const verifyScript = buildVerifyScript(hostPort, waitSec)

  say(`  ${bold("Machine")}  ${node.name}  ${dim(node.id.slice(0, 8))}`)
  say(`  ${bold("Runs as")}  ${container}  ${dim(`${runnable.image} → 127.0.0.1:${hostPort} (local only)`)}`)

  if (args["dry-run"]) {
    const plan = {
      ok: true,
      dry_run: true,
      need,
      kit: best.kit.name,
      matched: best.matched,
      node: node.name,
      node_id: node.id,
      container,
      image: runnable.image,
      bind: `127.0.0.1:${hostPort}`,
      container_port: runnable.port,
      run_script: runScript,
      verify_script: verifyScript,
      record: args["skip-record"] ? null : { bloq: HIVE_APPS_BLOQ, list: HIVE_APPS_RUNNING_LIST, title: recordTitle(best.kit, node.name, hostPort, need) },
    }
    if (json) { await writeJson(plan); return }
    say()
    say(bold("─── would run on the node ───"))
    say(runScript)
    say(bold("─── then verify (on the node) ───"))
    say(verifyScript)
    say()
    say(dim(args["skip-record"] ? "  Would not record (--skip-record)." : `  Then record it on bloq #${HIVE_APPS_BLOQ}: "${plan.record!.title}"`))
    prompts.outro("Dry run — nothing was run")
    return
  }

  // ── run ──────────────────────────────────────────────────────────────
  const spinner = json ? null : prompts.spinner()
  spinner?.start(`Starting ${best.kit.name} on ${node.name}…`)
  let runTask: { taskId: string; final: Record<string, unknown> | null }
  try {
    runTask = await dispatchTaskAndWait(userId, buildTaskPayload({
      userId, type: "shell", nodeId: node.id, prompt: runScript, title: `Hive App: ${instance}`, config: {}, timeoutSec: 900,
    }))
  } catch (err) {
    spinner?.stop("Failed", 1)
    return fail(1, err instanceof Error ? err.message : String(err))
  }
  const runResult = fromHiveTask(runTask.final as HiveTaskLike)
  const runOut = `${runResult.stdout ?? ""}${runResult.stderr ? `\n${runResult.stderr}` : ""}`.trim()
  const runCode = runTask.final ? exitCodeForResult(runResult) : 124
  if (runCode !== 0) {
    spinner?.stop("Did not start", 1)
    const hints: string[] = []
    if (runCode === RUN_EXIT.EXISTS) {
      hints.push(`  It may already be running — check it: iris hive run ${node.name} "docker ps --filter name=${container}"`)
      hints.push(`  Run a second copy: --as ${instance}-2 --port ${hostPort + 1}    Replace it: --replace`)
    } else if (/port is already allocated|address already in use/i.test(runOut)) {
      hints.push(`  Port ${hostPort} is taken on ${node.name} — pick another with --port.`)
    } else if (!runTask.final) {
      hints.push(`  Still running at the time limit — read it: iris hive tasks get ${runTask.taskId}`)
    }
    return fail(runCode === 124 ? 124 : 1, `Starting ${best.kit.name} on ${node.name} failed (exit ${runCode}).`,
      { task_id: runTask.taskId, output: runOut }, [runOut ? dim(runOut.split("\n").slice(-15).map((l) => `  ${l}`).join("\n")) : "", ...hints])
  }
  spinner?.stop(`Started ${container} on ${node.name}`)

  // ── verify ───────────────────────────────────────────────────────────
  spinner?.start(`Waiting for it to answer on 127.0.0.1:${hostPort} (up to ${waitSec}s)…`)
  let verifyTask: { taskId: string; final: Record<string, unknown> | null }
  try {
    verifyTask = await dispatchTaskAndWait(userId, buildTaskPayload({
      userId, type: "shell", nodeId: node.id, prompt: verifyScript, title: `Hive App: verify ${instance}`, config: {}, timeoutSec: waitSec + 30,
    }))
  } catch (err) {
    spinner?.stop("Could not verify", 1)
    return fail(1, err instanceof Error ? err.message : String(err), { container, node: node.name })
  }
  const verifyOut = String(fromHiveTask(verifyTask.final as HiveTaskLike).stdout ?? "")
  const verdict = parseVerifyOutput(verifyOut)
  if (!verdict.ready) {
    spinner?.stop("Started, but it does not answer", 1)
    // Started is not working. Leave it in place (it may be slow) but say how to remove it.
    return fail(1, `${best.kit.name} started on ${node.name} but did not answer on 127.0.0.1:${hostPort} within ${waitSec}s (last HTTP ${verdict.http ?? "none"}).`,
      { container, node: node.name, verify_output: verifyOut.trim() },
      [dim(`  Logs:   iris hive run ${node.name} "docker logs --tail 50 ${container}"`), dim(`  Remove: ${stopCommand(node.name, container)}`)])
  }
  const verifiedText = `HTTP ${verdict.http} from 127.0.0.1:${hostPort}/ on ${node.name} after ${verdict.afterSec}s`
  spinner?.stop(`It answers — ${verifiedText}`)

  // ── record ───────────────────────────────────────────────────────────
  let recordId: number | null = null
  let recordError: string | null = null
  if (!args["skip-record"]) {
    try {
      const res = await irisFetch(`/api/v1/user/${userId}/bloqs/${HIVE_APPS_BLOQ}/items`, {
        method: "POST",
        body: JSON.stringify({
          title: recordTitle(best.kit, node.name, hostPort, need),
          content: recordText(best.kit, node.name, hostPort, container, new Date().toISOString().slice(0, 16) + "Z", verifiedText),
          list_id: HIVE_APPS_RUNNING_LIST,
          type: "default",
        }),
      })
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { data?: any; id?: any } | null
        recordId = Number(body?.data?.id ?? body?.data?.data?.id ?? body?.id) || null
      } else recordError = `HTTP ${res.status}`
    } catch (err) {
      recordError = err instanceof Error ? err.message : String(err)
    }
  }

  if (json) {
    await writeJson({
      ok: true, need, kit: best.kit.name, node: node.name, node_id: node.id, container,
      bind: `127.0.0.1:${hostPort}`, verified: { http: verdict.http, after_sec: verdict.afterSec },
      record_item_id: recordId, record_error: recordError,
      run_task_id: runTask.taskId, verify_task_id: verifyTask.taskId,
      stop: stopCommand(node.name, container),
    })
    return
  }
  printDivider()
  printKV("Running", `${best.kit.name} on ${node.name}`)
  printKV("Local", `http://127.0.0.1:${hostPort}  (on ${node.name} only)`)
  printKV("Reach it", reachHint(node.name, hostPort))
  printKV("Stop it", stopCommand(node.name, container))
  if (recordId) printKV("Recorded", `bloq #${HIVE_APPS_BLOQ} item #${recordId}`)
  else if (recordError) printKV("Recorded", `NO — ${recordError} (it is running; add it by hand)`)
  printDivider()
  console.log(dim("  Exposing it to other people (Tailscale serve, a domain) is a separate, deliberate step — several kits have no login."))
  prompts.outro("Done")
}

// ============================================================================
// Subcommands
// ============================================================================

const CreateCommand = cmd({
  command: "create <name>",
  describe:
    'run an app you own on a Hive machine instead of paying for one — `iris apps create "edit and merge PDFs" --node <node>` (IRIS Hive Apps). A single-word name with no Hive flags scaffolds an IRIS-hosted app directory instead',
  builder: (yargs) =>
    yargs
      .positional("name", {
        describe: 'the job in plain words ("edit and merge PDFs") — or, for a scaffold, the app directory name',
        type: "string",
        demandOption: true,
      })
      .option("node", { describe: "Hive machine to run it on (default: first online node with a container sandbox)", type: "string" })
      .option("kit", { describe: "skip matching and use this kit by name (e.g. Stirling-PDF)", type: "string" })
      .option("port", { describe: "port on the machine; the app binds to 127.0.0.1 only", type: "number" })
      .option("as", { describe: "instance name — the container is hiveapp-<as> (default: the kit's name)", type: "string" })
      .option("replace", { describe: "replace an existing container of the same name", type: "boolean", default: false })
      .option("dry-run", { describe: "show the plan (kit, machine, exact command) without running anything", type: "boolean", default: false })
      .option("wait", { describe: "seconds to wait for the app to answer", type: "number", default: 120 })
      .option("skip-record", { describe: "do not record it on the Hive Apps board (bloq #736)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("template", {
        alias: "t",
        describe: "scaffold template (scaffold mode only; default basic)",
        choices: ["basic", "react", "vue"] as const,
      }),
  async handler(args) {
    const name = args.name as string
    if (isHiveAppRequest(args as Record<string, unknown>, name)) {
      if (args.template) {
        prompts.log.error("--template scaffolds a local app directory; it cannot be combined with Hive App flags (--node, --kit, --port, --as, --replace, --dry-run).")
        process.exitCode = 2
        return
      }
      await createHiveApp(args as unknown as HiveAppArgs)
      return
    }
    const template = (args.template as string | undefined) ?? "basic"

    UI.empty()
    prompts.intro(`◈  Create IRIS App: ${name}`)

    const targetDir = join(process.cwd(), name)
    if (existsSync(targetDir)) {
      prompts.log.error(`Directory "${name}" already exists`)
      process.exitCode = 1
      return
    }

    try {
      mkdirSync(targetDir, { recursive: true })

      writeFileSync(join(targetDir, "index.html"), getTemplate(name, template))
      writeFileSync(join(targetDir, "README.md"), readmeTemplate(name, template))
      writeFileSync(
        join(targetDir, "iris.json"),
        JSON.stringify(
          {
            name,
            entry_point: "index.html",
            version: "1.0.0",
            description: `${name} - Built with IRIS`,
          },
          null,
          2,
        ),
      )

      console.log()
      console.log(`  ${success("✓")} App scaffolded with template: ${bold(template)}`)
      printDivider()
      printKV("Path", targetDir)
      printKV("Files", "index.html, README.md, iris.json")
      printDivider()
      console.log()
      console.log(`  ${dim("Next steps:")}`)
      console.log(`  ${dim(`  cd ${name}`)}`)
      console.log(`  ${dim("  # edit your files")}`)
      console.log(`  ${dim("  iris app deploy")}`)
      prompts.outro("Done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      prompts.log.error(`Failed to create app: ${msg}`)
      prompts.outro("Done")
      process.exitCode = 1
    }
  },
})

const DeployCommand = cmd({
  command: "deploy",
  describe: "deploy current directory (or --path) to IRIS",
  builder: (yargs) =>
    yargs
      .option("path", { alias: "p", describe: "path to app directory", type: "string", default: "." })
      .option("name", { describe: "override app name (also writes iris.json)", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return

    const appPath = resolve(args.path as string)
    if (!existsSync(appPath) || !statSync(appPath).isDirectory()) {
      const msg = `Invalid path: ${args.path}`
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 1
      return
    }

    if (!args.json) {
      UI.empty()
      prompts.intro("◈  Deploy to IRIS")
    }

    // Read or create iris.json
    const configPath = join(appPath, "iris.json")
    let config: any
    if (existsSync(configPath)) {
      try {
        config = JSON.parse(readFileSync(configPath, "utf-8"))
      } catch {
        const msg = "Invalid iris.json file"
        if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 1
        return
      }
    } else {
      // No iris.json — need a name. Use --name flag, or prompt (or default to dirname in non-TTY).
      let appName = args.name as string | undefined
      if (!appName) {
        if (isNonInteractive()) {
          appName = basename(appPath)
        } else {
          try {
            appName = (await promptOrFail("name", () =>
              prompts.text({
                message: "App name",
                placeholder: basename(appPath),
                validate: (x) => (x && x.length > 0 ? undefined : "Required"),
              }),
            )) as string
            if (prompts.isCancel(appName)) {
              prompts.outro("Cancelled")
              return
            }
          } catch (err) {
            if (err instanceof MissingFlagError) {
              prompts.log.error(err.message)
              prompts.outro("Done")
              process.exitCode = 2
              return
            }
            throw err
          }
        }
      }
      config = { name: appName, entry_point: "index.html", version: "1.0.0" }
      writeFileSync(configPath, JSON.stringify(config, null, 2))
      if (!args.json) prompts.log.info(`Created iris.json for "${appName}"`)
    }

    // Collect + bundle
    if (!args.json) prompts.log.info("Collecting files…")
    const files = collectFiles(appPath)
    const fileCount = Object.keys(files).length
    if (fileCount === 0) {
      const msg = "No files found to deploy"
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(msg)
      process.exitCode = 1
      return
    }

    const bundle: Record<string, string> = {}
    for (const [path, buf] of Object.entries(files)) {
      bundle[path] = buf.toString("base64")
    }

    if (!args.json) prompts.log.info(`Bundled ${fileCount} files. Uploading…`)

    const spinner = args.json ? null : prompts.spinner()
    spinner?.start("Uploading to IRIS…")

    try {
      const res = await irisFetch("/api/v1/apps/deploy", {
        method: "POST",
        body: JSON.stringify({ config, bundle }),
      })

      if (!res.ok) {
        const text = await res.text()
        spinner?.stop("Failed", 1)
        if (args.json) {
          console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 300) }))
        } else {
          prompts.log.error(`Deployment failed (HTTP ${res.status})`)
          console.log(`  ${dim(text.slice(0, 300))}`)
          prompts.outro("Done")
        }
        process.exitCode = 1
        return
      }

      const result = (await res.json()) as { success?: boolean; error?: string; data?: { id?: number; url?: string } }
      if (!result.success) {
        spinner?.stop("Failed", 1)
        if (args.json) console.log(JSON.stringify({ ok: false, error: result.error ?? "unknown" }))
        else prompts.log.error(`Deployment failed: ${result.error ?? "Unknown error"}`)
        process.exitCode = 1
        return
      }

      if (args.json) {
        console.log(JSON.stringify({ ok: true, ...result.data }))
        return
      }

      spinner?.stop(`${success("✓")} Deployed: ${bold(config.name)}`)
      printDivider()
      printKV("App ID", result.data?.id)
      printKV("URL", result.data?.url)
      printKV("Files", fileCount)
      printDivider()
      prompts.outro(dim(`iris app list  to see all apps`))
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      spinner?.stop("Error", 1)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else {
        prompts.log.error(`Deploy failed: ${msg}`)
        prompts.outro("Done")
      }
      process.exitCode = 1
    }
  },
})

const ListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your IRIS apps",
  builder: (yargs) => yargs.option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/apps`)
      if (!res.ok) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        else prompts.log.error(`Failed to fetch apps (HTTP ${res.status})`)
        process.exitCode = 1
        return
      }
      const body = (await res.json()) as { data?: any[] }
      const apps = body?.data ?? []

      if (args.json) {
        await writeJson(apps)
        return
      }

      UI.empty()
      prompts.intro("◈  Your IRIS Apps")

      if (apps.length === 0) {
        prompts.log.warn("No apps found.")
        console.log(`  ${dim("Create one:  iris app create <name>")}`)
        prompts.outro("Done")
        return
      }

      printDivider()
      for (const app of apps) {
        const id = app.id
        const name = bold(String(app.name ?? `App #${id}`))
        const type = app.storage_type === "github" ? "🔗 GitHub" : "☁️  IRIS"
        const source =
          app.storage_type === "github"
            ? app.repository_url ?? "N/A"
            : "IRIS Cloud"
        const agent = app.agent?.name ?? "-"
        const synced = app.last_synced_at
          ? new Date(app.last_synced_at).toISOString().slice(0, 10)
          : "Never"

        console.log(`  ${name}  ${dim("#" + id)}  ${type}`)
        console.log(`     ${dim("Source:")}      ${String(source).slice(0, 60)}`)
        console.log(`     ${dim("Agent:")}       ${agent}`)
        console.log(`     ${dim("Last synced:")} ${synced}`)
        console.log()
      }
      printDivider()
      console.log(`  ${dim(`Total: ${apps.length} app(s)`)}`)
      prompts.outro("Done")
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Failed: ${msg}`)
      process.exitCode = 1
    }
  },
})

const DeleteCommand = cmd({
  command: "delete <id>",
  aliases: ["rm"],
  describe: "delete an app",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "app ID", type: "number", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return

    const appId = args.id as number

    if (!args.force) {
      if (isNonInteractive()) {
        const msg = "Refusing to delete without --yes in non-interactive mode."
        if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
        else prompts.log.error(msg)
        process.exitCode = 2
        return
      }
      UI.empty()
      const confirmed = await prompts.confirm({ message: `Delete app #${appId}? This cannot be undone.` })
      if (!confirmed || prompts.isCancel(confirmed)) {
        prompts.outro("Cancelled")
        return
      }
    }

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/apps/${appId}`, { method: "DELETE" })
      if (!res.ok && res.status !== 204) {
        const text = await res.text()
        if (args.json) console.log(JSON.stringify({ ok: false, status: res.status, error: text.slice(0, 200) }))
        else prompts.log.error(`Failed to delete app (HTTP ${res.status})`)
        process.exitCode = 1
        return
      }
      if (args.json) console.log(JSON.stringify({ ok: true }))
      else console.log(`  ${success("✓")} App #${appId} deleted`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (args.json) console.log(JSON.stringify({ ok: false, error: msg }))
      else prompts.log.error(`Error: ${msg}`)
      process.exitCode = 1
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformAppCommand = cmd({
  command: "app",
  aliases: ["apps"],
  describe: "apps you own: run one on your Hive instead of paying for it (create \"<job>\" --node), or scaffold/deploy an IRIS-hosted app",
  builder: (yargs) =>
    yargs
      .command(CreateCommand)
      .command(DeployCommand)
      .command(ListCommand)
      .command(DeleteCommand)
      .demandCommand(1),
  async handler() {},
})
