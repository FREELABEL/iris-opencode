import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, success } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"

/**
 * `iris agents export` — the distribution-shaped sibling of `agents pull`.
 *
 * `pull` writes the raw API row to one .json file, which is right for its job: pull, edit,
 * push, round-trip against the same install. It is the wrong thing to hand somebody else.
 * That row carries 72 keys, and most of them describe THIS install rather than the agent —
 * user_id, bloq_id, stripe_product_id, total_revenue_cents, clone_count, health,
 * google_workspace_*, last_heartbeat_at. Committing that to a public repo publishes a
 * database row, not a shareable agent.
 *
 * So export splits the payload in two and says which half it kept. What makes the agent
 * what it is — its prompt, model, tool allowlist, heartbeat posture — becomes a small
 * folder a person can read, diff, fork and PR. Everything that only means something inside
 * one tenant is dropped, and the README names what was dropped rather than silently
 * omitting it: an export that quietly loses fields is the same failure shape as a status
 * board that reports success by not looking.
 */

/** Fields that describe the agent. These travel. */
export const PORTABLE = [
  "name", "description", "type", "icon", "role",
  "config", "settings", "initial_prompt", "personality_traits",
  "structured_output", "heartbeat_mode", "workflow_version",
] as const

/**
 * Fields deliberately left behind, grouped so the README can explain WHY rather than just
 * listing them. Anything not named here and not in PORTABLE is reported as "unclassified"
 * at export time — a new column upstream should surface as a question, not vanish.
 */
export const DROPPED: Record<string, string[]> = {
  "identity on this install": ["id", "public_uuid", "user_id", "bloq_id", "workspace_id", "linked_user_id", "original_template_id", "manager_agent_id"],
  "runtime state": ["active", "health", "health_status", "health_status_changed_at", "consecutive_failures", "last_run_at", "last_active_at", "last_used_at", "last_heartbeat_at", "stats", "usage_count", "opencode_session_id"],
  "commerce": ["access_type", "payment_type", "markup_percentage", "free_actions", "subscription_interval", "subscription_price_cents", "stripe_product_id", "stripe_price_id", "total_revenue_cents", "total_paid_actions", "total_subscriptions"],
  "publishing + template": ["is_public", "is_template", "is_featured_template", "template_category", "clone_count", "public_slug", "public_name", "public_description", "public_settings", "public_usage_count", "custom_logo_url", "custom_background_url", "is_team_visible", "is_favorite", "is_general_agent"],
  "tenant directory binding": ["google_workspace_user_id", "google_workspace_org_unit", "google_workspace_groups", "google_workspace_suspended", "google_workspace_synced_at", "google_workspace_match_state", "google_workspace_manager_email", "google_workspace_department", "google_workspace_title"],
  "contact + timestamps": ["email", "phone_number", "created_at", "updated_at"],
  "not portable yet": ["file_attachments", "v7_config"],
}

/**
 * Look for credential-shaped values before a human is asked to eyeball the folder.
 *
 * The README tells the exporter to read agent.md first, and they will — once. The point of
 * this repo's whole gap analysis is that a warning nobody can act on is not a control, so
 * this does the reading. It is deliberately a WARNING and not a refusal: a false positive
 * that blocks a legitimate export teaches people to reach for a flag that skips the check,
 * and then the check is gone. It names what it found and lets the person decide.
 */
export function scanForSecrets(blob: string): string[] {
  const hits: string[] = []
  const rules: [string, RegExp][] = [
    ["token / key / secret field", /"[^"]*(token|secret|api[_-]?key|password|credential)[^"]*"\s*:\s*"[^"]{8,}"/gi],
    ["long opaque string (32+ chars)", /"[A-Za-z0-9_\-]{32,}"/g],
    ["email address", /[\w.+-]+@[\w-]+\.[\w.]{2,}/g],
    ["bearer header", /bearer\s+[A-Za-z0-9._\-]{12,}/gi],
    ["private key block", /-----BEGIN [A-Z ]*PRIVATE KEY-----/g],
  ]
  for (const [label, re] of rules) {
    const n = (blob.match(re) ?? []).length
    if (n) hits.push(`${label} × ${n}`)
  }
  return hits
}

function slugify(name: string): string {
  return (name || "agent").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "agent"
}

/** The tool allowlist lives in more than one place depending on the agent's vintage. */
export function collectTools(agent: any): string[] {
  const s = agent?.settings ?? {}
  const c = agent?.config ?? {}
  const out = new Set<string>()
  for (const src of [s.integrations, s.agentIntegrations, s.heartbeat_tools, c.tools, s.tools]) {
    if (Array.isArray(src)) for (const t of src) {
      if (typeof t === "string") out.add(t)
      else if (t && typeof t === "object" && typeof t.type === "string") out.add(t.type)
    }
  }
  return [...out].sort()
}

function frontmatter(agent: any, tools: string[]): string {
  const cfg = agent?.config ?? {}
  const set = agent?.settings ?? {}
  const q = (v: any) => JSON.stringify(v ?? null)
  const lines = [
    "---",
    `name: ${q(agent.name)}`,
    `model: ${q(cfg.model ?? set.model ?? agent.model ?? null)}`,
    `heartbeat: ${q(agent.heartbeat_mode ?? null)}`,
    `workflow_version: ${q(agent.workflow_version ?? null)}`,
    `max_iterations: ${q(set.max_iterations ?? null)}`,
    `tools: ${tools.length ? `[${tools.map((t) => JSON.stringify(t)).join(", ")}]` : "[]"}`,
    "---",
  ]
  return lines.join("\n")
}

export const AgentsExportCommand = cmd({
  command: "export <id>",
  describe: "export an agent as a forkable folder (portable fields only)",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "agent ID", type: "number", demandOption: true })
      .option("out", { alias: "o", describe: "output directory (default ./agents)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Export Agent #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching agent…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/agents/${args.id}`)
      const ok = await handleApiError(res, "Export agent")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const agent = data?.data ?? data

      const portable: Record<string, any> = {}
      for (const k of PORTABLE) if (agent[k] !== undefined && agent[k] !== null) portable[k] = agent[k]

      const known = new Set<string>([...PORTABLE, ...Object.values(DROPPED).flat()])
      const unclassified = Object.keys(agent).filter((k) => !known.has(k))

      const tools = collectTools(agent)
      const prompt = agent?.config?.system_prompt ?? agent?.settings?.system_prompt ?? ""
      const mission = agent?.initial_prompt ?? ""
      const slug = slugify(agent.name)
      const baseDir = resolve(args.out ?? "./agents")
      const dir = join(baseDir, slug)
      mkdirSync(dir, { recursive: true })

      const body = [
        frontmatter(agent, tools),
        "",
        `# ${agent.name}`,
        agent.description ? `\n${agent.description}\n` : "",
        "## System prompt",
        "",
        prompt ? prompt.trim() : "_none set_",
        "",
        ...(mission ? ["## Mission", "", mission.trim(), ""] : []),
      ].join("\n")
      writeFileSync(join(dir, "agent.md"), body.replace(/\n{3,}/g, "\n\n") + "\n")

      writeFileSync(join(dir, "tools.json"), JSON.stringify(tools, null, 2) + "\n")
      writeFileSync(join(dir, "agent.json"), JSON.stringify(portable, null, 2) + "\n")

      const droppedMd = Object.entries(DROPPED)
        .map(([why, keys]) => `- **${why}** — \`${keys.filter((k) => k in agent).join("`, `") || "none present"}\``)
        .join("\n")

      writeFileSync(join(dir, "README.md"), [
        `# ${agent.name}`,
        "",
        agent.description ? agent.description + "\n" : "",
        "An IRIS agent, exported as a folder so it can be read, diffed, forked and reviewed.",
        "",
        "## Files",
        "",
        "| file | what it is |",
        "| --- | --- |",
        "| `agent.md` | the agent as prose — model, tools and heartbeat in frontmatter, system prompt as the body. **Edit this one.** |",
        "| `tools.json` | the tool allowlist, resolved from every place it is stored |",
        "| `agent.json` | the portable fields, machine-readable, for re-import |",
        "",
        "## Importing it",
        "",
        "```sh",
        "iris agents create --name \"" + String(agent.name).replace(/"/g, '\\"') + "\"",
        "# then paste agent.md's system prompt, or push agent.json onto the new id:",
        "iris agents push <new-id> --file agent.json",
        "```",
        "",
        "## What was deliberately left out",
        "",
        "This export carries what makes the agent *this agent*. It drops everything that only",
        "means something inside the install it came from — copying those into a new tenant would",
        "at best be meaningless and at worst point the clone at somebody else's records.",
        "",
        droppedMd,
        "",
        ...(unclassified.length
          ? ["> **Unclassified fields present:** `" + unclassified.join("`, `") + "`.",
             "> These are new upstream and were not exported. Classify them in",
             "> `platform-agents-export.ts` rather than letting them disappear quietly.", ""]
          : []),
        "## Before making this public",
        "",
        "A system prompt is written for one company and often names clients, pricing, internal",
        "process or people. **Read `agent.md` before pushing this anywhere public.** Nothing here",
        "is redacted for you.",
        "",
      ].join("\n"))

      spinner.stop(success("Exported"))
      printDivider()
      printKV("Name", agent.name)
      printKV("Folder", dir)
      printKV("Portable fields", `${Object.keys(portable).length} kept · ${Object.values(DROPPED).flat().filter((k) => k in agent).length} dropped`)
      printKV("Tools", tools.length ? String(tools.length) : dim("none"))
      if (unclassified.length) printKV("Unclassified", unclassified.join(", "))
      printDivider()
      const secrets = scanForSecrets(JSON.stringify(portable) + prompt + mission)
      if (secrets.length) {
        prompts.log.error("Credential-shaped values found — do NOT publish this folder until you have checked them:")
        for (const h of secrets) prompts.log.error(`  ${h}`)
      } else {
        prompts.log.warn("No credential-shaped values found. Still read agent.md — prompts routinely name clients and pricing.")
      }
      prompts.outro(dim(`cd ${dir}  |  iris agents push <id> --file agent.json`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})
