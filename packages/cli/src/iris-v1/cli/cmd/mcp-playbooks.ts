/**
 * Playbooks as MCP tools and resources.
 *
 * The MCP server already exposed `iris_run` — one tool taking an arbitrary
 * command string. That is the worst possible shape for a model: no schema, no
 * discovery, no validation, and a playbook's carefully typed `args:` block
 * reduced to prose the model has to guess its way through.
 *
 * But a v2 playbook's `args:` block is already a JSON Schema wearing a
 * different hat — `type` / `required` / `enum` / `default` / `description` map
 * one-to-one onto an MCP `inputSchema`. So this is not a translation layer, it
 * is the same declaration read by a second reader.
 *
 * The split follows what a playbook actually holds:
 *
 *   the SOP prose  →  a *resource* (iris://playbook/<name>) — read, not run.
 *                     All playbooks have one; 35 of 40 have ONLY this.
 *   the steps      →  a *tool* (playbook_<name>) — v2 only, since v1 has no
 *                     executable steps to call.
 *
 * Both point at the same container, which is why ${{playbook.root}} had to land
 * first: an MCP server is spawned by the client, so its cwd is whatever that
 * client happened to be sitting in. A playbook that resolved assets against the
 * cwd would read a different file over MCP than it does in a terminal.
 */

import { Skill } from "../../skill/skill"
import { Instance } from "../../project/instance"
import { parsePlan, executeSkill, playbookPaths, type SkillPlan, type ArgDef } from "../../skill/executor"
import { existsSync, readdirSync } from "fs"

export const PLAYBOOK_URI_PREFIX = "iris://playbook/"
export const TOOL_PREFIX = "playbook_"

/** MCP tool names are `[a-zA-Z0-9_-]{1,64}`; playbook names are looser. */
export function toolNameFor(playbookName: string): string {
  return (TOOL_PREFIX + playbookName.replace(/[^a-zA-Z0-9_-]/g, "-")).slice(0, 64)
}

/**
 * True when the author flagged this playbook as needing a human to look before
 * it runs — a plan-level `confirm:` glob, a step-level `confirm: true`, or a
 * step the danger heuristics would have stopped on in the terminal.
 */
export function needsApproval(plan: SkillPlan): boolean {
  return plan.confirm.length > 0 || plan.steps.some((s) => s.confirm)
}

/** Map one playbook `args:` entry onto a JSON Schema property. */
function propertyFor(def: ArgDef): Record<string, unknown> {
  const prop: Record<string, unknown> = { type: def.type }
  if (def.description) prop.description = def.description
  if (def.enum) prop.enum = def.enum
  if (def.default !== undefined) {
    prop.default = def.default
    // Say it in prose too — not every client surfaces `default` to the model.
    prop.description = [prop.description, `Defaults to ${JSON.stringify(def.default)}.`]
      .filter(Boolean)
      .join(" ")
  }
  return prop
}

export function inputSchemaFor(plan: SkillPlan): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  const required: string[] = []

  for (const [key, def] of Object.entries(plan.args)) {
    properties[key] = propertyFor(def)
    if (def.required) required.push(key)
  }

  // The human-in-the-loop mapping. MCP has no "ask the operator" primitive, but
  // every real client shows a tool-approval dialog with the arguments in it. So
  // for a playbook the author gated, make the model state its intent as an
  // argument — which is exactly what that dialog then puts in front of a person.
  if (needsApproval(plan)) {
    properties.confirm = {
      type: "boolean",
      description:
        "Required. This playbook contains steps its author gated behind a confirmation. " +
        "Pass true only if the operator has agreed to run it.",
    }
    required.push("confirm")
  }

  return { type: "object", properties, required }
}

export function descriptionFor(plan: SkillPlan): string {
  const lines = [plan.description]

  const steps = plan.steps.map((s) => `${s.id} (${s.mode})`).join(" → ")
  if (steps) lines.push(`\nSteps: ${steps}`)

  if (plan.steps.some((s) => s.mode === "human")) {
    lines.push(
      "\nThis playbook pauses at a step a person has to do. The call returns the " +
        "pause and a run id; resume it with `iris playbook resume <runId>`.",
    )
  }
  if (needsApproval(plan)) {
    lines.push("\nGated: requires confirm=true.")
  }

  lines.push(`\nThe written procedure is the resource ${PLAYBOOK_URI_PREFIX}${plan.name}.`)
  return lines.join("\n")
}

export interface PlaybookEntry {
  plan: SkillPlan
  /** v2 only — v1 playbooks are documents with no steps to call. */
  callable: boolean
}

/**
 * Every discoverable playbook, parsed. Unparseable ones are dropped rather than
 * failing the listing — one malformed playbook must not hide the other 39.
 *
 * Self-provides the Instance rather than assuming ambient context: these run
 * from MCP request handlers, which the transport invokes from its own I/O
 * callbacks. Discovery walks up from the server's cwd (the directory the MCP
 * client spawned us in) plus ~/.iris, so a project's playbooks and the global
 * ones both appear. Discovery is cached per directory, and MCP clients read
 * tools/list once at connect — a playbook added mid-session needs a reconnect.
 */
export async function loadPlaybooks(): Promise<PlaybookEntry[]> {
  return Instance.provide({
    directory: process.cwd(),
    fn: async () => {
      const out: PlaybookEntry[] = []
      for (const info of await Skill.all()) {
        try {
          const plan = await parsePlan(info)
          out.push({ plan, callable: plan.version === 2 && plan.steps.length > 0 })
        } catch {
          // Malformed frontmatter or unreadable file — skip it.
        }
      }
      return out.sort((a, b) => a.plan.name.localeCompare(b.plan.name))
    },
  })
}

export function toolsFor(entries: PlaybookEntry[]) {
  return entries
    .filter((e) => e.callable)
    .map((e) => ({
      name: toolNameFor(e.plan.name),
      description: descriptionFor(e.plan),
      inputSchema: inputSchemaFor(e.plan) as any,
    }))
}

export function resourcesFor(entries: PlaybookEntry[]) {
  return entries.map((e) => ({
    uri: `${PLAYBOOK_URI_PREFIX}${e.plan.name}`,
    name: `Playbook: ${e.plan.name}`,
    description: e.plan.description,
    mimeType: "text/markdown",
  }))
}

/**
 * Render a playbook as a document: the SOP as written, plus a header naming
 * the container so a reader can resolve the paths the prose refers to.
 */
export async function readPlaybookResource(name: string): Promise<string> {
  const entries = await loadPlaybooks()
  const entry = entries.find((e) => e.plan.name === name)
  if (!entry) throw new Error(`Unknown playbook: ${name}`)

  const paths = playbookPaths(entry.plan.location)
  const header = [
    `# ${entry.plan.name}`,
    "",
    entry.plan.description,
    "",
    `- Container: \`${paths.root}\``,
  ]
  if (existsSync(paths.assets)) {
    const files = readdirSync(paths.assets)
    header.push(`- Assets: \`${paths.assets}\` — ${files.join(", ")}`)
  }
  header.push(
    entry.callable
      ? `- Runnable: yes, as the \`${toolNameFor(entry.plan.name)}\` tool (or \`iris playbook run ${entry.plan.name}\`)`
      : "- Runnable: no — this playbook is a written procedure, not executable steps",
    "",
    "---",
    "",
  )

  const body = await Bun.file(entry.plan.location).text()
  return header.join("\n") + body
}

export interface CallResult {
  text: string
  isError: boolean
}

/** Execute a playbook by tool name and render the run as text for the model. */
export async function callPlaybookTool(toolName: string, args: Record<string, unknown>): Promise<CallResult> {
  const entries = await loadPlaybooks()
  const entry = entries.find((e) => e.callable && toolNameFor(e.plan.name) === toolName)
  if (!entry) return { text: `Unknown playbook tool: ${toolName}`, isError: true }

  const { plan } = entry

  if (needsApproval(plan) && args.confirm !== true) {
    return {
      text:
        `${plan.name} is gated: it contains steps its author marked as needing confirmation. ` +
        `Ask the operator, then call again with confirm=true.`,
      isError: true,
    }
  }

  // `confirm` is our gate, not one of the playbook's declared args.
  const { confirm: _gate, ...playbookArgs } = args

  // yes:true is honest here — the approval already happened, in the client's
  // tool dialog, before this call was ever dispatched.
  const result = await executeSkill(plan, playbookArgs, { yes: true })

  const lines = [`${plan.name} — ${result.status} (run ${result.run_id})`, ""]
  for (const step of plan.steps) {
    const sr = result.steps[step.id]
    if (!sr) continue
    lines.push(`## ${step.id} — ${sr.status}`)
    if (sr.output.trim()) lines.push(sr.output.trim())
    lines.push("")
  }

  if (result.status === "paused" && result.paused_on) {
    lines.push(
      `Paused at "${result.paused_on.id}" — a person has to do this part:`,
      result.paused_on.instructions,
      "",
      `Resume with: iris playbook resume ${result.run_id}`,
    )
  }

  return { text: lines.join("\n").trim(), isError: result.status === "failed" }
}
