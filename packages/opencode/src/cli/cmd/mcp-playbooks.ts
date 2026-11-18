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

/**
 * PLAYBOOKS BEHIND SEARCH (#191216, epic #190539 E6).
 *
 * One typed tool per playbook made every client pay for every playbook's manual before doing
 * anything. Measured 2026-10-26: 39 playbook tools ≈ 19,500 of the server's 24,000 tools/list
 * tokens (81%), growing with every playbook published. Past a handful, the same playbooks are
 * offered as two tools — `playbook_find` (search) and `playbook_run` (execute) — the Code Mode
 * shape the core tools already have (iris_help + iris_run).
 *
 * At or under TYPED_TOOL_LIMIT the typed tools stay: a small set is cheap and its schemas help.
 * `playbook_<name>` keeps working as a CALL in either mode, so a saved prompt or agent that names
 * one is not broken — it is just no longer advertised. IRIS_MCP_PLAYBOOK_TOOLS=all|search|auto.
 */
export const TYPED_TOOL_LIMIT = 8
export const FIND_TOOL = "playbook_find"
export const RUN_TOOL = "playbook_run"

export type PlaybookToolMode = "all" | "search" | "auto"

export function playbookToolMode(env: Record<string, string | undefined> = process.env): PlaybookToolMode {
  const v = (env.IRIS_MCP_PLAYBOOK_TOOLS ?? "").toLowerCase()
  return v === "all" || v === "search" ? v : "auto"
}

/** Whether these playbooks are advertised as search + run rather than one tool each. */
export function useSearchTools(entries: PlaybookEntry[], mode: PlaybookToolMode = playbookToolMode()): boolean {
  const n = entries.filter((e) => e.callable).length
  return mode === "search" || (mode === "auto" && n > TYPED_TOOL_LIMIT)
}

export function toolsFor(entries: PlaybookEntry[], mode: PlaybookToolMode = playbookToolMode()) {
  const callable = entries.filter((e) => e.callable)
  if (!useSearchTools(entries, mode))
    return callable.map((e) => ({
      name: toolNameFor(e.plan.name),
      description: descriptionFor(e.plan),
      inputSchema: inputSchemaFor(e.plan) as any,
    }))
  const names = callable.map((e) => e.plan.name)
  return [
    {
      name: FIND_TOOL,
      description:
        `Find an IRIS playbook — a written, runnable procedure — by what you want done. ` +
        `Returns each match's name, purpose and arguments; then run it with ${RUN_TOOL}. ` +
        `${names.length} available: ${names.join(", ")}.`,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "what you want done, in plain words; empty lists them all" },
          limit: { type: "number", description: "max matches (default 5)" },
        },
      } as any,
    },
    {
      name: RUN_TOOL,
      description:
        `Run an IRIS playbook by name with its arguments (find them with ${FIND_TOOL}). ` +
        `A gated playbook needs confirm=true, passed only after the operator agreed.`,
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "the playbook name, e.g. opportunity-posts" },
          args: { type: "object", description: "the playbook's arguments, as listed by playbook_find" },
          confirm: { type: "boolean", description: "required for gated playbooks; true only if the operator agreed" },
        },
        required: ["name"],
      } as any,
    },
  ]
}

const words = (s: string) => s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2)

/** Rank playbooks against a plain-words request. Name hits outweigh description hits. */
export function findPlaybooks(entries: PlaybookEntry[], query: string, limit = 5): PlaybookEntry[] {
  const callable = entries.filter((e) => e.callable)
  const q = words(query)
  if (!q.length) return callable.slice(0, Math.max(limit, callable.length))
  const scored = callable
    .map((e) => {
      const name = e.plan.name.toLowerCase()
      const nameWords = new Set(words(name.replace(/-/g, " ")))
      const desc = new Set(words(e.plan.description))
      let score = 0
      for (const w of q) {
        if (name === w) score += 20
        if (nameWords.has(w)) score += 8
        else if (name.includes(w)) score += 4
        if (desc.has(w)) score += 2
        else if ([...desc].some((d) => d.startsWith(w) || w.startsWith(d))) score += 1
      }
      return { e, score }
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.e.plan.name.localeCompare(b.e.plan.name))
  return scored.slice(0, limit).map((x) => x.e)
}

/** One match, compactly: what a model needs to call it, and nothing it does not. */
export function describeMatch(e: PlaybookEntry): string {
  const { plan } = e
  const args = Object.entries(plan.args).map(([k, d]) => {
    const enumPart = d.enum ? `=${d.enum.join("|")}` : ""
    const def = d.default !== undefined ? ` (default ${JSON.stringify(d.default)})` : ""
    return `  - ${k}${d.required ? " (required)" : ""}: ${d.type}${enumPart}${def}${d.description ? ` — ${d.description}` : ""}`
  })
  const flags = [needsApproval(plan) ? "gated: pass confirm=true after the operator agrees" : "", plan.steps.some((s) => s.mode === "human") ? "pauses for a person" : ""].filter(Boolean)
  return [`## ${plan.name}`, plan.description.split("\n")[0], ...(flags.length ? [`(${flags.join("; ")})`] : []), ...(args.length ? ["args:", ...args] : ["args: none"])].join("\n")
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
      ? `- Runnable: yes, as ${useSearchTools(entries) ? `\`${RUN_TOOL}\` {name: "${entry.plan.name}"}` : `the \`${toolNameFor(entry.plan.name)}\` tool`} (or \`iris playbook run ${entry.plan.name}\`)`
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

/**
 * Execute a playbook tool call and render it as text for the model. Handles the search pair
 * (`playbook_find`, `playbook_run`) and every `playbook_<name>` — advertised or not.
 */
export async function callPlaybookTool(toolName: string, args: Record<string, unknown>): Promise<CallResult> {
  const entries = await loadPlaybooks()
  // A playbook literally named "find" or "run" keeps its typed name when typed tools are on.
  const typedHit = entries.find((e) => e.callable && toolNameFor(e.plan.name) === toolName)
  const searchMode = useSearchTools(entries)

  if (toolName === FIND_TOOL && (searchMode || !typedHit)) {
    const limit = Math.max(1, Math.min(50, Number(args.limit) || 5))
    const hits = findPlaybooks(entries, String(args.query ?? ""), limit)
    if (!hits.length)
      return {
        text: `No playbook matches "${args.query ?? ""}". Call ${FIND_TOOL} with no query to list them all, or use iris_help for CLI commands.`,
        isError: false,
      }
    return { text: hits.map(describeMatch).join("\n\n") + `\n\nRun one: ${RUN_TOOL} {name, args}`, isError: false }
  }

  if (toolName === RUN_TOOL && (searchMode || !typedHit)) {
    const name = String(args.name ?? "")
    const target = entries.find((e) => e.callable && e.plan.name === name)
    if (!target) return { text: `Unknown playbook: "${name}". Find one with ${FIND_TOOL}.`, isError: true }
    const inner = (args.args && typeof args.args === "object" ? args.args : {}) as Record<string, unknown>
    return runEntry(target, { ...inner, ...(args.confirm !== undefined ? { confirm: args.confirm } : {}) })
  }

  if (!typedHit) return { text: `Unknown playbook tool: ${toolName}`, isError: true }
  return runEntry(typedHit, args)
}

async function runEntry(entry: PlaybookEntry, args: Record<string, unknown>): Promise<CallResult> {

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
