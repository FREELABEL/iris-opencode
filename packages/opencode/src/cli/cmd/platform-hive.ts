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

async function bridgeFetch(path: string) {
  return fetch(`${BRIDGE_URL}${path}`, { headers: { Accept: "application/json" } })
}

// ── iris hive tasks ─────────────────────────────────────────────────────

const HiveTasksCommand = cmd({
  command: "tasks",
  describe: "list pending/running tasks on your node",
  builder: (yargs) =>
    yargs
      .option("status", { describe: "filter by status", type: "string", choices: ["pending", "running", "all"], default: "all" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Hive Tasks")

    const spinner = prompts.spinner()
    spinner.start("Loading tasks…")

    try {
      // Cloud: pending tasks from iris-api
      const pendingRes = await nodeFetch("/api/v6/node-agent/tasks/pending")
      const pendingData = await pendingRes.json() as Record<string, unknown>
      const pendingTasks = (pendingData.tasks ?? []) as Record<string, unknown>[]

      // Local: running tasks from bridge daemon
      let runningTasks: Record<string, unknown>[] = []
      try {
        const queueRes = await bridgeFetch("/daemon/queue")
        const queueData = await queueRes.json() as Record<string, unknown>
        runningTasks = (queueData.tasks ?? []) as Record<string, unknown>[]
      } catch { /* bridge not running */ }

      spinner.stop(`${pendingTasks.length} pending, ${runningTasks.length} running`)
      printDivider()

      if (runningTasks.length > 0) {
        console.log(bold("  Running:"))
        for (const t of runningTasks) {
          const id = dim(String(t.id ?? "").substring(0, 12) + "…")
          const title = bold(String(t.title ?? t.type ?? "unknown"))
          const uptime = t.uptime_s ? dim(`${t.uptime_s}s`) : ""
          console.log(`    ${success("▶")} ${id}  ${title}  ${uptime}`)
        }
        console.log()
      }

      if (pendingTasks.length > 0) {
        console.log(bold("  Pending (cloud):"))
        for (const t of pendingTasks) {
          const id = dim(String(t.id ?? "").substring(0, 12) + "…")
          const title = String(t.title ?? "unknown")
          const status = dim(String(t.status ?? ""))
          console.log(`    ◌ ${id}  ${title}  ${status}`)
        }
      }

      if (pendingTasks.length === 0 && runningTasks.length === 0) {
        console.log(dim("  No tasks. Node is idle."))
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
      .option("stale", { describe: "cancel tasks older than 1 hour", type: "boolean", default: false }),
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

        const confirm = await prompts.confirm({ message: `Cancel ${tasks.length} task(s)?` })
        if (!confirm || prompts.isCancel(confirm)) { prompts.outro("Cancelled"); return }

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
        prompts.log.warn("Daemon not running. Start with: npm run bridge")
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
      const res = await fetch(`${BRIDGE_URL}/daemon/pause`, { method: "POST" })
      if (res.ok) {
        prompts.log.success("Daemon paused — no new tasks will be accepted")
      } else {
        prompts.log.error("Failed to pause daemon")
      }
    } catch {
      prompts.log.error("Daemon not running. Start with: npm run bridge")
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
      const res = await fetch(`${BRIDGE_URL}/daemon/resume`, { method: "POST" })
      if (res.ok) {
        prompts.log.success("Daemon resumed — accepting tasks")
      } else {
        prompts.log.error("Failed to resume daemon")
      }
    } catch {
      prompts.log.error("Daemon not running. Start with: npm run bridge")
    }
  },
})

// ── iris hive purge ─────────────────────────────────────────────────────

const HivePurgeCommand = cmd({
  command: "purge",
  describe: "cancel ALL pending tasks + clear daemon state (emergency)",
  builder: (yargs) => yargs,
  async handler() {
    UI.empty()
    prompts.intro("◈  Purge All Tasks")

    const confirm = await prompts.confirm({ message: "Cancel ALL pending tasks on this node? This is irreversible." })
    if (!confirm || prompts.isCancel(confirm)) { prompts.outro("Cancelled"); return }

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
        await fetch(`${BRIDGE_URL}/daemon/pause`, { method: "POST" })
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
// Root command
// ============================================================================

export const PlatformHiveCommand = cmd({
  command: "hive",
  describe: "manage Hive nodes, tasks, projects & deployments",
  builder: (yargs) =>
    yargs
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
      .demandCommand(),
  async handler() {},
})
