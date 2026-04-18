import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// Use iris-api base for Hive endpoints
const IRIS_API = process.env.IRIS_API_URL ?? "https://heyiris.io"

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

async function bridgeFetch(path: string) {
  const prefix = await detectBridgePrefix()
  // path comes in as "/daemon/queue" — strip the /daemon prefix and re-add the detected one
  const cleanPath = path.replace(/^\/daemon/, "")
  return fetch(`${BRIDGE_URL}${prefix}${cleanPath}`, { headers: { Accept: "application/json" } })
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
      const res = await fetch(`${BRIDGE_URL}${prefix}/pause`, { method: "POST" })
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
      const res = await fetch(`${BRIDGE_URL}${prefix}/resume`, { method: "POST" })
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
        const purgePrefix = await detectBridgePrefix()
        await fetch(`${BRIDGE_URL}${purgePrefix}/pause`, { method: "POST" })
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
        headers: { "Content-Type": "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
        headers: { Accept: "application/json" },
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
        headers: { "Content-Type": "application/json" },
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
          headers: { "Content-Type": "application/json" },
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
        prompts.log.warn("Schedule registry not available. Is the daemon running?")
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
        headers: { "Content-Type": "application/json" },
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
        headers: { Accept: "application/json" },
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
        headers: { Accept: "application/json" },
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
        headers: { Accept: "application/json" },
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

const HiveCredentialsCommand = cmd({
  command: "credentials",
  aliases: ["creds"],
  describe: "manage project credentials across Hive machines",
  builder: (yargs) =>
    yargs
      .command(HiveCredentialsListCommand)
      .command(HiveCredentialsAddCommand)
      .command(HiveCredentialsRemoveCommand)
      .demandCommand(),
  async handler() {},
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
      .demandCommand(),
  async handler() {},
})
