import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, writeJson } from "./iris-api"
import { resolveNode } from "./platform-hive-nodes"
import { existsSync, writeFileSync, readFileSync } from "fs"
import { createHash } from "crypto"

// User scripts live on the IRIS API (fl-iris-api), not fl-api.
const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"
function scriptsFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

/**
 * The content hash IS the script's identity.
 *
 * Sending it with the dispatch is what makes a stale cache impossible rather than merely
 * unlikely. The daemon used to cache by SLUG — a mutable name — and reuse that copy forever
 * with no version, hash, ETag or TTL (#182275), so pushing a fix changed nothing on any node
 * that had already run the slug once. Two machines, same slug, different code, both reporting
 * success.
 *
 * The fix is not to add revalidation on top of a slug-keyed cache. It is to stop keying on a
 * mutable name: a different version is a different hash is a different file, so "which version
 * does this node hold" stops being a question anyone can get wrong. Verification comes free —
 * the address and the checksum are the same value (#182276).
 */
export function scriptDigest(content: string): string {
  return createHash("sha256").update(content, "utf-8").digest("hex")
}

function inferRuntime(file: string): string {
  if (file.endsWith(".spec.ts") || file.endsWith(".ts")) return "playwright"
  if (file.endsWith(".js") || file.endsWith(".mjs")) return "node"
  if (file.endsWith(".py")) return "python"
  return "bash"
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your saved scripts",
  builder: (y) => y.option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await scriptsFetch("/api/v1/scripts")
    if (!res.ok) return void (await handleApiError(res, "List scripts"))
    const json = (await res.json()) as { data?: any[] }
    const scripts = json.data ?? []
    if (args.json) return void await writeJson(scripts)
    if (!scripts.length) {
      prompts.log.info("No scripts yet. Save one: iris scripts push <slug> <file>")
      return
    }
    console.log(bold("\nYour scripts"))
    for (const s of scripts) {
      console.log(`  ${bold(s.slug)}  ${dim(`[${s.runtime}]`)}${s.auto_pull ? dim("  · auto-pull") : ""}`)
      if (s.name && s.name !== s.slug) console.log(`    ${dim(s.name)}`)
    }
    console.log()
  },
})

const PushCmd = cmd({
  command: "push <slug> <file>",
  describe: "save (upsert) a script to the cloud under a slug",
  builder: (y) =>
    y
      .positional("slug", { describe: "hyphenated slug, e.g. my-inbox-scan", type: "string", demandOption: true })
      .positional("file", { describe: "path to the script file", type: "string", demandOption: true })
      .option("runtime", { describe: "bash|node|python|playwright (default: inferred from extension)", type: "string" })
      .option("name", { describe: "human-readable name", type: "string" })
      .option("auto-pull", { describe: "pre-fetch this script to every node on heartbeat", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const file = args.file as string
    if (!existsSync(file)) return void prompts.log.error(`File not found: ${file}`)
    const content = readFileSync(file, "utf8")
    const res = await scriptsFetch("/api/v1/scripts", {
      method: "POST",
      body: JSON.stringify({
        slug: args.slug,
        name: args.name,
        runtime: (args.runtime as string) ?? inferRuntime(file),
        script_content: content,
        auto_pull: args["auto-pull"],
        user_id: await requireUserId(),
      }),
    })
    if (!res.ok) return void (await handleApiError(res, "Push script"))
    const json = (await res.json()) as { data?: any }
    const created = res.status === 201
    success(`${created ? "Created" : "Updated"} ${bold(json.data?.slug ?? String(args.slug))} ${dim(`[${json.data?.runtime}]`)}`)
  },
})

const PullCmd = cmd({
  command: "pull <slug> [file]",
  describe: "download a saved script (to a file, or stdout)",
  builder: (y) =>
    y
      .positional("slug", { describe: "script slug", type: "string", demandOption: true })
      .positional("file", { describe: "write to this path (default: stdout)", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(args.slug as string)}`)
    if (res.status === 404) return void prompts.log.error(`Script '${args.slug}' not found`)
    if (!res.ok) return void (await handleApiError(res, "Pull script"))
    const json = (await res.json()) as { data?: any }
    const content = json.data?.script_content ?? ""
    if (args.file) {
      writeFileSync(args.file as string, content)
      success(`Wrote ${bold(String(args.file))}`)
    } else {
      process.stdout.write(content.endsWith("\n") ? content : content + "\n")
    }
  },
})

const RmCmd = cmd({
  command: "rm <slug>",
  aliases: ["delete"],
  describe: "delete a saved script",
  builder: (y) => y.positional("slug", { describe: "script slug", type: "string", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(args.slug as string)}`, {
      method: "DELETE",
      body: JSON.stringify({ user_id: await requireUserId() }),
    })
    if (res.status === 404) return void prompts.log.error(`Script '${args.slug}' not found`)
    if (!res.ok) return void (await handleApiError(res, "Delete script"))
    success(`Deleted ${bold(String(args.slug))}`)
  },
})

const RunCmd = cmd({
  command: "run <slug>",
  describe: "run a saved script on a Hive node (the node pulls it from the cloud if missing)",
  builder: (y) =>
    y
      .positional("slug", { describe: "script slug", type: "string", demandOption: true })
      .option("node", { describe: "node name or id to run on", type: "string", demandOption: true })
      .option("timeout", { describe: "task timeout in seconds", type: "number", default: 120 })
      .option("queue", { describe: "dispatch and exit (don't wait for output)", type: "boolean", default: false })
      .option("json", { describe: "JSON output (full task)", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return

    const node = await resolveNode(userId, String(args.node))
    if (!node) return void prompts.log.error(`No node matching "${args.node}". Run: iris hive nodes list`)
    if (node.connection_status !== "online") {
      return void prompts.log.error(`Node "${node.name}" is ${node.connection_status} — cannot dispatch.`)
    }

    const timeoutSec = Math.max(30, Math.min(3600, Number(args.timeout) || 120))

    // Resolve the slug to a CONTENT HASH before dispatching, and send that with the task. The
    // node then runs exactly this version or refuses — it never has to guess whether the copy
    // it cached weeks ago is still current. Non-fatal: an older API or a transient failure
    // just means no digest, and the daemon falls back to its previous behaviour while saying
    // the run was unverified.
    let digest: string | null = null
    try {
      const meta = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(String(args.slug))}`)
      if (meta.ok) {
        const body = (await meta.json()) as { data?: { script_content?: string } }
        const content = body.data?.script_content
        if (typeof content === "string") digest = scriptDigest(content)
      }
    } catch { /* leave digest null — reported below rather than silently assumed */ }

    if (!args.json) {
      console.log(`${dim("→")} dispatching ${bold(String(args.slug))} to ${bold(node.name)}`)
      console.log(digest
        ? dim(`   sha256 ${digest.slice(0, 12)}… — the node runs this exact version or refuses`)
        : dim("   could not resolve a content hash — this run will be UNVERIFIED"))
    }

    const createRes = await scriptsFetch("/api/v6/nodes/tasks", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        title: `iris scripts run: ${args.slug}`,
        type: "user_script",
        node_id: node.id,
        prompt: String(args.slug), // also the slug — the daemon reads config.script_slug ?? prompt
        config: { script_slug: args.slug, ...(digest ? { script_sha256: digest } : {}) },
        timeout_seconds: timeoutSec,
      }),
    })
    if (!createRes.ok) return void prompts.log.error(`Dispatch failed: ${createRes.status} ${await createRes.text()}`)

    const created = (await createRes.json()) as { task: { id: string; status: string } }
    const taskId = created.task.id
    if (args.queue) return void success(`Dispatched task ${bold(taskId)}  (check: iris hive tasks --task ${taskId})`)
    if (!args.json) console.log(dim("waiting for completion…"))

    const deadline = Date.now() + (timeoutSec + 30) * 1000
    const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])
    let final: any = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const r = await scriptsFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!r.ok) return void prompts.log.error(`Poll failed: ${r.status}`)
      const t = ((await r.json()) as { task: any }).task
      if (terminal.has(t.status)) {
        final = t
        break
      }
    }
    if (!final) return void prompts.log.error(`Timed out waiting for task ${taskId}`)
    if (args.json) return void await writeJson(final)

    const out = final.result?.output ?? final.output ?? final.result?.stdout ?? ""
    console.log()
    if (out) console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2))
    if (["succeeded", "completed"].includes(final.status)) success(`${bold(String(args.slug))} ran on ${node.name}`)
    else prompts.log.error(`Script ${final.status} on ${node.name}`)
  },
})

/**
 * S1.4 — which nodes can run this script, and what each is missing.
 *
 * The verdict is computed by the HUB, not here. The hub is what actually refuses a dispatch,
 * so the answer an operator reads has to come from the same code that makes the decision; a
 * client that recomputed eligibility would be a second opinion that eventually disagrees with
 * the router, and the operator would believe the wrong one.
 */
const DoctorCmd = cmd({
  command: "doctor <slug>",
  describe: "which nodes can run this script, and what each is missing",
  builder: (y) =>
    y
      .positional("slug", { describe: "script slug", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) UI.empty()
    const token = await requireAuth()
    if (!token) return

    const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(String(args.slug))}/doctor`)
    if (!res.ok) return void (await handleApiError(res, `Doctor failed for '${args.slug}'`))

    const d = ((await res.json()) as any).data
    if (args.json) return void (await writeJson(d))

    console.log()
    console.log(`  ${bold(String(d.slug))}`)

    if (!d.requires?.length) {
      // Say this plainly. "No requirements" and "requirements we failed to parse" look the
      // same in a list of zero, and only one of them means the script routes anywhere.
      console.log(`  ${dim("declares no requirements — routes to any available node")}`)
    } else {
      console.log(`  ${dim("requires:")} ${d.requires.join(", ")}`)
    }

    // Parse errors first: an ignored directive is the likeliest reason a script is not routing
    // the way its author expects, and it is invisible everywhere else.
    for (const e of d.manifest_errors ?? []) {
      console.log(`  ${UI.Style.TEXT_WARNING}⚠ manifest: ${e}${UI.Style.TEXT_NORMAL}`)
    }

    console.log()
    for (const row of d.eligible ?? []) {
      console.log(`  ${success("✓")} ${bold(row.node)}  ${dim("can run this")}`)
    }
    for (const row of d.blocked ?? []) {
      console.log(`  ${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL} ${bold(row.node)}`)
      for (const u of row.verdict?.unmet ?? []) {
        console.log(`      ${dim(`${u.requirement} — ${u.reason}`)}`)
      }
    }

    console.log()
    // ELIGIBLE-BUT-OFFLINE IS NOT CAPACITY. A node that qualifies but is not online cannot run
    // anything, and reporting it as capacity would say the script is fine while nothing runs.
    if (d.runnable_now) {
      prompts.outro(`${success("✓")} runnable now on ${d.eligible_online} node(s)`)
    } else if ((d.eligible ?? []).length) {
      prompts.outro(`No node can run this RIGHT NOW — ${d.eligible.length} qualify but none are online`)
    } else {
      prompts.outro("No node can run this")
    }
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformScriptsCommand = cmd({
  command: "scripts",
  describe: "account-scoped, slug-addressed scripts that run on your Hive fleet",
  builder: (y) =>
    y.command(ListCmd).command(PushCmd).command(PullCmd).command(RunCmd).command(RmCmd).command(DoctorCmd).demandCommand(),
  async handler() {},
})
