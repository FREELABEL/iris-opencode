import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// OBS Studio CLI — control OBS via WebSocket through the IRIS bridge
//
// Bridge endpoints: /api/obs/* on localhost:3200
// OBS WebSocket: obs-websocket v5 on localhost:4455
// ============================================================================

const BRIDGE = "http://localhost:3200"

async function obsFetch(path: string, method = "GET", body?: any): Promise<any> {
  const res = await fetch(`${BRIDGE}${path}`, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(err.error || `HTTP ${res.status}`)
  }
  return res.json()
}

function printDivider() { console.log(dim("  " + "─".repeat(60))) }

// ── connect ──

const ConnectCmd = cmd({
  command: "connect [url]",
  describe: "connect to OBS WebSocket (default: ws://localhost:4455)",
  builder: (y) =>
    y
      .positional("url", { type: "string", default: "ws://localhost:4455" })
      .option("password", { type: "string", describe: "OBS WebSocket password" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  OBS Connect")
    const sp = prompts.spinner()
    sp.start(`Connecting to ${args.url}…`)
    try {
      const result = await obsFetch("/api/providers/obs", "POST", {
        ws_url: args.url,
        password: args.password ?? undefined,
      })
      sp.stop(success(`Connected to ${result.host}`))
    } catch (e: any) {
      sp.stop("Failed")
      prompts.log.error(e.message)
      prompts.log.info(dim("Make sure OBS is running with WebSocket Server enabled"))
      prompts.log.info(dim("OBS → Tools → WebSocket Server Settings → Enable"))
    }
    prompts.outro("Done")
  },
})

// ── disconnect ──

const DisconnectCmd = cmd({
  command: "disconnect",
  describe: "disconnect from OBS",
  async handler() {
    UI.empty()
    prompts.intro("◈  OBS Disconnect")
    try {
      await obsFetch("/api/providers/obs", "DELETE")
      prompts.log.success("Disconnected from OBS")
    } catch (e: any) {
      prompts.log.error(e.message)
    }
    prompts.outro("Done")
  },
})

// ── scenes ──

const ScenesCmd = cmd({
  command: "scenes",
  aliases: ["ls"],
  describe: "list available OBS scenes",
  async handler() {
    UI.empty()
    prompts.intro("◈  OBS Scenes")
    try {
      const data = await obsFetch("/api/obs/scenes")
      printDivider()
      for (const s of data.scenes || []) {
        const current = s.name === data.current ? success(" ● LIVE") : ""
        console.log(`  ${highlight(s.name)}${current}`)
      }
      printDivider()
      if (data.current) {
        console.log(`  ${dim("Current:")} ${bold(data.current)}`)
      }
    } catch (e: any) {
      prompts.log.error(e.message)
    }
    prompts.outro("Done")
  },
})

// ── scene <name> ──

const SceneCmd = cmd({
  command: "scene <name>",
  aliases: ["switch"],
  describe: "switch to a scene",
  builder: (y) => y.positional("name", { type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    const sp = prompts.spinner()
    sp.start(`Switching to "${args.name}"…`)
    try {
      await obsFetch("/api/obs/scene", "POST", { scene_name: args.name })
      sp.stop(success(`Scene: ${args.name}`))
    } catch (e: any) {
      sp.stop("Failed")
      prompts.log.error(e.message)
    }
  },
})

// ── stream start|stop|status ──

const StreamCmd = cmd({
  command: "stream <action>",
  describe: "control streaming (start|stop|status)",
  builder: (y) => y.positional("action", { type: "string", choices: ["start", "stop", "status"], demandOption: true }),
  async handler(args) {
    UI.empty()
    if (args.action === "status") {
      try {
        const data = await obsFetch("/api/obs/stream/status")
        prompts.intro("◈  Stream Status")
        console.log(`  ${bold("Active:")}    ${data.active ? success("LIVE") : dim("offline")}`)
        if (data.timecode) console.log(`  ${bold("Timecode:")} ${data.timecode}`)
        if (data.bytes) console.log(`  ${bold("Sent:")}     ${(data.bytes / 1024 / 1024).toFixed(1)} MB`)
        if (data.skippedFrames) console.log(`  ${bold("Dropped:")}  ${data.skippedFrames}/${data.totalFrames} frames`)
      } catch (e: any) {
        prompts.log.error(e.message)
      }
    } else {
      const sp = prompts.spinner()
      sp.start(`${args.action === "start" ? "Starting" : "Stopping"} stream…`)
      try {
        await obsFetch(`/api/obs/stream/${args.action}`, "POST")
        sp.stop(success(`Stream ${args.action === "start" ? "started" : "stopped"}`))
      } catch (e: any) {
        sp.stop("Failed")
        prompts.log.error(e.message)
      }
    }
  },
})

// ── record start|stop|status ──

const RecordCmd = cmd({
  command: "record <action>",
  aliases: ["rec"],
  describe: "control recording (start|stop|status)",
  builder: (y) => y.positional("action", { type: "string", choices: ["start", "stop", "status"], demandOption: true }),
  async handler(args) {
    UI.empty()
    if (args.action === "status") {
      try {
        const data = await obsFetch("/api/obs/record/status")
        prompts.intro("◈  Recording Status")
        console.log(`  ${bold("Active:")}    ${data.active ? success("RECORDING") : dim("stopped")}`)
        if (data.paused) console.log(`  ${bold("Paused:")}    yes`)
        if (data.timecode) console.log(`  ${bold("Timecode:")} ${data.timecode}`)
      } catch (e: any) {
        prompts.log.error(e.message)
      }
    } else {
      const sp = prompts.spinner()
      sp.start(`${args.action === "start" ? "Starting" : "Stopping"} recording…`)
      try {
        const result = await obsFetch(`/api/obs/record/${args.action}`, "POST")
        sp.stop(success(`Recording ${args.action === "start" ? "started" : "stopped"}`))
        if (result.outputPath) console.log(`  ${dim("File:")} ${result.outputPath}`)
      } catch (e: any) {
        sp.stop("Failed")
        prompts.log.error(e.message)
      }
    }
  },
})

// ── marker ──

const MarkerCmd = cmd({
  command: "marker [description]",
  aliases: ["mark"],
  describe: "create a stream/recording marker (for highlights)",
  builder: (y) => y.positional("description", { type: "string", default: "Marker" }),
  async handler(args) {
    UI.empty()
    try {
      const result = await obsFetch("/api/obs/marker", "POST", { description: args.description })
      const m = result.marker
      console.log(`  ${success("●")} Marker at ${bold(m.timecode)} — ${m.description}`)
    } catch (e: any) {
      prompts.log.error(e.message)
    }
  },
})

// ── mute ──

const MuteCmd = cmd({
  command: "mute <input>",
  describe: "toggle mute on an audio input",
  builder: (y) =>
    y
      .positional("input", { type: "string", demandOption: true })
      .option("unmute", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    try {
      const result = await obsFetch("/api/obs/audio/mute", "POST", {
        input: args.input,
        muted: !args.unmute,
      })
      console.log(`  ${result.muted ? dim("🔇 Muted") : success("🔊 Unmuted")}: ${bold(args.input as string)}`)
    } catch (e: any) {
      prompts.log.error(e.message)
    }
  },
})

// ── inputs ──

const InputsCmd = cmd({
  command: "inputs",
  aliases: ["sources"],
  describe: "list audio/video inputs",
  async handler() {
    UI.empty()
    prompts.intro("◈  OBS Inputs")
    try {
      const inputs = await obsFetch("/api/obs/inputs")
      printDivider()
      for (const i of inputs) {
        console.log(`  ${highlight(i.name)}  ${dim(i.kind || "")}`)
      }
      printDivider()
    } catch (e: any) {
      prompts.log.error(e.message)
    }
    prompts.outro("Done")
  },
})

// ── status ──

const StatusCmd = cmd({
  command: "status",
  describe: "full OBS status (connection + stream + recording)",
  async handler() {
    UI.empty()
    prompts.intro("◈  OBS Status")
    try {
      const health = await fetch(`${BRIDGE}/health`, { signal: AbortSignal.timeout(3000) }).then(r => r.json())
      const obs = health?.messaging?.obs ?? health?.obs ?? { status: "stopped" }
      console.log(`  ${bold("Connection:")} ${obs.status === "running" ? success("connected") : dim("disconnected")}`)
      if (obs.host) console.log(`  ${bold("Host:")}       ${dim(obs.host)}`)

      if (obs.status === "running") {
        try {
          const stream = await obsFetch("/api/obs/stream/status")
          console.log(`  ${bold("Stream:")}     ${stream.active ? success("LIVE") : dim("offline")}`)
          if (stream.timecode) console.log(`  ${bold("Uptime:")}     ${stream.timecode}`)
        } catch {}
        try {
          const rec = await obsFetch("/api/obs/record/status")
          console.log(`  ${bold("Recording:")}  ${rec.active ? success("RECORDING") : dim("stopped")}`)
        } catch {}
        try {
          const scenes = await obsFetch("/api/obs/scenes")
          console.log(`  ${bold("Scene:")}      ${highlight(scenes.current || "?")}`)
        } catch {}
      }
    } catch (e: any) {
      prompts.log.error(`Bridge not running: ${e.message}`)
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformObsCommand = cmd({
  command: "obs",
  describe: "control OBS Studio — scenes, streaming, recording, markers, audio",
  builder: (y) =>
    y
      .command(ConnectCmd)
      .command(DisconnectCmd)
      .command(ScenesCmd)
      .command(SceneCmd)
      .command(StreamCmd)
      .command(RecordCmd)
      .command(MarkerCmd)
      .command(MuteCmd)
      .command(InputsCmd)
      .command(StatusCmd)
      .demandCommand(1, "specify: connect, scenes, scene, stream, record, marker, mute, inputs, status"),
  async handler() {},
})
