import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, requireUserId, printDivider, printKV, dim, success } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync } from "fs"
import { join, resolve } from "path"

/**
 * `iris workflows export --format claude-workflow`
 *
 * Emits a runnable `.claude/workflows/<slug>.js`. IRIS stays the system of record and
 * Claude Code becomes a runtime — the point of P4.
 *
 * This is a TRANSLITERATION, not an equivalence, and the generated file says so at the top
 * rather than letting someone discover it in production. What does not survive the trip:
 *
 *   - tool scoping. An IRIS step runs against `allowed_tools` / the agent's integration
 *     allowlist. A Claude Code `agent()` gets whatever its own harness gives it. The
 *     translated script cannot enforce the narrower set, so it names the tools the original
 *     was scoped to and leaves honouring them to the reader.
 *   - human approval. `require_human_approval` has no counterpart; /workflows is ephemeral
 *     and session-scoped, which is exactly the gap section 03 says to sell into.
 *   - `code` execution mode. script_content is a shell/JS payload for the IRIS runner and is
 *     NOT wrapped in agent() — pretending a script is a prompt would produce a file that
 *     runs and does the wrong thing. It is emitted as a commented block and reported.
 */

export type Step = { id?: any; name?: string; type?: string; order?: number; prompt?: string; settings?: any }

/** Fenced so a prompt containing backticks cannot break out of the template literal. */
export function jsTemplate(text: string): string {
  return "`" + String(text ?? "").replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$\{/g, "\\${") + "`"
}

export function slugify(name: string): string {
  return (name || "workflow").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "workflow"
}

/** What the original was scoped to, from wherever this vintage of workflow stored it. */
export function scopedTools(w: any): string[] {
  const out = new Set<string>()
  for (const src of [w?.allowed_tools, w?.settings?.allowed_tools, w?.agent_config?.tools]) {
    if (Array.isArray(src)) for (const t of src) {
      if (typeof t === "string") out.add(t)
      else if (t && typeof t === "object" && typeof t.type === "string") out.add(t.type)
    }
  }
  return [...out].sort()
}

export function buildScript(w: any): { code: string; untranslated: string[] } {
  const steps: Step[] = Array.isArray(w?.steps) ? [...w.steps].sort((a, b) => (a.order ?? 0) - (b.order ?? 0)) : []
  const tools = scopedTools(w)
  const untranslated: string[] = []

  if (w?.require_human_approval) untranslated.push("require_human_approval — /workflows has no approval primitive")
  if (tools.length) untranslated.push(`allowed_tools (${tools.length}) — not enforceable in a Claude Code agent()`)
  if (w?.execution_mode === "code" || w?.script_content) untranslated.push("script_content — emitted as a comment, not wrapped in agent()")
  if (w?.max_iterations) untranslated.push(`max_iterations=${w.max_iterations} — no equivalent ceiling`)

  const slug = slugify(w?.name)
  const phases = steps.length
    ? steps.map((s, i) => `    { title: ${JSON.stringify(s.name || `Step ${i + 1}`)} },`).join("\n")
    : `    { title: "Run" },`

  const header = [
    "/**",
    ` * ${w?.name ?? "IRIS workflow"}`,
    w?.description ? ` *` : null,
    w?.description ? ` * ${String(w.description).replace(/\n/g, "\n * ")}` : null,
    " *",
    ` * Transliterated from IRIS workflow #${w?.id} (execution_mode: ${w?.execution_mode ?? "unknown"}).`,
    " * IRIS remains the system of record; this file makes Claude Code a runtime for it.",
    " *",
    untranslated.length
      ? " * DID NOT SURVIVE THE TRANSLATION — read before trusting this file:\n" +
        untranslated.map((u) => ` *   - ${u}`).join("\n")
      : " * Everything in the source workflow translated cleanly.",
    tools.length ? " *\n * The original was scoped to these tools; honouring that is on you:\n" + tools.map((t) => ` *   - ${t}`).join("\n") : null,
    " */",
  ].filter(Boolean).join("\n")

  const meta = [
    "export const meta = {",
    `  name: ${JSON.stringify(slug)},`,
    `  description: ${JSON.stringify(String(w?.description ?? w?.name ?? "Imported IRIS workflow").slice(0, 200))},`,
    "  phases: [",
    phases,
    "  ],",
    "}",
  ].join("\n")

  let body: string
  if (steps.length) {
    body = steps
      .map((s, i) => {
        const title = JSON.stringify(s.name || `Step ${i + 1}`)
        const p = s.prompt || s.name || "Continue."
        const prev = i === 0 ? "" : `\n\nPrevious step returned:\n\${step${i}}`
        return [
          `phase(${title})`,
          `const step${i + 1} = await agent(${jsTemplate(p + (i === 0 ? "" : "") )}${prev ? " + " + jsTemplate(prev) : ""}, { label: ${title} })`,
        ].join("\n")
      })
      .join("\n\n")
    body += `\n\nreturn { ${steps.map((_, i) => `step${i + 1}`).join(", ")} }`
  } else {
    const p = w?.agent_prompt || w?.description || w?.name || "Run this workflow."
    body = [`phase("Run")`, `const result = await agent(${jsTemplate(p)}, { label: ${JSON.stringify(slug)} })`, "", "return { result }"].join("\n")
  }

  const script = w?.script_content
    ? "\n\n/* Original script_content — NOT executed here, translate deliberately:\n" +
      String(w.script_content).replace(/\*\//g, "*\\/") +
      "\n*/\n"
    : ""

  return { code: `${header}\n\n${meta}\n\n${body}\n${script}`, untranslated }
}

export const WorkflowsExportCommand = cmd({
  command: "export <id>",
  describe: "export a workflow as a runnable .claude/workflows/*.js",
  builder: (yargs) =>
    yargs
      .positional("id", { describe: "workflow ID", type: "number", demandOption: true })
      .option("format", { describe: "output format", choices: ["claude-workflow"] as const, default: "claude-workflow" })
      .option("out", { alias: "o", describe: "output directory (default ./.claude/workflows)", type: "string" })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Export Workflow #${args.id}`)

    const token = await requireAuth()
    if (!token) { prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"])
    if (!userId) { prompts.outro("Done"); return }

    const spinner = prompts.spinner()
    spinner.start("Fetching workflow…")

    try {
      const res = await irisFetch(`/api/v1/users/${userId}/bloqs/workflows/${args.id}`)
      const ok = await handleApiError(res, "Export workflow")
      if (!ok) { spinner.stop("Failed", 1); process.exitCode = 1; prompts.outro("Done"); return }

      const data = (await res.json()) as { data?: any }
      const w = data?.data ?? data

      const { code, untranslated } = buildScript(w)
      const dir = resolve(args.out ?? "./.claude/workflows")
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const file = join(dir, `${slugify(w?.name)}.js`)
      writeFileSync(file, code)

      spinner.stop(success("Exported"))
      printDivider()
      printKV("Name", w?.name)
      printKV("Mode", w?.execution_mode ?? dim("unknown"))
      printKV("Steps", String(Array.isArray(w?.steps) ? w.steps.length : 0))
      printKV("File", file)
      printDivider()
      if (untranslated.length) {
        prompts.log.warn("Did not survive the translation — named at the top of the file:")
        for (const u of untranslated) prompts.log.warn(`  ${u}`)
      } else {
        prompts.log.info("Everything in the source workflow translated cleanly.")
      }
      prompts.outro(dim(`claude  # then: /workflows`))
    } catch (err) {
      spinner.stop("Error", 1)
      process.exitCode = 1
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})
