// `iris hive trigger` — a signed URL another service calls to start a Hive task (#188301).
//
// The server holds the trigger (fl-iris-api: hive_triggers, POST /api/v1/hooks/{id}). This is the
// owner's side: create one, see them, delete one. The signing secret is printed ONCE, at creation,
// with the exact place to paste it in the sending service.

import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { requireAuth, requireUserId, writeJson, dim, bold, success, printKV, printDivider } from "./iris-api"
import { hiveFetch, resolveNode } from "./platform-hive-nodes"
import { readFileSync, existsSync } from "fs"

export const SCHEMES = ["github", "linear", "generic-sha256"] as const

/** Where the sender expects the URL and secret, said in its own words. */
export function setupHint(scheme: string, url: string): string[] {
  if (scheme === "github")
    return [
      "GitHub → your repo → Settings → Webhooks → Add webhook",
      `  Payload URL:   ${url}`,
      "  Content type:  application/json",
      "  Secret:        (the secret above)",
      "  Events:        pick the ones you want (e.g. Issues) — GitHub sends a ping first; that is not a task",
    ]
  if (scheme === "linear")
    return ["Linear → Settings → API → Webhooks → New webhook", `  URL: ${url}`, "  Signing secret: (the secret above)"]
  return [
    `POST ${url}`,
    "  Sign the raw body: X-Signature-256: sha256=<hex HMAC-SHA256 of the body, keyed by the secret above>",
    "  Optional X-Request-Id: the same id twice runs once",
  ]
}

/** A template is text, or a path to a file holding it. */
export function readTemplate(arg: string | undefined, exists = existsSync, read = (p: string) => readFileSync(p, "utf-8")): string | null {
  if (!arg || !arg.trim()) return null
  if (exists(arg)) return read(arg)
  return arg
}

const Create = cmd({
  command: "create <name>",
  describe: "create a webhook URL that starts a Hive task (prints the signing secret once)",
  builder: (y) =>
    y
      .positional("name", { type: "string", demandOption: true, describe: "a name you will recognise, e.g. 'issue triage'" })
      .option("from", { type: "string", choices: [...SCHEMES], default: "github", describe: "who signs the requests" })
      .option("template", {
        type: "string",
        demandOption: true,
        describe: "the prompt, or a file holding it — {{issue.title}}, {{repository.full_name}}, {{event}}, {{payload}}",
      })
      .option("type", { type: "string", default: "code_generation", describe: "Hive task type to run" })
      .option("node", { type: "string", describe: "pin to one node (it waits for the node if offline)" })
      .option("requires", { type: "array", describe: "only run on a node advertising this capability" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!args.json) { UI.empty(); prompts.intro("◈  Hive trigger") }
    if (!(await requireAuth())) { process.exitCode = 1; return }
    const userId = await requireUserId(undefined)
    if (!userId) { process.exitCode = 1; return }
    const template = readTemplate(args.template as string)
    if (!template) { prompts.log.error("--template is empty"); process.exitCode = 2; return }

    let nodeId: string | undefined
    if (args.node) {
      const node = await resolveNode(userId, String(args.node))
      if (!node) { prompts.log.error(`No node matching "${args.node}". Run: iris hive nodes list`); process.exitCode = 2; return }
      nodeId = node.id
    }
    const requires = (args.requires as string[] | undefined)?.length
      ? Object.fromEntries((args.requires as string[]).map((c) => [String(c), true]))
      : undefined

    const res = await hiveFetch("/api/v6/nodes/triggers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        user_id: userId,
        name: args.name,
        scheme: args.from,
        prompt_template: template,
        task_type: args.type,
        ...(nodeId ? { node_id: nodeId } : {}),
        ...(requires ? { required_capabilities: requires } : {}),
      }),
    })
    if (!res.ok) {
      const t = await res.text().catch(() => "")
      prompts.log.error(`Could not create the trigger (HTTP ${res.status}) ${t.slice(0, 200)}`)
      process.exitCode = 1
      if (!args.json) prompts.outro("Done")
      return
    }
    const d = ((await res.json()) as any)?.data ?? {}
    if (args.json) { await writeJson(d); return }
    printDivider()
    printKV("Trigger", `${bold(d.name)}  ${dim(d.id)}`)
    printKV("URL", d.url)
    printKV("Secret", `${d.secret}  ${dim("— shown once; store it in the sender now")}`)
    printKV("Runs", `${d.task_type}${nodeId ? ` on ${args.node} (waits if offline)` : " on any capable node"}`)
    printDivider()
    for (const l of setupHint(String(d.scheme), String(d.url))) console.log(`  ${l}`)
    prompts.outro(success("Created"))
  },
})

const List = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "your webhook triggers",
  builder: (y) => y.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) { process.exitCode = 1; return }
    const userId = await requireUserId(undefined)
    const res = await hiveFetch(`/api/v6/nodes/triggers?user_id=${userId}`)
    if (!res.ok) { console.error(`HTTP ${res.status}`); process.exitCode = 1; return }
    const rows: any[] = ((await res.json()) as any)?.data ?? []
    if (args.json) { await writeJson(rows); return }
    if (!rows.length) { console.log(dim("No triggers yet — iris hive trigger create <name> --from github --template '…'")); return }
    for (const t of rows)
      console.log(`  ${bold(t.name)}  ${dim(t.id)}  ${t.scheme}  fired ${t.fire_count}×${t.last_fired_at ? dim(` (last ${t.last_fired_at})`) : ""}\n    ${dim(t.url)}`)
  },
})

const Delete = cmd({
  command: "delete <id>",
  aliases: ["rm"],
  describe: "delete a webhook trigger (its URL stops working)",
  builder: (y) => y.positional("id", { type: "string", demandOption: true }),
  async handler(args) {
    if (!(await requireAuth())) { process.exitCode = 1; return }
    const userId = await requireUserId(undefined)
    const res = await hiveFetch(`/api/v6/nodes/triggers/${encodeURIComponent(String(args.id))}?user_id=${userId}`, { method: "DELETE" })
    if (!res.ok) { console.error(res.status === 404 ? `No trigger ${args.id}` : `HTTP ${res.status}`); process.exitCode = 1; return }
    console.log(success(`Deleted ${args.id} — its URL no longer starts anything.`))
  },
})

export const HiveTriggerCommand = cmd({
  command: "trigger <subcommand>",
  aliases: ["triggers"],
  describe: "webhook URLs that start Hive tasks — GitHub, Linear, or anything that signs its requests",
  builder: (y) => y.command(Create).command(List).command(Delete).demandCommand(1),
  async handler() {},
})
