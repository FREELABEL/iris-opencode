import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// Use iris-api base for Hive endpoints
const IRIS_API = process.env.IRIS_API_URL ?? "https://main.heyiris.io"

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
    failed: `${UI.Style.TEXT_ERROR}✗ failed${UI.Style.TEXT_NORMAL}`,
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
      .option("user-id", { describe: "user ID", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Delete Project")

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }

    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const confirm = await prompts.confirm({ message: `Delete project "${args.slug}" and its GitHub repo? This cannot be undone.` })
    if (!confirm || prompts.isCancel(confirm)) { prompts.outro("Cancelled"); return }

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

    const pairs = (args.pairs as string[]) || []
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
// Root command
// ============================================================================

export const PlatformHiveCommand = cmd({
  command: "hive",
  describe: "manage Hive projects, deployments, PRs & issues",
  builder: (yargs) =>
    yargs
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
      .demandCommand(),
  async handler() {},
})
