import fs from "fs"
import os from "os"
import path from "path"
import { spawn } from "child_process"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { requireAuth, resolveUserId, printDivider, dim, bold, writeJson } from "./iris-api"
import { findFreelabelRoot, savedSessions } from "./reachr-instagram"

const out = (...parts: string[]) => console.log(parts.join(""))

/**
 * `iris reachr inbox <bloq-id>` — the inbound half of ReachR: who replied, which lead they are,
 * and what the next step of their outreach strategy would say.
 *
 * A front door onto the inbox scan that already runs on a schedule (tests/e2e/inbox-followup.spec.ts,
 * the daemon's `inbox_scan` task), not a second one.
 *
 * READ-ONLY BY DEFAULT, and private: the scan runs with DRY_RUN=1 and NOTIFY_DISCORD=0. Without the
 * second, even a dry run posted a summary and the reply text (DM content) to the team channel.
 *
 * NEVER SENDS. The scan can auto-send the next strategy step (SEND_REPLIES); that is not exposed
 * here and is forced off. Messaging a person is a separate, deliberate act. `--write-back` is the only
 * write: notes and "replied"/"no response" tags on the matched leads.
 *
 * People who messaged you but are not leads yet are listed with the command that adds them —
 * `iris reachr scrape <board> --instagram inbox`.
 */

const SPEC = path.join("tests", "e2e", "inbox-followup.spec.ts")

export const ReachrInboxCmd = cmd({
  command: "inbox <bloq-id>",
  describe: "who replied to your Instagram outreach, which lead they are, and what the next step would say — read-only; --write-back tags them",
  builder: (y: any) =>
    y
      .positional("bloq-id", { describe: "board whose leads replies are matched against", type: "number" })
      .option("ig-account", { describe: "the Instagram account whose inbox to read (saved session)", type: "string" })
      .option("since", { describe: "how far back: 24h, 3d, 1w", type: "string", default: "24h" })
      .option("limit", { describe: "conversations to read", type: "number", default: 30 })
      .option("write-back", { describe: "add notes and replied / no-response tags to the matched leads (never sends a message)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    const bloqId = Number(args["bloq-id"])
    const isJson = Boolean(args.json)
    const spinner = isJson ? null : prompts.spinner()
    const fail = (msg: string) => {
      spinner?.stop("Inbox not read", 1)
      if (isJson) writeJson({ ok: false, measured: false, error: msg })
      else prompts.log.error(msg)
      process.exitCode = 2
    }

    if (!/^\d+[hdw]$/i.test(String(args.since))) return fail(`--since must look like 24h, 3d or 1w — got "${args.since}"`)
    const root = findFreelabelRoot()
    if (!root)
      return fail("The inbox scan lives in the Freelabel checkout (tests/e2e/inbox-followup.spec.ts) and this machine has none. Set FREELABEL_PATH.")
    const sessions = savedSessions(root)
    const account = args["ig-account"] ?? (sessions.length === 1 ? sessions[0] : null)
    if (!account)
      return fail(
        sessions.length
          ? `Choose whose inbox to read with --ig-account: ${sessions.join(", ")}`
          : "No saved Instagram session. Save one: IG_ACCOUNT=<account> npx playwright test tests/e2e/save-instagram-session.spec.ts --headed",
      )
    if (!sessions.includes(account)) return fail(`No saved session for @${account}. Saved: ${sessions.join(", ") || "none"}.`)
    const token = await requireAuth()
    const userId = await resolveUserId()
    if (!token || !userId) return fail("Not signed in — run `iris login`. The scan reads the board to match replies to leads.")

    const writeBack = Boolean(args["write-back"])
    const resultFile = path.join(os.tmpdir(), `reachr-inbox-${process.pid}-${Date.now()}.json`)
    spinner?.start(
      `Reading @${account}'s inbox (last ${args.since}) — a browser window will open; ${writeBack ? "matched leads will be tagged" : "nothing is written"}, nothing is sent…`,
    )
    const run = await new Promise<{ code: number; text: string }>((resolve) => {
      const child = spawn("npx", ["playwright", "test", SPEC, "--headed", "--timeout", String(15 * 60_000)], {
        cwd: root,
        env: {
          ...process.env,
          BOARD_ID: String(bloqId),
          IG_ACCOUNT: account,
          SINCE: String(args.since),
          LIMIT: String(args.limit),
          HEYIRIS_TOKEN: token,
          USER_ID: String(userId),
          WRITE_BACK: writeBack ? "1" : "0",
          DRY_RUN: writeBack ? "0" : "1",
          SEND_REPLIES: "0", // never — messaging a person is not this command's job
          NOTIFY_DISCORD: "0",
          RESULT_FILE: resultFile,
        },
      })
      let text = ""
      child.stdout.on("data", (d) => (text += d))
      child.stderr.on("data", (d) => (text += d))
      child.on("close", (code) => resolve({ code: code ?? 1, text }))
      child.on("error", (e) => resolve({ code: 1, text: String(e) }))
    })

    let r: any = null
    try {
      r = JSON.parse(fs.readFileSync(resultFile, "utf8"))
    } catch {
      r = null
    } finally {
      fs.rmSync(resultFile, { force: true })
    }
    if (!r) {
      const tail = run.text.trim().split("\n").filter(Boolean).slice(-3).join(" | ").slice(-400)
      return fail(`the inbox scan produced no result (exit ${run.code}): ${tail || "no output"}`)
    }
    // With --write-back the scan continues past the result file; its exit code says whether the
    // write-back finished.
    const wroteOk = !writeBack || run.code === 0

    spinner?.stop(
      `@${account}: ${r.conversations} conversation(s) — ${r.replied.length} replied, ${r.no_response.length} no response, ${r.not_on_board.length} not on board ${bloqId}`,
    )
    if (isJson) {
      // discord_posted is read from the scan's own log, so "private" is checked, not assumed.
      writeJson({ ok: wroteOk, measured: true, write_back: writeBack, discord_posted: /Discord (scan summary|notification) sent/.test(run.text), ...r })
      process.exitCode = wroteOk ? 0 : 1
      return
    }

    printDivider()
    if (r.replied.length) {
      out(bold("  Replied"))
      for (const l of r.replied) {
        out(`  @${l.handle}  ${dim(`→ ${l.lead_name} #${l.lead_id} · ${l.reply_age}`)}${l.opt_out ? "  OPTED OUT — never contact" : ""}`)
        if (l.last_reply) out(dim(`      “${String(l.last_reply).slice(0, 140)}”`))
        if (l.next_step && !l.opt_out) out(dim(`      next step: ${l.next_step.title}${l.next_step.text ? ` — ${String(l.next_step.text).slice(0, 120)}` : ""}`))
      }
    } else out(dim("  No replies in this window."))
    if (r.not_on_board.length) {
      printDivider()
      out(bold(`  Messaged you, not a lead yet (${r.not_on_board.length})`))
      out(dim(`  ${r.not_on_board.slice(0, 12).map((u: any) => "@" + u.handle).join("  ")}${r.not_on_board.length > 12 ? "  …" : ""}`))
      out(dim(`  Add them: iris reachr scrape ${bloqId} --instagram inbox --ig-account ${account} --write`))
    }
    printDivider()
    prompts.outro(
      writeBack
        ? wroteOk
          ? "Matched leads tagged and noted. Nothing was sent."
          : `Write-back did not finish (exit ${run.code}) — check the leads; nothing was sent.`
        : dim(`Read-only — nothing written or sent. --write-back tags the matched leads.`),
    )
    process.exitCode = wroteOk ? 0 : 1
  },
})
