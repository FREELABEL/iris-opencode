import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, writeJson } from "./iris-api"

const RAICHU = process.env.IRIS_FL_API_URL ?? process.env.FL_API_URL ?? "https://raichu.heyiris.io"

interface PendingMessage {
  id: number
  subject: string
  status: string
  to_email: string | null
  to_name: string | null
  lead: { id: number; nickname: string } | null
  created_at: string
  expires_at: string | null
  is_expired: boolean
  preview: string
}

async function fetchPending(state?: "approved"): Promise<PendingMessage[]> {
  const res = await irisFetch(`/api/v1/outreach/pending-approvals${state ? `?state=${state}` : ""}`, {}, RAICHU)
  if (!res.ok) { await handleApiError(res, "fetch pending approvals"); return [] }
  const body = (await res.json()) as any
  return body.data ?? []
}

/** The status the server left the message in, or null if it refused. */
async function reviewMessage(id: number, action: "approve" | "decline", notes?: string): Promise<string | null> {
  const res = await irisFetch(`/api/v1/outreach/messages/${id}/review`, {
    method: "POST",
    body: JSON.stringify({ action, notes: notes ?? null }),
  }, RAICHU)
  if (!res.ok) {
    await handleApiError(res, `${action} message #${id}`)
    return null
  }
  const body = (await res.json().catch(() => ({}))) as any
  return body?.data?.status ?? "unknown"
}

/**
 * What approving did. Approving records the decision and sends nothing (#191987); a server that has not
 * taken that change yet still sends, and only the status it answers with can say which happened.
 */
function approvedLine(id: number, status: string): string {
  return status === "sent"
    ? `Message #${id} approved and sent`
    : `Message #${id} approved. Not sent: ${highlight(`iris outreach approve send ${id}`)}`
}

function timeAgo(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60000)
  if (mins < 60) return `${mins}m ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs}h ago`
  return `${Math.floor(hrs / 24)}d ago`
}

function expiresIn(iso: string | null): string {
  if (!iso) return dim("no expiry")
  const diff = new Date(iso).getTime() - Date.now()
  if (diff <= 0) return "EXPIRED"
  const hrs = Math.floor(diff / 3600000)
  const mins = Math.floor((diff % 3600000) / 60000)
  return hrs > 0 ? `${hrs}h ${mins}m left` : `${mins}m left`
}

// ── LIST ──────────────────────────────────────────────────────
const OutreachApproveListCommand = cmd({
  command: "list",
  aliases: ["ls", "pending"],
  describe: "list pending outreach messages awaiting approval",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    prompts.intro("◈  Pending Approvals")

    const pending = await fetchPending()
    if (pending.length === 0) {
      prompts.log.info(dim("No pending approvals"))
      prompts.outro("Done")
      return
    }

    if (args.json) {
      await writeJson(pending)
      return
    }

    for (const m of pending) {
      const expired = m.is_expired ? " EXPIRED" : ""
      const lead = m.lead ? `${m.lead.nickname} (#${m.lead.id})` : "unknown"
      printDivider()
      console.log(`  ${bold(`#${m.id}`)} → ${m.to_email ?? "no email"}${expired}`)
      printKV("Subject", m.subject)
      printKV("Lead", lead)
      printKV("Created", timeAgo(m.created_at))
      printKV("Expires", expiresIn(m.expires_at))
      printKV("Preview", dim(m.preview))
    }

    console.log()
    prompts.log.info(`${bold(String(pending.length))} pending — approve with: ${highlight("iris outreach approve approve <id>")} or ${highlight("iris outreach approve --all")}. Approving does not send.`)
    prompts.outro("Done")
  },
})

// ── APPROVE ───────────────────────────────────────────────────
const OutreachApproveCommand = cmd({
  command: "approve [id]",
  describe: "approve a pending outreach message (or --all). Records the decision and sends nothing",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", describe: "message ID to approve" })
      .option("all", { type: "boolean", default: false, describe: "approve all pending messages" })
      .option("notes", { type: "string", describe: "approval notes" })
      .option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()

    const approveAll = args.all as boolean
    const messageId = args.id as number | undefined

    if (!approveAll && !messageId) {
      // No args — show pending list instead
      const pending = await fetchPending()
      if (pending.length === 0) {
        prompts.log.info(dim("No pending approvals"))
        return
      }
      prompts.intro(`◈  ${pending.length} Pending Approval${pending.length > 1 ? "s" : ""}`)
      for (const m of pending) {
        const lead = m.lead ? `${m.lead.nickname}` : "?"
        console.log(`  ${bold(`#${m.id}`)} ${m.subject ?? "(no subject)"} → ${m.to_email ?? "?"} (${lead}) ${dim(timeAgo(m.created_at))}`)
      }
      console.log()
      prompts.log.info(`Approve one: ${highlight("iris outreach approve approve <id>")}`)
      prompts.log.info(`Approve all: ${highlight("iris outreach approve --all")}`)
      prompts.outro("Done")
      return
    }

    if (approveAll) {
      prompts.intro("◈  Approve All")
      const pending = await fetchPending()
      const active = pending.filter((m) => !m.is_expired)
      if (active.length === 0) {
        prompts.log.info(dim("No active pending approvals"))
        prompts.outro("Done")
        return
      }

      let approved = 0
      let sent = 0
      for (const m of active) {
        const status = await reviewMessage(m.id, "approve", (args.notes as string) ?? undefined)
        if (status) {
          approved++
          if (status === "sent") sent++
          console.log(`  ${success("✓")} #${m.id} → ${m.to_email ?? "?"} (${m.subject ?? "no subject"})`)
        } else {
          console.log(`  ${dim("✗")} #${m.id} failed`)
        }
      }
      if (approved > sent) prompts.log.info(`${approved - sent} approved and not sent. See them: ${highlight("iris outreach approve approved")}`)
      prompts.outro(`${approved}/${active.length} approved`)
    } else {
      prompts.intro(`◈  Approve #${messageId}`)
      const status = await reviewMessage(messageId!, "approve", (args.notes as string) ?? undefined)
      if (status) {
        prompts.outro(`${success("✓")} ${approvedLine(messageId!, status)}`)
      } else {
        prompts.outro("Failed")
      }
    }
  },
})

// ── DECLINE ───────────────────────────────────────────────────
const OutreachDeclineCommand = cmd({
  command: "decline <id>",
  describe: "decline a pending outreach message",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", demandOption: true })
      .option("reason", { alias: "r", type: "string", describe: "decline reason" }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    const id = args.id as number
    prompts.intro(`◈  Decline #${id}`)
    const status = await reviewMessage(id, "decline", (args.reason as string) ?? undefined)
    if (status) {
      prompts.outro(`${success("✓")} Message #${id} declined`)
    } else {
      prompts.outro("Failed")
    }
  },
})

// ── APPROVED, NOT SENT ───────────────────────────────────────
const OutreachApprovedListCommand = cmd({
  command: "approved",
  describe: "list messages a person approved that have not gone out",
  builder: (yargs) => yargs.option("json", { type: "boolean", default: false }),
  async handler(args) {
    if (!(await requireAuth())) return
    const waiting = await fetchPending("approved")
    if (args.json) {
      await writeJson(waiting)
      return
    }
    UI.empty()
    prompts.intro("◈  Approved, not sent")
    if (waiting.length === 0) {
      prompts.log.info(dim("Nothing waiting"))
      prompts.outro("Done")
      return
    }
    for (const m of waiting) {
      console.log(`  ${bold(`#${m.id}`)} ${m.status}  ${m.subject ?? "(no subject)"} → ${m.to_email ?? "?"}`)
    }
    console.log()
    prompts.log.info(`Send one: ${highlight("iris outreach approve send <id>")}`)
    prompts.log.info(dim("failed: it may have gone out. Check first, then --retry. pre_check: a send stopped midway; check before doing anything."))
    prompts.outro("Done")
  },
})

// ── SEND ──────────────────────────────────────────────────────
const OutreachSendApprovedCommand = cmd({
  command: "send <id>",
  describe: "send one approved message now. This is a real send",
  builder: (yargs) =>
    yargs
      .positional("id", { type: "number", demandOption: true, describe: "message ID" })
      .option("retry", { type: "boolean", default: false, describe: "also send a message whose last send failed. It may already have gone out" }),
  async handler(args) {
    if (!(await requireAuth())) return
    UI.empty()
    const id = args.id as number
    prompts.intro(`◈  Send #${id}`)
    const res = await irisFetch(`/api/v1/outreach/messages/${id}/send`, {
      method: "POST",
      body: JSON.stringify(args.retry ? { retry: true } : {}),
    }, RAICHU)
    if (!res.ok) {
      await handleApiError(res, `send message #${id}`)
      prompts.outro("Not sent")
      return
    }
    prompts.outro(`${success("✓")} Message #${id} sent`)
  },
})

// ── PARENT GROUP ──────────────────────────────────────────────
export const OutreachApproveGroup = cmd({
  command: "approve",
  aliases: ["review"],
  describe: "review and approve pending outreach messages",
  builder: (yargs) =>
    yargs
      .command(OutreachApproveListCommand)
      .command(OutreachApproveCommand)
      .command(OutreachDeclineCommand)
      .command(OutreachApprovedListCommand)
      .command(OutreachSendApprovedCommand)
      .option("all", { type: "boolean", default: false, describe: "approve all pending" })
      .option("id", { type: "number", describe: "message ID" }),
  async handler(args) {
    // Default: if --all or positional id, approve; otherwise list
    if (args.all) {
      return OutreachApproveCommand.handler(args as any)
    }
    return OutreachApproveListCommand.handler(args as any)
  },
})
