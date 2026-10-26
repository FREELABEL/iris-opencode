#!/usr/bin/env bun
// iris2 front door (ADR-04): ONE binary, our front door in front of v2.
// ./index.ts runs when dynamically imported from another entrypoint inside a single
// Bun.build({compile}).
//
// iris2 ships BESIDE the stable `iris` as an opt-in preview (#188596). `upgrade`/`update` are
// claimed here and go to selfUpdate (iris-v1/cli/cmd/iris2.ts, the same module stable's
// `iris iris2 install` runs). It replaces only the running binary and picks the release by slot
// + channel: as iris2 it follows previews; copied in as `iris` (canary) it follows previews too,
// and `--channel stable` rolls that slot back to the stable build.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "./version"
import irisDesktopProvider from "./iris-provider.json"

// Release builds get 1.5.0-beta.N from the tag (release-iris2.yml); telemetry rows carry it as
// cli_version, which is how iris2 traffic is told apart from stable.
const IRIS_VERSION = OPENCODE_VERSION === "local" ? "0.0.0-iris2-local" : OPENCODE_VERSION

function helpText(): string {
  return [
    `iris2 ${IRIS_VERSION} — preview of IRIS on the opencode v2 engine (your stable \`iris\` is separate)`,
    "",
    "Usage: iris2 [platform-command] [args...]",
    "",
    "Platform commands (ours, unchanged from 1.3.x):",
    "  atlas        Atlas boards, lists and items",
    "  bloqs        Knowledge bases (alias: kb, memory)",
    "  genesis      Composable page builder (alias: pages)",
    "  playbook     Run playbooks / SOPs",
    "  hive         Distributed compute and agent mesh",
    "  leads        Lead capture, enrichment, outreach",
    "  integrations Execute integration functions",
    "  mcp          IRIS MCP servers",
    "  auth         IRIS login and providers",
    "",
    "Core commands (opencode v2):",
    "  run          Non-interactive run",
    "  serve        Start the server",
    "  session      Session management",
    "  upgrade      Update this binary (iris2: newest preview · --channel stable|preview · --check)",
    "",
    "Run `iris2 <command> --help` for command-specific help.",
    "",
  ].join("\n")
}

function readSdkEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  const file = path.join(os.homedir(), ".iris", "sdk", ".env")
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const trimmed = line.trim()
      if (!trimmed || trimmed.startsWith("#")) continue
      const eq = trimmed.indexOf("=")
      if (eq === -1) continue
      let value = trimmed.slice(eq + 1).trim()
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1)
      }
      env[trimmed.slice(0, eq).trim()] = value
    }
  } catch {
    // no SDK env — the core run will surface a missing key
  }
  return env
}

// What a stable `iris` user already configured, carried into v2 on every launch (#188596).
// v2 keeps its own config in ~/.config/iris, so without this the IRIS OS MCP server, the agents
// `iris agents desktop-sync` writes and the user's commands all vanish from the TUI. Read each
// launch, not copied once: `iris mcp add` (the platform layer) still writes the v1 file.
// OPENCODE_PERMISSION is how the Hive daemon stops unattended `iris run` from waiting on a
// prompt nobody can answer (#188292); v1 read it, v2 does not. All keys stay in v1's shape —
// v2's config normalizer migrates them (core/src/v1/config/migrate.ts).
function v1Carryover(): Record<string, unknown> {
  const dir = path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config"), "opencode")
  const v1 = readJson(path.join(dir, "opencode.json")) ?? readJson(path.join(dir, "opencode.jsonc")) ?? {}
  const permission = process.env.OPENCODE_PERMISSION ? readJsonText(process.env.OPENCODE_PERMISSION) : undefined
  return Object.fromEntries(
    Object.entries({ mcp: irisOsServer(v1.mcp), agent: v1.agent, command: v1.command, permission }).filter(
      ([, v]) => v,
    ),
  )
}

// IRIS OS is launched by THIS binary, directly (#189991). `iris mcp install` writes it in several
// forms — bare `iris` (PATH-dependent), an absolute path that may be stale, or a
// `/bin/bash -l -c "exec iris mcp serve"` wrapper whose login shell can print to stdout before the
// server speaks, which breaks the MCP handshake. Any entry that launches `iris mcp serve` (under any
// key) collapses into one "IRIS OS" entry; the user's environment and enabled flag are kept, and it
// is added when missing so every user has it.
function irisOsServer(mcp: unknown): Record<string, unknown> {
  const servers = mcp && typeof mcp === "object" && !Array.isArray(mcp) ? (mcp as Record<string, unknown>) : {}
  const launchesIris = (entry: unknown) => {
    if (!entry || typeof entry !== "object") return false
    const e = entry as { command?: unknown; args?: unknown }
    const words = [e.command, e.args].flat().filter((w) => typeof w === "string").join(" ").toLowerCase()
    return words.includes("iris") && words.includes("mcp") && words.includes("serve")
  }
  const iris = Object.values(servers).find(launchesIris) as { enabled?: boolean; environment?: unknown } | undefined
  const others = Object.fromEntries(Object.entries(servers).filter(([, entry]) => !launchesIris(entry)))
  const self = /^iris2?(\.exe)?$/i.test(path.basename(process.execPath))
    ? process.execPath
    : path.join(os.homedir(), ".iris", "bin", process.platform === "win32" ? "iris.exe" : "iris")
  return {
    ...others,
    "IRIS OS": {
      type: "local",
      command: [self, "mcp", "serve"],
      enabled: iris?.enabled ?? true,
      ...(iris?.environment ? { environment: iris.environment } : {}),
    },
  }
}

// Agent and command markdown, and the global AGENTS.md, live beside the v1 config. Link them
// into v2's config dir rather than copy, so what `iris agents desktop-sync` writes later still
// shows up. Only where v2 has nothing of that name: a user's own v2 files are never replaced.
// Junctions on Windows, which need no developer mode; a failure only means it is not carried.
function linkV1Files() {
  const base = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")
  const v1 = path.join(base, "opencode")
  const v2 = path.join(base, "iris")
  for (const name of ["agent", "agents", "command", "commands", "AGENTS.md"]) {
    const source = path.join(v1, name)
    const target = path.join(v2, name)
    if (!fs.existsSync(source) || fs.existsSync(target)) continue
    try {
      fs.mkdirSync(v2, { recursive: true })
      const dir = fs.statSync(source).isDirectory()
      fs.symlinkSync(source, target, dir ? (process.platform === "win32" ? "junction" : "dir") : "file")
    } catch {}
  }
}

function readJson(file: string): Record<string, unknown> | undefined {
  if (!fs.existsSync(file)) return
  return readJsonText(fs.readFileSync(file, "utf8"))
}

// A config the user broke must not stop `iris` from starting; it just carries nothing over.
function readJsonText(text: string): Record<string, unknown> | undefined {
  const value: unknown = (() => {
    try {
      return Bun.JSONC.parse(text)
    } catch {
      return undefined
    }
  })()
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

// The model rail matches IRIS Desktop (#188596). The models are the server's live list, the
// desktop's own rule: only `available` models, so switching one off on the server removes it here
// with no release (iris-models.ts). The desktop's provider file — iris/1.18.23
// packages/desktop/src-tauri/resources/iris-provider.json, refreshed by release-iris2.yml on every
// build — supplies the default, the endpoint, and the offline fallback list.
async function irisProviderConfig(traceId: string): Promise<string> {
  const sdk = readSdkEnv()
  const iris = irisDesktopProvider.provider.iris
  const apiURL = process.env.IRIS_API_URL ?? sdk.IRIS_API_URL
  const baseURL = apiURL ? apiURL + "/api/v6/openai" : iris.options.baseURL
  const { loadIrisModels, modelsFromSeed } = await import("./iris-models")
  const { models } = await loadIrisModels({
    baseURL,
    apiKey: process.env.IRIS_API_KEY,
    cacheFile: path.join(process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), ".cache"), "iris", "iris-models.json"),
    seed: modelsFromSeed(iris.models),
  })
  // The desktop default, unless the server has switched it off — then the first model it offers.
  const seedDefault = irisDesktopProvider.model.replace(/^iris\//, "")
  const model = `iris/${seedDefault in models ? seedDefault : Object.keys(models)[0]}`
  return JSON.stringify({
    ...v1Carryover(),
    $schema: "https://opencode.ai/config.json",
    model,
    // v2 adds its own free `opencode/*` models; the desktop file hides them. Its enabled_providers
    // (iris only) is NOT applied: it would also hide a provider the user connected themselves.
    disabled_providers: irisDesktopProvider.disabled_providers,
    // IRIS slash commands — v1 offered these in prompt autocomplete. Each runs the real
    // `iris` platform command, so the behaviour stays in one place (the platform layer).
    commands: {
      recall: {
        description: "search past sessions, memory, and diary",
        template: "Run `iris recall $ARGUMENTS` with the bash tool and summarize what it found, citing sources.",
      },
      personality: {
        description: "view or switch agent personality preset",
        template: "Run `iris personality $ARGUMENTS` with the bash tool (no arguments: `iris personality list`) and report the result.",
      },
      usage: {
        description: "show token usage and costs",
        template: "Run `iris usage $ARGUMENTS` with the bash tool and report the totals.",
      },
      sdk: {
        description: "invoke any SDK endpoint (e.g. /sdk leads.list search=acme)",
        template: "Run `iris sdk:call $ARGUMENTS` with the bash tool (if that form is rejected, run `iris sdk --help` and use the matching command) and report the result.",
      },
    },
    provider: {
      iris: {
        npm: iris.npm,
        name: iris.name,
        options: {
          ...iris.options,
          baseURL,
          apiKey: "{env:IRIS_API_KEY}",
          headers: { "X-Iris-Trace-Id": traceId },
        },
        models,
      },
    },
  })
}

const argv = process.argv.slice(2)
const first = argv[0]
// A prerelease version is the opt-in iris2 preview that sits beside `iris`. A bare version is
// the stable `iris` itself (#188596): it gets v1's full help and v1's uninstall, not the
// "your stable iris is separate" wording, which would be false.
const PREVIEW = IRIS_VERSION.includes("-")
const help = first === "--help" || first === "-h" || first === "help"

if (help && PREVIEW) {
  process.stdout.write(helpText())
  process.exit(0)
}
if (first === "--version" || first === "-v" || first === "-V") {
  process.stdout.write(IRIS_VERSION + "\n")
  process.exit(0)
}

// ── Updates replace this binary only (#188596 A3) ─────────────────────────────
// Before this, `upgrade` fell through to v1's updater, which downloads the STABLE asset and
// writes `iris` in this binary's directory — `iris2 upgrade` would have replaced the user's
// stable iris. v2's `upgrade` would instead install upstream OpenCode (I3). Neither may run.
if (first === "upgrade" || first === "update") {
  const { selfUpdate } = await import("./iris-v1/cli/cmd/iris2")
  const code = await selfUpdate(argv.slice(1), IRIS_VERSION)
  // The v2 background service outlives the binary that started it, so after an update it kept
  // serving the old version's config — old model list included — until something restarted it
  // (#188596). Stop it only when the version actually changed; the next command starts the new one.
  const { spawnSync } = await import("node:child_process")
  const installed = spawnSync(process.execPath, ["--version"], { encoding: "utf8", timeout: 30_000 }).stdout?.trim()
  if (code === 0 && installed && installed !== IRIS_VERSION)
    spawnSync(process.execPath, ["service", "stop"], { stdio: "ignore", timeout: 30_000 })
  process.exit(code)
}
if (first === "uninstall" && PREVIEW) {
  process.stdout.write("Remove iris2 with: iris iris2 remove   (your stable iris and its data are untouched)\n")
  process.exit(0)
}

// ── Command ownership (§7.4 C1) — see iris-route.ts ───────────────────────────
const { routesToV2 } = await import("./iris-route")
const head = first?.split(":")[0]
const toV2 = routesToV2(argv)

if (toV2) {
  // ── Isolation from the user's own opencode data (I4) is NOT done here ───────
  // It is `app = "iris"` in packages/util/src/global.ts, so v2 roots its data at
  // ~/.local/share/iris, ~/.config/iris, … Setting XDG_* or OPENCODE_CONFIG_DIR here
  // leaked into every shell the agent ran — `git` and `gh` lost ~/.config (R1).

  // ── Inject the IRIS model rail (I5) ────────────────────────────────────────
  const sdk = readSdkEnv()
  if (!process.env.IRIS_API_KEY && sdk.IRIS_API_KEY) process.env.IRIS_API_KEY = sdk.IRIS_API_KEY
  // ── Telemetry, the same contract as v1's index.ts (and the same opt-out: `iris telemetry off`) ──
  // Before this the v2 path reported nothing: no app_open, no crash reports, and every model
  // request carried the same constant trace id, so a session could not be joined to its spend.
  const { Beacon } = await import("./iris-v1/telemetry/beacon")
  const { Consent } = await import("./iris-v1/telemetry/consent")
  const traceId = Beacon.traceId()
  const runSpanId = Beacon.newSpanId()
  const startedAt = Date.now()
  // The command WORD only — never argv (flags and positionals carry search terms and ids).
  const commandName = first === undefined || first.startsWith("-") || first.includes("/") || first.includes(".") ? "tui" : head
  Beacon.span("run_start", { trace_id: traceId, span_id: runSpanId, command: commandName })
  Consent.noticeOnce()
  if (commandName === "tui") Beacon.usage("app_open")
  const crash = (kind: string) => (e: unknown) =>
    void Beacon.report("cli_uncaught", {
      message: e instanceof Error ? e.message : String(e),
      command: commandName,
      context: { kind, engine: "v2", channel: "iris2" },
    })
  process.on("unhandledRejection", crash("unhandledRejection"))
  process.on("uncaughtException", crash("uncaughtException"))
  // run_end. v2 leaves through process.exit, which skips beforeExit, so the span is queued on
  // "exit" and flushed by Beacon's own timer only if the process lives long enough; a natural
  // exit (beforeExit) gets an awaited flush. Known gap: a TUI quit can still drop it.
  let ended = false
  const end = () => {
    if (ended) return
    ended = true
    Beacon.span("run_end", {
      trace_id: traceId,
      span_id: Beacon.newSpanId(),
      parent_span_id: runSpanId,
      command: commandName,
      outcome: process.exitCode ? "error" : "ok",
      duration_ms: Date.now() - startedAt,
    })
  }
  process.once("beforeExit", () => {
    end()
    void Beacon.flush()
  })
  process.once("exit", end)

  linkV1Files()
  process.env.OPENCODE_CONFIG_CONTENT ??= await irisProviderConfig(traceId)

  // ── Hand off to v2 (A5) ───────────────────────────────────────────────────
  // No process.exit() after this import: v2 STARTS its CLI via NodeRuntime.runMain,
  // so the import resolves at once and an exit here killed v2 before any output (R4).
  // IRIS TUI plugins (sidebar tabs). builtins.ts reads this registry; the TUI runs in-process.
  ;(globalThis as any).__IRIS_TUI_PLUGINS = [(await import("./iris-tui/sidebar")).default]
  await import("./index.ts")
} else {
  // ── IRIS platform layer (vendored v1 index.ts; reg()/getRegistry()/namespaced help) ──
  // v1's TUI can auto-update for users with `autoupdate: true`, and v1's updater writes `iris`.
  // Inside iris2 that would replace the stable binary, so it is off here.
  process.env.OPENCODE_DISABLE_AUTOUPDATE ??= "1"
  await import("./iris-v1/index.ts")
  process.exit(process.exitCode ?? 0)
}
