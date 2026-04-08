import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
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
  isNonInteractive,
} from "./iris-api"
import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  statSync,
  readdirSync,
} from "fs"
import { join, resolve, basename, relative } from "path"

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
// Subcommands
// ============================================================================

const CreateCommand = cmd({
  command: "create <name>",
  describe: "scaffold a new IRIS-hosted app",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "app name (becomes directory)", type: "string", demandOption: true })
      .option("template", {
        alias: "t",
        describe: "template",
        choices: ["basic", "react", "vue"] as const,
        default: "basic" as const,
      }),
  async handler(args) {
    const name = args.name as string
    const template = args.template as string

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
        console.log(JSON.stringify(apps, null, 2))
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
      .option("yes", { alias: "y", describe: "skip confirmation", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return
    const userId = await requireUserId()
    if (!userId) return

    const appId = args.id as number

    if (!args.yes) {
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
  describe: "manage IRIS-hosted apps (create, deploy, list, delete)",
  builder: (yargs) =>
    yargs
      .command(CreateCommand)
      .command(DeployCommand)
      .command(ListCommand)
      .command(DeleteCommand)
      .demandCommand(1),
  async handler() {},
})
