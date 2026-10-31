import { cmd } from "./cmd"
import { Consent } from "../../telemetry/consent"

// `iris telemetry [status|on|off]` (#186171) — see and change what this machine reports.
export const TelemetryCommand = cmd({
  command: "telemetry [action]",
  describe: "show or change usage telemetry (status | on | off)",
  builder: (y) =>
    y.positional("action", { type: "string", choices: ["status", "on", "off"], default: "status" }),
  async handler(args) {
    if (args.action === "on" || args.action === "off") Consent.setEnabled(args.action === "on")
    const s = Consent.status()
    console.log(`telemetry: ${s.enabled ? "on" : "off"}${s.reason === "default" ? "" : `  (${s.reason})`}`)
    if (args.action === "on" && !s.enabled) {
      console.log(`  still off: ${s.reason} is set in this environment, and it wins`)
    }
    console.log("")
    console.log("  Recorded: the command word (e.g. `leads`), whether it worked, how long it took, app version, OS;")
    console.log("  app opened, signed in, playbook run (counted, not named). Never arguments, files, prompts or content.")
    console.log("  Off: iris telemetry off  ·  IRIS_TELEMETRY=0  ·  DO_NOT_TRACK=1")
  },
})
