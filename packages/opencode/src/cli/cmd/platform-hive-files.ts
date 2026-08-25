/**
 * `iris hive fs` — move files to and from your OWN Hive nodes (#182013).
 *
 * NAMED `fs`, NOT `files`. `iris hive files <connection-id>` already exists and is the PEER
 * path: it browses another person's node through a connection relay, the same family as
 * `iris hive exec`. This command addresses YOUR machines by node name over Tailscale, so it
 * is a different subject and must not shadow the other. (That the two are told apart only by
 * the verb is itself a usability problem — nothing in either name tells you which one you
 * want. Worth its own ticket; not fixed here.)
 *
 * There was no file transfer in the Hive at all. Recovering one 57KB controller mapping on
 * 2026-08-23 took Tailscale, ssh, a TCC diagnosis, a staged copy and a hand-run sha256 at
 * both ends. This is that, as a verb.
 *
 * It goes over Tailscale/scp rather than the Hive task transport ON PURPOSE — see the header
 * of hive-tailscale.ts. The transport is not byte-safe and a base64 round-trip through it
 * came back corrupted.
 */

import { cmd } from "./cmd"
import { requireAuth, requireUserId, dim, bold, success, writeJson } from "./iris-api"
import { resolveNode } from "./platform-hive-nodes"
import {
  resolveSshTarget,
  ensureSshUser,
  sshRun,
  pullFile,
  pushFile,
  shqPath,
  classifyRemoteError,
  type SshTarget,
} from "./hive-tailscale"

async function target(argv: any): Promise<{ t: SshTarget; nodeName: string } | null> {
  await requireAuth()
  const userId = await requireUserId(argv["user-id"] as number | undefined)
  if (!userId) process.exit(1)

  const node = await resolveNode(userId, String(argv.node))
  if (!node) {
    console.error(`No node matching "${argv.node}". Run: iris hive nodes list`)
    process.exit(1)
  }

  // NOTE: deliberately NOT gated on connection_status. That flag describes the Hive daemon's
  // heartbeat, and this command does not use the daemon — a node whose daemon is dead is
  // still reachable over ssh, which is exactly when you most want to fetch a file off it.
  const resolved = await resolveSshTarget(node.id, node.name, {
    host: argv.host as string | undefined,
    user: argv.user as string | undefined,
    // What the node itself reported in its heartbeat. Without this the resolver had to guess
    // from names, and for a node whose Hive name differs from its tailnet name the first call
    // dead-ended asking for the IP you wanted it to find (#182368).
    advertised: (node as any).tailscale_ip ?? null,
  })
  if ("error" in resolved) {
    console.error(resolved.error)
    process.exit(1)
  }

  const withUser = await ensureSshUser(node.id, resolved)
  if ("error" in withUser) {
    console.error(withUser.error)
    process.exit(1)
  }

  if (!argv.json) {
    const via = resolved.via === "tailscale" ? `tailscale ${resolved.peer?.hostName ?? ""}`.trim() : resolved.via
    console.log(`${dim("→")} ${bold(node.name)} ${dim(`via ${via} → ${withUser.user ? withUser.user + "@" : ""}${withUser.host}`)}`)
  }
  return { t: withUser, nodeName: node.name }
}

const commonOpts = (yargs: any) =>
  yargs
    .option("host", { describe: "override the address (skip Tailscale resolution)", type: "string" })
    .option("user", { describe: "ssh user on the node (remembered after the first success)", type: "string" })
    .option("user-id", { describe: "user ID", type: "number" })
    .option("json", { describe: "JSON output", type: "boolean", default: false })

const FilesLsCommand = cmd({
  command: "ls <node> <path>",
  describe: "list a directory on a Hive node",
  builder: (yargs) =>
    commonOpts(
      yargs
        .positional("node", { describe: "node name or id", type: "string", demandOption: true })
        .positional("path", { describe: "remote path", type: "string", demandOption: true }),
    ),
  async handler(argv) {
    const resolved = await target(argv)
    if (!resolved) return
    const path = String(argv.path)

    const r = await sshRun(resolved.t, `ls -la ${shqPath(path)}`)
    if (!r.ok) {
      const c = classifyRemoteError(r.stderr)
      if (argv.json) {
        await writeJson({ ok: false, path, error_kind: c.kind, error: c.hint })
        process.exit(1)
      }
      // A TCC refusal must never read as "not found" — that sends you hunting for a file
      // that is sitting right there (#182007).
      console.error(`\n  ${c.kind === "tcc" ? bold("REFUSED BY macOS PRIVACY (TCC)") : bold(c.kind.toUpperCase())}`)
      console.error(`  ${c.hint}\n`)
      process.exit(1)
    }

    if (argv.json) {
      await writeJson({ ok: true, path, listing: r.stdout.trimEnd().split("\n") })
      return
    }
    console.log()
    console.log(r.stdout.trimEnd())
    console.log()
  },
})

const FilesPullCommand = cmd({
  command: "pull <node> <remote-path..>",
  describe: "copy file(s) OFF a node, sha256-verified at both ends",
  builder: (yargs) =>
    commonOpts(
      yargs
        .positional("node", { describe: "node name or id", type: "string", demandOption: true })
        .positional("remote-path", { describe: "path(s) on the node", type: "string", demandOption: true })
        .option("out", { describe: "local directory (default: .)", type: "string", default: "." }),
    ),
  async handler(argv) {
    const resolved = await target(argv)
    if (!resolved) return
    const paths = ([] as string[]).concat(argv["remote-path"] as any)
    const outDir = String(argv.out)

    const results = []
    for (const p of paths) results.push(await pullFile(resolved.t, p, outDir))

    if (argv.json) {
      await writeJson({ ok: results.every((r) => r.ok), results })
      if (!results.every((r) => r.ok)) process.exit(1)
      return
    }

    console.log()
    for (const r of results) {
      if (r.ok) {
        console.log(`  ${success("✓")} ${bold(r.localPath)}  ${dim(`${r.bytes} bytes`)}`)
        console.log(`     ${dim("sha256 " + r.sha256 + " — matched on the node")}`)
      } else {
        console.log(`  ${dim("✗")} ${bold(r.remotePath)}`)
        console.log(`     ${r.error}`)
      }
    }
    console.log()
    const bad = results.filter((r) => !r.ok).length
    if (bad) {
      console.log(`  ${bad} of ${results.length} failed.`)
      process.exit(1)
    }
  },
})

const FilesPushCommand = cmd({
  command: "push <node> <local-path..>",
  describe: "copy local file(s) ON to a node, sha256-verified at both ends",
  builder: (yargs) =>
    commonOpts(
      yargs
        .positional("node", { describe: "node name or id", type: "string", demandOption: true })
        .positional("local-path", { describe: "local file(s)", type: "string", demandOption: true })
        .option("to", { describe: "remote directory", type: "string", demandOption: true }),
    ),
  async handler(argv) {
    const resolved = await target(argv)
    if (!resolved) return
    const paths = ([] as string[]).concat(argv["local-path"] as any)
    const to = String(argv.to)

    const results = []
    for (const p of paths) results.push(await pushFile(resolved.t, p, to))

    if (argv.json) {
      await writeJson({ ok: results.every((r) => r.ok), results })
      if (!results.every((r) => r.ok)) process.exit(1)
      return
    }

    console.log()
    for (const r of results) {
      if (r.ok) {
        console.log(`  ${success("✓")} ${bold(r.remotePath)}  ${dim(`${r.bytes} bytes`)}`)
        console.log(`     ${dim("sha256 " + r.sha256 + " — matched on the node")}`)
      } else {
        console.log(`  ${dim("✗")} ${bold(r.localPath)}`)
        console.log(`     ${r.error}`)
      }
    }
    console.log()
    const bad = results.filter((r) => !r.ok).length
    if (bad) {
      console.log(`  ${bad} of ${results.length} failed.`)
      process.exit(1)
    }
  },
})

const HiveFilesCommand = cmd({
  command: "fs",
  describe: "move files to and from YOUR OWN Hive nodes over Tailscale, sha256-verified both ends",
  builder: (yargs) =>
    yargs
      .command(FilesLsCommand)
      .command(FilesPullCommand)
      .command(FilesPushCommand)
      .demandCommand(1, "Specify: ls, pull, push"),
  async handler() {},
})

export const HiveFilesCommandExport = HiveFilesCommand
