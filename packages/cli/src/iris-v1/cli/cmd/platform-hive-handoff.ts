import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { hiveFetch } from "./platform-hive-nodes"
import { deliverToInbox, inboxExpiresAt, resolveOwnOrPeerNode, senderNodeName } from "./platform-hive-peer"
// Reused rather than reimplemented: `7d`, `36h`, `90m`, `2w`, bare number = days, null when
// unparseable. A second duration format would be a second thing to get wrong.
import { parseDuration } from "./platform-atlas-store"

// ============================================================================
// iris hive handoff <item> --target <node> — hand a work item to an agent (epic #184516)
//
// Same substrate as `iris hive send` (a message task in the recipient's hive inbox) with a
// work-item reference riding along, so "check your hive inbox" is also how a client's agent
// receives work. Two modes, and the split is a permission boundary, not a convenience:
//   deliver (default) — lands in the target inbox as a `handoff`; the OWNER of that machine
//                       decides whether to run it. Works for your nodes and a peer's.
//   --run             — executes it NOW as an agent task on YOUR node; the result is written
//                       to your inbox as a `job`. Refused for a peer's node on purpose: a chat
//                       permission must never turn into "run work on someone else's machine".
// ============================================================================

/** item:1234 · 1234 · bloq:item:1234 · atlas:item:1234 · --bloqItem / --atlas → one canonical ref. */
export function normalizeItemRef(raw: string | undefined, bloqItem?: number, atlas?: string): string | null {
  if (bloqItem) return `bloq:item:${bloqItem}`
  if (atlas) return atlas.startsWith("atlas:") ? atlas : `atlas:${atlas}`
  if (!raw) return null
  const s = raw.trim()
  if (/^item:\d+$/i.test(s)) return `bloq:${s.toLowerCase()}`
  if (/^\d+$/.test(s)) return `bloq:item:${s}`
  if (/^(bloq|atlas):/i.test(s)) return s
  return s
}

export const HiveHandoffCommand = cmd({
  command: "handoff [item]",
  describe: "hand a work item (bloq / Atlas) to an agent's hive inbox — or run it on your own node",
  builder: (yargs) =>
    yargs
      .positional("item", { describe: "item:1234 · bloq:item:1234 · atlas:item:1234", type: "string" })
      .option("target", { alias: ["to", "t"], describe: "target node — yours, or a peer's", type: "string", demandOption: true })
      .option("bloqItem", { describe: "bloq item id", type: "number" })
      .option("atlas", { describe: "Atlas ref, e.g. item:12345", type: "string" })
      .option("note", { alias: "m", describe: "what to do with it", type: "string" })
      .option("expires", { describe: "how long it stays deliverable: 30m, 4h, 7d (default 7d)", type: "string" })
      .option("burn", { describe: "delete it from their inbox the first time it is read", type: "boolean", default: false })
      .option("run", { describe: "execute on YOUR node now; the result lands in your inbox as a job", type: "boolean", default: false })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(argv) {
    if (!argv.json) { UI.empty(); prompts.intro("◈  Hive Handoff") }

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(argv["user-id"] as number | undefined)
    if (!userId) { prompts.outro("Done"); return }

    const item = normalizeItemRef(argv.item as string | undefined, argv.bloqItem as number | undefined, argv.atlas as string | undefined)
    if (!item) {
      prompts.log.error("Give an item: item:1234, --bloqItem=123, or --atlas=item:12345")
      process.exit(1)
    }

    const target = await resolveOwnOrPeerNode(userId, String(argv.target))
    if (!target) {
      prompts.log.error(`No node matching "${argv.target}" among your nodes or your peers' online nodes.`)
      prompts.log.info("Your nodes: iris hive nodes list   ·   Peers: iris hive connections")
      process.exit(1)
    }

    const note = (argv.note as string | undefined) ?? `Work item ${item}: fetch it and do the work.`
    const sp = argv.json ? null : prompts.spinner()
    sp?.start(`Handing ${item} to ${target.node.name}…`)

    if (argv.run) {
      if (target.kind !== "own") {
        sp?.stop("Refused", 1)
        prompts.log.error("--run executes on YOUR node only. A peer's machine runs what its owner chooses — send without --run to deliver it to their inbox.")
        process.exit(1)
      }
      const res = await hiveFetch(`/api/v6/nodes/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          type: "custom",
          runtime: "opencode",
          node_id: target.node.id,
          title: `Handoff: ${item}`,
          prompt: note,
          config: {
            sender_name: await senderNodeName(userId),
            hive_inbox: true,
            inbox_type: "job",
            handoff: { item },
            expires_at: inboxExpiresAt(),
          },
          timeout_seconds: 600,
        }),
      })
      if (!res.ok) { sp?.stop("Failed", 1); prompts.log.error(`HTTP ${res.status}`); process.exit(1) }
      const data = (await res.json()) as { task?: { id: string } }
      sp?.stop(success(`Running ${item} on ${bold(target.node.name)}`))
      if (argv.json) { await writeJson({ ok: true, mode: "run", item, task_id: data.task?.id, node: target.node.name }); return }
      console.log(`  ${dim("result lands in:")} iris hive inbox   ${dim(`task=${(data.task?.id ?? "").slice(0, 8)}`)}`)
      prompts.outro("Done")
      return
    }

    let ttlMs: number | undefined
    if (argv.expires !== undefined) {
      const parsed = parseDuration(String(argv.expires))
      if (parsed === null || parsed <= 0) {
        console.error(`Could not read --expires "${argv.expires}". Use 30m, 4h, 7d, or a bare number of days.`)
        process.exit(1)
      }
      ttlMs = parsed
    }

    const r = await deliverToInbox(userId, target, {
      text: note,
      inboxType: "handoff",
      handoff: { item },
      ttlMs,
      burn: Boolean(argv.burn),
    })
    if (!r.ok) { sp?.stop("Failed", 1); prompts.log.error(r.error ?? "send failed"); process.exit(1) }

    const via = target.kind === "peer" ? dim(` (${target.peerName}, via relay)`) : ""
    sp?.stop(success(`Handed ${item} to ${bold(target.node.name)}${via}`))
    if (argv.json) { await writeJson({ ok: true, mode: "deliver", item, task_id: r.taskId, node: target.node.name, via: target.kind }); return }
    console.log(`  ${dim("they see it with:")} iris hive inbox`)
    prompts.outro("Done")
  },
})
