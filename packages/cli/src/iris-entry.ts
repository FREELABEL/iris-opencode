#!/usr/bin/env bun
// iris2 front door (ADR-04): ONE binary, our front door in front of v2.
// ./index.ts runs when dynamically imported from another entrypoint inside a single
// Bun.build({compile}).
//
// iris2 ships BESIDE the stable `iris` as an opt-in preview (#188596). It must never write the
// stable binary: `upgrade`/`update` are claimed here and go to the iris2 updater, which only
// ever replaces a file named iris2 (iris-v1/cli/cmd/iris2.ts, the same code stable's
// `iris iris2 install` runs).

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "./version"

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
    "  upgrade      Update iris2 to the newest preview (never touches `iris`)",
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

function irisProviderConfig(traceId: string): string {
  const sdk = readSdkEnv()
  const baseURL = (process.env.IRIS_API_URL ?? sdk.IRIS_API_URL ?? "https://freelabel.net") + "/api/v6/openai"
  const models: Record<string, { name: string; tool_call: boolean }> = {}
  for (const [id, name] of [
    ["iris-ai", "IRIS AI"],
    ["iris-ai-reasoning", "IRIS AI Reasoning"],
    ["grok-4.3", "Grok 4.3"],
    ["gpt-4o-mini", "GPT-4o Mini"],
    ["gpt-4.1-nano", "GPT-4.1 Nano"],
    ["gpt-5-nano", "GPT-5 Nano"],
    ["gpt-5.4-nano", "GPT-5.4 Nano"],
    ["gpt-5.6-luna", "GPT-5.6 Luna"],
    ["gpt-5.6-terra", "GPT-5.6 Terra"],
    ["gpt-5.6-sol", "GPT-5.6 Sol"],
    ["big-pickle", "Big Pickle"],
    ["deepseek-v4-flash", "DeepSeek V4 Flash"],
  ] as const) {
    models[id] = { name, tool_call: true }
  }
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    model: "iris/gpt-4.1-nano",
    // v1's model picker listed IRIS models only; v2 adds its own free `opencode/*` models.
    // Hide those. A provider the user connects themselves still shows.
    disabled_providers: ["opencode"],
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
        npm: "@ai-sdk/openai-compatible",
        name: "IRIS",
        options: {
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

if (first === "--help" || first === "-h" || first === "help") {
  process.stdout.write(helpText())
  process.exit(0)
}
if (first === "--version" || first === "-v" || first === "-V") {
  process.stdout.write(IRIS_VERSION + "\n")
  process.exit(0)
}

// ── Updates are iris2's own (#188596 A3) ──────────────────────────────────────
// Before this, `upgrade` fell through to v1's updater, which downloads the STABLE asset and
// writes `iris` in this binary's directory — `iris2 upgrade` would have replaced the user's
// stable iris. v2's `upgrade` would instead install upstream OpenCode (I3). Neither may run.
if (first === "upgrade" || first === "update") {
  const { selfUpdate } = await import("./iris-v1/cli/cmd/iris2")
  process.exit(await selfUpdate(argv.slice(1), IRIS_VERSION))
}
if (first === "uninstall") {
  process.stdout.write("Remove iris2 with: iris iris2 remove   (your stable iris and its data are untouched)\n")
  process.exit(0)
}

// ── Command ownership (§7.4 C1) ───────────────────────────────────────────────
// v2 owns its own command names; everything else (210+ platform names, upgrades,
// `mcp`, `auth`, `help`, namespaced `x:y`, typos) routes to the vendored v1 layer.
const V2_OWNED = new Set([
  "run", "serve", "acp", "api", "debug", "models", "mini", "session",
  "service", "plugin", "pair", "reload",
])
const head = first?.split(":")[0]

// v2's ROOT flags (-c/--continue, -s/--session, --prompt, --standalone, --server, --auto, …) and
// its [directory] positional open the TUI too. They used to fall through to the v1 layer, which
// hung silently: `iris --continue` drew nothing. Same rule v1's thread.ts used for a directory —
// it contains "/" or ".", so a plain word is still read as a command. Help/version are claimed above.
const toV2 =
  first === undefined ||
  V2_OWNED.has(head!) ||
  first.startsWith("-") ||
  first.includes("/") ||
  first.includes(".")

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

  process.env.OPENCODE_CONFIG_CONTENT ??= irisProviderConfig(traceId)

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
