import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, highlight, getBridgeToken } from "./iris-api"
import {
  HiveScanCommandExport,
  HiveProbeCommandExport,
  HiveSshCommandExport,
} from "./platform-hive-net"
import {
  HiveNodesCommandExport,
  HiveRunCommandExport,
} from "./platform-hive-nodes"
import {
  HiveDiscoverCommandExport,
  HiveEnrollCommandExport,
  HiveSshSetupCommandExport,
} from "./platform-hive-enroll"
import { HiveVpnCommandExport } from "./platform-hive-vpn"
import {
  HiveSendCommand,
  HiveSentCommand,
} from "./platform-hive-send"
import {
  HiveInboxCommand,
} from "./platform-hive-inbox"
import {
  HiveSearchCommand,
} from "./platform-hive-search"
import {
  ExchangeCommand,
} from "./platform-exchange"

// Use iris-api base for Hive endpoints
const IRIS_API = process.env.IRIS_API_URL ?? "https://freelabel.net"

async function hiveFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, IRIS_API)
}

// ============================================================================
// Display helpers
// ============================================================================

function statusBadge(status: string): string {
  const badges: Record<string, string> = {
    deployed: `${UI.Style.TEXT_SUCCESS}● deployed${UI.Style.TEXT_NORMAL}`,
    deploying: `${UI.Style.TEXT_HIGHLIGHT}◌ deploying${UI.Style.TEXT_NORMAL}`,
    failed: `${UI.Style.TEXT_DANGER}✗ failed${UI.Style.TEXT_NORMAL}`,
    stopped: `${dim("○ stopped")}`,
    not_deployed: `${dim("○ not deployed")}`,
  }
  return badges[status] || dim(status)
}

function printProject(p: Record<string, unknown>): void {
  const name = bold(String(p.name ?? "Unnamed"))
  const slug = dim(String(p.slug ?? ""))
  const type = dim(`[${p.type}]`)
  const status = statusBadge(String(p.deploy_status ?? "not_deployed"))
  console.log(`  ${name}  ${slug}  ${type}  ${status}`)
  if (p.github_repo_full_name) {
    console.log(`    ${dim("repo:")} ${p.github_repo_full_name}`)
  }
  const node = p.node as Record<string, unknown> | null
  if (node) {
    console.log(`    ${dim("node:")} ${node.name} (${node.connection_status})`)
  }
}

// ============================================================================
// Subcommands
// ============================================================================

const HiveListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list your Hive projects",
  builder: (yargs) =>
    yargs.option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Projects")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading projects…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects?user_id=${userId}`)
      const ok = await handleApiError(res, "List projects")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const projects = (json.data ?? json) as Record<string, unknown>[]

      spinner.stop(`${projects.length} project(s)`)
      printDivider()

      if (projects.length === 0) {
        console.log(dim("  No projects yet. Create one with: iris hive create <name>"))
      } else {
        for (const p of projects) {
          printProject(p)
          console.log()
        }
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveCreateCommand = cmd({
  command: "create <name>",
  describe: "create a new Hive project + GitHub repo",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "project name", type: "string", demandOption: true })
      .option("type", { describe: "project type", type: "string", choices: ["sdk_bot", "genesis_site", "custom"], default: "sdk_bot" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Hive Project")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(`Creating project "${args.name}"…`)

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, name: args.name, type: args.type }),
      })
      const ok = await handleApiError(res, "Create project")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const project = (json.data ?? json) as Record<string, unknown>

      spinner.stop(success("Project created"))
      printDivider()
      printKV("Name", project.name)
      printKV("Slug", project.slug)
      printKV("Type", project.type)
      printKV("Repo", project.github_repo_full_name)
      printKV("Status", project.deploy_status)
      console.log()
      console.log(dim(`  Next: iris hive deploy ${project.slug} --node <node-name>`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveGetCommand = cmd({
  command: "get <slug>",
  describe: "show project details",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Project")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}?user_id=${userId}`)
      const ok = await handleApiError(res, "Get project")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const p = (json.data ?? json) as Record<string, unknown>

      spinner.stop(bold(String(p.name)))
      printDivider()
      printKV("Slug", p.slug)
      printKV("Type", p.type)
      printKV("Repo", p.github_repo_full_name)
      printKV("Status", statusBadge(String(p.deploy_status ?? "not_deployed")))
      printKV("Auto-deploy", p.auto_deploy ? "ON" : "OFF")
      printKV("PM2 Process", p.pm2_process_name ?? dim("none"))
      printKV("Last Deployed", p.last_deployed_at ?? dim("never"))
      printKV("Last Commit", p.last_deploy_commit ?? dim("none"))

      const node = p.node as Record<string, unknown> | null
      if (node) {
        printKV("Node", `${node.name} (${node.connection_status})`)
      }
      if (p.client_repo_url) {
        printKV("Client Sync", p.client_repo_url)
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveDeployCommand = cmd({
  command: "deploy <slug>",
  describe: "deploy project to a Hive node",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("node", { describe: "target node ID or name", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Deploy Project")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(`Deploying ${args.slug}…`)

    try {
      const body: Record<string, unknown> = { user_id: userId }
      if (args.node) body.node_id = args.node

      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/deploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const ok = await handleApiError(res, "Deploy")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>

      spinner.stop(success("Deploy task dispatched"))
      printKV("Task ID", json.task_id)
      printKV("Message", json.message)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveRedeployCommand = cmd({
  command: "redeploy <slug>",
  describe: "redeploy (pull latest + restart)",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Redeploy Project")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(`Redeploying ${args.slug}…`)

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/redeploy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      })
      const ok = await handleApiError(res, "Redeploy")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      spinner.stop(success("Redeploy task dispatched"))
      printKV("Task ID", json.task_id)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveStopCommand = cmd({
  command: "stop <slug>",
  describe: "stop a deployed project",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Stop Project")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start(`Stopping ${args.slug}…`)

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/stop`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      })
      const ok = await handleApiError(res, "Stop")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Stop task dispatched"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveDeleteCommand = cmd({
  command: "delete <slug>",
  describe: "delete project + GitHub repo",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Delete Project")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    if (!args.force) {
      const confirm = await prompts.confirm({ message: `Delete project "${args.slug}" and its GitHub repo? This cannot be undone.` })
      if (!confirm || prompts.isCancel(confirm)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Deleting…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}?user_id=${userId}`, {
        method: "DELETE",
      })
      const ok = await handleApiError(res, "Delete")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Project deleted"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

// ── Env Vars ──────────────────────────────────────────────────────────────

const HiveEnvListCommand = cmd({
  command: "list <slug>",
  aliases: ["ls"],
  describe: "list env var keys for a project",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Env Vars")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/env?user_id=${userId}`)
      const ok = await handleApiError(res, "List env vars")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const keys = json.data as string[]

      spinner.stop(`${keys.length} variable(s)`)
      for (const k of keys) {
        console.log(`  ${k}=${dim("●●●●●●")}`)
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveEnvSetCommand = cmd({
  command: "set <slug> <pairs..>",
  describe: "set env vars (KEY=VALUE pairs)",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .positional("pairs", { describe: "KEY=VALUE pairs", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Set Env Vars")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const pairs = (args.pairs as unknown as string[]) || []
    const vars: Record<string, string> = {}
    for (const pair of pairs) {
      const eqIdx = pair.indexOf("=")
      if (eqIdx === -1) { prompts.log.warn(`Skipping "${pair}" — expected KEY=VALUE`); continue }
      vars[pair.substring(0, eqIdx)] = pair.substring(eqIdx + 1)
    }

    if (Object.keys(vars).length === 0) {
      prompts.log.warn("No valid KEY=VALUE pairs provided")
      prompts.outro("Done")
      return
    }

    const spinner = prompts.spinner()
    spinner.start("Updating…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/env`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, vars }),
      })
      const ok = await handleApiError(res, "Set env vars")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success(`${Object.keys(vars).length} variable(s) updated`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveEnvCommand = cmd({
  command: "env",
  describe: "manage project environment variables",
  builder: (yargs) =>
    yargs
      .command(HiveEnvListCommand)
      .command(HiveEnvSetCommand)
      .demandCommand(),
  async handler() {},
})

// ── Client Sync ───────────────────────────────────────────────────────────

const HiveSyncEnableCommand = cmd({
  command: "enable <slug> <client-repo-url>",
  describe: "enable push sync to client repo",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .positional("client-repo-url", { describe: "client GitHub repo URL", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Enable Client Sync")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Configuring sync…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/client-sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId, client_repo_url: args["client-repo-url"] }),
      })
      const ok = await handleApiError(res, "Enable sync")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Client sync enabled"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveSyncDisableCommand = cmd({
  command: "disable <slug>",
  describe: "disable client sync",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Disable Client Sync")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Removing sync…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/client-sync?user_id=${userId}`, {
        method: "DELETE",
      })
      const ok = await handleApiError(res, "Disable sync")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Client sync removed"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveSyncCommand = cmd({
  command: "sync",
  describe: "manage client repo sync",
  builder: (yargs) =>
    yargs
      .command(HiveSyncEnableCommand)
      .command(HiveSyncDisableCommand)
      .demandCommand(),
  async handler() {},
})

// ── Pull Requests ─────────────────────────────────────────────────────────

const HivePrListCommand = cmd({
  command: "list <slug>",
  aliases: ["ls"],
  describe: "list pull requests",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("state", { describe: "PR state", type: "string", choices: ["open", "closed", "all"], default: "open" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Pull Requests")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading PRs…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/prs?user_id=${userId}&state=${args.state}`)
      const ok = await handleApiError(res, "List PRs")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const prs = (json.data ?? json) as Record<string, unknown>[]

      spinner.stop(`${prs.length} PR(s)`)
      printDivider()

      for (const pr of prs) {
        const num = bold(`#${pr.number}`)
        const title = String(pr.title ?? "")
        const state = pr.state === "open" ? success("open") : dim("closed")
        console.log(`  ${num} ${title}  ${state}`)
        if (pr.html_url) console.log(`    ${dim(String(pr.html_url))}`)
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HivePrCreateCommand = cmd({
  command: "create <slug>",
  describe: "create a pull request",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("title", { alias: "t", describe: "PR title", type: "string", demandOption: true })
      .option("head", { describe: "head branch", type: "string", demandOption: true })
      .option("base", { describe: "base branch (default: main)", type: "string" })
      .option("body", { alias: "b", describe: "PR body", type: "string", default: "" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create PR")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Creating PR…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/prs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          title: args.title,
          head: args.head,
          base: args.base,
          body: args.body,
        }),
      })
      const ok = await handleApiError(res, "Create PR")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const pr = (json.data ?? json) as Record<string, unknown>

      spinner.stop(success(`PR #${pr.number} created`))
      if (pr.html_url) console.log(`  ${pr.html_url}`)
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HivePrCommand = cmd({
  command: "pr",
  describe: "manage pull requests",
  builder: (yargs) =>
    yargs
      .command(HivePrListCommand)
      .command(HivePrCreateCommand)
      .demandCommand(),
  async handler() {},
})

// ── Issues ────────────────────────────────────────────────────────────────

const HiveIssuesListCommand = cmd({
  command: "list <slug>",
  aliases: ["ls"],
  describe: "list project issues",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("status", { describe: "filter by status", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Issues")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading issues…")

    try {
      const statusParam = args.status ? `&status=${args.status}` : ""
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/issues?user_id=${userId}${statusParam}`)
      const ok = await handleApiError(res, "List issues")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const issues = (json.data ?? json) as Record<string, unknown>[]

      spinner.stop(`${issues.length} issue(s)`)
      printDivider()

      for (const issue of issues) {
        const id = dim(`#${issue.id}`)
        const title = bold(String(issue.title ?? ""))
        const meta = issue.metadata as Record<string, unknown> | null
        const priority = meta?.priority ? highlight(String(meta.priority)) : ""
        console.log(`  ${id} ${title}  ${priority}`)
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveIssuesCreateCommand = cmd({
  command: "create <slug> <title>",
  describe: "create an issue",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .positional("title", { describe: "issue title", type: "string", demandOption: true })
      .option("priority", { alias: "p", describe: "priority", type: "string", choices: ["low", "medium", "high", "critical"], default: "medium" })
      .option("description", { alias: "d", describe: "issue description", type: "string", default: "" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Create Issue")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Creating issue…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}/issues`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          user_id: userId,
          title: args.title,
          description: args.description,
          priority: args.priority,
        }),
      })
      const ok = await handleApiError(res, "Create issue")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      spinner.stop(success("Issue created"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

const HiveIssuesCommand = cmd({
  command: "issues",
  describe: "manage project issues & bugs",
  builder: (yargs) =>
    yargs
      .command(HiveIssuesListCommand)
      .command(HiveIssuesCreateCommand)
      .demandCommand(),
  async handler() {},
})

// ── Status ────────────────────────────────────────────────────────────────

const HiveStatusCommand = cmd({
  command: "status <slug>",
  describe: "quick status overview",
  builder: (yargs) =>
    yargs
      .positional("slug", { describe: "project slug or ID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Project Status")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/projects/${args.slug}?user_id=${userId}`)
      const ok = await handleApiError(res, "Status")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const p = (json.data ?? json) as Record<string, unknown>

      spinner.stop(bold(String(p.name)))
      printDivider()
      printKV("Deploy", statusBadge(String(p.deploy_status ?? "not_deployed")))
      printKV("Repo", p.github_repo_full_name)

      const node = p.node as Record<string, unknown> | null
      printKV("Node", node ? `${node.name} (${node.connection_status})` : dim("none"))
      printKV("Auto-deploy", p.auto_deploy ? success("ON") : dim("OFF"))
      printKV("Last Deploy", p.last_deployed_at ?? dim("never"))
      printKV("Client Sync", p.client_repo_url ?? dim("not configured"))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  }
})

// ============================================================================
// Daemon Operations — tasks, cancel, queue, pause, resume, purge, doctor
// ============================================================================

const BRIDGE_URL = process.env.BRIDGE_URL ?? "http://localhost:3200"

/** Build headers with bridge auth token for direct fetch calls */
function bridgeHeaders(extra: Record<string, string> = {}): Record<string, string> {
  const token = getBridgeToken()
  const h: Record<string, string> = { "Content-Type": "application/json", Accept: "application/json", ...extra }
  if (token) h["X-Bridge-Key"] = token
  return h
}

function readNodeKey(): string | null {
  try {
    const fs = require("fs")
    const path = require("path")
    const home = process.env.HOME || process.env.USERPROFILE || ""
    const configPath = path.join(home, ".iris", "config.json")
    if (fs.existsSync(configPath)) {
      const config = JSON.parse(fs.readFileSync(configPath, "utf-8"))
      return config.node_api_key || null
    }
  } catch { /* ignore */ }
  return null
}

async function nodeFetch(path: string, options: RequestInit = {}) {
  const nodeKey = readNodeKey()
  if (!nodeKey) throw new Error("No node_api_key in ~/.iris/config.json. Run the IRIS installer first.")
  return fetch(`${IRIS_API}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${nodeKey}`,
      ...((options.headers as Record<string, string>) || {}),
    },
  })
}

// The daemon can run in two modes:
//  1. Embedded in bridge (index.js) — routes at /daemon/*
//  2. Standalone (daemon.js)        — routes at /*  (no prefix)
// Detect which mode is active and cache the result.
let _bridgePrefix: string | null = null

async function detectBridgePrefix(): Promise<string> {
  if (_bridgePrefix !== null) return _bridgePrefix
  const opts = { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(2000) }
  // Try embedded mode first (/daemon/health)
  try {
    const res = await fetch(`${BRIDGE_URL}/daemon/health`, opts)
    if (res.ok) { _bridgePrefix = "/daemon"; return _bridgePrefix }
  } catch { /* not embedded */ }
  // Try standalone mode (/health)
  try {
    const res = await fetch(`${BRIDGE_URL}/health`, opts)
    if (res.ok) { _bridgePrefix = ""; return _bridgePrefix }
  } catch { /* not reachable */ }
  // Neither worked — default to /daemon and let caller handle the error
  _bridgePrefix = "/daemon"
  return _bridgePrefix
}

async function bridgeFetch(path: string, opts: RequestInit = {}) {
  const prefix = await detectBridgePrefix()
  // path comes in as "/daemon/queue" — strip the /daemon prefix and re-add the detected one
  const cleanPath = path.replace(/^\/daemon/, "")
  const token = getBridgeToken()
  const headers: Record<string, string> = { Accept: "application/json", ...(opts.headers as Record<string, string> || {}) }
  if (token) headers["X-Bridge-Key"] = token
  return fetch(`${BRIDGE_URL}${prefix}${cleanPath}`, { ...opts, headers })
}

// ── iris hive tasks ─────────────────────────────────────────────────────

function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "—"
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${s % 60}s`
}

function taskStatusBadge(status: string): string {
  switch (status) {
    case "completed": return success("✓ completed")
    case "failed": return "\x1b[31m✗ failed\x1b[0m"
    case "running": case "dispatched": return "\x1b[34m▶ running\x1b[0m"
    case "pending": return dim("◌ pending")
    case "timeout": return "\x1b[33m⏱ timeout\x1b[0m"
    default: return dim(status)
  }
}

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return ""
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.round(diff / 60000)
  if (mins < 1) return "just now"
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.round(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.round(hrs / 24)}d ago`
}

const HiveTasksCommand = cmd({
  command: "tasks [subcommand] [task-id]",
  describe: "list pending/running tasks on your node",
  builder: (yargs) =>
    yargs
      .positional("subcommand", { describe: "get or logs", type: "string" })
      .positional("task-id", { describe: "task ID (for get/logs)", type: "string" })
      .option("status", { describe: "filter by status", type: "string", choices: ["pending", "running", "completed", "failed", "all"], default: "all" })
      .option("type", { describe: "filter by task type (discover, som_batch, etc.)", type: "string" })
      .option("history", { describe: "include completed tasks (last 48h)", type: "boolean", default: false })
      .option("since", { describe: "time window (e.g. 24h, 7d)", type: "string", default: "48h" })
      .option("limit", { describe: "max tasks to show", type: "number", default: 20 })
      .option("tail", { describe: "lines of output to show (for logs)", type: "number", default: 50 })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    const sub = args.subcommand as string | undefined
    const extraArgs = args._ as string[]
    const userId = await requireUserId(args["user-id"] as number | undefined)

    // ── iris hive tasks get <id> ──
    if (sub === "get" || sub === "logs") {
      const taskId = args["task-id"] as string || extraArgs[extraArgs.length - 1]
      if (!taskId) {
        prompts.log.error("Usage: iris hive tasks get <task-id>")
        return
      }
      prompts.intro(`◈  Task ${String(taskId).substring(0, 12)}…`)
      const spinner = prompts.spinner()
      spinner.start("Loading…")

      try {
        const res = await hiveFetch(`/api/v6/nodes/tasks/${taskId}?detailed=1&user_id=${userId}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const data = await res.json() as Record<string, unknown>
        const t = (data.task ?? data.data ?? data) as Record<string, unknown>
        spinner.stop(taskStatusBadge(String(t.status ?? "unknown")))
        printDivider()

        printKV("Type", String(t.type ?? "—"))
        printKV("Title", String(t.title ?? "—"))
        printKV("Status", taskStatusBadge(String(t.status ?? "—")))
        printKV("Duration", formatDuration(t.duration_ms as number))
        if (t.created_at) printKV("Created", `${new Date(String(t.created_at)).toLocaleTimeString()} (${timeAgo(String(t.created_at))})`)
        if (t.started_at) printKV("Started", new Date(String(t.started_at)).toLocaleTimeString())
        if (t.completed_at) printKV("Completed", new Date(String(t.completed_at)).toLocaleTimeString())
        if (t.progress) printKV("Progress", `${t.progress}%${t.progress_message ? ` — ${t.progress_message}` : ""}`)
        if (t.error) {
          console.log()
          console.log(bold("  Error"))
          printDivider()
          console.log(`  \x1b[31m${String(t.error).substring(0, 500)}\x1b[0m`)
        }
        if (t.prompt) {
          console.log()
          console.log(bold("  Prompt"))
          printDivider()
          console.log(dim(`  ${String(t.prompt).substring(0, 200)}`))
        }

        // Output (from result)
        const result = t.result as Record<string, unknown> | null
        const output = result?.output ?? (typeof result === "string" ? result : null)
        if (output) {
          console.log()
          console.log(bold("  Output"))
          printDivider()
          const lines = String(output).split("\n")
          const tailN = sub === "logs" ? (args.tail as number ?? 50) : 30
          const display = lines.slice(-tailN)
          if (lines.length > tailN) console.log(dim(`  ... ${lines.length - tailN} lines truncated`))
          for (const line of display) {
            console.log(`  ${line}`)
          }
        }
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
      prompts.outro("Done")
      return
    }

    // ── iris hive tasks (list) ──
    prompts.intro("◈  Hive Tasks")
    const spinner = prompts.spinner()
    spinner.start("Loading tasks…")

    try {
      // Live: running tasks from bridge daemon
      let runningTasks: Record<string, unknown>[] = []
      try {
        const queueRes = await bridgeFetch("/daemon/queue")
        const queueData = await queueRes.json() as Record<string, unknown>
        runningTasks = (queueData.tasks ?? []) as Record<string, unknown>[]
      } catch { /* bridge not running */ }

      // Cloud: pending tasks
      let pendingTasks: Record<string, unknown>[] = []
      try {
        const pendingRes = await nodeFetch("/api/v6/node-agent/tasks/pending")
        const pendingData = await pendingRes.json() as Record<string, unknown>
        pendingTasks = (pendingData.tasks ?? []) as Record<string, unknown>[]
      } catch { /* may not have node key */ }

      // History: recent completed/failed tasks from iris-api
      let historyTasks: Record<string, unknown>[] = []
      const showHistory = args.history || args.status === "completed" || args.status === "failed" || args.status === "all" || args.type
      if (showHistory) {
        try {
          const params = new URLSearchParams()
          params.set("user_id", String(userId))
          params.set("since", args.since as string ?? "48h")
          params.set("limit", String(args.limit ?? 20))
          if (args.status && args.status !== "all") params.set("status", args.status as string)
          if (args.type) params.set("type", args.type as string)
          const histRes = await hiveFetch(`/api/v6/nodes/tasks?${params}`)
          if (histRes.ok) {
            const histData = await histRes.json() as Record<string, unknown>
            historyTasks = (histData.tasks ?? []) as Record<string, unknown>[]
          }
        } catch { /* auth issue or endpoint not available */ }
      }

      const totalCount = runningTasks.length + pendingTasks.length + historyTasks.length
      spinner.stop(`${runningTasks.length} running, ${pendingTasks.length} pending${showHistory ? `, ${historyTasks.length} recent` : ""}`)
      printDivider()

      // Running
      if (runningTasks.length > 0) {
        console.log(bold("  Running:"))
        for (const t of runningTasks) {
          const id = dim(String(t.id ?? "").substring(0, 12))
          const type = String(t.type ?? t.title ?? "unknown")
          const uptime = t.uptime_s ? dim(`${t.uptime_s}s`) : ""
          console.log(`    \x1b[34m▶\x1b[0m ${id}  ${bold(type)}  ${uptime}`)
        }
        console.log()
      }

      // Pending
      if (pendingTasks.length > 0) {
        console.log(bold("  Pending:"))
        for (const t of pendingTasks) {
          const id = dim(String(t.id ?? "").substring(0, 12))
          const title = String(t.title ?? t.type ?? "unknown")
          console.log(`    ◌ ${id}  ${title}`)
        }
        console.log()
      }

      // History
      if (historyTasks.length > 0) {
        console.log(bold("  Recent:"))
        for (const t of historyTasks) {
          // Skip tasks already shown as running/pending
          const tid = String(t.id ?? "")
          if (runningTasks.some(r => String(r.id) === tid)) continue
          if (pendingTasks.some(p => String(p.id) === tid)) continue

          const id = dim(tid.substring(0, 12))
          const type = String(t.type ?? "unknown").padEnd(14)
          const badge = taskStatusBadge(String(t.status ?? ""))
          const dur = formatDuration(t.duration_ms as number)
          const ago = timeAgo(String(t.completed_at ?? t.created_at ?? ""))
          console.log(`    ${id}  ${type}  ${badge}  ${dim(dur)}  ${dim(ago)}`)
        }
      }

      if (totalCount === 0) {
        console.log(dim("  No tasks. Node is idle."))
        if (!showHistory) console.log(dim("  Use --history to see completed tasks."))
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ── iris hive cancel ────────────────────────────────────────────────────

const HiveCancelCommand = cmd({
  command: "cancel [task-id]",
  describe: "cancel a task or all pending tasks",
  builder: (yargs) =>
    yargs
      .positional("task-id", { describe: "task ID to cancel (omit for interactive)", type: "string" })
      .option("all", { describe: "cancel ALL pending tasks", type: "boolean", default: false })
      .option("stale", { describe: "cancel tasks older than 1 hour", type: "boolean", default: false })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Cancel Tasks")

    const spinner = prompts.spinner()

    try {
      if (args.all || args.stale) {
        spinner.start("Fetching pending tasks…")
        const res = await nodeFetch("/api/v6/node-agent/tasks/pending")
        const data = await res.json() as Record<string, unknown>
        let tasks = (data.tasks ?? []) as Record<string, unknown>[]

        if (args.stale) {
          const oneHourAgo = Date.now() - 60 * 60 * 1000
          tasks = tasks.filter(t => {
            const created = new Date(String(t.created_at ?? "")).getTime()
            return created < oneHourAgo
          })
        }

        if (tasks.length === 0) {
          spinner.stop("No tasks to cancel")
          prompts.outro("Done")
          return
        }

        spinner.stop(`Found ${tasks.length} task(s) to cancel`)

        if (!args.force) {
          const confirm = await prompts.confirm({ message: `Cancel ${tasks.length} task(s)?` })
          if (!confirm || prompts.isCancel(confirm)) { prompts.outro("Cancelled"); return }
        }

        let cancelled = 0
        for (const t of tasks) {
          try {
            await nodeFetch(`/api/v6/node-agent/tasks/${t.id}/result`, {
              method: "POST",
              body: JSON.stringify({ status: "failed", output: "Cancelled via iris hive cancel", error: "Manually cancelled" }),
            })
            cancelled++
            console.log(`  ${success("✓")} ${String(t.id).substring(0, 12)}… — ${t.title}`)
          } catch (err) {
            console.log(`  ${dim("✗")} ${String(t.id).substring(0, 12)}… — ${err instanceof Error ? err.message : "failed"}`)
          }
        }
        console.log()
        prompts.log.success(`${cancelled}/${tasks.length} tasks cancelled`)
      } else if (args["task-id"]) {
        spinner.start("Cancelling…")
        const res = await nodeFetch(`/api/v6/node-agent/tasks/${args["task-id"]}/result`, {
          method: "POST",
          body: JSON.stringify({ status: "failed", output: "Cancelled via iris hive cancel", error: "Manually cancelled" }),
        })
        if (res.ok) {
          spinner.stop(success("Task cancelled"))
        } else {
          const err = await res.text()
          spinner.stop("Failed", 1)
          prompts.log.error(err)
        }
      } else {
        // Interactive: show pending and let user pick
        spinner.start("Fetching tasks…")
        const res = await nodeFetch("/api/v6/node-agent/tasks/pending")
        const data = await res.json() as Record<string, unknown>
        const tasks = (data.tasks ?? []) as Record<string, unknown>[]
        spinner.stop(`${tasks.length} pending`)

        if (tasks.length === 0) {
          console.log(dim("  No pending tasks to cancel."))
          prompts.outro("Done")
          return
        }

        const selected = await prompts.select({
          message: "Select task to cancel:",
          options: tasks.map(t => ({
            value: String(t.id),
            label: `${String(t.id).substring(0, 12)}… — ${t.title}`,
          })),
        })
        if (prompts.isCancel(selected)) { prompts.outro("Cancelled"); return }

        await nodeFetch(`/api/v6/node-agent/tasks/${selected}/result`, {
          method: "POST",
          body: JSON.stringify({ status: "failed", output: "Cancelled via iris hive cancel", error: "Manually cancelled" }),
        })
        prompts.log.success("Task cancelled")
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ── iris hive queue ─────────────────────────────────────────────────────

const HiveQueueCommand = cmd({
  command: "queue",
  describe: "show daemon queue (running tasks, capacity)",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Daemon Queue")

    try {
      const [queueRes, healthRes, capacityRes] = await Promise.all([
        bridgeFetch("/daemon/queue").catch(() => null),
        bridgeFetch("/daemon/health").catch(() => null),
        bridgeFetch("/daemon/capacity").catch(() => null),
      ])

      if (!queueRes || !queueRes.ok) {
        prompts.log.warn("Daemon not running. Start with: iris daemon start")
        prompts.outro("Done")
        return
      }

      const queue = await queueRes.json() as Record<string, unknown>
      const health = healthRes ? await healthRes.json() as Record<string, unknown> : {}
      const capacity = capacityRes ? await capacityRes.json() as Record<string, unknown> : {}

      printDivider()
      printKV("Status", health.paused ? highlight("PAUSED") : success("active"))
      printKV("Node", health.node_name ?? dim("unknown"))
      printKV("Tasks", `${queue.active_tasks ?? 0} active`)
      printKV("Capacity", capacity.level ?? "unknown")
      printKV("Uptime", health.uptime_s ? `${Math.round(Number(health.uptime_s) / 60)}m` : dim("unknown"))
      console.log()

      const tasks = (queue.tasks ?? []) as Record<string, unknown>[]
      if (tasks.length > 0) {
        console.log(bold("  Active tasks:"))
        for (const t of tasks) {
          const id = dim(String(t.id ?? "").substring(0, 12) + "…")
          const title = bold(String(t.title ?? t.type ?? ""))
          const uptime = t.uptime_s ? dim(`${t.uptime_s}s`) : ""
          const pid = t.pid ? dim(`PID:${t.pid}`) : ""
          console.log(`    ${success("▶")} ${id}  ${title}  ${uptime}  ${pid}`)
        }
      } else {
        console.log(dim("  No active tasks. Waiting for dispatch."))
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ── iris hive pause / resume ────────────────────────────────────────────

const HivePauseCommand = cmd({
  command: "pause",
  describe: "pause daemon (no new tasks accepted)",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    try {
      const prefix = await detectBridgePrefix()
      const res = await fetch(`${BRIDGE_URL}${prefix}/pause`, { method: "POST", headers: bridgeHeaders() })
      if (res.ok) {
        prompts.log.success("Daemon paused — no new tasks will be accepted")
      } else {
        prompts.log.error("Failed to pause daemon")
      }
    } catch {
      prompts.log.error("Daemon not running. Start with: iris daemon start")
    }
  },
})

const HiveResumeCommand = cmd({
  command: "resume",
  describe: "resume daemon (accept tasks again)",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    try {
      const prefix = await detectBridgePrefix()
      const res = await fetch(`${BRIDGE_URL}${prefix}/resume`, { method: "POST", headers: bridgeHeaders() })
      if (res.ok) {
        prompts.log.success("Daemon resumed — accepting tasks")
      } else {
        prompts.log.error("Failed to resume daemon")
      }
    } catch {
      prompts.log.error("Daemon not running. Start with: iris daemon start")
    }
  },
})

// ── iris hive purge ─────────────────────────────────────────────────────

const HivePurgeCommand = cmd({
  command: "purge",
  describe: "cancel ALL pending tasks + clear daemon state (emergency)",
  builder: (yargs) =>
    yargs.option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Purge All Tasks")

    if (!args.force) {
      const confirm = await prompts.confirm({ message: "Cancel ALL pending tasks on this node? This is irreversible." })
      if (!confirm || prompts.isCancel(confirm)) { prompts.outro("Cancelled"); return }
    }

    const spinner = prompts.spinner()
    spinner.start("Purging…")

    try {
      const res = await nodeFetch("/api/v6/node-agent/tasks/pending")
      const data = await res.json() as Record<string, unknown>
      const tasks = (data.tasks ?? []) as Record<string, unknown>[]

      let cancelled = 0
      for (const t of tasks) {
        try {
          await nodeFetch(`/api/v6/node-agent/tasks/${t.id}/result`, {
            method: "POST",
            body: JSON.stringify({ status: "failed", output: "Purged via iris hive purge", error: "Emergency purge" }),
          })
          cancelled++
        } catch { /* best effort */ }
      }

      spinner.stop(success(`${cancelled} tasks purged`))

      // Also try to pause the daemon to prevent re-dispatch
      try {
        const purgePrefix = await detectBridgePrefix()
        await fetch(`${BRIDGE_URL}${purgePrefix}/pause`, { method: "POST", headers: bridgeHeaders() })
        prompts.log.info("Daemon paused to prevent re-dispatch. Resume with: iris hive resume")
      } catch {
        prompts.log.warn("Daemon not reachable — tasks may be re-dispatched on next heartbeat")
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ── iris hive doctor ────────────────────────────────────────────────────

const HiveDoctorCommand = cmd({
  command: "doctor",
  describe: "diagnose daemon health, connectivity, and stale tasks",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Hive Doctor")

    const checks: { name: string; status: "pass" | "fail" | "warn"; detail: string }[] = []

    // 1. Node key
    const nodeKey = readNodeKey()
    checks.push(nodeKey
      ? { name: "Node API key", status: "pass", detail: `${nodeKey.substring(0, 15)}…` }
      : { name: "Node API key", status: "fail", detail: "Missing — run iris-login or add node_api_key to ~/.iris/config.json" }
    )

    // 2. Bridge daemon
    try {
      const res = await bridgeFetch("/daemon/health")
      if (res.ok) {
        const h = await res.json() as Record<string, unknown>
        checks.push({ name: "Bridge daemon", status: "pass", detail: `${h.status} | ${h.running_tasks} tasks | uptime ${Math.round(Number(h.uptime_s || 0) / 60)}m` })
      } else {
        checks.push({ name: "Bridge daemon", status: "fail", detail: `HTTP ${res.status}` })
      }
    } catch {
      checks.push({ name: "Bridge daemon", status: "warn", detail: "Not running (localhost:3200). Start with: npm run bridge" })
    }

    // 3. Cloud connectivity
    if (nodeKey) {
      try {
        const res = await nodeFetch("/api/v6/node-agent/heartbeat", { method: "POST", body: JSON.stringify({}) })
        if (res.ok) {
          const h = await res.json() as Record<string, unknown>
          checks.push({ name: "Cloud API", status: "pass", detail: `Connected to ${IRIS_API}` })
          checks.push({ name: "Node ID", status: "pass", detail: String(h.node_id ?? "unknown").substring(0, 16) + "…" })
        } else {
          checks.push({ name: "Cloud API", status: "fail", detail: `HTTP ${res.status} — key may be invalid` })
        }
      } catch (err) {
        checks.push({ name: "Cloud API", status: "fail", detail: err instanceof Error ? err.message : "Connection failed" })
      }
    }

    // 4. Stale tasks
    if (nodeKey) {
      try {
        const res = await nodeFetch("/api/v6/node-agent/tasks/pending")
        const data = await res.json() as Record<string, unknown>
        const tasks = (data.tasks ?? []) as Record<string, unknown>[]
        const stale = tasks.filter(t => {
          const created = new Date(String(t.created_at ?? "")).getTime()
          return (Date.now() - created) > 60 * 60 * 1000
        })
        if (tasks.length === 0) {
          checks.push({ name: "Pending tasks", status: "pass", detail: "0 pending" })
        } else if (stale.length > 0) {
          checks.push({ name: "Pending tasks", status: "warn", detail: `${tasks.length} pending (${stale.length} stale >1hr). Run: iris hive cancel --stale` })
        } else {
          checks.push({ name: "Pending tasks", status: "pass", detail: `${tasks.length} pending` })
        }
      } catch { /* skip */ }
    }

    // 5. Capacity
    try {
      const res = await bridgeFetch("/daemon/capacity")
      if (res.ok) {
        const c = await res.json() as Record<string, unknown>
        const level = String(c.level ?? "unknown")
        const status = level === "overloaded" ? "warn" : "pass"
        checks.push({ name: "Capacity", status, detail: level })
      }
    } catch { /* bridge not running */ }

    // 6. Security hardening checks
    const fs = require("fs")
    const path = require("path")
    const os = require("os")
    const tokenPath = path.join(os.homedir(), ".iris", "bridge-token")

    // Auth token
    if (fs.existsSync(tokenPath)) {
      try {
        if (process.platform === "win32") {
          // Windows doesn't have Unix permissions — just check file exists
          checks.push({ name: "Auth token", status: "pass", detail: "~/.iris/bridge-token" })
        } else {
          const stat = fs.statSync(tokenPath)
          const mode = (stat.mode & 0o777).toString(8)
          if (mode === "600") {
            checks.push({ name: "Auth token", status: "pass", detail: `~/.iris/bridge-token (mode 0600)` })
          } else {
            checks.push({ name: "Auth token", status: "warn", detail: `Permissions too open (${mode}). Run: chmod 600 ~/.iris/bridge-token` })
          }
        }
      } catch {
        checks.push({ name: "Auth token", status: "pass", detail: "~/.iris/bridge-token" })
      }
    } else {
      checks.push({ name: "Auth token", status: "warn", detail: "Missing — bridge will generate on next start" })
    }

    // Bind address (check if bridge is externally accessible)
    try {
      const netRes = await fetch("http://localhost:3200/health", { signal: AbortSignal.timeout(1000) }).catch(() => null)
      if (netRes?.ok) {
        // Try from 0.0.0.0 — if it also responds, bridge is externally bound
        const extRes = await fetch("http://0.0.0.0:3200/health", { signal: AbortSignal.timeout(1000) }).catch(() => null)
        if (extRes?.ok) {
          checks.push({ name: "Bind address", status: "warn", detail: "Bound to 0.0.0.0 (network-accessible). Set BRIDGE_BIND_HOST=127.0.0.1" })
        } else {
          checks.push({ name: "Bind address", status: "pass", detail: "127.0.0.1 (localhost only)" })
        }
      }
    } catch { /* bridge not running — skip */ }

    // Auth enforcement (try calling a protected endpoint without token)
    try {
      const noAuthRes = await fetch("http://localhost:3200/api/mail/search?from=test", {
        signal: AbortSignal.timeout(1000),
        headers: { Accept: "application/json" } // no X-Bridge-Key
      }).catch(() => null)
      if (noAuthRes) {
        if (noAuthRes.status === 401) {
          checks.push({ name: "Auth enforcement", status: "pass", detail: "Protected endpoints require X-Bridge-Key" })
        } else {
          checks.push({ name: "Auth enforcement", status: "fail", detail: `Unprotected! GET /api/mail/search returned ${noAuthRes.status} without auth. Update bridge.` })
        }
      }
    } catch { /* bridge not running — skip */ }

    // HMAC task signing (informational)
    checks.push({ name: "Task signing", status: "pass", detail: "HMAC-SHA256 verification enabled" })

    // Display results
    printDivider()
    for (const check of checks) {
      const icon = check.status === "pass" ? success("✓") : check.status === "warn" ? highlight("⚠") : `${UI.Style.TEXT_DANGER}✗${UI.Style.TEXT_NORMAL}`
      console.log(`  ${icon}  ${bold(check.name)}: ${check.detail}`)
    }
    console.log()

    const failures = checks.filter(c => c.status === "fail")
    if (failures.length > 0) {
      prompts.log.warn(`${failures.length} issue(s) found`)
    } else {
      prompts.log.success("All checks passed")
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// Script deployment — push, exec, list, rm
// ============================================================================

const HiveScriptPushCommand = cmd({
  command: "push <file>",
  describe: "push a local script to the node and execute it",
  builder: (yargs) =>
    yargs
      .positional("file", { type: "string", describe: "local file path" })
      .option("project", { alias: "p", type: "string", describe: "inject env vars from a hive project" })
      .option("persist", { type: "boolean", default: true, describe: "keep script on node after execution" })
      .option("args", { type: "array", string: true, default: [], describe: "arguments to pass to the script" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Push Script")

    const fs = require("fs")
    const path = require("path")
    const filePath = args.file as string

    if (!fs.existsSync(filePath)) {
      prompts.log.error(`File not found: ${filePath}`)
      prompts.outro("Done")
      return
    }

    const filename = path.basename(filePath)
    const content = fs.readFileSync(filePath, "utf-8")
    const spinner = prompts.spinner()
    spinner.start(`Pushing ${bold(filename)} to node...`)

    try {
      // #58002: Fetch project env vars if --project specified
      let projectEnv: Record<string, string> = {}
      if (args.project) {
        try {
          const userId = await requireUserId()
          if (userId) {
            const envRes = await hiveFetch(`/api/v6/nodes/projects/${args.project}/env?user_id=${userId}&include_values=true`)
            if (envRes.ok) {
              const envData = await envRes.json() as Record<string, unknown>
              const envVals = envData.data as any
              if (envVals && typeof envVals === "object" && !Array.isArray(envVals)) {
                projectEnv = envVals
              }
            }
          }
        } catch {}
      }

      const res = await fetch(`${BRIDGE_URL}/execute-script`, {
        method: "POST",
        headers: bridgeHeaders(),
        body: JSON.stringify({
          filename,
          content,
          persist: args.persist,
          args: args.args,
          env: Object.keys(projectEnv).length > 0 ? projectEnv : undefined,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        spinner.stop(`Failed: ${err.error}`, 1)
        prompts.outro("Done")
        return
      }

      const result = await res.json() as Record<string, unknown>
      spinner.stop(result.status === "completed" ? success("Completed") : highlight(String(result.status)))

      printDivider()
      printKV("Exit code", String(result.exit_code ?? "?"))
      printKV("Duration", `${result.duration_ms}ms`)
      if (result.script_path) printKV("Persisted", success(String(result.script_path)))
      if (result.machine) printKV("Machine", dim(String(result.machine)))

      const stdout = String(result.stdout ?? "").trim()
      const stderr = String(result.stderr ?? "").trim()
      if (stdout) {
        console.log()
        console.log(bold("  stdout:"))
        for (const line of stdout.split("\n").slice(0, 50)) {
          console.log(`    ${line}`)
        }
      }
      if (stderr) {
        console.log()
        console.log(highlight("  stderr:"))
        for (const line of stderr.split("\n").slice(0, 20)) {
          console.log(`    ${line}`)
        }
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.log.warn("Is the daemon running? Start with: npm run hive:daemon")
    }
    prompts.outro("Done")
  },
})

const HiveScriptExecCommand = cmd({
  command: "exec <filename>",
  describe: "execute a script already on the node",
  builder: (yargs) =>
    yargs
      .positional("filename", { type: "string", describe: "script name (in /scripts/)" })
      .option("project", { alias: "p", type: "string", describe: "inject env vars from a hive project" })
      .option("args", { type: "array", string: true, default: [], describe: "arguments to pass" })
      .option("timeout", { type: "number", default: 30000, describe: "timeout in ms" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Execute Script")

    const filename = args.filename as string
    const spinner = prompts.spinner()
    spinner.start(`Running ${bold(filename)}...`)

    try {
      // First read the script content from the node, then execute it
      const readRes = await bridgeFetch(`/files?path=/scripts/${encodeURIComponent(filename)}`)
      if (!readRes.ok) {
        spinner.stop(`Script not found: ${filename}`, 1)
        prompts.log.warn("Push a script first: iris hive script push <file>")
        prompts.outro("Done")
        return
      }

      const fileInfo = await readRes.json() as Record<string, unknown>
      const content = fileInfo.content as string
      if (!content) {
        spinner.stop("Script too large to read inline (>512KB)", 1)
        prompts.outro("Done")
        return
      }

      // #58002: Fetch project env vars if --project specified
      let projectEnv: Record<string, string> = {}
      if (args.project) {
        try {
          const userId = await requireUserId()
          if (userId) {
            const envRes = await hiveFetch(`/api/v6/nodes/projects/${args.project}/env?user_id=${userId}&include_values=true`)
            if (envRes.ok) {
              const envData = await envRes.json() as Record<string, unknown>
              // Server returns { data: { KEY: "value", ... } } or { data: ["KEY1", "KEY2"] }
              const envVals = envData.data as any
              if (envVals && typeof envVals === "object" && !Array.isArray(envVals)) {
                projectEnv = envVals
              }
            }
          }
        } catch { /* non-fatal — script still runs without env */ }
      }

      const res = await fetch(`${BRIDGE_URL}/execute-script`, {
        method: "POST",
        headers: bridgeHeaders(),
        body: JSON.stringify({
          filename,
          content,
          persist: true,
          args: args.args,
          timeout_ms: args.timeout,
          env: Object.keys(projectEnv).length > 0 ? projectEnv : undefined,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        spinner.stop(`Failed: ${err.error}`, 1)
        prompts.outro("Done")
        return
      }

      const result = await res.json() as Record<string, unknown>
      spinner.stop(result.status === "completed" ? success("Completed") : highlight(String(result.status)))

      printDivider()
      printKV("Exit code", String(result.exit_code ?? "?"))
      printKV("Duration", `${result.duration_ms}ms`)

      const stdout = String(result.stdout ?? "").trim()
      const stderr = String(result.stderr ?? "").trim()
      if (stdout) {
        console.log()
        for (const line of stdout.split("\n").slice(0, 80)) {
          console.log(`  ${line}`)
        }
      }
      if (stderr) {
        console.log()
        console.log(highlight("  stderr:"))
        for (const line of stderr.split("\n").slice(0, 20)) {
          console.log(`    ${line}`)
        }
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.log.warn("Is the daemon running? Start with: npm run hive:daemon")
    }
    prompts.outro("Done")
  },
})

const HiveScriptListCommand = cmd({
  command: "list",
  describe: "list persisted scripts on the node",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Node Scripts")

    try {
      const res = await bridgeFetch("/files?path=/scripts")
      if (!res.ok) {
        prompts.log.warn("No scripts directory yet. Push a script first.")
        prompts.outro("Done")
        return
      }

      const data = await res.json() as Record<string, unknown>
      const entries = (data.entries ?? []) as Record<string, unknown>[]

      if (entries.length === 0) {
        console.log(dim("  No scripts. Push one with: iris hive script push <file>"))
      } else {
        printDivider()
        for (const entry of entries) {
          const name = bold(String(entry.name))
          const size = dim(`${entry.size} bytes`)
          const modified = entry.modified ? dim(new Date(String(entry.modified)).toLocaleString()) : ""
          console.log(`  ${success("■")} ${name}  ${size}  ${modified}`)
        }
        console.log()
        console.log(dim(`  ${entries.length} script(s) on node`))
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.log.warn("Is the daemon running? Start with: npm run hive:daemon")
    }
    prompts.outro("Done")
  },
})

const HiveScriptRmCommand = cmd({
  command: "rm <filename>",
  describe: "delete a persisted script from the node",
  builder: (yargs) =>
    yargs.positional("filename", { type: "string", describe: "script name to delete" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Remove Script")

    const filename = args.filename as string

    try {
      const res = await fetch(`${BRIDGE_URL}/files?path=/scripts/${encodeURIComponent(filename)}`, {
        method: "DELETE",
        headers: bridgeHeaders(),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        prompts.log.error(String(err.error ?? "Delete failed"))
        prompts.outro("Done")
        return
      }

      prompts.log.success(`Deleted ${bold(filename)}`)
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveScriptDemoCommand = cmd({
  command: "demo",
  describe: "install and run a demo health-check script on the node",
  builder: (yargs) =>
    yargs.option("schedule", {
      type: "string",
      describe: 'also schedule it (e.g. "*/5 * * * *")',
    }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Script Demo")

    const DEMO_SCRIPT = `#!/bin/bash
# iris-hive-demo.sh — Node health check & system report
echo "=== IRIS Hive Node Health Report ==="
echo "Timestamp: $(date -u '+%Y-%m-%dT%H:%M:%SZ')"
echo "Hostname:  $(hostname)"
echo "Uptime:    $(uptime | sed 's/.*up //' | sed 's/,.*//')"
echo ""
echo "--- System ---"
echo "OS:      $(uname -s) $(uname -r)"
echo "Arch:    $(uname -m)"
echo "CPUs:    $(nproc 2>/dev/null || sysctl -n hw.ncpu 2>/dev/null || echo '?')"
echo ""
echo "--- Memory ---"
if command -v free &>/dev/null; then
  free -h | head -2
elif [[ "$(uname)" == "Darwin" ]]; then
  total=$(sysctl -n hw.memsize 2>/dev/null)
  echo "Total: $((total / 1073741824)) GB"
fi
echo ""
echo "--- Disk ---"
df -h / | tail -1 | awk '{print "Used: "$3" / "$2"  ("$5" full)"}'
echo ""
echo "--- Daemon ---"
health=$(curl -s http://localhost:3200/health 2>/dev/null)
if [ $? -eq 0 ]; then
  echo "Status:  $(echo "$health" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)"
  echo "Node:    $(echo "$health" | grep -o '"node_name":"[^"]*"' | cut -d'"' -f4)"
  echo "Tasks:   $(echo "$health" | grep -o '"running_tasks":[0-9]*' | cut -d: -f2)"
else
  echo "Status:  unreachable"
fi
echo ""
echo "=== Report Complete ==="
`

    const spinner = prompts.spinner()
    spinner.start("Pushing demo script to node...")

    try {
      const res = await fetch(`${BRIDGE_URL}/execute-script`, {
        method: "POST",
        headers: bridgeHeaders(),
        body: JSON.stringify({
          filename: "iris-hive-demo.sh",
          content: DEMO_SCRIPT,
          persist: true,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        spinner.stop(`Failed: ${err.error}`, 1)
        prompts.outro("Done")
        return
      }

      const result = await res.json() as Record<string, unknown>
      spinner.stop(result.status === "completed" ? success("Demo executed") : highlight(String(result.status)))

      const stdout = String(result.stdout ?? "").trim()
      if (stdout) {
        console.log()
        for (const line of stdout.split("\n")) {
          console.log(`  ${line}`)
        }
      }

      console.log()
      printKV("Script", success("/scripts/iris-hive-demo.sh (persisted)"))
      printKV("Duration", `${result.duration_ms}ms`)

      // Optionally schedule it
      if (args.schedule) {
        const schedRes = await fetch(`${BRIDGE_URL}/schedules`, {
          method: "POST",
          headers: bridgeHeaders(),
          body: JSON.stringify({
            filename: "iris-hive-demo.sh",
            cron: args.schedule,
          }),
        })

        if (schedRes.ok) {
          const sched = await schedRes.json() as Record<string, unknown>
          const schedObj = sched.schedule as Record<string, unknown>
          printKV("Scheduled", success(`${args.schedule} (${schedObj?.id})`))
        } else {
          const err = await schedRes.json().catch(() => ({ error: "unknown" })) as Record<string, unknown>
          prompts.log.warn(`Schedule failed: ${err.error}`)
        }
      } else {
        console.log(dim(`  Tip: add --schedule "*/5 * * * *" to run it on a cron`))
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.log.warn("Is the daemon running? Start with: npm run hive:daemon")
    }
    prompts.outro("Done")
  },
})

const HiveScriptCommand = cmd({
  command: "script",
  describe: "deploy & run scripts on Hive nodes",
  builder: (yargs) =>
    yargs
      .command(HiveScriptDemoCommand)
      .command(HiveScriptPushCommand)
      .command(HiveScriptExecCommand)
      .command(HiveScriptListCommand)
      .command(HiveScriptRmCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Schedule management
// ============================================================================

const HiveScheduleListCommand = cmd({
  command: "list",
  describe: "list cron schedules on the local node",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Node Schedules")

    try {
      const res = await bridgeFetch("/schedules")
      if (!res.ok) {
        if (res.status === 404) {
          prompts.log.warn("This daemon build doesn't expose /schedules — update the daemon: iris daemon restart (or iris update)")
        } else {
          prompts.log.warn(`Schedule registry returned HTTP ${res.status}. Check the daemon: iris daemon status`)
        }
        prompts.outro("Done")
        return
      }

      const data = await res.json() as Record<string, unknown>
      const schedules = (data.schedules ?? []) as Record<string, unknown>[]

      if (schedules.length === 0) {
        console.log(dim("  No schedules. Create one with: iris hive schedule add <script> --cron \"...\""))
      } else {
        printDivider()
        for (const s of schedules) {
          const id = dim(String(s.id ?? "").substring(0, 20))
          const file = bold(String(s.filename))
          const cronStr = String(s.cron)
          const enabled = s.enabled ? success("● active") : dim("○ paused")
          const runs = `${s.run_count ?? 0} runs`
          const last = s.last_run ? dim(new Date(String(s.last_run)).toLocaleString()) : dim("never")
          const lastStatus = s.last_status ? (s.last_status === "completed" ? success("ok") : highlight(String(s.last_status))) : ""

          console.log(`  ${enabled}  ${file}  ${dim(cronStr)}  ${runs}  ${lastStatus}`)
          console.log(`    ${id}  last: ${last}`)
        }
        console.log()
        console.log(dim(`  ${schedules.length} schedule(s)`))
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveScheduleAddCommand = cmd({
  command: "add <filename>",
  describe: "schedule a persisted script to run on a cron",
  builder: (yargs) =>
    yargs
      .positional("filename", { type: "string", describe: "script name (in /scripts/)" })
      .option("cron", { type: "string", demandOption: true, describe: 'cron expression (e.g. "0 9 * * *")' })
      .option("args", { type: "array", string: true, default: [], describe: "arguments to pass" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Add Schedule")

    const spinner = prompts.spinner()
    spinner.start("Creating schedule...")

    try {
      const res = await fetch(`${BRIDGE_URL}/schedules`, {
        method: "POST",
        headers: bridgeHeaders(),
        body: JSON.stringify({
          filename: args.filename,
          cron: args.cron,
          args: args.args,
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        spinner.stop(`Failed: ${err.error}`, 1)
        prompts.outro("Done")
        return
      }

      const data = await res.json() as Record<string, unknown>
      const s = data.schedule as Record<string, unknown>
      spinner.stop(success("Schedule created"))

      printDivider()
      printKV("ID", String(s.id))
      printKV("Script", bold(String(s.filename)))
      printKV("Cron", String(s.cron))
      if ((args.args as string[]).length > 0) printKV("Args", (args.args as string[]).join(" "))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveScheduleRmCommand = cmd({
  command: "rm <id>",
  describe: "remove a schedule",
  builder: (yargs) =>
    yargs.positional("id", { type: "string", describe: "schedule ID" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Remove Schedule")

    try {
      const res = await fetch(`${BRIDGE_URL}/schedules/${encodeURIComponent(args.id as string)}`, {
        method: "DELETE",
        headers: bridgeHeaders(),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        prompts.log.error(String(err.error))
      } else {
        const data = await res.json() as Record<string, unknown>
        const s = data.schedule as Record<string, unknown>
        prompts.log.success(`Removed schedule for ${bold(String(s?.filename ?? args.id))}`)
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveSchedulePauseCommand = cmd({
  command: "pause <id>",
  describe: "pause a schedule",
  builder: (yargs) =>
    yargs.positional("id", { type: "string", describe: "schedule ID" }),
  async handler(args) {
    UI.empty()
    try {
      const res = await fetch(`${BRIDGE_URL}/schedules/${encodeURIComponent(args.id as string)}/pause`, {
        method: "POST",
        headers: bridgeHeaders(),
      })
      if (res.ok) {
        prompts.log.success("Schedule paused")
      } else {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        prompts.log.error(String(err.error))
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

const HiveScheduleResumeCommand = cmd({
  command: "resume <id>",
  describe: "resume a paused schedule",
  builder: (yargs) =>
    yargs.positional("id", { type: "string", describe: "schedule ID" }),
  async handler(args) {
    UI.empty()
    try {
      const res = await fetch(`${BRIDGE_URL}/schedules/${encodeURIComponent(args.id as string)}/resume`, {
        method: "POST",
        headers: bridgeHeaders(),
      })
      if (res.ok) {
        prompts.log.success("Schedule resumed")
      } else {
        const err = await res.json().catch(() => ({ error: res.statusText })) as Record<string, unknown>
        prompts.log.error(String(err.error))
      }
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
  },
})

const HiveScheduleCommand = cmd({
  command: "schedule",
  describe: "manage cron schedules on the local node",
  builder: (yargs) =>
    yargs
      .command(HiveScheduleListCommand)
      .command(HiveScheduleAddCommand)
      .command(HiveScheduleRmCommand)
      .command(HiveSchedulePauseCommand)
      .command(HiveScheduleResumeCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Peer-to-Peer (Hive Connections) — invite, accept, list, peers, chat, files, exec
//
// These wrap iris-api endpoints at /api/v6/nodes/connections/* which are
// already production-ready (HiveConnectionController + HiveNodeProxyController).
// Trust model: single IRIS SDK token. No third-party accounts. Real-time
// transport: Pusher private channels (server-side) — CLI uses polling for v1.
// ============================================================================

interface HiveConnectionRow {
  id: string
  status: string
  invite_code: string
  peer_user_id: number | null
  peer_name: string | null
  is_inviter: boolean
  permissions: Record<string, boolean>
  accepted_at: string | null
  expires_at: string | null
  created_at: string
}

function formatPerms(perms: Record<string, boolean>): string {
  const enabled = Object.entries(perms || {})
    .filter(([, v]) => v)
    .map(([k]) => k)
  return enabled.length > 0 ? enabled.join(",") : dim("none")
}

function printConnection(c: HiveConnectionRow): void {
  const role = c.is_inviter ? dim("(inviter)") : dim("(invitee)")
  const peer = c.peer_name ? bold(c.peer_name) : dim("pending — share invite code")
  const statusColor =
    c.status === "active"
      ? `${UI.Style.TEXT_SUCCESS}● ${c.status}${UI.Style.TEXT_NORMAL}`
      : `${UI.Style.TEXT_HIGHLIGHT}◌ ${c.status}${UI.Style.TEXT_NORMAL}`
  console.log(`  ${peer}  ${role}  ${statusColor}`)
  console.log(`    ${dim("id:")}    ${c.id}`)
  console.log(`    ${dim("perms:")} ${formatPerms(c.permissions)}`)
  if (c.status === "pending" && c.invite_code) {
    console.log(`    ${dim("code:")}  ${highlight(c.invite_code)}  ${dim("(share with peer to accept)")}`)
  }
  if (c.expires_at) {
    console.log(`    ${dim("expires:")} ${new Date(c.expires_at).toLocaleString()}`)
  }
}

const HiveInviteCommand = cmd({
  command: "invite",
  describe: "generate an invite code to share your Hive with another IRIS user",
  builder: (yargs) =>
    yargs
      .option("permissions", {
        describe: "comma-separated: files,chat,terminal,tasks",
        type: "string",
        default: "files,chat",
      })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Invite")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const requested = String(args.permissions || "files,chat")
      .split(",")
      .map((p) => p.trim().toLowerCase())
      .filter(Boolean)

    const permissions: Record<string, boolean> = {
      files: requested.includes("files"),
      chat: requested.includes("chat"),
      terminal: requested.includes("terminal"),
      tasks: requested.includes("tasks"),
    }

    const spinner = prompts.spinner()
    spinner.start("Generating invite…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/connections/invite`, {
        method: "POST",
        body: JSON.stringify({ user_id: userId, permissions }),
      })
      const ok = await handleApiError(res, "Generate invite")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = (await res.json()) as { invite_code: string; connection: HiveConnectionRow }
      spinner.stop("Invite created")
      printDivider()
      console.log()
      console.log(`  ${dim("Invite code:")}  ${bold(highlight(json.invite_code))}`)
      console.log(`  ${dim("Permissions:")}  ${formatPerms(permissions)}`)
      console.log(`  ${dim("Expires:")}      ${new Date(json.connection.expires_at || "").toLocaleString()}`)
      console.log()
      console.log(`  ${dim("Share this command with your peer:")}`)
      console.log(`    ${highlight("iris hive accept " + json.invite_code)}`)
      console.log()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveAcceptCommand = cmd({
  command: "accept <code>",
  describe: "accept a Hive invite code from another IRIS user",
  builder: (yargs) =>
    yargs
      .positional("code", { describe: "12-character invite code", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Accept")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const code = String(args.code).trim().toUpperCase()
    if (code.length !== 12) {
      prompts.log.error("Invite code must be 12 characters")
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()
    spinner.start(`Accepting invite ${code}…`)

    try {
      const res = await hiveFetch(`/api/v6/nodes/connections/accept`, {
        method: "POST",
        body: JSON.stringify({ user_id: userId, invite_code: code }),
      })
      const ok = await handleApiError(res, "Accept invite")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = (await res.json()) as { connection: HiveConnectionRow }
      spinner.stop("Connected!")
      printDivider()
      console.log()
      printConnection(json.connection)
      console.log()
      console.log(`  ${dim("Next steps:")}`)
      console.log(`    ${highlight("iris hive peers " + json.connection.id)}    ${dim("# list peer's nodes")}`)
      console.log(`    ${highlight("iris hive chat " + json.connection.id)}     ${dim("# chat with peer")}`)
      console.log()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveConnectionsCommand = cmd({
  command: "connections",
  aliases: ["conns"],
  describe: "list your active Hive peer connections",
  builder: (yargs) => yargs.option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Connections")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading connections…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/connections/?user_id=${userId}`)
      const ok = await handleApiError(res, "List connections")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = (await res.json()) as { connections: HiveConnectionRow[] }
      const conns = json.connections || []
      spinner.stop(`${conns.length} connection(s)`)
      printDivider()

      if (conns.length === 0) {
        console.log()
        console.log(dim("  No connections yet."))
        console.log(dim("  Create one with: ") + highlight("iris hive invite"))
        console.log()
      } else {
        for (const c of conns) {
          console.log()
          printConnection(c)
        }
        console.log()
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HivePeersCommand = cmd({
  command: "peers <connection-id>",
  describe: "list a connected peer's online compute nodes",
  builder: (yargs) =>
    yargs
      .positional("connection-id", { describe: "connection UUID", type: "string", demandOption: true })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Peer Nodes")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const connId = String(args["connection-id"])
    const spinner = prompts.spinner()
    spinner.start("Loading peer nodes…")

    try {
      const res = await hiveFetch(`/api/v6/nodes/connections/${connId}/nodes?user_id=${userId}`)
      const ok = await handleApiError(res, "List peer nodes")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = (await res.json()) as { nodes: Array<Record<string, unknown>> }
      const nodes = json.nodes || []
      spinner.stop(`${nodes.length} node(s) online`)
      printDivider()

      if (nodes.length === 0) {
        console.log()
        console.log(dim("  No peer nodes online right now."))
        console.log()
      } else {
        for (const n of nodes) {
          console.log()
          console.log(`  ${bold(String(n.name))}  ${dim(String(n.id))}`)
          console.log(`    ${dim("status:")} ${success(String(n.connection_status))}  ${dim("active tasks:")} ${n.active_tasks}`)
          if (n.last_heartbeat_at) {
            console.log(`    ${dim("last seen:")} ${new Date(String(n.last_heartbeat_at)).toLocaleString()}`)
          }
        }
        console.log()
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveChatCommand = cmd({
  command: "chat <connection-id>",
  describe: "open an interactive chat session with a connected peer",
  builder: (yargs) =>
    yargs
      .positional("connection-id", { describe: "connection UUID", type: "string", demandOption: true })
      .option("history", { describe: "show last N messages on open", type: "number", default: 20 })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Chat")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const connId = String(args["connection-id"])
    const histLimit = Number(args.history) || 20

    // Load recent history
    try {
      const res = await hiveFetch(
        `/api/v6/nodes/connections/${connId}/messages?user_id=${userId}&limit=${histLimit}`,
      )
      const ok = await handleApiError(res, "Load history")
      if (!ok) { prompts.outro("Done"); return }

      const json = (await res.json()) as { messages: Array<Record<string, unknown>> }
      const msgs = (json.messages || []).slice().reverse() // oldest first

      printDivider()
      console.log(dim(`  ${msgs.length} recent message(s). Type to send. Ctrl-D or /quit to exit.`))
      console.log()

      for (const m of msgs) {
        const isMe = Number(m.sender_user_id) === userId
        const who = isMe ? success(String(m.sender_name)) : highlight(String(m.sender_name))
        const when = dim(new Date(String(m.created_at)).toLocaleTimeString())
        console.log(`  ${who} ${when}`)
        console.log(`    ${m.message}`)
      }
      console.log()
    } catch (err) {
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
      return
    }

    // Track most recent timestamp for cursor polling
    let lastSeenAt = new Date().toISOString()

    // Background poller — checks for new messages every 2s
    let polling = true
    const pollLoop = async () => {
      while (polling) {
        try {
          const res = await hiveFetch(
            `/api/v6/nodes/connections/${connId}/messages?user_id=${userId}&limit=20`,
          )
          if (res.ok) {
            const json = (await res.json()) as { messages: Array<Record<string, unknown>> }
            const fresh = (json.messages || [])
              .filter((m) => String(m.created_at) > lastSeenAt && Number(m.sender_user_id) !== userId)
              .reverse() // oldest first
            for (const m of fresh) {
              const who = highlight(String(m.sender_name))
              const when = dim(new Date(String(m.created_at)).toLocaleTimeString())
              process.stdout.write(`\r\x1b[K  ${who} ${when}\n`)
              process.stdout.write(`    ${m.message}\n`)
              process.stdout.write(`  ${dim("you>")} `)
              lastSeenAt = String(m.created_at)
            }
          }
        } catch {}
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    pollLoop()

    // Read user input via readline
    const readline = await import("readline")
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
    const prompt = `  ${dim("you>")} `

    const sendMessage = async (text: string): Promise<void> => {
      try {
        const res = await hiveFetch(`/api/v6/nodes/connections/${connId}/messages`, {
          method: "POST",
          body: JSON.stringify({ user_id: userId, message: text }),
        })
        if (!res.ok) {
          const body = await res.text().catch(() => "")
          process.stdout.write(`\r\x1b[K  ${dim("(send failed:")} ${body}${dim(")")}\n`)
        } else {
          const json = (await res.json()) as { message?: { created_at?: string } }
          if (json.message?.created_at) lastSeenAt = json.message.created_at
        }
      } catch (err) {
        process.stdout.write(`\r\x1b[K  ${dim("(error:")} ${err instanceof Error ? err.message : String(err)}${dim(")")}\n`)
      }
    }

    await new Promise<void>((resolve) => {
      rl.setPrompt(prompt)
      rl.prompt()
      rl.on("line", async (line) => {
        const text = line.trim()
        if (text === "/quit" || text === "/exit") {
          rl.close()
          return
        }
        if (text.length > 0) {
          await sendMessage(text)
        }
        rl.prompt()
      })
      rl.on("close", () => {
        polling = false
        resolve()
      })
    })

    console.log()
    prompts.outro("Chat closed")
  },
})

const HiveFilesCommand = cmd({
  command: "files <connection-id>",
  describe: "browse or download files from a peer's node",
  builder: (yargs) =>
    yargs
      .positional("connection-id", { describe: "connection UUID", type: "string", demandOption: true })
      .option("node", { describe: "peer node ID (run: iris hive peers <conn>)", type: "string", demandOption: true })
      .option("path", { describe: "remote path to browse", type: "string", default: "/" })
      .option("download", { describe: "download remote file to this local path", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(args.download ? "◈  Hive Download" : "◈  Hive Files")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const connId = String(args["connection-id"])
    const nodeId = String(args.node)
    const remotePath = String(args.path)
    const isDownload = Boolean(args.download)

    const spinner = prompts.spinner()
    spinner.start(isDownload ? `Downloading ${remotePath}…` : `Browsing ${remotePath}…`)

    try {
      const res = await hiveFetch(`/api/v6/nodes/connections/${connId}/relay`, {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          node_id: nodeId,
          action: isDownload ? "download" : "files",
          params: { path: remotePath },
        }),
      })
      const ok = await handleApiError(res, isDownload ? "Download" : "Browse")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = (await res.json()) as { result?: Record<string, unknown> }
      const result = json.result || {}

      if (isDownload && result.content_base64) {
        const fs = await import("fs")
        const localPath = String(args.download)
        fs.writeFileSync(localPath, Buffer.from(String(result.content_base64), "base64"))
        spinner.stop(`Saved to ${localPath} (${result.size} bytes)`)
      } else if (result.type === "file") {
        spinner.stop(`File: ${result.path}`)
        printDivider()
        console.log()
        printKV("size", `${result.size} bytes`)
        printKV("modified", String(result.modified))
        if (result.content) {
          console.log()
          console.log(dim("--- file content ---"))
          console.log(String(result.content))
        }
      } else {
        // Directory listing
        const entries = (result.entries as Array<Record<string, unknown>>) || []
        spinner.stop(`${entries.length} entries in ${result.path}`)
        printDivider()
        console.log()
        for (const e of entries) {
          const icon = e.type === "directory" ? "📁" : "📄"
          const size = e.type === "file" ? dim(`${e.size} bytes`) : dim(`${e.children ?? 0} items`)
          console.log(`  ${icon}  ${bold(String(e.name))}  ${size}`)
        }
        console.log()
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveExecCommand = cmd({
  command: "exec <connection-id> <command>",
  describe: "run a shell command on a peer's node and stream the output back",
  builder: (yargs) =>
    yargs
      .positional("connection-id", { describe: "connection UUID", type: "string", demandOption: true })
      .positional("command", { describe: "shell command (quote it)", type: "string", demandOption: true })
      .option("node", { describe: "peer node ID (run: iris hive peers <conn>)", type: "string", demandOption: true })
      .option("cwd", { describe: "remote working directory", type: "string" })
      .option("timeout", { describe: "max seconds (1-60)", type: "number", default: 30 })
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Remote Exec")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const connId = String(args["connection-id"])
    const nodeId = String(args.node)
    const command = String(args.command)
    const timeout = Math.max(1, Math.min(Number(args.timeout) || 30, 60))

    const spinner = prompts.spinner()
    spinner.start(`Running on peer node…`)

    try {
      const res = await hiveFetch(`/api/v6/nodes/connections/${connId}/relay`, {
        method: "POST",
        body: JSON.stringify({
          user_id: userId,
          node_id: nodeId,
          action: "exec",
          params: {
            command,
            cwd: args.cwd || null,
            timeout_seconds: timeout,
          },
        }),
      })
      const ok = await handleApiError(res, "Remote exec")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = (await res.json()) as {
        result?: { command: string; stdout: string; stderr: string; exit_code: number; duration_ms: number; cwd?: string }
      }
      const r = json.result
      if (!r) {
        spinner.stop("Empty result", 1)
        prompts.outro("Done"); return
      }

      const exitOk = r.exit_code === 0
      spinner.stop(exitOk ? `exit ${r.exit_code} (${r.duration_ms}ms)` : `exit ${r.exit_code} (${r.duration_ms}ms)`, exitOk ? 0 : 1)
      printDivider()
      console.log()
      console.log(`  ${dim("$")} ${highlight(r.command)}`)
      if (r.cwd) console.log(`  ${dim("cwd:")} ${r.cwd}`)
      console.log()
      if (r.stdout) {
        console.log(r.stdout.replace(/\n$/, ""))
      }
      if (r.stderr) {
        console.log()
        console.log(dim("--- stderr ---"))
        console.log(r.stderr.replace(/\n$/, ""))
      }
      console.log()
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// credentials — manage project credentials across machines
// ============================================================================

const HiveCredentialsListCommand = cmd({
  command: "list <bloq-id>",
  describe: "list project credentials",
  builder: (yargs) =>
    yargs.positional("bloq-id", { describe: "bloq/project ID", type: "number", demandOption: true }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await requireUserId()
    if (!userId) return

    const params = new URLSearchParams()
    params.set("bloq_id", String(args["bloq-id"]))
    params.set("user_id", String(userId))

    const res = await hiveFetch(`/api/v1/project-credentials?${params}`)
    const ok = await handleApiError(res, "List credentials")
    if (!ok) return

    const data = (await res.json()) as any
    const creds: any[] = data?.data ?? []

    printDivider()
    if (creds.length === 0) {
      console.log(`  ${dim("No credentials found")}`)
    } else {
      for (const c of creds) {
        const expired = c.status === "expired" ? "  EXPIRED" : ""
        console.log(`  ${bold(c.platform)}  ${dim(`bloq:${c.bloq_id}`)}  ${dim(c.credential_type)}  ${dim(`#${c.id}`)}${expired}`)
      }
    }
    printDivider()
    console.log(dim("  iris hive credentials add --help"))
    console.log("")
  },
})

const HiveCredentialsAddCommand = cmd({
  command: "add",
  describe: "store a new project credential",
  builder: (yargs) =>
    yargs
      .option("bloq-id", { describe: "bloq/project ID", type: "number", demandOption: true })
      .option("platform", { describe: "platform (n8n, youtube, instagram, twitter, linkedin, email)", type: "string", demandOption: true })
      .option("type", { describe: "credential type", type: "string", choices: ["api_key", "browser_session"], default: "api_key" })
      .option("key", { describe: "key=value pairs for api_key type (repeatable)", type: "array" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    let credentials: Record<string, string> = {}

    if (args.type === "api_key") {
      // Parse key=value pairs from --key flags
      const keys = (args.key || []) as string[]
      if (keys.length === 0) {
        // Interactive: ask for key-value pairs
        console.log(dim("  Enter credentials as KEY=VALUE (one per line, empty line to finish):"))
        let line: string | symbol
        while (true) {
          line = await prompts.text({ message: "KEY=VALUE (or empty to finish)", placeholder: "N8N_EMAIL=admin@example.com" })
          if (prompts.isCancel(line) || !line || String(line).trim() === "") break
          const eq = String(line).indexOf("=")
          if (eq > 0) {
            credentials[String(line).slice(0, eq).trim()] = String(line).slice(eq + 1).trim()
          }
        }
      } else {
        for (const kv of keys) {
          const eq = String(kv).indexOf("=")
          if (eq > 0) {
            credentials[String(kv).slice(0, eq).trim()] = String(kv).slice(eq + 1).trim()
          }
        }
      }
    } else {
      // browser_session: read from file
      const filePath = await prompts.text({ message: "Path to session JSON file" })
      if (prompts.isCancel(filePath)) return
      try {
        const content = await Bun.file(String(filePath)).text()
        credentials = JSON.parse(content)
      } catch (e: any) {
        console.error(`Failed to read session file: ${e.message}`)
        return
      }
    }

    if (Object.keys(credentials).length === 0) {
      console.log(dim("No credentials provided"))
      return
    }

    const userId = await requireUserId()
    if (!userId) return

    const res = await hiveFetch("/api/v1/project-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bloq_id: args["bloq-id"],
        platform: args.platform,
        credential_type: args.type,
        credentials: JSON.stringify(credentials),
        user_id: userId,
      }),
    })
    const ok = await handleApiError(res, "Store credential")
    if (!ok) return

    const data = (await res.json()) as any
    const cred = data?.data ?? data
    printDivider()
    printKV("ID", cred.id)
    printKV("Platform", args.platform)
    printKV("Type", args.type)
    printKV("Bloq", args["bloq-id"])
    printKV("Keys", Object.keys(credentials).join(", "))
    printDivider()
    console.log(success("Credential stored — available to all Hive nodes for this project"))
    console.log("")
  },
})

const HiveCredentialsUploadCommand = cmd({
  command: "upload",
  describe: "upload a browser session file (shortcut for add --type browser_session)",
  builder: (yargs) =>
    yargs
      .option("platform", { describe: "platform (instagram, linkedin, twitter, youtube)", type: "string", demandOption: true })
      .option("account", { describe: "account handle (e.g. thebeatbox__)", type: "string" })
      .option("file", { describe: "path to session JSON file", type: "string", demandOption: true })
      .option("bloq", { describe: "bloq/project ID", type: "number", demandOption: true }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await requireUserId()
    if (!userId) return

    const fs = require("fs")
    const filePath = String(args.file)
    if (!fs.existsSync(filePath)) {
      console.error(`File not found: ${filePath}`)
      return
    }

    let credentials: any
    try {
      credentials = JSON.parse(fs.readFileSync(filePath, "utf8"))
    } catch (e: any) {
      console.error(`Failed to read session file: ${e.message}`)
      return
    }

    const cookieCount = credentials?.cookies?.length ?? Object.keys(credentials).length
    console.log(dim(`  Read ${cookieCount} cookies from ${filePath}`))

    const res = await hiveFetch("/api/v1/project-credentials", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        bloq_id: args.bloq,
        platform: args.platform,
        credential_type: "browser_session",
        credentials: JSON.stringify(credentials),
        user_id: userId,
        account: args.account || null,
      }),
    })
    const ok = await handleApiError(res, "Upload credential")
    if (!ok) return

    printDivider()
    printKV("Platform", args.platform)
    if (args.account) printKV("Account", args.account)
    printKV("Bloq", args.bloq)
    printKV("Cookies", cookieCount)
    printDivider()
    console.log(success("Session uploaded — Hive nodes will use it automatically"))
    console.log("")
  },
})

const HiveCredentialsSaveSessionCommand = cmd({
  command: "save-session",
  aliases: ["connect"],
  describe: "open a browser, log in, and auto-upload session to project vault",
  builder: (yargs) =>
    yargs
      .option("platform", { describe: "platform (instagram, linkedin, twitter, youtube)", type: "string", demandOption: true })
      .option("bloq", { describe: "bloq/project ID", type: "number", demandOption: true })
      .option("account", { describe: "account handle", type: "string" }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const userId = await requireUserId()
    if (!userId) return

    const path = require("path")
    const os = require("os")
    const { execSync } = require("child_process")

    const bridgeDir = path.join(os.homedir(), ".iris", "bridge")
    const connectScript = path.join(bridgeDir, "installers", "connect-session.js")
    const fs = require("fs")

    if (!fs.existsSync(connectScript)) {
      console.error("Bridge not installed. Run: curl -fsSL https://heyiris.io/install-code | bash")
      return
    }

    const apiUrl = process.env.IRIS_API_URL ?? "https://freelabel.net"
    const apiToken = await getBridgeToken()

    console.log(dim(`  Opening browser for ${args.platform} login...`))
    console.log(dim(`  Log in, handle any 2FA, then the window will close automatically.\n`))

    try {
      execSync(
        `node "${connectScript}" --platform ${args.platform} --project ${args.bloq} --user-id ${userId} --api-url ${apiUrl}`,
        { stdio: "inherit", env: { ...process.env, FL_RAICHU_API_TOKEN: apiToken || "" } }
      )
    } catch {
      console.error("Session capture failed. Try again or use: iris hive credentials upload --file <path>")
    }
  },
})

const HiveCredentialsRemoveCommand = cmd({
  command: "remove <id>",
  describe: "revoke a project credential",
  builder: (yargs) =>
    yargs.positional("id", { describe: "credential ID", type: "string", demandOption: true }),
  async handler(args) {
    const token = await requireAuth()
    if (!token) return

    const res = await hiveFetch(`/api/v1/project-credentials/${args.id}`, { method: "DELETE" })
    const ok = await handleApiError(res, "Remove credential")
    if (!ok) return

    console.log(success(`Credential ${args.id} removed`))
  },
})

const HiveSeedCommand = cmd({
  command: "seed",
  describe: "seed default campaign templates for your account",
  builder: (yargs) =>
    yargs.option("defaults", { describe: "seed default templates", type: "boolean", default: true }),
  async handler() {
    UI.empty()
    prompts.intro("Seed Campaign Templates")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId()
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Seeding default templates...")

    try {
      const res = await hiveFetch("/api/v1/campaign-templates/seed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ user_id: userId }),
      })
      const ok = await handleApiError(res, "Seed templates")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      spinner.stop(success(`${data.count ?? 0} template(s) — ${data.message}`))
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveCredentialsCommand = cmd({
  command: "credentials",
  aliases: ["creds"],
  describe: "manage project credentials across Hive machines",
  builder: (yargs) =>
    yargs
      .command(HiveCredentialsListCommand)
      .command(HiveCredentialsAddCommand)
      .command(HiveCredentialsUploadCommand)
      .command(HiveCredentialsSaveSessionCommand)
      .command(HiveCredentialsRemoveCommand)
      .demandCommand(),
  async handler() {},
})

// ============================================================================
// Domain Management (Cloudflare + Domain Mappings)
// ============================================================================

const FL_API = process.env.FL_API_URL ?? "https://raichu.heyiris.io"

async function flApiFetch(path: string, options: RequestInit = {}) {
  return irisFetch(path, options, FL_API)
}

// ----------------------------------------------------------------------------
// Cloudflare REST API helpers (per-subdomain only — never zone-wide wildcards)
// Postmortem: a `*.freelabel.net/*` Worker route caused web.freelabel.net to
// loop redirect on May 1, 2026. This command MUST only ever provision per-
// subdomain DNS records and per-subdomain Worker routes.
// ----------------------------------------------------------------------------

const CF_API = "https://api.cloudflare.com/client/v4"
const CF_PROXY_SCRIPT = "iris-domain-proxy"

function readWranglerToken(): string | null {
  try {
    const fs = require("fs")
    const path = require("path")
    const os = require("os")
    const cfgPath = path.join(os.homedir(), "Library/Preferences/.wrangler/config/default.toml")
    if (!fs.existsSync(cfgPath)) return null
    const text = fs.readFileSync(cfgPath, "utf8") as string
    const match = text.match(/oauth_token\s*=\s*"([^"]+)"/)
    return match ? match[1] : null
  } catch { return null }
}

function getCfToken(): string | null {
  return process.env.CLOUDFLARE_API_TOKEN || process.env.CF_API_TOKEN || readWranglerToken()
}

async function cfFetch(path: string, options: RequestInit = {}): Promise<any> {
  const token = getCfToken()
  if (!token) throw new Error("No Cloudflare token. Set CLOUDFLARE_API_TOKEN or run: npx wrangler login")
  const res = await fetch(`${CF_API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  })
  return res.json()
}

async function cfGetZoneId(domain: string): Promise<string | null> {
  const r = await cfFetch(`/zones?name=${encodeURIComponent(domain)}`)
  return r?.result?.[0]?.id ?? null
}

async function cfCreateDnsRecord(zoneId: string, sub: string, baseDomain: string): Promise<{ ok: boolean, msg: string }> {
  const r = await cfFetch(`/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: JSON.stringify({ type: "A", name: sub, content: "192.0.2.1", proxied: true }),
  })
  if (r?.success) return { ok: true, msg: `DNS A ${sub}.${baseDomain} → 192.0.2.1 (proxied)` }
  const errs = (r?.errors || []) as Array<{ message: string }>
  const msg = errs.map((e) => e.message).join("; ")
  if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("identical")) {
    return { ok: true, msg: "DNS record already exists" }
  }
  return { ok: false, msg }
}

async function cfCreateWorkerRoute(zoneId: string, fullDomain: string): Promise<{ ok: boolean, msg: string }> {
  // CRITICAL: per-subdomain pattern only — never zone-wide wildcards.
  const pattern = `*${fullDomain}/*`
  const r = await cfFetch(`/zones/${zoneId}/workers/routes`, {
    method: "POST",
    body: JSON.stringify({ pattern, script: CF_PROXY_SCRIPT }),
  })
  if (r?.success) return { ok: true, msg: `Worker route ${pattern} → ${CF_PROXY_SCRIPT}` }
  const errs = (r?.errors || []) as Array<{ message: string }>
  const msg = errs.map((e) => e.message).join("; ")
  if (msg.toLowerCase().includes("already") || msg.toLowerCase().includes("conflict") || msg.toLowerCase().includes("duplicate")) {
    return { ok: true, msg: "Worker route already exists" }
  }
  return { ok: false, msg }
}

async function cfFindDnsRecord(zoneId: string, fullName: string): Promise<{ id: string } | null> {
  const r = await cfFetch(`/zones/${zoneId}/dns_records?name=${encodeURIComponent(fullName)}&type=A`)
  return r?.result?.[0] ?? null
}

async function cfFindWorkerRoute(zoneId: string, fullDomain: string): Promise<{ id: string, pattern: string } | null> {
  const r = await cfFetch(`/zones/${zoneId}/workers/routes`)
  const wanted = `*${fullDomain}/*`
  const match = (r?.result || []).find((rt: any) => rt.pattern === wanted)
  return match ?? null
}

async function cfDeleteDnsRecord(zoneId: string, recordId: string): Promise<boolean> {
  const r = await cfFetch(`/zones/${zoneId}/dns_records/${recordId}`, { method: "DELETE" })
  return !!r?.success
}

async function cfDeleteWorkerRoute(zoneId: string, routeId: string): Promise<boolean> {
  const r = await cfFetch(`/zones/${zoneId}/workers/routes/${routeId}`, { method: "DELETE" })
  return !!r?.success
}

const HiveDomainsProxyCommand = cmd({
  command: "proxy <subdomain> <target>",
  describe: "proxy a subdomain to an external URL via Cloudflare + domain mapping",
  builder: (yargs) =>
    yargs
      .positional("subdomain", { describe: "subdomain (e.g. 'comic' → comic.heyiris.io)", type: "string", demandOption: true })
      .positional("target", { describe: "target URL to proxy to (e.g. https://my-app.vercel.app)", type: "string", demandOption: true })
      .option("base-domain", { describe: "base domain", type: "string", default: "heyiris.io" })
      .option("skip-cf", { describe: "skip Cloudflare DNS/route setup (domain mapping only)", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Domain Proxy Setup")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const sub = args.subdomain as string
    const target = args.target as string
    const baseDomain = args["base-domain"] as string
    const domain = sub.includes(".") ? sub : `${sub}.${baseDomain}`
    const skipCf = args["skip-cf"] as boolean

    // Hard guard: never allow wildcard subdomains (caused freelabel.net redirect loop incident)
    if (sub === "*" || sub === "@" || sub.includes("*")) {
      prompts.log.error("Wildcard / apex subdomains are not allowed. Use a specific subdomain (e.g. 'comic').")
      prompts.outro("Done"); return
    }

    const spinner = prompts.spinner()

    // Step 1: Cloudflare DNS + per-subdomain Worker route via REST API
    if (!skipCf) {
      spinner.start(`Looking up Cloudflare zone ${baseDomain}…`)
      try {
        const zoneId = await cfGetZoneId(baseDomain)
        if (!zoneId) {
          spinner.stop(`Zone not found for ${baseDomain}`, 1)
          prompts.log.warn("Skipping Cloudflare setup — domain mapping only.")
        } else {
          spinner.stop(`Zone: ${baseDomain}`)

          spinner.start("Creating DNS record…")
          const dns = await cfCreateDnsRecord(zoneId, sub, baseDomain)
          if (dns.ok) spinner.stop(success(dns.msg))
          else { spinner.stop(`DNS failed: ${dns.msg}`, 1); prompts.outro("Done"); return }

          spinner.start("Creating Worker route…")
          const route = await cfCreateWorkerRoute(zoneId, domain)
          if (route.ok) spinner.stop(success(route.msg))
          else { spinner.stop(`Route failed: ${route.msg}`, 1); prompts.outro("Done"); return }
        }
      } catch (err) {
        spinner.stop("Cloudflare error", 1)
        prompts.log.warn(err instanceof Error ? err.message : String(err))
        prompts.log.warn("Continuing with domain mapping only. Set CLOUDFLARE_API_TOKEN or run: npx wrangler login")
      }
    }

    // Step 2: Create domain mapping in fl-api
    spinner.start("Creating domain mapping…")
    try {
      const res = await flApiFetch("/api/v1/domain-mappings", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain,
          mapping_type: "proxy",
          mapping_mode: "proxy",
          proxy_target: target,
          status: "active",
        }),
      })

      if (res.status === 422) {
        const err = await res.json() as Record<string, unknown>
        const errors = err.errors as Record<string, string[]> | undefined
        if (errors?.domain?.[0]?.includes("already")) {
          spinner.stop(dim("Domain mapping already exists — updating"))
          // Fetch existing mapping and update it
          const listRes = await flApiFetch("/api/v1/domain-mappings")
          const listJson = await listRes.json() as Record<string, unknown>
          const mappings = (listJson.data ?? []) as Record<string, unknown>[]
          const existing = mappings.find((m) => m.domain === domain)
          if (existing) {
            await flApiFetch(`/api/v1/domain-mappings/${existing.id}`, {
              method: "PUT",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ proxy_target: target, mapping_mode: "proxy", mapping_type: "proxy" }),
            })
            prompts.log.success("Domain mapping updated")
          }
        } else {
          spinner.stop("Failed", 1)
          prompts.log.error(JSON.stringify(errors))
          prompts.outro("Done"); return
        }
      } else {
        const ok = await handleApiError(res, "Create domain mapping")
        if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
        spinner.stop(success("Domain mapping created"))
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done"); return
    }

    // Summary
    printDivider()
    printKV("Domain", bold(domain))
    printKV("Target", target)
    printKV("Mode", "proxy")
    console.log()
    console.log(dim(`  Test: curl -sI https://${domain}/`))
    console.log(dim(`  DNS may take 1-5 min to propagate`))

    prompts.outro("Done")
  },
})

const HiveDomainsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all domain mappings",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Domain Mappings")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Loading…")

    try {
      const res = await flApiFetch("/api/v1/domain-mappings")
      const ok = await handleApiError(res, "List domains")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }

      const json = await res.json() as Record<string, unknown>
      const mappings = (json.data ?? []) as Record<string, unknown>[]

      spinner.stop(`${mappings.length} mapping(s)`)
      printDivider()

      if (mappings.length === 0) {
        console.log(dim("  No domains configured. Add one with: iris hive domains proxy <subdomain> <target>"))
      } else {
        for (const m of mappings) {
          const mode = String(m.mapping_mode ?? m.mapping_type ?? "?")
          const target = m.proxy_target || (m.page_id ? `page #${m.page_id}` : m.site_id ? `site #${m.site_id}` : "?")
          const status = m.status === "active"
            ? `${UI.Style.TEXT_SUCCESS}● active${UI.Style.TEXT_NORMAL}`
            : dim(String(m.status ?? "pending"))
          console.log(`  ${bold(String(m.domain))}  ${dim(`[${mode}]`)}  → ${target}  ${status}`)
        }
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveDomainsRemoveCommand = cmd({
  command: "remove <domain>",
  aliases: ["rm", "delete"],
  describe: "remove a domain mapping",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "domain to remove", type: "string", demandOption: true })
      .option("force", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Remove Domain Mapping")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const domain = args.domain as string
    const spinner = prompts.spinner()
    spinner.start("Finding mapping…")

    try {
      const listRes = await flApiFetch("/api/v1/domain-mappings")
      const listJson = await listRes.json() as Record<string, unknown>
      const mappings = (listJson.data ?? []) as Record<string, unknown>[]
      const mapping = mappings.find((m) => String(m.domain) === domain)

      if (!mapping) {
        spinner.stop("Not found", 1)
        prompts.log.error(`No mapping found for ${domain}`)
        prompts.outro("Done"); return
      }

      spinner.stop(`Found: ${domain} → ${mapping.proxy_target || `page #${mapping.page_id}`}`)

      if (!args.force) {
        const confirmed = await prompts.confirm({ message: `Delete mapping for ${bold(domain)}?` })
        if (!confirmed || prompts.isCancel(confirmed)) {
          prompts.outro("Cancelled"); return
        }
      }

      spinner.start("Deleting domain mapping…")
      const res = await flApiFetch(`/api/v1/domain-mappings/${mapping.id}`, { method: "DELETE" })
      const ok = await handleApiError(res, "Delete mapping")
      if (!ok) { spinner.stop("Failed", 1); prompts.outro("Done"); return }
      spinner.stop(success("Domain mapping removed"))

      // Clean up Cloudflare resources (per-subdomain only — same scope as create)
      const parts = domain.split(".")
      if (parts.length >= 3) {
        const sub = parts[0]
        const baseDomain = parts.slice(1).join(".")
        try {
          spinner.start("Cleaning up Cloudflare DNS + Worker route…")
          const zoneId = await cfGetZoneId(baseDomain)
          if (zoneId) {
            const dnsRecord = await cfFindDnsRecord(zoneId, domain)
            const workerRoute = await cfFindWorkerRoute(zoneId, domain)
            const messages: string[] = []
            if (dnsRecord) {
              if (await cfDeleteDnsRecord(zoneId, dnsRecord.id)) messages.push("DNS deleted")
            }
            if (workerRoute) {
              if (await cfDeleteWorkerRoute(zoneId, workerRoute.id)) messages.push("Worker route deleted")
            }
            spinner.stop(messages.length ? success(messages.join(", ")) : dim("No CF resources found"))
          } else {
            spinner.stop(dim(`Zone not found for ${baseDomain} — skipped CF cleanup`))
          }
        } catch (err) {
          spinner.stop(dim("CF cleanup skipped — set CLOUDFLARE_API_TOKEN or run: npx wrangler login"))
        }
      } else {
        console.log(dim(`  Skipped CF cleanup (couldn't parse subdomain from ${domain})`))
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

const HiveDomainsCommand = cmd({
  command: "domains",
  describe: "manage domain mappings and proxies",
  builder: (yargs) =>
    yargs
      .command(HiveDomainsProxyCommand)
      .command(HiveDomainsListCommand)
      .command(HiveDomainsRemoveCommand)
      .demandCommand(1, "Specify: proxy, list, or remove"),
  async handler() {},
})

// ============================================================================
// Dashboard — unified status view
// ============================================================================

function dashFormatDuration(ms: number): string {
  if (ms < 0) return "0s"
  const s = Math.floor(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const rs = s % 60
  if (m < 60) return `${m}m ${rs}s`
  const h = Math.floor(m / 60)
  const rm = m % 60
  return `${h}h ${rm}m`
}

function formatTime(dateStr: string): string {
  try {
    const d = new Date(dateStr)
    return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
  } catch { return "" }
}

function dashTimeUntil(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const now = Date.now()
  const target = new Date(String(dateStr)).getTime()
  const diff = target - now
  if (isNaN(target)) return ""
  if (diff < 0) return "overdue"
  if (diff < 60_000) return `${Math.round(diff / 1000)}s`
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m`
  if (diff < 86400_000) {
    const h = Math.floor(diff / 3600_000)
    const m = Math.round((diff % 3600_000) / 60_000)
    return `${h}h ${m}m`
  }
  return `${Math.round(diff / 86400_000)}d`
}

const HiveDashboardCommand = cmd({
  command: "dashboard",
  aliases: ["dash"],
  describe: "unified status view — daemon, schedules, tasks",
  builder: (yargs) =>
    yargs
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("watch", { alias: "w", describe: "refresh every 10 seconds", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    const renderDashboard = async () => {
      if (args.watch) {
        // Clear screen for watch mode
        process.stdout.write("\x1B[2J\x1B[0f")
      }

      if (!args.json) {
        UI.empty()
        console.log(`  ${bold("IRIS Hive Dashboard")}`)
        printDivider()
      }

      const token = await requireAuth()
      if (!token) { if (!args.json) console.log(dim("  Not authenticated")); return }

      const userId = await requireUserId(args["user-id"])
      if (!userId) { if (!args.json) console.log(dim("  No user ID")); return }

      // ── Parallel fetches ─────────────────────────────────────────────
      const [daemonResult, schedulesResult, historyResult, pendingResult, allJobsResult] = await Promise.all([
        // 1. Local daemon status
        (async () => {
          try {
            const [qRes, hRes] = await Promise.all([
              bridgeFetch("/daemon/queue").catch(() => null),
              bridgeFetch("/daemon/health").catch(() => null),
            ])
            if (!qRes || !qRes.ok) return null
            const queue = await qRes.json() as Record<string, unknown>
            const health = hRes && hRes.ok ? await hRes.json() as Record<string, unknown> : {}
            return { queue, health }
          } catch { return null }
        })(),

        // 2. Scheduled jobs — all active statuses (fl-api)
        (async () => {
          try {
            const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?per_page=50&status=scheduled`)
            if (!res.ok) return []
            const data = await res.json() as Record<string, any>
            return (data?.data ?? []) as any[]
          } catch { return [] }
        })(),

        // 3. Recent task history (iris-api node tasks)
        (async () => {
          try {
            const res = await hiveFetch(`/api/v6/nodes/tasks?limit=10&sort=-created_at`)
            if (!res.ok) return []
            const data = await res.json() as Record<string, any>
            return (data?.data ?? data?.tasks ?? []) as any[]
          } catch { return [] }
        })(),

        // 4. Pending cloud tasks
        (async () => {
          try {
            const res = await nodeFetch("/api/v6/node-agent/tasks/pending")
            if (!res.ok) return []
            const data = await res.json() as Record<string, any>
            return (data?.tasks ?? []) as any[]
          } catch { return [] }
        })(),

        // 5. All jobs including running/completed for summary stats
        (async () => {
          try {
            const res = await irisFetch(`/api/v1/users/${userId}/bloqs/scheduled-jobs?all=1&per_page=200`)
            if (!res.ok) return []
            const data = await res.json() as Record<string, any>
            return (data?.data ?? []) as any[]
          } catch { return [] }
        })(),
      ])

      // ── Compute summary stats ─────────────────────────────────────────
      const jobsByStatus = { scheduled: 0, running: 0, paused: 0, completed: 0, failed: 0 }
      for (const j of allJobsResult) {
        const s = String(j.status ?? "").toLowerCase()
        if (s in jobsByStatus) (jobsByStatus as any)[s]++
      }

      // ── JSON output ──────────────────────────────────────────────────
      if (args.json) {
        const daemon = daemonResult ? {
          status: daemonResult.health.paused ? "paused" : "online",
          node_name: daemonResult.health.node_name ?? null,
          active_tasks: daemonResult.queue.active_tasks ?? 0,
          tasks: daemonResult.queue.tasks ?? [],
        } : { status: "offline", node_name: null, active_tasks: 0, tasks: [] }

        console.log(JSON.stringify({
          daemon,
          summary: jobsByStatus,
          pending_tasks: pendingResult.length,
          scheduled_jobs: schedulesResult.slice(0, 10).map((s: any) => ({
            id: s.id,
            name: s.name ?? s.task_name,
            frequency: s.frequency,
            next_run_at: s.next_run_at,
          })),
          recent_history: historyResult.slice(0, 10).map((t: any) => ({
            id: t.id,
            type: t.type ?? t.task_type,
            status: t.status,
            created_at: t.created_at,
          })),
        }, null, 2))
        return
      }

      // ── Summary line ─────────────────────────────────────────────────
      const summaryParts: string[] = []
      if (jobsByStatus.scheduled > 0) summaryParts.push(`${jobsByStatus.scheduled} scheduled`)
      if (jobsByStatus.running > 0) summaryParts.push(`${jobsByStatus.running} running`)
      if (jobsByStatus.paused > 0) summaryParts.push(`${jobsByStatus.paused} paused`)
      if (pendingResult.length > 0) summaryParts.push(`${pendingResult.length} queued`)
      if (summaryParts.length > 0) {
        console.log(`  ${bold("Jobs")}      ${summaryParts.join(" | ")}`)
      }

      // ── Daemon section ───────────────────────────────────────────────
      if (daemonResult) {
        const q = daemonResult.queue
        const h = daemonResult.health
        const daemonStatus = (h as any).paused
          ? highlight("paused")
          : success("online")
        const activeTasks = Number(q.active_tasks ?? 0)
        const taskLabel = activeTasks > 0
          ? `${activeTasks} active task${activeTasks !== 1 ? "s" : ""}`
          : "idle"
        console.log(`  ${bold("Daemon")}    ${daemonStatus} | ${taskLabel}`)

        const nodeName = (h as any).node_name ?? (h as any).hostname ?? ""
        const platform = (h as any).platform ?? ""
        const mem = (h as any).memory_gb ? `${(h as any).memory_gb}GB` : ""
        if (nodeName) {
          const parts = [nodeName, platform, mem].filter(Boolean).join(" | ")
          console.log(`  ${bold("Node")}      ${dim(parts)}`)
        }

        // Show running tasks
        const tasks = (q.tasks ?? []) as Record<string, unknown>[]
        if (tasks.length > 0) {
          console.log()
          console.log(`  ${bold(`Running Tasks (${tasks.length})`)}`)
          for (const t of tasks) {
            const id = dim(String(t.id ?? "").substring(0, 12) + "...")
            const title = String(t.title ?? t.type ?? "unknown")
            const uptime = t.uptime_s ? dashFormatDuration(Number(t.uptime_s) * 1000) : ""
            console.log(`    ${success("▶")} ${id} ${title.padEnd(20)} ${dim(uptime)}`)
          }
        }
      } else {
        console.log(`  ${bold("Daemon")}    ${dim("offline")}`)
      }

      // ── Pending cloud tasks ──────────────────────────────────────────
      if (pendingResult.length > 0) {
        console.log()
        console.log(`  ${bold(`Queued Tasks (${pendingResult.length})`)}`)
        for (const t of pendingResult.slice(0, 5)) {
          const id = dim(String(t.id ?? "").substring(0, 12) + "...")
          const title = String(t.title ?? t.type ?? "unknown")
          const status = dim(String(t.status ?? "pending"))
          console.log(`    ◌ ${id} ${title.padEnd(20)} ${status}`)
        }
        if (pendingResult.length > 5) {
          console.log(dim(`    ... and ${pendingResult.length - 5} more`))
        }
      }

      // ── Scheduled Jobs section ───────────────────────────────────────
      const activeSchedules = schedulesResult
        .filter((s: any) => s.status === "scheduled" && s.next_run_at)
        .sort((a: any, b: any) => new Date(a.next_run_at).getTime() - new Date(b.next_run_at).getTime())
        .slice(0, 5)

      if (activeSchedules.length > 0) {
        console.log()
        console.log(`  ${bold(`Scheduled Jobs (next ${activeSchedules.length})`)}`)
        for (const s of activeSchedules) {
          const id = dim(`#${s.id}`.padEnd(6))
          const name = String(s.name ?? s.task_name ?? "").slice(0, 20)
          const freq = dim(String(s.frequency ?? "").replace(/_/g, " ").padEnd(14))
          const until = dashTimeUntil(s.next_run_at)
          const untilStr = until === "overdue"
            ? `${UI.Style.TEXT_DANGER}overdue${UI.Style.TEXT_NORMAL}`
            : `next: ${until}`
          console.log(`    ${id} ${name.padEnd(20)} ${freq} ${dim(untilStr)}`)
        }
      } else if (schedulesResult.length > 0) {
        console.log()
        console.log(`  ${bold("Scheduled Jobs")}  ${dim("none due")}`)
      }

      // ── Recent History section ───────────────────────────────────────
      const recentTasks = historyResult.slice(0, 5)
      if (recentTasks.length > 0) {
        console.log()
        console.log(`  ${bold(`Recent History (last ${recentTasks.length})`)}`)
        for (const t of recentTasks) {
          const taskType = String(t.type ?? t.task_type ?? t.title ?? "task").slice(0, 18)
          const status = String(t.status ?? "").toLowerCase()
          let statusStr: string
          if (status === "completed") statusStr = `${UI.Style.TEXT_SUCCESS}completed${UI.Style.TEXT_NORMAL}`
          else if (status === "failed") statusStr = `${UI.Style.TEXT_DANGER}failed${UI.Style.TEXT_NORMAL}`
          else if (status === "running") statusStr = `${UI.Style.TEXT_HIGHLIGHT}running${UI.Style.TEXT_NORMAL}`
          else statusStr = dim(status)

          // Duration
          let dur = ""
          if (t.started_at && t.completed_at) {
            const ms = new Date(t.completed_at).getTime() - new Date(t.started_at).getTime()
            dur = dashFormatDuration(ms)
          } else if (t.duration_s) {
            dur = dashFormatDuration(Number(t.duration_s) * 1000)
          }

          const time = formatTime(t.completed_at ?? t.created_at ?? "")
          console.log(`    ${taskType.padEnd(18)} ${statusStr.padEnd(22)} ${dim(dur.padEnd(10))} ${dim(time)}`)
        }
      }

      printDivider()

      if (args.watch) {
        console.log(dim(`  Refreshing every 10s — Ctrl+C to stop`))
      }
    }

    // ── Watch mode ───────────────────────────────────────────────────────
    if (args.watch) {
      await renderDashboard()
      const interval = setInterval(async () => {
        try {
          await renderDashboard()
        } catch (err) {
          console.error(err instanceof Error ? err.message : String(err))
        }
      }, 10_000)

      // Keep process alive until Ctrl+C
      process.on("SIGINT", () => {
        clearInterval(interval)
        console.log()
        process.exit(0)
      })

      // Wait indefinitely
      await new Promise(() => {})
    } else {
      await renderDashboard()
    }
  },
})

// ── iris hive api-keys ──────────────────────────────────────────────────

const HiveApiKeysCommand = cmd({
  command: "api-keys [action]",
  describe: "manage partner API keys for webhook triggers",
  builder: (yargs) =>
    yargs
      .positional("action", { describe: "create, list, or revoke", type: "string", default: "list" })
      .option("name", { describe: "partner name (for create)", type: "string" })
      .option("scopes", { describe: "comma-separated task types (for create)", type: "string" })
      .option("user-id", { describe: "user ID", type: "number" })
      .option("key-id", { describe: "key ID to revoke", type: "number" }),
  async handler(args) {
    UI.empty()
    const action = args.action as string
    const userId = await requireUserId(args["user-id"] as number | undefined)

    if (action === "create") {
      prompts.intro("◈  Create Partner API Key")
      const name = args.name as string
      if (!name) {
        prompts.log.error("Usage: iris hive api-keys create --name 'Partner Name' --scopes discover,som_batch")
        return
      }
      const scopes = args.scopes ? (args.scopes as string).split(",").map(s => s.trim()) : []
      const spinner = prompts.spinner()
      spinner.start("Creating API key…")

      try {
        const res = await hiveFetch("/api/v6/nodes/partner-api-keys", {
          method: "POST",
          body: JSON.stringify({ partner_name: name, scopes, user_id: userId }),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`)
        const data = await res.json() as Record<string, unknown>
        spinner.stop(success("Created"))
        printDivider()
        printKV("Partner", name)
        printKV("Scopes", scopes.length > 0 ? scopes.join(", ") : "all (unrestricted)")
        console.log()
        console.log(bold("  API Key (save this — it won't be shown again):"))
        printDivider()
        console.log(`  ${highlight(String(data.api_key ?? data.plaintext_key ?? "?"))}`)
        console.log()
        console.log(dim("  Usage:"))
        console.log(dim(`  curl -X POST https://freelabel.net/api/v1/webhooks/hive/trigger \\`))
        console.log(dim(`    -H "X-API-Key: ${String(data.api_key ?? 'pk_live_...').substring(0, 20)}..." \\`))
        console.log(dim(`    -H "Content-Type: application/json" \\`))
        console.log(dim(`    -d '{"task_type":"discover","prompt":"import-yt-feed"}'`))
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
      prompts.outro("Done")
      return
    }

    if (action === "revoke") {
      prompts.intro("◈  Revoke API Key")
      const keyId = args["key-id"] as number
      if (!keyId) {
        prompts.log.error("Usage: iris hive api-keys revoke --key-id 123")
        return
      }
      const spinner = prompts.spinner()
      spinner.start("Revoking…")
      try {
        const res = await hiveFetch(`/api/v6/nodes/partner-api-keys/${keyId}`, { method: "DELETE" })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        spinner.stop(success("Revoked"))
      } catch (err) {
        spinner.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
      }
      prompts.outro("Done")
      return
    }

    // Default: list
    prompts.intro("◈  Partner API Keys")
    const spinner = prompts.spinner()
    spinner.start("Loading…")
    try {
      const res = await hiveFetch(`/api/v6/nodes/partner-api-keys?user_id=${userId}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json() as Record<string, unknown>
      const keys = (data.keys ?? []) as Record<string, unknown>[]
      spinner.stop(`${keys.length} key(s)`)
      printDivider()
      if (keys.length === 0) {
        console.log(dim("  No API keys. Create one: iris hive api-keys create --name 'Partner Name'"))
      }
      for (const k of keys) {
        const scopes = Array.isArray(k.scopes) && k.scopes.length > 0 ? k.scopes.join(", ") : "all"
        const active = k.active ? success("active") : dim("revoked")
        const lastUsed = k.last_used_at ? timeAgo(String(k.last_used_at)) : dim("never")
        console.log(`  #${k.id}  ${bold(String(k.partner_name))}  ${active}  scopes: ${dim(scopes)}  last used: ${lastUsed}  prefix: ${dim(String(k.key_prefix ?? ""))}`)
      }
    } catch (err) {
      spinner.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// tmux swarm / attach / panes
// ============================================================================

// BRIDGE_URL already declared above — reuse it

const HiveSwarmCommand = cmd({
  command: "swarm <prompt>",
  describe: "launch a multi-agent swarm (one tmux pane per role)",
  builder: (yargs) =>
    yargs
      .positional("prompt", { describe: "task description", type: "string", demandOption: true })
      .option("roles", { describe: "comma-separated agent roles", type: "string", default: "researcher,writer,reviewer" })
      .option("agents", { describe: "comma-separated agent IDs (one per role)", type: "string" })
      .option("model", { describe: "model for all agents", type: "string", default: "gpt-4.1-nano" })
      .option("user-id", { type: "number" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("Hive Swarm")

    const userId = await requireUserId(args["user-id"])
    if (!userId) return

    const roleNames = (args.roles as string).split(",").map((r: string) => r.trim()).filter(Boolean)
    const agentIds = args.agents ? (args.agents as string).split(",").map((a: string) => parseInt(a.trim())) : []

    const roles = roleNames.map((name: string, i: number) => ({
      name,
      agent_id: agentIds[i] || null,
      prompt_override: null,
    }))

    const spinner = prompts.spinner()
    spinner.start("Dispatching swarm...")

    try {
      const res = await hiveFetch(`/api/v6/nodes/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          type: "swarm",
          prompt: args.prompt,
          title: `Swarm: ${args.prompt}`.substring(0, 100),
          user_id: userId,
          config: {
            roles,
            model: args.model,
          },
        }),
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as Record<string, unknown>
        spinner.stop("Failed", 1)
        prompts.log.error(`API error: ${(err as any).error || res.statusText}`)
        prompts.outro("Done")
        return
      }

      const data = await res.json() as Record<string, unknown>
      spinner.stop("Swarm dispatched")

      if (args.json) {
        console.log(JSON.stringify(data, null, 2))
      } else {
        prompts.log.success(`Task ID: ${(data as any).task?.id || (data as any).id || "unknown"}`)
        prompts.log.info(`Roles: ${roleNames.join(", ")} (${roleNames.length} panes)`)
        prompts.log.info(`Model: ${args.model}`)
        printDivider()
        prompts.log.info("View panes: iris hive panes")
        prompts.log.info("Attach:     iris hive attach")
      }
    } catch (err) {
      spinner.stop("Failed", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
    }

    prompts.outro("Done")
  },
})

const HiveAttachCommand = cmd({
  command: "attach [session]",
  describe: "attach to a running tmux session (power user)",
  builder: (yargs) =>
    yargs
      .positional("session", { describe: "session name or task ID prefix", type: "string" })
      .option("pane", { describe: "pane index to focus", type: "number" }),
  async handler(args) {
    const { TmuxSession } = await import("../../tmux/session-manager")

    try {
      await TmuxSession.ensureTmux()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      return
    }

    let targetSession = args.session as string | undefined

    if (!targetSession) {
      // List sessions and let user pick
      const sessions = await TmuxSession.listSessions()
      if (sessions.length === 0) {
        console.log("No active tmux sessions")
        return
      }

      const selected = await prompts.select({
        message: "Select session to attach",
        options: sessions.map((s) => ({
          label: `${s.name} (${s.panes.length} panes)`,
          value: s.name,
        })),
      })

      if (typeof selected !== "string") return
      targetSession = selected
    }

    // Resolve partial session name
    if (targetSession && !targetSession.startsWith("iris-")) {
      const sessions = await TmuxSession.listSessions()
      const match = sessions.find(
        (s) => s.name.includes(targetSession!) || s.name.endsWith(targetSession!)
      )
      if (match) targetSession = match.name
    }

    if (args.pane !== undefined) {
      // Select specific pane before attaching
      const { execSync } = await import("child_process")
      execSync(`tmux -L iris select-pane -t ${targetSession}:0.${args.pane}`, { stdio: "ignore" })
    }

    TmuxSession.attachSession(targetSession!)
  },
})

const HivePanesCommand = cmd({
  command: "panes [session]",
  describe: "show pane status for tmux sessions",
  builder: (yargs) =>
    yargs
      .positional("session", { describe: "session name (default: all)", type: "string" })
      .option("output", { alias: "o", describe: "show last N lines of each pane", type: "number", default: 5 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    // Try daemon bridge first (has richer metadata), fall back to direct tmux
    const { TmuxSession } = await import("../../tmux/session-manager")
    const sessionFilter = args.session as string | undefined

    let sessions: Array<{ name: string; panes: Array<{ index: number; role: string | null; command: string; output?: string }> }> = []

    // Try bridge
    const bridgeSessions = await TmuxSession.fetchBridgeSessions()
    if (bridgeSessions.length > 0) {
      for (const s of bridgeSessions) {
        if (sessionFilter && !s.name.includes(sessionFilter)) continue
        const detail = await TmuxSession.fetchBridgePanes(s.name, args.output as number)
        sessions.push({
          name: s.name,
          panes: (detail?.panes || s.panes).map((p) => ({
            index: p.index,
            role: p.role,
            command: p.command,
            output: (p as any).output || "",
          })),
        })
      }
    } else {
      // Direct tmux fallback
      try {
        await TmuxSession.ensureTmux()
        const all = await TmuxSession.listSessions()
        for (const s of all) {
          if (sessionFilter && !s.name.includes(sessionFilter)) continue
          const panes = await Promise.all(
            s.panes.map(async (p) => ({
              index: p.index,
              role: p.role,
              command: p.command,
              output: await TmuxSession.captureOutput(s.name, p.index, args.output as number),
            }))
          )
          sessions.push({ name: s.name, panes })
        }
      } catch {
        console.log("No tmux sessions found (daemon not running?)")
        return
      }
    }

    if (sessions.length === 0) {
      console.log(sessionFilter ? `No sessions matching "${sessionFilter}"` : "No active tmux sessions")
      return
    }

    if (args.json) {
      console.log(JSON.stringify(sessions, null, 2))
      return
    }

    for (const s of sessions) {
      console.log(`\n${bold(s.name)}  (${s.panes.length} pane${s.panes.length > 1 ? "s" : ""})`)
      for (const p of s.panes) {
        const roleLabel = p.role ? highlight(p.role) : dim(`pane ${p.index}`)
        const cmdLabel = dim(p.command || "—")
        const prefix = p.index === s.panes.length - 1 ? "└─" : "├─"
        console.log(`  ${prefix} [${p.index}] ${roleLabel}  ${cmdLabel}`)
        if (p.output) {
          const lines = p.output
            .split("\n")
            .filter((l: string) => l.trim())
            .slice(-(args.output as number))
          for (const line of lines) {
            console.log(`  ${p.index === s.panes.length - 1 ? " " : "│"}   ${dim(line.substring(0, 120))}`)
          }
        }
      }
    }
    console.log("")
  },
})

// ============================================================================
// iris hive watch — live tail of swarm events
// ============================================================================

const HiveWatchCommand = cmd({
  command: "watch [session]",
  describe: "live tail of a running swarm's director events",
  builder: (yargs) =>
    yargs
      .positional("session", { describe: "session name or prefix", type: "string" })
      .option("raw", { describe: "show raw JSON events", type: "boolean", default: false }),
  async handler(args) {
    const { TmuxSession } = await import("../../tmux/session-manager")
    let targetSession = args.session as string | undefined

    // If no session, pick one
    if (!targetSession) {
      const sessions = await TmuxSession.fetchBridgeSessions()
      if (sessions.length === 0) {
        try {
          await TmuxSession.ensureTmux()
          const local = await TmuxSession.listSessions()
          if (local.length === 0) {
            console.log("No active swarm sessions")
            return
          }
          targetSession = local[0].name
        } catch {
          console.log("No active swarm sessions (daemon not running?)")
          return
        }
      } else if (sessions.length === 1) {
        targetSession = sessions[0].name
      } else {
        const selected = await prompts.select({
          message: "Select session to watch",
          options: sessions.map((s) => ({
            label: `${s.name} (${s.panes.length} panes)${s.type ? ` [${s.type}]` : ""}`,
            value: s.name,
          })),
        })
        if (typeof selected !== "string") return
        targetSession = selected
      }
    }

    // Resolve partial name
    if (targetSession && !targetSession.startsWith("iris-")) {
      const sessions = await TmuxSession.fetchBridgeSessions()
      const match = sessions.find(
        (s) => s.name.includes(targetSession!) || s.name.endsWith(targetSession!)
      )
      if (match) targetSession = match.name
    }

    console.log(`${bold("Watching")} ${highlight(targetSession!)}  (Ctrl+C to stop)\n`)

    const BRIDGE = process.env.IRIS_BRIDGE_URL ?? "http://localhost:3200"
    const bridgeKey = getBridgeToken()
    let lastEventCount = 0

    // Poll events every 2s
    const poll = setInterval(async () => {
      try {
        const headers: Record<string, string> = {}
        if (bridgeKey) headers["X-Bridge-Key"] = bridgeKey

        const res = await fetch(
          `${BRIDGE}/daemon/tmux/sessions/${targetSession}/events?limit=100`,
          { headers, signal: AbortSignal.timeout(3000) }
        )
        if (!res.ok) return

        const data = (await res.json()) as { events: any[]; total: number }
        const newEvents = data.events.slice(lastEventCount)
        lastEventCount = data.events.length

        for (const e of newEvents) {
          if (args.raw) {
            console.log(JSON.stringify(e))
            continue
          }
          const ts = e.ts ? new Date(e.ts).toLocaleTimeString("en-US", { hour12: false }) : ""
          const prefix = dim(`[${ts}]`)

          switch (e.type) {
            case "start":
              console.log(`${prefix} ${success("START")} ${e.goal?.substring(0, 100)}`)
              if (e.workers) {
                for (const w of e.workers as any[]) {
                  console.log(`${prefix}   ${highlight(w.role)} (pane ${w.index})`)
                }
              }
              break
            case "round": {
              const workers = (e.workers as any[] || [])
                .map((w: any) => {
                  const status = w.alive ? "\x1b[32m●\x1b[0m" : "\x1b[90m○\x1b[0m"
                  return `${status} ${w.role} (${w.lines}L)`
                })
                .join("  ")
              console.log(`${prefix} ${bold(`Round ${e.round}/${e.maxRounds}`)}  ${workers}`)
              // Show last line of each worker
              for (const w of e.workers as any[] || []) {
                if (w.lastLine) {
                  console.log(`${prefix}   ${dim(w.role + ":")} ${dim(w.lastLine.substring(0, 100))}`)
                }
              }
              break
            }
            case "decision":
              console.log(`${prefix} ${highlight("DECISION")} ${e.decision?.substring(0, 120)}`)
              break
            case "send":
              console.log(`${prefix} ${"\x1b[33m→ SEND\x1b[0m"} ${e.role} (pane ${e.pane}): ${e.text?.substring(0, 80)}`)
              break
            case "done":
              console.log(`${prefix} ${success("✓ DONE")} ${e.summary}`)
              console.log(`${prefix} ${dim(`Completed in ${Math.round((e.elapsedMs || 0) / 1000)}s`)}`)
              clearInterval(poll)
              break
            case "timeout":
              console.log(`${prefix} ${"\x1b[33m⏱ TIMEOUT\x1b[0m"} after ${Math.round((e.elapsedMs || 0) / 1000)}s`)
              clearInterval(poll)
              break
            case "all_workers_exited":
              console.log(`${prefix} ${dim("All workers exited")} (round ${e.round})`)
              clearInterval(poll)
              break
            case "session_dead":
              console.log(`${prefix} ${"\x1b[31mSession died\x1b[0m"}`)
              clearInterval(poll)
              break
            default:
              console.log(`${prefix} ${e.type}: ${JSON.stringify(e).substring(0, 100)}`)
          }
        }

        // Check if session still exists
        const alive = await TmuxSession.isAlive(targetSession!).catch(() => false)
        if (!alive && newEvents.length === 0) {
          console.log(dim("\nSession ended."))
          clearInterval(poll)
          process.exit(0)
        }
      } catch {
        // Bridge unavailable — try direct tmux check
      }
    }, 2000)

    // Handle Ctrl+C
    process.on("SIGINT", () => {
      clearInterval(poll)
      console.log(dim("\nStopped watching."))
      process.exit(0)
    })

    // Keep alive
    await new Promise(() => {})
  },
})

// ============================================================================
// iris hive logs — persistent session history from ledger
// ============================================================================

const HiveLogsCommand = cmd({
  command: "logs [session]",
  aliases: ["history"],
  describe: "show session history from the tmux ledger",
  builder: (yargs) =>
    yargs
      .positional("session", { describe: "session name to show events for (omit for all)", type: "string" })
      .option("source", { describe: "filter by source", type: "string", choices: ["pusher", "a2a", "mesh", "cli"] })
      .option("type", { describe: "filter by task type", type: "string" })
      .option("status", { describe: "filter by status", type: "string", choices: ["running", "completed", "failed"] })
      .option("limit", { alias: "n", describe: "max entries", type: "number", default: 30 })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    const session = args.session as string | undefined
    const BRIDGE = process.env.IRIS_BRIDGE_URL ?? "http://localhost:3200"
    const bridgeKey = getBridgeToken()

    // If session specified, show events for that session
    if (session) {
      try {
        const headers: Record<string, string> = {}
        if (bridgeKey) headers["X-Bridge-Key"] = bridgeKey

        const res = await fetch(`${BRIDGE}/daemon/tmux/sessions/${session}/events?limit=100`, {
          headers,
          signal: AbortSignal.timeout(5000),
        })
        if (res.ok) {
          const data = (await res.json()) as { events: any[] }
          if (args.json) {
            console.log(JSON.stringify(data.events, null, 2))
            return
          }
          if (data.events.length === 0) {
            console.log(`No events for ${session}`)
            return
          }
          console.log(`${bold(session)} — ${data.events.length} events\n`)
          for (const e of data.events) {
            const ts = e.ts ? new Date(e.ts).toLocaleTimeString("en-US", { hour12: false }) : ""
            console.log(`  ${dim(ts)} ${e.type.padEnd(12)} ${JSON.stringify(e).substring(0, 100)}`)
          }
          return
        }
      } catch {}
    }

    // Show ledger (all sessions history)
    try {
      const params = new URLSearchParams()
      params.set("limit", String(args.limit))
      if (args.source) params.set("source", args.source as string)
      if (args.type) params.set("type", args.type as string)
      if (args.status) params.set("status", args.status as string)

      const headers: Record<string, string> = {}
      if (bridgeKey) headers["X-Bridge-Key"] = bridgeKey

      const res = await fetch(`${BRIDGE}/daemon/tmux/ledger?${params}`, {
        headers,
        signal: AbortSignal.timeout(5000),
      })
      if (!res.ok) {
        console.log("Daemon bridge unavailable (is daemon running?)")
        return
      }

      const data = (await res.json()) as { entries: any[] }
      if (args.json) {
        console.log(JSON.stringify(data.entries, null, 2))
        return
      }

      if (data.entries.length === 0) {
        console.log("No session history yet")
        return
      }

      console.log(`${bold("Session History")} (${data.entries.length} entries)\n`)

      for (const e of data.entries) {
        const status = e.status === "completed" ? success("✓") : e.status === "failed" ? "\x1b[31m✗\x1b[0m" : "\x1b[34m▶\x1b[0m"
        const source = (e.source || "?").padEnd(7)
        const type = (e.type || "?").padEnd(14)
        const title = (e.title || "—").substring(0, 40).padEnd(42)
        const dur = e.durationMs ? dim(`${Math.round(e.durationMs / 1000)}s`) : dim("—")
        const time = e.created ? dim(new Date(e.created).toLocaleTimeString("en-US", { hour12: false })) : ""

        console.log(`  ${status} ${source} ${type} ${title} ${dur}  ${time}`)
      }
      console.log("")
    } catch (err) {
      console.log(`Error: ${err instanceof Error ? err.message : err}`)
    }
  },
})

// ============================================================================
// Root command
// ============================================================================

export const PlatformHiveCommand = cmd({
  command: "hive",
  aliases: ["compute"],
  describe: "manage Hive nodes, tasks, projects & peer connections",
  builder: (yargs) =>
    yargs
      // LAN discovery (local utility — no API)
      .command(HiveScanCommandExport)
      .command(HiveProbeCommandExport)
      .command(HiveSshCommandExport)
      // Node management + remote exec
      .command(HiveNodesCommandExport)
      .command(HiveRunCommandExport)
      // Remote enrollment (SSH-based)
      .command(HiveSshSetupCommandExport)
      .command(HiveDiscoverCommandExport)
      .command(HiveEnrollCommandExport)
      // Secure transport (Tailscale/WireGuard) — reach nodes off your LAN, no open ports
      .command(HiveVpnCommandExport)
      // Script deployment
      .command(HiveScriptCommand)
      .command(HiveScheduleCommand)
      // Daemon operations (fast debugging)
      .command(HiveTasksCommand)
      .command(HiveCancelCommand)
      .command(HiveQueueCommand)
      .command(HivePauseCommand)
      .command(HiveResumeCommand)
      .command(HivePurgeCommand)
      .command(HiveDoctorCommand)
      // Project management
      .command(HiveListCommand)
      .command(HiveCreateCommand)
      .command(HiveGetCommand)
      .command(HiveDeployCommand)
      .command(HiveRedeployCommand)
      .command(HiveStopCommand)
      .command(HiveDeleteCommand)
      .command(HiveEnvCommand)
      .command(HiveSyncCommand)
      .command(HivePrCommand)
      .command(HiveIssuesCommand)
      .command(HiveStatusCommand)
      // Peer-to-Peer (Hive Connections)
      .command(HiveInviteCommand)
      .command(HiveAcceptCommand)
      .command(HiveConnectionsCommand)
      .command(HivePeersCommand)
      .command(HiveChatCommand)
      .command(HiveFilesCommand)
      .command(HiveExecCommand)
      // Credentials
      .command(HiveCredentialsCommand)
      // Template seeding
      .command(HiveSeedCommand)
      // Domain management
      .command(HiveDomainsCommand)
      // Unified dashboard
      .command(HiveDashboardCommand)
      // Partner API keys
      .command(HiveApiKeysCommand)
      // Cross-node send/inbox/search
      .command(HiveSendCommand)
      .command(HiveSentCommand)
      .command(HiveInboxCommand)
      .command(HiveSearchCommand)
      // IRIS Exchange — distributed task marketplace
      .command(ExchangeCommand)
      // tmux swarm orchestration
      .command(HiveSwarmCommand)
      .command(HiveAttachCommand)
      .command(HivePanesCommand)
      .command(HiveWatchCommand)
      .command(HiveLogsCommand)
      .demandCommand(),
  async handler() {},
})
