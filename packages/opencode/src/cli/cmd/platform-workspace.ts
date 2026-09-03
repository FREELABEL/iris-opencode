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
  highlight, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"

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
      await writeJson(payload)
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
      if (ws.uses_external_infra) {
        console.log(`  ${success("🛡 Secure infra")} ${dim("— data on client/external backend (" + (ws.storage_driver || "byo") + "), not shared IRIS")}`)
      }
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
      await writeJson(ws)
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
      await writeJson(r)
      prompts.outro("Done")
      return
    }
    printDivider()
    console.log(`  ${dim("Directory users:")} ${r.directory_count ?? 0}`)
    console.log(`  ${success("Matched:")}  ${r.matched ?? 0}`)
    console.log(`  ${bold("Imported:")} ${r.imported ?? 0} ${dim("(new human agents)")}`)
    if ((r.attached ?? 0) > 0) console.log(`  ${dim("Attached:")} ${r.attached} ${dim("(existing agents re-homed, not duplicated)")}`)
    console.log(`  ${dim("IRIS-only:")} ${r.iris_only ?? 0}`)
    if ((r.import_failed ?? 0) > 0) console.log(`  ${bold("Import FAILED:")} ${r.import_failed} ${dim("(" + (r.import_failed_emails ?? []).join(", ") + ") — sync is PARTIAL")}`)
    if ((r.deprovisioned ?? 0) > 0) console.log(`  ${bold("Deprovisioned:")} ${r.deprovisioned} ${dim("(suspended/removed in Google → disabled)")}`)
    if ((r.reprovisioned ?? 0) > 0) console.log(`  ${dim("Reprovisioned:")} ${r.reprovisioned} ${dim("(re-enabled)")}`)
    console.log(`  ${dim("Suggestions:")} ${(r.suggestions?.length) ?? 0}`)
    printDivider()
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// workspace org <bloqId> — the reporting tree (humans + AI), provenance-tagged
// ----------------------------------------------------------------------------

/** Recursively print a node + its reports as an indented tree. */
function printOrgNode(node: any, prefix: string, isLast: boolean): void {
  const kind = node.is_human ? "👤" : "🤖"
  // provenance: synced = Google's truth (green ◆), iris = yours to arrange (purple ✦)
  const prov = node.provenance === "synced" ? success("◆") : highlight("✦")
  const meta = [node.title, node.department || node.org_unit].filter(Boolean).join(" · ")
  const branch = prefix === "" ? "" : isLast ? "└─ " : "├─ "
  console.log(`  ${prefix}${branch}${kind} ${bold(node.name)} ${prov}${meta ? dim(" " + meta) : ""}`)
  const kids = node.reports || []
  const childPrefix = prefix === "" ? "   " : prefix + (isLast ? "   " : "│  ")
  kids.forEach((child: any, i: number) => printOrgNode(child, childPrefix, i === kids.length - 1))
}

const OrgCommand = cmd({
  command: "org <bloqId>",
  aliases: ["tree", "chart"],
  describe: "print the Workforce org tree for a bloq (humans + AI, provenance-tagged)",
  builder: (yargs) =>
    yargs
      .positional("bloqId", { type: "number", demandOption: true })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Workspace · Org")
    const data = await call("Get org tree", `/api/v1/bloqs/${args.bloqId}/org`)
    if (!data) return
    const payload = data?.data ?? data
    if (args.json) {
      await writeJson(payload)
      prompts.outro("Done")
      return
    }
    printDivider()
    const tree: any[] = firstArray(payload?.tree)
    if (!tree.length) {
      console.log(`  ${dim("No agents on bloq")} #${args.bloqId}`)
    } else {
      tree.forEach((root, i) => printOrgNode(root, "", i === tree.length - 1))
    }
    printDivider()
    console.log(`  ${dim("Total:")} ${payload.count ?? 0} ${dim("·")} ${success(String(payload.synced_count ?? 0) + " synced")} ${dim("·")} ${highlight(String(payload.iris_count ?? 0) + " IRIS-owned")}`)
    console.log(`  ${dim("legend:")} ${success("◆")} ${dim("Google-synced")}  ${highlight("✦")} ${dim("IRIS-owned")}`)
    prompts.outro("Done")
  },
})

// ----------------------------------------------------------------------------
// workspace place <agentId> --under <managerAgentId> | --detach
// ----------------------------------------------------------------------------

const PlaceCommand = cmd({
  command: "place <agentId>",
  aliases: ["report"],
  describe: "place an agent under a manager (e.g. an AI teammate under a human) — IRIS-owned",
  builder: (yargs) =>
    yargs
      .positional("agentId", { type: "number", demandOption: true })
      .option("under", { type: "number", describe: "manager agent ID to report to" })
      .option("detach", { type: "boolean", default: false, describe: "remove the reporting link" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Workspace · Place")
    if (!args.detach && (args.under === undefined || args.under === null)) {
      console.log(`  ${dim("✗ pass --under <managerAgentId> (or --detach to remove the link)")}`)
      prompts.outro("Done")
      return
    }
    const managerId = args.detach ? null : args.under
    const data = await call("Place agent", `/api/v1/agents/${args.agentId}/manager`, {
      method: "POST",
      body: JSON.stringify({ manager_agent_id: managerId }),
    })
    if (!data) return
    const r = data?.data ?? data
    if (args.json) {
      await writeJson(r)
      prompts.outro("Done")
      return
    }
    printDivider()
    if (r.manager_agent_id) {
      console.log(`  ${success("✓ placed")} ${dim("agent")} #${args.agentId} ${dim("→ reports to")} #${r.manager_agent_id}`)
    } else {
      console.log(`  ${success("✓ detached")} ${dim("agent")} #${args.agentId} ${dim("(now a root)")}`)
    }
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
  describe: "Workspace (team) ↔ Google Workspace identity sync (show, bind, sync, org, place)",
  builder: (yargs) =>
    yargs
      .command(ShowCommand)
      .command(BindCommand)
      .command(SyncCommand)
      .command(OrgCommand)
      .command(PlaceCommand)
      .demandCommand(),
  async handler() {},
})
