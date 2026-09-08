import { cmd } from "./cmd"
import * as prompts from "./clack"
import {
  irisFetch, requireAuth, handleApiError, printKV,
  dim, bold, success, writeJson,
} from "./iris-api"

/**
 * `iris reachr script` — the MESSAGE template, versioned.
 *
 * The one object in the outreach domain that had a complete API and no CLI. It is referenced by
 * both strategies (`script_template_id` on every step) and campaigns, and until now the only way
 * to touch one was `iris som edit <campaign>` — which meant scripts were reachable solely through
 * the campaign path even though strategies depend on them just as much.
 *
 * Versions are first-class server-side: `versions[]`, `current_version`, activate and rollback.
 * Nothing surfaced that either, so a script could be edited but never reverted from the CLI.
 */

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

type Script = Record<string, unknown>

function base(bloqId: string): string {
  return `/api/v1/bloqs/${bloqId}/outreach-script-templates`
}

async function getScripts(bloqId: string, type?: string, category?: string): Promise<Script[]> {
  const q = new URLSearchParams()
  if (type) q.set("type", type)
  if (category) q.set("category", category)
  const qs = q.toString() ? `?${q}` : ""
  const resp = await irisFetch(`${base(bloqId)}${qs}`, {}, RAICHU)
  if (!resp.ok) { await handleApiError(resp, "fetch scripts"); return [] }
  const body = await resp.json()
  return body.data?.templates ?? body.data ?? body.templates ?? []
}

async function getScript(bloqId: string, id: string): Promise<Script> {
  const resp = await irisFetch(`${base(bloqId)}/${id}`, {}, RAICHU)
  if (!resp.ok) { await handleApiError(resp, "fetch script"); return {} }
  const body = await resp.json()
  return body.data ?? body
}

/** Merge tokens the server will substitute. An unknown one ships to the recipient verbatim. */
const MERGE_FIELDS = [
  "{name}", "{first_name}", "{company}", "{email}", "{phone}",
  "{social_handle}", "{instagram}", "{price_bid}", "{notes}",
  "{sender_name}", "{sender_role}", "{sender_company}",
  "{sender_email}", "{sender_phone}", "{sender_calendar}",
]

/**
 * Warn locally about tokens nothing will substitute.
 *
 * The server refuses these on save for strategies. Checking here too means the author sees it
 * while writing rather than as a 422 — and it is the same failure that shipped `{sender_name}`
 * to a real inbox before the server guard existed.
 */
function unknownTokens(text: string): string[] {
  const found = text.match(/\{[a-z][a-z0-9_]{1,39}\}/g) ?? []
  return [...new Set(found.filter((t) => !MERGE_FIELDS.includes(t)))]
}

function printScript(s: Script, full = false): void {
  printKV("ID", String(s.id))
  printKV("Name", bold(String(s.name)))
  printKV("Type", String(s.type ?? "-"))
  printKV("Tone", String(s.tone ?? "-"))
  printKV("Category", String(s.category ?? "-"))
  printKV("Version", String(s.current_version ?? 1))
  printKV("Uses", String(s.usage_count ?? 0))

  const msg = String(s.message ?? "")
  if (msg) {
    console.log("")
    console.log(bold("Message:"))
    console.log(full ? msg : dim(msg.length > 240 ? msg.slice(0, 240) + "…" : msg))

    const bad = unknownTokens(msg)
    if (bad.length > 0) {
      console.log("")
      console.log(`  ⚠  ${bad.join(" ")} ${dim("— not a merge field; this text would be SENT as-is")}`)
    }
  }
}

// ── list ──

const ScriptListCommand = cmd({
  command: "list <bloq-id>",
  aliases: ["ls"],
  describe: "list message scripts for a board",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .option("type", { describe: "filter by channel type", type: "string" })
      .option("category", { describe: "filter by category", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const scripts = await getScripts(args.bloqId, args.type as string, args.category as string)

    if (args.json) { await writeJson(scripts); return }

    if (scripts.length === 0) {
      console.log("")
      console.log(dim(`  No scripts on board #${args.bloqId}.`))
      console.log(dim(`  iris reachr script create ${args.bloqId} --from-json script.json`))
      console.log("")
      return
    }

    console.log(bold(`\nMessage Scripts [Board #${args.bloqId}]\n`))
    for (const s of scripts) {
      const v = dim(`v${s.current_version ?? 1}`)
      const uses = dim(`${s.usage_count ?? 0} uses`)
      const meta = [s.type, s.tone].filter(Boolean).join(" · ")
      console.log(`  ${dim(`#${s.id}`)} ${bold(String(s.name))}  ${v}  ${dim(meta)}  ${uses}`)
    }
    console.log("")
  },
})

// ── show ──

const ScriptShowCommand = cmd({
  command: "show <bloq-id> <id>",
  describe: "show a script, its full message and its merge tokens",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "script ID", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const s = await getScript(args.bloqId, args.id)
    if (args.json) { await writeJson(s); return }
    console.log("")
    printScript(s, true)
    console.log("")
  },
})

// ── create ──

const ScriptCreateCommand = cmd({
  command: "create <bloq-id>",
  describe: "create a script from a JSON file",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .option("from-json", { describe: "JSON file path", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const fs = await import("fs")
    const filePath = args.fromJson as string
    if (!fs.existsSync(filePath)) { prompts.log.error(`File not found: ${filePath}`); return }

    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"))

    const bad = unknownTokens(String(payload.message ?? ""))
    if (bad.length > 0) {
      prompts.log.error(`Unknown merge token(s): ${bad.join(" ")}`)
      console.log(dim(`  These are not substituted and would be SENT to the recipient as literal text.`))
      console.log(dim(`  Supported: ${MERGE_FIELDS.join(" ")}`))
      return
    }

    const resp = await irisFetch(base(args.bloqId), {
      method: "POST",
      body: JSON.stringify(payload),
    }, RAICHU)
    if (!resp.ok) { await handleApiError(resp, "create script"); return }

    const created = (await resp.json()).data ?? {}
    if (args.json) { await writeJson(created); return }
    prompts.log.success(`Script "${created.name}" created (ID: ${created.id})`)
  },
})

// ── update ──

const ScriptUpdateCommand = cmd({
  command: "update <bloq-id> <id>",
  describe: "update a script from a JSON file",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "script ID", type: "string", demandOption: true })
      .option("from-json", { describe: "JSON file path", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const fs = await import("fs")
    const filePath = args.fromJson as string
    if (!fs.existsSync(filePath)) { prompts.log.error(`File not found: ${filePath}`); return }

    const payload = JSON.parse(fs.readFileSync(filePath, "utf-8"))

    const bad = unknownTokens(String(payload.message ?? ""))
    if (bad.length > 0) {
      prompts.log.error(`Unknown merge token(s): ${bad.join(" ")}`)
      console.log(dim(`  Supported: ${MERGE_FIELDS.join(" ")}`))
      return
    }

    const resp = await irisFetch(`${base(args.bloqId)}/${args.id}`, {
      method: "PUT",
      body: JSON.stringify(payload),
    }, RAICHU)
    if (!resp.ok) { await handleApiError(resp, "update script"); return }

    const updated = (await resp.json()).data ?? {}
    if (args.json) { await writeJson(updated); return }
    prompts.log.success(`Script #${args.id} updated (now v${updated.current_version ?? "?"})`)
    console.log(dim(`  Editing does not snapshot. Run: iris reachr script snapshot ${args.bloqId} ${args.id} --label "..."`))
  },
})

// ── delete ──

const ScriptDeleteCommand = cmd({
  command: "delete <bloq-id> <id>",
  aliases: ["rm"],
  describe: "delete a script",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "script ID", type: "string", demandOption: true })
      .option("force", { describe: "skip confirmation", type: "boolean" }),
  async handler(args) {
    await requireAuth()

    if (!args.force) {
      const s = await getScript(args.bloqId, args.id)
      const uses = Number(s.usage_count ?? 0)
      const warn = uses > 0 ? `  It has been used ${uses} time(s).` : ""
      const ok = await prompts.confirm({ message: `Delete script "${s.name}"?${warn}` })
      if (!ok || prompts.isCancel(ok)) { prompts.log.info("Cancelled."); return }
    }

    const resp = await irisFetch(`${base(args.bloqId)}/${args.id}`, { method: "DELETE" }, RAICHU)
    if (!resp.ok) { await handleApiError(resp, "delete script"); return }
    prompts.log.success(`Script #${args.id} deleted`)
  },
})

// ── versions ──

const ScriptVersionsCommand = cmd({
  command: "versions <bloq-id> <id>",
  describe: "list a script's saved versions",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "script ID", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    await requireAuth()
    const resp = await irisFetch(`${base(args.bloqId)}/${args.id}/versions`, {}, RAICHU)
    if (!resp.ok) { await handleApiError(resp, "fetch versions"); return }

    const body = await resp.json()
    const versions = (body.data?.versions ?? body.data ?? body.versions ?? []) as Record<string, unknown>[]
    const current = body.data?.current_version ?? body.current_version

    if (args.json) { await writeJson({ current_version: current, versions }); return }

    if (versions.length === 0) {
      console.log("")
      console.log(dim(`  No saved versions. The live message is v${current ?? 1} and has never been snapshotted.`))
      console.log(dim(`  iris reachr script snapshot ${args.bloqId} ${args.id} --label "before rewrite"`))
      console.log("")
      return
    }

    console.log(bold(`\nVersions — script #${args.id}\n`))
    for (const v of versions) {
      const isCurrent = Number(v.version) === Number(current)
      const marker = isCurrent ? success(" ← active") : ""
      const label = v.label ? ` ${String(v.label)}` : dim(" (no label)")
      const msg = String(v.message ?? "")
      console.log(`  ${bold(`v${v.version}`)}${label}${marker}  ${dim(String(v.created_at ?? ""))}`)
      console.log(`     ${dim(msg.length > 90 ? msg.slice(0, 90) + "…" : msg)}`)
    }
    console.log("")
  },
})

const ScriptSnapshotCommand = cmd({
  command: "snapshot <bloq-id> <id>",
  describe: "save the current message as a new version",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "script ID", type: "string", demandOption: true })
      .option("label", { describe: "what this version is, in a few words", type: "string" }),
  async handler(args) {
    await requireAuth()

    // The endpoint requires `message` — it sets the live message AND snapshots it in one call.
    // "Snapshot the current message" therefore means reading it first and sending it back
    // unchanged. Posting only a label returns a 500 that says "Failed to add version", which
    // names neither the missing field nor the fact that it was a validation error at all.
    const current = await getScript(args.bloqId, args.id)
    const message = String(current.message ?? "")
    if (!message) {
      prompts.log.error(`Script #${args.id} has no message to snapshot.`)
      return
    }

    const resp = await irisFetch(`${base(args.bloqId)}/${args.id}/versions`, {
      method: "POST",
      body: JSON.stringify({ message, label: args.label ?? null }),
    }, RAICHU)
    if (!resp.ok) { await handleApiError(resp, "snapshot script"); return }
    const body = await resp.json()
    const v = body.data?.version_number ?? body.data?.version ?? body.version ?? "?"
    prompts.log.success(`Saved as v${v}${args.label ? ` — ${args.label}` : ""}`)
  },
})

const ScriptActivateCommand = cmd({
  command: "activate <bloq-id> <id> <n>",
  aliases: ["rollback"],
  describe: "make a saved version the live message",
  builder: (yargs) =>
    yargs
      .positional("bloq-id", { describe: "board/bloq ID", type: "string", demandOption: true })
      .positional("id", { describe: "script ID", type: "string", demandOption: true })
      // NOT named `version`. The CLI has a global `-v, --version`, and a positional of the same
      // name is shadowed by it — yargs resolved args.version to the global flag, so `activate 3 1`
      // sent version 0 and the server answered "Version 0 not found". The error named the symptom
      // and nothing about where the 0 came from.
      .positional("n", { describe: "version number to activate", type: "string", demandOption: true }),
  async handler(args) {
    await requireAuth()
    const resp = await irisFetch(
      `${base(args.bloqId)}/${args.id}/versions/${args.n}/activate`,
      { method: "PUT" },
      RAICHU,
    )
    if (!resp.ok) { await handleApiError(resp, "activate version"); return }
    prompts.log.success(`Script #${args.id} is now on v${args.n}`)
  },
})

// ── group ──

export const ScriptGroup = cmd({
  command: "script <command>",
  aliases: ["scripts"],
  describe: "message scripts — the copy a step carries, versioned",
  builder: (yargs) =>
    yargs
      .command(ScriptListCommand)
      .command(ScriptShowCommand)
      .command(ScriptCreateCommand)
      .command(ScriptUpdateCommand)
      .command(ScriptDeleteCommand)
      .command(ScriptVersionsCommand)
      .command(ScriptSnapshotCommand)
      .command(ScriptActivateCommand)
      .demandCommand(1, "Pick a subcommand — list, show, create, update, delete, versions, snapshot, activate"),
  async handler() {},
})
