import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "@/cli/ui"
import {
  livePeers,
  pruneDead,
  resolvePeer,
  type PeerEntry,
} from "./hive-peer-registry"

const dim = (s: string) => `${UI.Style.TEXT_DIM}${s}${UI.Style.TEXT_NORMAL}`
const bold = (s: string) => `${UI.Style.TEXT_NORMAL_BOLD}${s}${UI.Style.TEXT_NORMAL}`

/**
 * `iris hive tell` — put a message in front of another agent on THIS machine (epic #182718, S1).
 *
 * WHY THIS IS NOT `hive send-input`. `send-input` dispatches the `session_message` task type,
 * which the bridge implements as `opencode run -s <sid>` — a separate headless process doing a
 * full model turn. It returns ok and the watching human sees nothing, because the event bus is
 * PER-PROCESS: injected on :4096 while subscribed to :55087/event produced zero events there
 * (measured 2026-09-12, bug #184783). Delivery has to reach the process that is RENDERING the
 * session, and the `/tui/*` routes are scoped to exactly that process.
 *
 * TWO MODES, DELIBERATELY SEPARATE.
 *
 *   NOTIFY (default)  toast + append to their composer. Visible, durable until they act,
 *                     and it spends none of their tokens.
 *   INSTRUCT (--submit) also submits, so their agent takes a turn.
 *
 * Defaulting to INSTRUCT would quietly turn a messaging command into remote code execution on
 * a teammate's machine, billed to them. It is opt-in, per call, and says so.
 *
 * WHY NO sessionID. `/tui/append-prompt` acts on whatever session that TUI currently has open,
 * which is the one its human is looking at. Addressing a session id would be both harder and
 * wronger — every server shares one SQLite DB, so a session id does not identify a viewer.
 */

/** Prefix that makes an injected message distinguishable from something the operator typed. */
function provenance(from: string): string {
  return `[iris:${from}]`
}

async function post(peer: PeerEntry, path: string, body: unknown, timeoutMs = 4000) {
  const res = await fetch(`http://127.0.0.1:${peer.port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`)
  return res
}

function printPeers(peers: PeerEntry[]): void {
  if (peers.length === 0) {
    console.log(dim("  No live addressable sessions on this machine."))
    console.log(dim("  A session registers when its server starts; older builds do not register at all."))
    return
  }
  console.log()
  console.log(`  ${bold("NAME")}              ${bold("PORT")}    ${bold("PID")}      ${bold("DIRECTORY")}`)
  console.log(dim("  ────────────────────────────────────────────────────────────────────"))
  for (const p of peers) {
    console.log(
      `  ${p.name.padEnd(17)} ${String(p.port).padEnd(7)} ${String(p.pid).padEnd(8)} ${dim(p.directory)}`,
    )
  }
  console.log()
  console.log(dim(`  ${peers.length} live.  Reach one:  iris hive tell <name> "<message>"`))
}

export const HiveTellCommand = cmd({
  command: "tell [name] [message..]",
  describe: "put a message in front of another agent session on this machine",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "target session name (see --list)", type: "string" })
      .positional("message", { describe: "what to say", type: "string", array: true })
      .option("list", {
        alias: "l",
        describe: "list live addressable sessions on this machine and exit",
        type: "boolean",
        default: false,
      })
      .option("submit", {
        describe:
          "ALSO submit it, so their agent takes a turn (spends THEIR tokens). Off by default.",
        type: "boolean",
        default: false,
      })
      .option("from", {
        describe: "name to attribute the message to (default: this directory's basename)",
        type: "string",
      })
      .option("no-toast", { describe: "skip the toast, append only", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    pruneDead()
    const peers = await livePeers()

    if (argv.list || !argv.name) {
      if (argv.json) {
        console.log(JSON.stringify(peers, null, 2))
        return
      }
      printPeers(peers)
      if (!argv.list && !argv.name) process.exitCode = peers.length ? 0 : 1
      return
    }

    const text = (argv.message as string[] | undefined)?.join(" ")?.trim() ?? ""
    if (!text) {
      console.error('No message given.  iris hive tell <name> "<message>"')
      process.exitCode = 1
      return
    }

    const resolved = resolvePeer(peers, String(argv.name))
    if ("error" in resolved) {
      console.error(resolved.error)
      process.exitCode = 1
      return
    }
    const peer = resolved.peer

    const from = (argv.from as string | undefined)?.trim() || require("path").basename(process.cwd())
    const line = `${provenance(from)} ${text}`

    UI.empty()
    prompts.intro(`◈  Tell ${peer.name}`)

    // Append FIRST. The toast is decoration; the composer text is the message. If the order
    // were reversed a failed append would leave a toast announcing a message that never
    // arrived — the same "reported, not delivered" failure this command exists to avoid.
    try {
      await post(peer, "/tui/append-prompt", { text: line })
    } catch (e) {
      prompts.log.error(`Could not reach ${peer.name} on port ${peer.port}: ${e instanceof Error ? e.message : e}`)
      prompts.log.info(dim("The entry may be stale. `iris hive tell --list` re-checks liveness."))
      process.exitCode = 1
      prompts.outro("Failed")
      return
    }

    if (!argv["no-toast"]) {
      try {
        await post(peer, "/tui/show-toast", {
          title: `iris:${from}`,
          message: text.length > 120 ? `${text.slice(0, 117)}...` : text,
          variant: "info",
          duration: 8000,
        })
      } catch {
        // A missing toast is cosmetic — the text is already in their composer.
        prompts.log.warn(dim("delivered, but the toast did not show"))
      }
    }

    if (argv.submit) {
      await post(peer, "/tui/execute-command", { command: "prompt.submit" })
      prompts.log.success(`Submitted — ${peer.name}'s agent is taking a turn`)
    } else {
      prompts.log.success(`Delivered to ${peer.name}'s composer`)
      prompts.log.info(dim("They can edit or clear it. Add --submit to make their agent act."))
    }

    // NOTE: none of the above proves a human saw anything. `/tui/show-toast` returns `true`
    // from a headless `opencode serve` with no TUI attached, because it only means the event
    // published. The composer append is the durable half, which is why it is not optional.
    prompts.outro("Done")
  },
})
