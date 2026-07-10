import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  handleApiError,
  printDivider,
  dim,
  bold,
  success,
  highlight,
} from "./iris-api"

// ============================================================================
// iris workspace — Workspace (team) ↔ Google Workspace identity sync, from the CLI
//
// Parity with the Elon agents tab (AITeamPanel "Sync Workspace" button) over
// WorkspaceController — all bloq-scoped, owner-authed server-side:
//   GET  /api/v1/bloqs/{id}/workspace         → getForBloq   (show)
//   POST /api/v1/bloqs/{id}/workspace         → bindForBloq  (bind)
//   POST /api/v1/bloqs/{id}/workspace/sync    → syncForBloq  (sync)
//
// A Workspace binds 1:1 to a bloq (bloq_id) and optionally 1:1 to a managed Google
// Workspace domain. Sync matches the team's agents to the directory BY EMAIL and
// (by default) imports the Google employees as human agents. One-way, Google → IRIS.
// ============================================================================

/** Run an authed request, honour --json, surface API errors consistently. */
async function call(action: string, path: string, init: RequestInit = {}): Promise<any | null> {
  const token = await requireAuth()
  if (!token) {
    prompts.outro("Done")
    return null
  }
  const res = await irisFetch(path, init)
  const ok = await handleApiError(res, action)
  if (!ok) {
    prompts.outro("Done")
    return null
  }
  return (await res.json()) as any
}

// ----------------------------------------------------------------------------
// workspace show <bloqId>
// ----------------------------------------------------------------------------

const ShowCommand = cmd({
  command: "show <bloqId>",
  aliases: ["status", "get"],
  describe: "show the Workspace bound to a bloq + Google sync status",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Workspace · Show")
    const data = await call("Get workspace", `/api/v1/bloqs/${args.bloqId}/workspace`)
    if (!data) return
    const payload = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    const ws = payload?.workspace
    if (!ws) {
      console.log(`  ${dim("No workspace bound to bloq")} #${args.bloqId}`)
      console.log(`  ${dim("bind one:")} ${highlight(`iris workspace bind ${args.bloqId} --domain <domain> --admin <admin-email>`)}`)
    } else {
      console.log(`  ${bold(ws.name)}  ${dim("#" + ws.id)}`)
      console.log(`  ${dim("Google domain:")} ${ws.google_workspace_domain || dim("(not bound)")}`)
      console.log(`  ${dim("Bound:")} ${payload.bound ? success("yes") : dim("no")}`)
      console.log(`  ${dim("Agents:")} ${payload.matched_agents ?? 0} matched ${dim("/")} ${payload.total_agents ?? 0} total`)
      console.log(`  ${dim("Last synced:")} ${ws.google_synced_at || dim("never")}`)
      if (payload.bound) {
        console.log(`  ${dim("sync now:")} ${highlight(`iris workspace sync ${args.bloqId}`)}`)
      }
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// workspace bind <bloqId> --domain --admin [--name]
// ----------------------------------------------------------------------------

const BindCommand = cmd({
  command: "bind <bloqId>",
  aliases: ["create", "connect"],
  describe: "create/bind a Workspace for a bloq (optionally to a Google Workspace domain)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("domain", { type: "string", describe: "managed Google Workspace domain (e.g. mypathwaysai.com)" })
      .option("admin", { type: "string", describe: "a super-admin email to impersonate (required with --domain)" })
      .option("name", { type: "string", describe: "workspace name (defaults to the bloq name)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Workspace · Bind")
    if (args.domain && !args.admin) {
      console.log(`  ${dim("✗ --admin <super-admin email> is required when binding --domain")}`)
      prompts.outro("Done")
      return
    }
    const body: Record<string, unknown> = {}
    if (args.name) body.name = args.name
    if (args.domain !== undefined) {
      body.google_workspace_domain = args.domain
      body.google_workspace_admin_email = args.admin
    }
    const data = await call("Bind workspace", `/api/v1/bloqs/${args.bloqId}/workspace`, {
      method: "POST",
      body: JSON.stringify(body),
    })
    if (!data) return
    const ws = (data?.data ?? data)?.workspace
    if (args.json) {
      console.log(JSON.stringify(ws, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${success("✓ bound")} ${bold(ws?.name)} ${dim("#" + ws?.id)} ${dim("→ bloq")} #${args.bloqId}`)
    if (ws?.google_workspace_domain) {
      console.log(`  ${dim("Google domain:")} ${ws.google_workspace_domain} ${ws.has_google_binding ? success("(ready to sync)") : dim("(no admin)")}`)
      console.log(`  ${dim("next:")} ${highlight(`iris workspace sync ${args.bloqId}`)}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// workspace sync <bloqId> [--no-import]
// ----------------------------------------------------------------------------

const SyncCommand = cmd({
  command: "sync <bloqId>",
  describe: "match agents to the Google directory by email + import the employees",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("import", { type: "boolean", default: true, describe: "import unmatched Google employees as agents (default on; --no-import to skip)" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Workspace · Sync")
    const data = await call("Sync workspace", `/api/v1/bloqs/${args.bloqId}/workspace/sync`, {
      method: "POST",
      body: JSON.stringify({ import: !!args.import }),
    })
    if (!data) return
    const r = data?.data ?? data
    if (args.json) {
      console.log(JSON.stringify(r, null, 2))
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${dim("Directory users:")} ${r.directory_count ?? 0}`)
    console.log(`  ${success("Matched:")}  ${r.matched ?? 0}`)
    console.log(`  ${bold("Imported:")} ${r.imported ?? 0} ${dim("(new human agents)")}`)
    console.log(`  ${dim("IRIS-only:")} ${r.iris_only ?? 0}`)
    console.log(`  ${dim("Suggestions:")} ${(r.suggestions?.length) ?? 0}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// Parent command
// ----------------------------------------------------------------------------

export const PlatformWorkspaceCommand = cmd({
  command: "workspace",
  aliases: ["workspaces", "ws"],
  describe: "Workspace (team) ↔ Google Workspace identity sync (show, bind, sync)",
  builder: (yargs) =>
    yargs
      .command(ShowCommand)
      .command(BindCommand)
      .command(SyncCommand)
      .demandCommand(),
  async handler() {},
})
