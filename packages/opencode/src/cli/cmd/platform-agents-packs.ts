import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import {
  irisFetch,
  requireAuth,
  requireUserId,
  isNonInteractive,
  writeJson,
  printDivider,
  printKV,
  dim,
  bold,
  success,
  FL_API,
  IRIS_API,
  PUBLIC_SITE,
} from "./iris-api"
import { bloqWebUrl } from "./bloq-web-url"
import { readIntegrationStores } from "./integration-stores"

/**
 * `iris agents install <pack>` / `iris agents packs` — Agent Packs from the terminal (#191436).
 *
 * A pack is a whole working agent in one step: its own board, lists, seed items, the intake
 * answers written onto that board, and an agent scoped by the pack's tool allowlist. fl-api #189
 * holds the installer (PackInstaller) and three routes on FL_API:
 *
 *   GET  /api/v1/users/{u}/agent-packs                  → {data: {packs: [summary…]}}
 *   GET  /api/v1/users/{u}/agent-packs/installs         → {data: {installs: [install…]}}
 *   POST /api/v1/users/{u}/agent-packs/{pack}/install   {variables, answers, install_key, dry_run}
 *        → dry run {data: {dry_run, plan}} · live {data: {created, install}} (201 new, 200 existing)
 *        → 422 {message, errors: [sentence…]} for an unknown pack, variable or answer
 *
 * This is a CLIENT-FACING command, so two rules shape it:
 *   1. Every refusal is a sentence the client can act on ("Unknown variable foo — this pack
 *      takes: …", "Connect slack first: …"). The server's raw body never reaches the terminal.
 *      Checks that need only the catalog run BEFORE the install call, so a typo costs nothing.
 *   2. Re-running is safe. The server is idempotent per (user, pack, --key); a second run returns
 *      the first install and says so instead of building a second board.
 */

// ── types ─────────────────────────────────────────────────────────────────────────────────

export interface PackVariableSpec {
  label?: string
  type?: string
  required?: boolean
  default?: string | number
  max_length?: number
  options?: string[]
  multiline?: boolean
}

export interface PackIntakeQuestion {
  id: string
  question: string
  list?: string
  required?: boolean
}

export interface PackIntegration {
  key: string
  required?: boolean
  reason?: string
}

export interface PackSummary {
  name: string
  version?: string
  title?: string
  description?: string
  disclaimer?: string | null
  variables?: Record<string, PackVariableSpec>
  intake?: PackIntakeQuestion[]
  tools?: string[]
  heartbeat?: { mode?: string; frequency?: string }
  integrations?: PackIntegration[]
  invalid?: boolean
}

export type Fetcher = (path: string, init?: RequestInit) => Promise<Response>
const defaultFetcher: Fetcher = (path, init) => irisFetch(path, init ?? {}, FL_API)

export const INSTALL_KEY_RE = /^[a-z0-9][a-z0-9_-]{0,99}$/

// ── pure helpers (tested without a server) ────────────────────────────────────────────────

/**
 * `--var k=v` / `--answer id=text`, repeatable. Only the FIRST `=` splits, so an answer may
 * contain `=` ("target=2m by 2040"). Returns the reason instead of throwing.
 */
export function parsePairs(raw: unknown, flag: string): { pairs: Record<string, string> } | { error: string } {
  const list = raw === undefined || raw === null ? [] : Array.isArray(raw) ? raw : [raw]
  const pairs: Record<string, string> = {}
  for (const item of list) {
    const s = String(item)
    const i = s.indexOf("=")
    if (i <= 0) return { error: `--${flag} needs name=value (got "${s}").` }
    pairs[s.slice(0, i).trim()] = s.slice(i + 1)
  }
  return { pairs }
}

/**
 * What the catalog alone can say is wrong with an install — before any write.
 * Wording is the client-facing contract; tests pin it.
 */
export function checkPackInput(
  pack: PackSummary,
  variables: Record<string, string>,
  answers: Record<string, string>,
  opts: { interactive?: boolean } = {},
): string[] {
  const errors: string[] = []
  const specs = pack.variables ?? {}
  const varNames = Object.keys(specs)
  for (const k of Object.keys(variables)) {
    if (!(k in specs)) {
      errors.push(`Unknown variable ${k} — this pack takes: ${varNames.join(", ") || "no variables"}.`)
    }
  }
  const questions = pack.intake ?? []
  const qIds = questions.map((q) => q.id)
  for (const k of Object.keys(answers)) {
    if (!qIds.includes(k)) {
      errors.push(`Unknown intake question ${k} — this pack asks: ${qIds.join(", ") || "nothing"}.`)
    }
  }
  for (const [name, spec] of Object.entries(specs)) {
    const v = variables[name]
    if (v !== undefined && spec.options?.length && !spec.options.includes(v)) {
      errors.push(`${name} must be one of: ${spec.options.join(", ")}.`)
    }
    if (v !== undefined && spec.max_length && v.length > spec.max_length) {
      errors.push(`${name} is longer than ${spec.max_length} characters.`)
    }
  }
  // Missing required values only matter when nobody will be asked for them.
  if (!opts.interactive) {
    for (const [name, spec] of Object.entries(specs)) {
      if (spec.required && spec.default === undefined && !(variables[name] ?? "").trim()) {
        errors.push(`Missing ${name}${spec.label ? ` (${spec.label})` : ""} — pass --var ${name}=…`)
      }
    }
    for (const q of questions) {
      if (q.required && !(answers[q.id] ?? "").trim()) {
        errors.push(`Intake question ${q.id} needs an answer: ${q.question} — pass --answer ${q.id}=…`)
      }
    }
  }
  return errors
}

/** Required integrations the client has not connected. `connected` = slugs from either store. */
export function missingIntegrations(pack: PackSummary, connected: string[]): PackIntegration[] {
  const have = new Set(connected.map((c) => c.toLowerCase()))
  return (pack.integrations ?? []).filter((i) => i.required !== false && !have.has(i.key.toLowerCase()))
}

/** "Connect X first" — one line per missing integration, with the command that does it. */
export function connectFirstMessage(missing: PackIntegration[]): string {
  return missing
    .map((i) => `Connect ${i.key} first${i.reason ? ` (${i.reason})` : ""}: iris integrations connect ${i.key}`)
    .join("\n")
}

/** The slugs an integrations row can carry its type under — the two stores disagree. */
export function integrationSlugs(rows: any[]): string[] {
  const out: string[] = []
  for (const r of rows ?? []) {
    for (const k of ["type", "slug", "integration_type", "key", "provider_key", "name"]) {
      if (typeof r?.[k] === "string" && r[k]) out.push(r[k])
    }
  }
  return out
}

export function installRequestBody(opts: {
  variables: Record<string, string>
  answers: Record<string, string>
  key?: string
  dryRun?: boolean
}): Record<string, unknown> {
  const body: Record<string, unknown> = { variables: opts.variables, answers: opts.answers }
  if (opts.key) body.install_key = opts.key
  if (opts.dryRun) body.dry_run = true
  return body
}

/**
 * Turn any non-2xx from the pack routes into sentences. The server's PackManifestException
 * messages are already written for people ("Unknown variable 'x'. This pack takes: …"); anything
 * else — a stack, an HTML error page, a Laravel validation bag — is reduced to what to do next.
 */
export function explainPackError(status: number, body: any): string[] {
  if (status === 401) return ["You're signed out. Run: iris auth login"]
  if (status === 403) return ["That account isn't yours to install onto. Check you're signed in as the right user (iris auth status)."]
  if (status === 404) return ["Agent packs aren't available on this server yet."]
  if (status === 429) return ["Too many installs in a row — wait a minute and try again."]
  if (status >= 500) return ["IRIS couldn't finish the install (server error). Nothing was half-built — the install is all-or-nothing. Try again in a minute."]
  const errs = body?.errors
  if (Array.isArray(errs) && errs.length) {
    return errs.map((e: unknown) => cleanServerSentence(String(e)))
  }
  if (errs && typeof errs === "object") {
    return Object.entries(errs).flatMap(([k, v]) => (Array.isArray(v) ? v : [v]).map((m) => `${k}: ${cleanServerSentence(String(m))}`))
  }
  if (typeof body?.message === "string" && body.message && !/exception|sqlstate|stack/i.test(body.message)) {
    return [cleanServerSentence(body.message)]
  }
  return [`The install was refused (HTTP ${status}). Run with --dry-run to see what would be created.`]
}

/** Server sentences use quotes around names ("Unknown variable 'foo'. This pack takes: …"). */
function cleanServerSentence(s: string): string {
  return s
    .replace(/^Unknown variable '([^']+)'\. This pack takes:/, "Unknown variable $1 — this pack takes:")
    .replace(/^Unknown intake question '([^']+)'\. This pack asks:/, "Unknown intake question $1 — this pack asks:")
    .trim()
}

/** Lines describing a dry-run plan, for people. */
export function formatPlan(plan: any): string[] {
  const out: string[] = []
  out.push(`Pack:   ${plan.pack} v${plan.version}  (key: ${plan.install_key})`)
  if (plan.already_installed) {
    out.push(`Already installed: board #${plan.already_installed.bloq_id}, agent #${plan.already_installed.agent_id} — a live install would change nothing.`)
  }
  out.push(`Board:  ${plan.board?.name ?? "?"}`)
  for (const l of plan.board?.lists ?? []) {
    out.push(`  • ${l.name}${l.items?.length ? ` — ${l.items.length} item(s)` : ""}`)
  }
  const a = plan.agent ?? {}
  out.push(`Agent:  ${a.name ?? "?"}  (${a.model ?? "default model"})`)
  out.push(`Tools:  ${(a.tools ?? []).join(", ") || "none"}`)
  const hb = a.heartbeat ?? {}
  out.push(`Runs:   ${hb.mode && hb.mode !== "off" ? `${hb.mode}${hb.frequency ? `, ${hb.frequency}` : ""}` : "only when you ask it"}`)
  const ints = (plan.integrations ?? []) as PackIntegration[]
  if (ints.length) out.push(`Needs:  ${ints.map((i) => i.key).join(", ")}`)
  if (plan.disclaimer) out.push(`Note:   ${plan.disclaimer}`)
  return out
}

export function boardUrl(bloqId: number | string): string {
  return bloqWebUrl(bloqId, PUBLIC_SITE)
}

// ── IO (fetcher injectable for tests) ─────────────────────────────────────────────────────

export async function fetchCatalog(userId: number, fetcher: Fetcher = defaultFetcher): Promise<{ packs: PackSummary[] } | { errors: string[] }> {
  const res = await fetcher(`/api/v1/users/${userId}/agent-packs`, { method: "GET" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { errors: explainPackError(res.status, body) }
  const packs = (body?.data?.packs ?? body?.packs ?? []) as PackSummary[]
  return { packs: packs.filter((p) => !p.invalid) }
}

export async function fetchInstalls(userId: number, fetcher: Fetcher = defaultFetcher): Promise<{ installs: any[] } | { errors: string[] }> {
  const res = await fetcher(`/api/v1/users/${userId}/agent-packs/installs`, { method: "GET" })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { errors: explainPackError(res.status, body) }
  return { installs: (body?.data?.installs ?? body?.installs ?? []) as any[] }
}

export type InstallOutcome =
  | { kind: "plan"; plan: any }
  | { kind: "installed"; created: boolean; install: any; boardUrl: string | null }
  | { kind: "error"; errors: string[] }

export async function requestInstall(
  userId: number,
  pack: string,
  opts: { variables: Record<string, string>; answers: Record<string, string>; key?: string; dryRun?: boolean },
  fetcher: Fetcher = defaultFetcher,
): Promise<InstallOutcome> {
  const res = await fetcher(`/api/v1/users/${userId}/agent-packs/${encodeURIComponent(pack)}/install`, {
    method: "POST",
    body: JSON.stringify(installRequestBody(opts)),
  })
  const body = await res.json().catch(() => ({}))
  if (!res.ok) return { kind: "error", errors: explainPackError(res.status, body) }
  const data = body?.data ?? {}
  if (data.dry_run) return { kind: "plan", plan: data.plan }
  const install = data.install ?? {}
  return {
    kind: "installed",
    created: !!data.created,
    install,
    boardUrl: install.bloq_id ? boardUrl(install.bloq_id) : null,
  }
}

/** Which integrations are connected, from both stores. Null = could not tell (never "none"). */
async function connectedIntegrations(userId: number): Promise<string[] | null> {
  const r = await readIntegrationStores(
    [
      { label: "fl-api", base: FL_API, inExecStore: false },
      { label: "iris-api", base: IRIS_API, inExecStore: true },
    ],
    async (base) => {
      const res = await irisFetch(`/api/v1/users/${userId}/integrations`, {}, base)
      return { ok: res.ok, status: res.status, body: await res.json().catch(() => ({})) }
    },
  )
  return r.rows ? integrationSlugs(r.rows) : null
}

// ── commands ──────────────────────────────────────────────────────────────────────────────

async function failWith(json: boolean, errors: string[]): Promise<void> {
  process.exitCode = 1
  if (json) {
    await writeJson({ success: false, error: errors[0] ?? "failed", errors })
    return
  }
  for (const e of errors) prompts.log.error(e)
  prompts.outro("Done")
}

async function showCatalog(userId: number, json: boolean, installed: boolean): Promise<void> {
  if (installed) {
    const r = await fetchInstalls(userId)
    if ("errors" in r) return failWith(json, r.errors)
    if (json) return writeJson({ success: true, installs: r.installs })
    if (!r.installs.length) {
      prompts.log.info("No packs installed yet.")
      prompts.outro(dim("iris agents packs  ·  iris agents install <pack>"))
      return
    }
    for (const i of r.installs) {
      console.log(`  ${bold(i.pack)} v${i.version}  ${dim(`key ${i.install_key}`)}`)
      console.log(`    ${dim("board")} #${i.bloq_id}  ${boardUrl(i.bloq_id)}`)
      console.log(`    ${dim("agent")} #${i.agent_id}  ${dim(String(i.installed_at ?? "").slice(0, 10))}`)
    }
    prompts.outro(dim("iris agents chat <agent-id>"))
    return
  }

  const r = await fetchCatalog(userId)
  if ("errors" in r) return failWith(json, r.errors)
  if (json) return writeJson({ success: true, packs: r.packs })
  if (!r.packs.length) {
    prompts.log.info("No agent packs are available yet.")
    prompts.outro("Done")
    return
  }
  for (const p of r.packs) {
    console.log(`  ${bold(p.name)} ${dim(`v${p.version ?? "?"}`)}  ${p.title && p.title !== p.name ? p.title : ""}`)
    if (p.description) console.log(`    ${dim(p.description)}`)
    const vars = Object.keys(p.variables ?? {})
    if (vars.length) console.log(`    ${dim("variables:")} ${vars.join(", ")}`)
    if (p.intake?.length) console.log(`    ${dim("asks:")} ${p.intake.length} intake question(s)`)
    if (p.integrations?.length) console.log(`    ${dim("needs:")} ${p.integrations.map((i) => i.key).join(", ")}`)
    console.log("")
  }
  prompts.outro(dim("iris agents install <pack>  ·  add --dry-run to preview"))
}

export const AgentsPacksCommand = cmd({
  command: "packs",
  aliases: ["pack-list"],
  describe: "list agent packs you can install (a ready agent with its own board) — or --installed",
  builder: (yargs) =>
    yargs
      .option("installed", { describe: "show the packs you have already installed", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .example("iris agents packs", "see every pack and what it asks for")
      .example("iris agents packs --installed", "your installs, with board links and agent ids"),
  async handler(args) {
    const json = !!args.json
    if (!json) { UI.empty(); prompts.intro(args.installed ? "◈  Installed Agent Packs" : "◈  Agent Packs") }
    if (!(await requireAuth())) { if (!json) prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) return failWith(json, ["Could not work out your user id — pass --user-id or run iris auth login."])
    await showCatalog(userId, json, !!args.installed)
  },
})

export const AgentsInstallCommand = cmd({
  command: "install [pack]",
  describe: "install an agent pack: its own board, lists, intake answers and a scoped agent, in one step",
  builder: (yargs) =>
    yargs
      .positional("pack", { describe: "pack name (omit to list packs)", type: "string" })
      .option("var", { describe: "pack variable as name=value (repeatable)", type: "string", array: true })
      .option("answer", { describe: "intake answer as question-id=text (repeatable)", type: "string", array: true })
      .option("key", { describe: "install key — re-running with the same key is safe; a new key installs a second copy", type: "string" })
      .option("dry-run", { describe: "show exactly what would be created, write nothing", type: "boolean", default: false })
      .option("yes", { alias: "y", describe: "skip the confirmation and the questions you did not answer", type: "boolean", default: false })
      .option("skip-integration-check", { describe: "install even if a required integration is not connected yet", type: "boolean", default: false })
      .option("json", { describe: "JSON output (non-interactive)", type: "boolean", default: false })
      .option("user-id", { describe: "user ID (or IRIS_USER_ID env)", type: "number" })
      .example("iris agents install", "list the packs you can install")
      .example("iris agents install long-term-investing-advisor", "answer the intake questions, then install")
      .example(
        "iris agents install long-term-investing-advisor --var owner_name=Sam --answer goal=\"2M by 2045\" --dry-run",
        "preview the board and agent without creating anything",
      )
      .example("iris agents install long-term-investing-advisor --var owner_name=Sam --key sam --yes --json", "scripted, idempotent install"),
  async handler(args) {
    const json = !!args.json
    const dryRun = !!args["dry-run"]
    const interactive = !json && !args.yes && !isNonInteractive()

    if (!json) { UI.empty(); prompts.intro(args.pack ? `◈  Install ${args.pack}${dryRun ? " (dry run)" : ""}` : "◈  Agent Packs") }
    if (!(await requireAuth())) { if (!json) prompts.outro("Done"); return }
    const userId = await requireUserId(args["user-id"] as number | undefined)
    if (!userId) return failWith(json, ["Could not work out your user id — pass --user-id or run iris auth login."])

    if (!args.pack) return showCatalog(userId, json, false)
    const packName = String(args.pack)

    const key = args.key ? String(args.key) : undefined
    if (key && !INSTALL_KEY_RE.test(key)) {
      return failWith(json, ["--key must be a short slug: lowercase letters, numbers, - or _ (e.g. --key sam)."])
    }
    const v = parsePairs(args.var, "var")
    if ("error" in v) return failWith(json, [v.error])
    const a = parsePairs(args.answer, "answer")
    if ("error" in a) return failWith(json, [a.error])
    const variables = v.pairs
    const answers = a.pairs

    const cat = await fetchCatalog(userId)
    if ("errors" in cat) return failWith(json, cat.errors)
    const pack = cat.packs.find((p) => p.name === packName)
    if (!pack) {
      return failWith(json, [`Unknown pack ${packName} — available: ${cat.packs.map((p) => p.name).join(", ") || "none yet"}.`])
    }

    const pre = checkPackInput(pack, variables, answers, { interactive })
    if (pre.length) return failWith(json, pre)

    // Intake: ask for what was not passed. Variables first (they name things), then questions.
    if (interactive) {
      if (pack.description) prompts.log.info(pack.description)
      for (const [name, spec] of Object.entries(pack.variables ?? {})) {
        if (variables[name] !== undefined) continue
        const answer = spec.options?.length
          ? await prompts.select({
              message: spec.label ?? name,
              options: spec.options.map((o) => ({ value: o, label: o })),
              initialValue: spec.default !== undefined ? String(spec.default) : undefined,
            })
          : await prompts.text({
              message: spec.label ?? name,
              placeholder: spec.default !== undefined ? String(spec.default) : spec.required ? "required" : "optional — Enter to skip",
              validate: (s) => (spec.required && spec.default === undefined && !String(s ?? "").trim() ? "This one is needed." : undefined),
            })
        if (prompts.isCancel(answer)) { prompts.outro("Cancelled"); return }
        if (String(answer ?? "").trim()) variables[name] = String(answer).trim()
      }
      for (const q of pack.intake ?? []) {
        if (answers[q.id] !== undefined) continue
        const answer = await prompts.text({
          message: q.question,
          placeholder: q.required ? "required" : "Enter to skip",
          validate: (s) => (q.required && !String(s ?? "").trim() ? "This one is needed." : undefined),
        })
        if (prompts.isCancel(answer)) { prompts.outro("Cancelled"); return }
        if (String(answer ?? "").trim()) answers[q.id] = String(answer).trim()
      }
    }

    // Required integrations — checked against both stores, and only refused when we could
    // actually read them. An unreadable store is a warning, never a false "not connected".
    if (!dryRun && !args["skip-integration-check"] && (pack.integrations ?? []).some((i) => i.required !== false)) {
      const connected = await connectedIntegrations(userId)
      if (connected === null) {
        if (!json) prompts.log.warn("Could not check your connected integrations — installing anyway; the agent will ask for them when it needs them.")
      } else {
        const missing = missingIntegrations(pack, connected)
        if (missing.length) return failWith(json, [connectFirstMessage(missing), "Or install now and connect later: add --skip-integration-check"])
      }
    }

    // Interactive live installs get one look at the plan before anything is written.
    if (interactive && !dryRun) {
      const preview = await requestInstall(userId, packName, { variables, answers, key, dryRun: true })
      if (preview.kind === "error") return failWith(json, preview.errors)
      if (preview.kind === "plan") {
        printDivider()
        for (const line of formatPlan(preview.plan)) console.log(`  ${line}`)
        printDivider()
        const ok = await prompts.confirm({ message: preview.plan.already_installed ? "Already installed — show it?" : "Install this?" })
        if (!ok || prompts.isCancel(ok)) { prompts.outro("Cancelled — nothing was created"); return }
      }
    }

    const spinner = json ? null : prompts.spinner()
    spinner?.start(dryRun ? "Planning…" : "Installing…")
    const out = await requestInstall(userId, packName, { variables, answers, key, dryRun })
    if (out.kind === "error") { spinner?.stop("Not installed", 1); return failWith(json, out.errors) }

    if (out.kind === "plan") {
      spinner?.stop("Plan — nothing was created")
      if (json) return writeJson({ success: true, dry_run: true, plan: out.plan })
      printDivider()
      for (const line of formatPlan(out.plan)) console.log(`  ${line}`)
      printDivider()
      prompts.outro(dim("Run again without --dry-run to install."))
      return
    }

    const i = out.install
    if (json) {
      return writeJson({ success: true, created: out.created, install: i, board_url: out.boardUrl, agent_id: i.agent_id ?? null })
    }
    spinner?.stop(out.created ? success(`✓ Installed ${i.pack} v${i.version}`) : `Already installed — nothing new was created`)
    printDivider()
    printKV("Board", out.boardUrl ? `#${i.bloq_id}  ${out.boardUrl}` : i.bloq_id)
    printKV("Agent", i.agent_id ? `#${i.agent_id}` : undefined)
    printKV("Install key", i.install_key)
    if (i.upgrade_available) printKV("Upgrade available", `v${i.upgrade_available}`)
    printDivider()
    const needs = (pack.integrations ?? []).map((x) => x.key)
    if (needs.length) prompts.log.info(`Connect when ready: ${needs.map((n) => `iris integrations connect ${n}`).join("  ·  ")}`)
    if (pack.disclaimer) prompts.log.warn(pack.disclaimer)
    prompts.outro(dim(i.agent_id ? `iris agents chat ${i.agent_id}` : "iris agents packs --installed"))
  },
})
