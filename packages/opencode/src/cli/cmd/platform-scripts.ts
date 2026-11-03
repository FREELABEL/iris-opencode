import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, requireUserId, handleApiError, dim, bold, success, writeJson } from "./iris-api"
import { resolveNode } from "./platform-hive-nodes"
import { scriptTaskOutcome } from "./hive-script-result"
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

/** "board #12, #40" — the audience of a project-scoped script, or "" when it has none. */
export function boardList(bloqIds: unknown): string {
  const ids = Array.isArray(bloqIds) ? bloqIds.filter((b) => b != null) : []
  return ids.length ? `board${ids.length > 1 ? "s" : ""} ${ids.map((b) => `#${b}`).join(", ")}` : ""
}

/** The one-line tags after a script's slug: version, visibility, audience, where it routes. */
export function scriptTags(s: { version?: unknown; visibility?: unknown; bloq_ids?: unknown; runs_on?: unknown }): string {
  const parts: string[] = []
  if (s.version != null) parts.push(`v${s.version}`)
  if (s.visibility) parts.push(String(s.visibility))
  const boards = boardList(s.bloq_ids)
  if (boards) parts.push(boards)
  if (s.runs_on) parts.push(`runs-on ${s.runs_on}`)
  return parts.join(" · ")
}

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your saved scripts (--shared: scripts others shared with you through your boards)",
  builder: (y) =>
    y
      .option("shared", { describe: "scripts OTHER accounts shared with you through boards you belong to", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const res = await scriptsFetch(args.shared ? "/api/v1/scripts?shared=1" : "/api/v1/scripts")
    if (!res.ok) return void (await handleApiError(res, args.shared ? "List shared scripts" : "List scripts"))
    const json = (await res.json()) as { data?: any[] }
    const scripts = json.data ?? []
    if (args.json) return void await writeJson(scripts)

    if (args.shared) {
      if (!scripts.length) {
        prompts.log.info("Nobody has shared a script with a board you belong to.")
        return
      }
      console.log(bold("\nShared with you"))
      for (const s of scripts) {
        const tags = scriptTags(s)
        console.log(`  ${bold(s.slug)}  ${dim(`[${s.runtime}]`)}${tags ? dim(`  ${tags}`) : ""}${s.author_name ? dim(`  · by ${s.author_name}`) : ""}`)
        if (s.name && s.name !== s.slug) console.log(`    ${dim(s.name)}`)
        // Run it by id, not slug: a slug names a script within ONE account, and yours may share it.
        if (s.id) console.log(`    ${dim(`run: iris scripts run ${s.id}${s.version != null ? `@${s.version}` : ""}`)}`)
      }
      console.log()
      return
    }

    if (!scripts.length) {
      prompts.log.info("No scripts yet. Save one: iris scripts push <slug> <file>")
      return
    }
    console.log(bold("\nYour scripts"))
    for (const s of scripts) {
      const tags = scriptTags(s)
      console.log(`  ${bold(s.slug)}  ${dim(`[${s.runtime}]`)}${tags ? dim(`  ${tags}`) : ""}${s.auto_pull ? dim("  · auto-pull") : ""}`)
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
      .option("description", { describe: "one line for the marketplace card (default: the prose at the top of the file)", type: "string" })
      .option("auto-pull", { describe: "pre-fetch this script to every node on heartbeat", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const file = args.file as string
    if (!existsSync(file)) { process.exitCode = 1; return void prompts.log.error(`File not found: ${file}`) }
    const content = readFileSync(file, "utf8")
    const res = await scriptsFetch("/api/v1/scripts", {
      method: "POST",
      body: JSON.stringify({
        slug: args.slug,
        name: args.name,
        description: args.description,
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
    if (res.status === 404) { process.exitCode = 1; return void prompts.log.error(`Script '${args.slug}' not found`) }
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
    if (res.status === 404) { process.exitCode = 1; return void prompts.log.error(`Script '${args.slug}' not found`) }
    if (!res.ok) return void (await handleApiError(res, "Delete script"))
    success(`Deleted ${bold(String(args.slug))}`)
  },
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * What a `run` ref names: `slug`, `slug@3`, `<uuid>`, or `<uuid>@3` (a uuid is someone else's
 * shared script). The CLI does not resolve any of these — the SERVER does, pins the version and
 * decides whether the caller may run it — so this only answers one local question: is this a
 * plain slug of mine, whose current content we can fetch and hash ourselves?
 */
export function parseScriptRef(ref: string): { ref: string; base: string; version: string | null; uuid: boolean; plainSlug: boolean } {
  const at = ref.lastIndexOf("@")
  const base = at > 0 ? ref.slice(0, at) : ref
  const version = at > 0 ? ref.slice(at + 1) : null
  const uuid = UUID_RE.test(base)
  return { ref, base, version, uuid, plainSlug: !uuid && version === null }
}

const RunCmd = cmd({
  command: "run <slug>",
  describe: "run a script on a Hive node — <slug>, <slug>@<version>, or a shared script's <uuid>[@<version>]",
  builder: (y) =>
    y
      .positional("slug", { describe: "slug, slug@3, <uuid> or <uuid>@3", type: "string", demandOption: true })
      .option("node", { describe: "node name or id to run on (default: the script's `# iris: runs-on=`)", type: "string" })
      .option("timeout", { describe: "task timeout in seconds", type: "number", default: 120 })
      .option("queue", { describe: "dispatch and exit (don't wait for output)", type: "boolean", default: false })
      .option("json", { describe: "JSON output (full task)", type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const userId = await requireUserId()
    if (!userId) return

    // Every failure below sets process.exitCode. They used to log and return, so the shell saw 0
    // and `iris scripts run … && next` ran `next` after a failure (#186174).
    const fail = (msg: string, code = 1) => { prompts.log.error(msg); process.exitCode = code }
    const ref = parseScriptRef(String(args.slug))

    // --node is optional (#191674): a script that declares `# iris: runs-on=` is routed by the
    // SERVER, which parsed that header. The CLI must not second-guess or default it.
    let node: Awaited<ReturnType<typeof resolveNode>> = null
    if (args.node) {
      node = await resolveNode(userId, String(args.node))
      if (!node) return fail(`No node matching "${args.node}". Run: iris hive nodes list`)
      if (node.connection_status !== "online") {
        return fail(`Node "${node.name}" is ${node.connection_status} — cannot dispatch.`)
      }
    }

    const timeoutSec = Math.max(30, Math.min(3600, Number(args.timeout) || 120))

    // Resolve the slug to a CONTENT HASH before dispatching, and send that with the task. The
    // node then runs exactly this version or refuses — it never has to guess whether the copy
    // it cached weeks ago is still current. Non-fatal: an older API or a transient failure
    // just means no digest, and the daemon falls back to its previous behaviour while saying
    // the run was unverified.
    //
    // ONLY for a plain slug of mine. A `@version` or a uuid names content we did not fetch —
    // hashing the CURRENT copy of a slug would send the wrong digest for `slug@3`, and a shared
    // script is not ours to read. For those the server resolves the ref, pins the version, and
    // computes and signs the hash itself.
    let digest: string | null = null
    let runsOn: string | null | undefined
    if (ref.plainSlug) {
      try {
        const meta = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(ref.ref)}`)
        if (meta.ok) {
          const body = (await meta.json()) as { data?: { script_content?: string; runs_on?: string | null } }
          const content = body.data?.script_content
          if (typeof content === "string") digest = scriptDigest(content)
          if (body.data && "runs_on" in body.data) runsOn = body.data.runs_on || null
        }
      } catch { /* leave digest null — reported below rather than silently assumed */ }
    }
    // Refuse locally only when we KNOW there is nowhere to route: the script was read and
    // declares no runs-on. An unknown (older API, a shared or pinned ref) goes to the server,
    // which is the one that decides — and whose refusal is printed below as-is.
    if (!node && runsOn === null) {
      return fail(`'${ref.ref}' declares no \`# iris: runs-on=\` — say where to run it: --node <name>`)
    }

    if (!args.json) {
      const where = node ? bold(node.name) : `${bold(runsOn ? `runs-on ${runsOn}` : "its runs-on node")} ${dim("(routed by the server)")}`
      console.log(`${dim("→")} dispatching ${bold(ref.ref)} to ${where}`)
      console.log(digest
        ? dim(`   sha256 ${digest.slice(0, 12)}… — the node runs this exact version or refuses`)
        : ref.plainSlug
          ? dim("   could not resolve a content hash — this run will be UNVERIFIED")
          : dim("   the server pins this version and signs its hash"))
    }

    const createRes = await scriptsFetch("/api/v6/nodes/tasks", {
      method: "POST",
      body: JSON.stringify({
        user_id: userId,
        title: `iris scripts run: ${ref.ref}`,
        type: "user_script",
        ...(node ? { node_id: node.id } : {}),
        // The ref, UNCHANGED, in both places — the server resolves `slug@3` / `<uuid>` (#191674).
        // The daemon reads config.script_slug ?? prompt; script_slug stays for a plain slug only.
        prompt: ref.ref,
        config: {
          script_ref: ref.ref,
          ...(ref.plainSlug ? { script_slug: ref.ref } : {}),
          ...(digest ? { script_sha256: digest } : {}),
        },
        timeout_seconds: timeoutSec,
      }),
    })
    if (!createRes.ok) {
      const text = await createRes.text()
      // 422 is the server refusing THIS caller this script (not shared with you, version gone,
      // no node for its runs-on). Its message is written for the operator — print it as-is.
      if (createRes.status === 422) {
        let message: string | undefined
        try { message = (JSON.parse(text) as { message?: string }).message } catch { /* not JSON */ }
        return fail(message || text)
      }
      return fail(`Dispatch failed: ${createRes.status} ${text}`)
    }

    const created = (await createRes.json()) as { task: { id: string; status: string; node_id?: string; node_name?: string } }
    const taskId = created.task.id
    if (args.queue) return void success(`Dispatched task ${bold(taskId)}  (check: iris hive tasks get ${taskId})`)
    if (!args.json) console.log(dim("waiting for completion…"))

    const deadline = Date.now() + (timeoutSec + 30) * 1000
    const terminal = new Set(["succeeded", "completed", "failed", "cancelled", "timeout", "errored"])
    let final: any = null
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500))
      const r = await scriptsFetch(`/api/v6/nodes/tasks/${taskId}?user_id=${userId}`)
      if (!r.ok) return fail(`Poll failed: ${r.status} — the task was created; read it with: iris hive tasks ${taskId}`)
      const t = ((await r.json()) as { task: any }).task
      if (terminal.has(t.status)) {
        final = t
        break
      }
    }
    const outcome = scriptTaskOutcome(final)
    if (!final) return fail(`Timed out waiting for task ${taskId} — ${outcome.reason}`, outcome.exitCode)
    if (args.json) {
      await writeJson(final)
      process.exitCode = outcome.exitCode
      return
    }

    const out = final.result?.output ?? final.output ?? final.result?.stdout ?? ""
    // Server-routed runs: name the node the task actually landed on, as the task reports it.
    const ranOn = node?.name ?? final.node_name ?? final.node?.name ?? final.node_id ?? "its runs-on node"
    console.log()
    if (out) console.log(typeof out === "string" ? out : JSON.stringify(out, null, 2))
    if (outcome.exitCode === 0) return void success(`${bold(ref.ref)} ran on ${ranOn}`)
    // The daemon's reason was in the task all along and never printed: "Script failed" with no why.
    fail(`Script ${final.status} on ${ranOn}${outcome.reason ? `: ${outcome.reason}` : ""}`, outcome.exitCode)
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
// publish / unpublish / share / unshare — the same shape as `iris playbook publish` / `unpublish`
// ============================================================================

export type ScriptScope = "project" | "unlisted" | "public"

/**
 * The publish body, or the reason there is none. `project` with no board would be a script
 * shared with nobody — the server refuses it, and so does this, before any request, in the
 * same words as `iris playbook publish --scope project`.
 */
export function publishBody(scope: ScriptScope, bloqs: unknown[]): { body: { visibility: ScriptScope; bloq_ids?: number[] } } | { error: string } {
  const ids = bloqs.map(Number)
  if (ids.some((n) => !Number.isInteger(n) || n <= 0)) return { error: "--bloq takes a numeric bloq (project) id" }
  if (scope === "project" && !ids.length) return { error: "--bloq <id> is required when --scope project" }
  return { body: { visibility: scope, ...(ids.length ? { bloq_ids: [...new Set(ids)] } : {}) } }
}

/**
 * Whether a publish may proceed, and whether it must ask first.
 *
 * Consent follows the DIRECTION of the change, as it does for playbooks. Making a script public
 * is the irreversible one — anyone can read its source and run it, and a copy taken cannot be
 * recalled — so it asks at a terminal and needs `--force` without one. With neither, it is
 * REFUSED rather than allowed: an agent or a CI job must not be able to make something public by
 * omission. `unlisted` appears in no listing and `project` reaches only signed-in board members;
 * neither asks.
 */
export function publishGate(o: { scope: ScriptScope; force: boolean; interactive: boolean }): "go" | "ask" | "refuse" {
  if (o.scope !== "public") return "go"
  if (o.force) return "go"
  return o.interactive ? "ask" : "refuse"
}

/**
 * Who can open a script at a given visibility, in words.
 *
 * Anything unrecognised reads as PRIVATE, matching the server (UserScript::normalizeVisibility):
 * the failure worth designing against is a typo that describes something as public.
 */
export function scriptReach(visibility: string, bloqIds: unknown = []): string {
  switch (visibility) {
    case "public": return "Anyone — listed in the marketplace, no sign-in needed"
    case "unlisted": return "Anyone with the link — it appears in no listing"
    case "project": return `Signed-in members of ${boardList(bloqIds) || "board #?"} only`
    default: return "Only you"
  }
}

/** A refusal that names its cause — a missing script and a bad manifest need different fixes. */
export function publishFailure(status: number, body: { error?: string; message?: string; errors?: unknown }, slug: string): string {
  if (status === 404) return `No script named '${slug}'. See: iris scripts list`
  if (status === 422) {
    const why = body.error || body.message || "The server refused it."
    const list = Array.isArray(body.errors) ? body.errors.map((e) => `\n    - ${typeof e === "string" ? e : JSON.stringify(e)}`).join("") : ""
    return `${why}${list}`
  }
  return `HTTP ${status}${body.message || body.error ? ` — ${body.message || body.error}` : ""}`
}

/** Read for REPORTING only — never as a gate (see the note in UnpublishCmd). */
async function currentVisibility(slug: string): Promise<string> {
  const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(slug)}`).catch(() => null)
  if (!res || !res.ok) return "unknown"
  const json = (await res.json().catch(() => ({}))) as { data?: { visibility?: string } }
  return json.data?.visibility ?? "private"
}

const MARKETPLACE_URL = "https://heyiris.io/p/hive-scripts"

const PublishCmd = cmd({
  command: "publish <slug>",
  describe: "publish a saved script: --scope project | unlisted | public (public lists it in the Hive marketplace)",
  builder: (y) =>
    y
      .positional("slug", { describe: "script slug", type: "string", demandOption: true })
      .option("scope", {
        type: "string",
        choices: ["project", "unlisted", "public"] as const,
        demandOption: true,
        describe:
          "project (members of the --bloq board(s), sign-in required), unlisted (anyone with the link, in no listing), " +
          "or public (the Hive marketplace)",
      })
      .option("bloq", { type: "array", default: [], describe: "bloq (project) id — required when --scope project (repeatable)" })
      .option("force", { type: "boolean", default: false, describe: "consent to a PUBLIC publish — REQUIRED when there is no terminal" })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const slug = String(args.slug)
    const scope = args.scope as ScriptScope
    const built = publishBody(scope, (args.bloq as unknown[]) ?? [])
    if ("error" in built) {
      process.exitCode = 1
      return void prompts.log.error(built.error)
    }

    const gate = publishGate({ scope, force: Boolean(args.force), interactive: Boolean(process.stdin.isTTY && process.stdout.isTTY) })
    if (gate === "refuse") {
      process.exitCode = 1
      return void prompts.log.error(
        `Refusing to make '${slug}' public without consent. There is no terminal to ask at — pass --force if that is what you mean.`,
      )
    }
    if (gate === "ask") {
      const ok = await prompts.confirm({
        message: `Publish '${slug}' to the PUBLIC Hive marketplace? Anyone will be able to read its source and run it.`,
        initialValue: false,
      })
      if (prompts.isCancel(ok) || !ok) {
        process.exitCode = 1
        return void prompts.log.info("Nothing published.")
      }
    }

    const before = await currentVisibility(slug)
    const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(slug)}/publish`, {
      method: "POST",
      body: JSON.stringify(built.body),
    })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as any
      process.exitCode = 1
      return void prompts.log.error(`Could not publish: ${publishFailure(res.status, body, slug)}`)
    }
    const json = (await res.json().catch(() => ({}))) as { data?: { visibility?: string; name?: string; bloq_ids?: number[]; version?: number; id?: string } }
    const now = json.data?.visibility ?? scope
    const bloqIds = json.data?.bloq_ids ?? built.body.bloq_ids ?? []
    // A project script has no anonymous source link — the public endpoint would 404 for it, and
    // a link that looks shareable but is not is worse than none (same rule as `playbook share`).
    const url = now === "project" ? null : `https://heyiris.io/api/v1/public/scripts/${slug}`

    if (args.json) return void (await writeJson({ slug, was: before, visibility: now, changed: before !== now, bloq_ids: bloqIds, version: json.data?.version ?? null, id: json.data?.id ?? null, url, marketplace: now === "public" ? MARKETPLACE_URL : null }))

    console.log()
    console.log(`  ${success("✓")} ${bold(slug)} is now ${bold(now)}${before === now || before === "unknown" ? "" : dim(` (was ${before})`)}`)
    console.log(`  ${dim(scriptReach(now, bloqIds))}`)
    if (json.data?.version != null) console.log(`  ${dim("Version:")}   v${json.data.version}`)
    if (now === "public") console.log(`  ${dim("Listed at:")} ${MARKETPLACE_URL}`)
    if (url) console.log(`  ${dim("Source:")}    ${url}`)
    if (now === "project" && json.data?.id) console.log(`  ${dim("Members run it with:")} iris scripts run ${json.data.id}`)
    console.log()
    console.log(`  ${dim("Take it back out of view:")} iris scripts unpublish ${slug}`)
  },
})

/**
 * Take a published script back out of view.
 *
 * IT DOES NOT UNDO A PUBLISH, and the output says so — same honesty as `iris playbook
 * unpublish`. Anyone who already pulled it has it. What changes is what happens NEXT: it leaves
 * the marketplace and stops resolving for anyone but you.
 *
 * Narrowing asks nothing: the gate on publish exists because widening is the irreversible
 * direction, and this one only ever removes reach. `before` is read for the WORDING, never as a
 * gate — a lookup that fails must not turn into "already private, nothing to do" and leave a
 * public script public. The write happens regardless.
 */
const UnpublishCmd = cmd({
  command: "unpublish <slug>",
  describe: "take a script out of the marketplace — narrows it back to private (does NOT un-send it)",
  builder: (y) =>
    y
      .positional("slug", { describe: "script slug", type: "string", demandOption: true })
      .option("json", { type: "boolean", default: false, describe: "JSON output" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const slug = String(args.slug)
    const before = await currentVisibility(slug)

    const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(slug)}/unpublish`, { method: "POST" })
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as any
      process.exitCode = 1
      return void prompts.log.error(`Could not unpublish: ${publishFailure(res.status, body, slug)}`)
    }

    if (args.json) return void (await writeJson({ slug, was: before, visibility: "private", changed: before !== "private" }))

    console.log()
    console.log(`  ${success("✓")} ${bold(slug)} is now ${bold("private")}${before === "private" || before === "unknown" ? "" : dim(` (was ${before})`)}`)
    console.log(`  ${dim("Delisted, and no longer readable by anyone but you.")}`)
    if (before === "public" || before === "unlisted") {
      console.log()
      console.log(`  ${dim("This does NOT un-send it. Anyone who already pulled it still has their copy.")}`)
      console.log(`  ${dim("Change what matters — credentials, ids, internal names — rather than relying on this.")}`)
    }
    console.log()
  },
})

/**
 * Add a board to a script's audience, or take one away — `--bloq` names it as on `publish`.
 *
 * share widens a PRIVATE script to `project` (the server does that move); it never widens past
 * project, so it asks nothing — the members of a board you belong to are a bounded audience,
 * the same reasoning that lets `unlisted` skip the prompt. unshare only removes reach.
 */
function audienceCmd(verb: "share" | "unshare") {
  return cmd({
    command: `${verb} <slug>`,
    describe: verb === "share"
      ? "share a script with a board's members (a private script becomes project-scoped)"
      : "stop sharing a script with a board (does NOT un-send copies already pulled)",
    builder: (y) =>
      y
        .positional("slug", { describe: "script slug", type: "string", demandOption: true })
        .option("bloq", { type: "number", demandOption: true, describe: "bloq (project) id" })
        .option("json", { type: "boolean", default: false, describe: "JSON output" }),
    async handler(args) {
      if (!(await requireAuth())) return
      const slug = String(args.slug)
      const bloq = Number(args.bloq)
      if (!Number.isInteger(bloq) || bloq <= 0) {
        process.exitCode = 1
        return void prompts.log.error("--bloq takes a numeric bloq (project) id")
      }

      const res = await scriptsFetch(`/api/v1/scripts/${encodeURIComponent(slug)}/${verb}`, {
        method: "POST",
        body: JSON.stringify({ bloq_id: bloq }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as any
        process.exitCode = 1
        return void prompts.log.error(`Could not ${verb}: ${publishFailure(res.status, body, slug)}`)
      }
      const json = (await res.json().catch(() => ({}))) as { data?: { visibility?: string; bloq_ids?: number[]; id?: string; version?: number } }
      const visibility = json.data?.visibility ?? "unknown"
      const bloqIds = json.data?.bloq_ids ?? []

      if (args.json) return void (await writeJson({ slug, bloq_id: bloq, visibility, bloq_ids: bloqIds, id: json.data?.id ?? null, version: json.data?.version ?? null }))

      console.log()
      console.log(verb === "share"
        ? `  ${success("✓")} ${bold(slug)} is shared with board #${bloq} — now ${bold(visibility)}`
        : `  ${success("✓")} ${bold(slug)} is no longer shared with board #${bloq} — now ${bold(visibility)}`)
      console.log(`  ${dim(scriptReach(visibility, bloqIds))}`)
      if (verb === "share" && json.data?.id) console.log(`  ${dim("Members run it with:")} iris scripts run ${json.data.id}`)
      if (verb === "unshare") console.log(`  ${dim("This does NOT un-send it. Members who already pulled it still have their copy.")}`)
      console.log()
    },
  })
}

const ShareCmd = audienceCmd("share")
const UnshareCmd = audienceCmd("unshare")

// ============================================================================
// Root
// ============================================================================

export const PlatformScriptsCommand = cmd({
  command: "scripts",
  describe: "account-scoped, slug-addressed scripts that run on your Hive fleet",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(PushCmd)
      .command(PullCmd)
      .command(RunCmd)
      .command(RmCmd)
      .command(DoctorCmd)
      .command(PublishCmd)
      .command(UnpublishCmd)
      .command(ShareCmd)
      .command(UnshareCmd)
      .demandCommand(),
  async handler() {},
})
