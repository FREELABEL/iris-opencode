import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success } from "./iris-api"

// ============================================================================
// iris commons — community / membership management (the flywheel surface).
//
// Wires onto the EXISTING, proven program/enrollment/community endpoints:
//   roster  → GET /api/v1/programs/{id}/enrollments     (enrollments.data[])
//   access  → GET /api/v1/programs/{id}/check-access     (data.hasAccess…)
//   chat    → GET /api/programs/{id}/chat/messages        (data.messages[])
// The 80% (program CRUD, packages, pricing, checkout) lives in `iris programs`;
// commons adds the 20% gap: who's in a community, their roles, and the hub.
// ============================================================================

function roleBadge(role: string): string {
  const r = String(role ?? "member").toLowerCase()
  if (r === "owner") return `${UI.Style.TEXT_DANGER}owner${UI.Style.TEXT_NORMAL}`
  if (r === "admin") return `${UI.Style.TEXT_WARNING}admin${UI.Style.TEXT_NORMAL}`
  if (r === "moderator") return `${UI.Style.TEXT_HIGHLIGHT}moderator${UI.Style.TEXT_NORMAL}`
  return dim("member")
}

function statusBadge(status: string): string {
  const s = String(status ?? "").toUpperCase()
  if (s === "CONFIRMED" || s === "COMPLETED") return `${UI.Style.TEXT_SUCCESS}${s}${UI.Style.TEXT_NORMAL}`
  if (s === "CANCELLED" || s === "ERROR") return `${UI.Style.TEXT_DANGER}${s}${UI.Style.TEXT_NORMAL}`
  if (s === "ENROLLING" || s === "FOLLOWUP") return `${UI.Style.TEXT_WARNING}${s}${UI.Style.TEXT_NORMAL}`
  return dim(s || "-")
}

function ago(dateStr: string | null | undefined): string {
  if (!dateStr) return ""
  const t = new Date(String(dateStr)).getTime()
  if (isNaN(t)) return ""
  const diff = Date.now() - t
  if (diff < 0) return "just now"
  if (diff < 3600_000) return `${Math.round(diff / 60_000)}m ago`
  if (diff < 86400_000) return `${Math.round(diff / 3600_000)}h ago`
  return `${Math.round(diff / 86400_000)}d ago`
}

// ── members (roster) ──

const MembersCmd = cmd({
  command: "members <program-id>",
  aliases: ["roster"],
  describe: "list a program's members with roles + enrollment status",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .option("role", { describe: "filter by role (owner/admin/moderator/member)", type: "string" })
      .option("all", { describe: "include cancelled/inactive enrollments", type: "boolean", default: false })
      .option("limit", { describe: "results per page", type: "number", default: 100 })
      .option("page", { describe: "page number", type: "number", default: 1 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pid = args["program-id"]
    UI.empty()
    prompts.intro(`◈  Commons — members of program #${pid}`)

    const sp = prompts.spinner()
    sp.start("Loading members…")
    try {
      const params = new URLSearchParams({ per_page: String(args.limit), page: String(args.page) })
      const res = await irisFetch(`/api/v1/programs/${pid}/enrollments?${params.toString()}`)
      if (!(await handleApiError(res, "List members"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const json = (await res.json()) as any

      // Response shape: { enrollments: { current_page, last_page, total, data: [...] } }
      const env = json?.enrollments ?? json?.data ?? json
      let rows: any[] = Array.isArray(env) ? env : (Array.isArray(env?.data) ? env.data : [])
      const total = env?.total ?? rows.length
      const lastPage = env?.last_page ?? 1
      const currentPage = env?.current_page ?? args.page ?? 1

      // Default to ACTIVE members — a "who's in my community" roster shouldn't be
      // padded with cancelled/errored former members. --all includes them.
      const inactive = new Set(["CANCELLED", "ERROR"])
      let hiddenInactive = 0
      if (!args.all) {
        const before = rows.length
        rows = rows.filter((r: any) => !inactive.has(String(r.status ?? "").toUpperCase()))
        hiddenInactive = before - rows.length
      }
      if (args.role) {
        const want = String(args.role).toLowerCase()
        rows = rows.filter((r: any) => String(r.role ?? "member").toLowerCase() === want)
      }

      const inactiveNote = hiddenInactive > 0 ? ` (${hiddenInactive} inactive hidden — --all)` : ""
      sp.stop(`${rows.length} of ${total} member(s)${inactiveNote}${lastPage > 1 ? ` — page ${currentPage}/${lastPage}` : ""}`)

      if (args.json) {
        console.log(JSON.stringify(rows.map((r: any) => ({
          enrollment_id: r.id, user_id: r.user_id, email: r.email ?? r.user?.email,
          name: r.user?.user_name ?? r.user?.name, role: r.role ?? "member", status: r.status,
          enrolled_at: r.created_at,
        })), null, 2))
        prompts.outro("Done")
        return
      }

      if (rows.length === 0) {
        prompts.log.warn(args.role ? `No ${args.role}s in program #${pid}` : "No members found")
        prompts.outro("Done")
        return
      }

      // Role distribution summary
      const dist: Record<string, number> = {}
      for (const r of rows) { const k = String(r.role ?? "member").toLowerCase(); dist[k] = (dist[k] ?? 0) + 1 }
      const distStr = Object.entries(dist).map(([k, v]) => `${v} ${k}`).join(" · ")

      printDivider()
      for (const r of rows) {
        const who = r.user?.user_name ?? r.email ?? r.user?.email ?? `user #${r.user_id}`
        console.log(`  ${roleBadge(r.role).padEnd(20)}  ${statusBadge(r.status).padEnd(22)}  ${bold(String(who).slice(0, 40))}`)
        const sub = [r.email && r.email !== who ? r.email : "", r.created_at ? `joined ${ago(r.created_at)}` : ""].filter(Boolean).join("  ·  ")
        if (sub) console.log(`        ${dim(sub)}`)
      }
      printDivider()
      console.log(`  ${dim(distStr)}`)
      const hints = ["iris commons access <program-id> <user-id>", "iris commons chat <program-id>"]
      if (currentPage < lastPage) hints.unshift(`iris commons members ${pid} --page ${currentPage + 1}`)
      prompts.outro(dim(hints.join("  ·  ")))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── access (audit one user's access to a program) ──

const AccessCmd = cmd({
  command: "access <program-id> <user-id>",
  describe: "check whether a user has access to a program (and why)",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .positional("user-id", { describe: "user ID", type: "number", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pid = args["program-id"]
    const uid = args["user-id"]
    const res = await irisFetch(`/api/v1/programs/${pid}/check-access?user_id=${uid}`)
    if (!(await handleApiError(res, "Check access"))) return
    const json = (await res.json()) as any
    const d = json?.data ?? json

    if (args.json) { console.log(JSON.stringify(d, null, 2)); return }

    console.log("")
    const has = d?.hasAccess
    console.log(bold(`Program #${pid} · user #${uid}`) + `  ${has ? `${UI.Style.TEXT_SUCCESS}✓ access${UI.Style.TEXT_NORMAL}` : `${UI.Style.TEXT_DANGER}✗ no access${UI.Style.TEXT_NORMAL}`}`)
    printDivider()
    printKV("Reason", d?.reason ?? "-")
    printKV("Owner", d?.isOwner ? "yes" : "no")
    printKV("Enrolled", d?.isEnrolled ? "yes" : "no")
    printKV("Enrollment status", d?.enrollmentStatus ?? "-")
    printDivider()
  },
})

// ── chat (read the community hub) ──

const ChatCmd = cmd({
  command: "chat <program-id>",
  aliases: ["messages"],
  describe: "read recent community hub messages for a program",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .option("channel", { describe: "filter to a channel slug", type: "string" })
      .option("limit", { describe: "messages to show", type: "number", default: 30 })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pid = args["program-id"]
    UI.empty()
    prompts.intro(`◈  Commons — chat for program #${pid}`)

    const sp = prompts.spinner()
    sp.start("Loading messages…")
    try {
      const params = new URLSearchParams({ per_page: String(args.limit) })
      if (args.channel) params.set("channel", String(args.channel))
      const res = await irisFetch(`/api/programs/${pid}/chat/messages?${params.toString()}`)
      if (!(await handleApiError(res, "Read chat"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const json = (await res.json()) as any

      // Response shape: { success, data: { messages: [...], pagination: {...} } }
      const d = json?.data ?? json
      const messages: any[] = Array.isArray(d?.messages) ? d.messages : (Array.isArray(d) ? d : [])
      const total = d?.pagination?.total ?? messages.length

      sp.stop(`${messages.length} message(s)${total > messages.length ? ` of ${total}` : ""}`)

      if (args.json) { console.log(JSON.stringify(messages, null, 2)); prompts.outro("Done"); return }

      if (messages.length === 0) {
        prompts.log.warn(args.channel ? `No messages in #${args.channel}` : "No messages yet in this community")
        prompts.outro("Done")
        return
      }

      printDivider()
      // Show oldest→newest for readability
      for (const m of [...messages].reverse()) {
        const who = m.user?.user_name ?? m.user?.name ?? `user #${m.user_id}`
        const chan = m.channel ? dim(`#${m.channel}`) : ""
        const pin = m.is_pinned ? `${UI.Style.TEXT_WARNING}📌${UI.Style.TEXT_NORMAL}` : ""
        console.log(`  ${bold(String(who).slice(0, 24))}  ${chan}  ${dim(ago(m.created_at))} ${pin}`)
        console.log(`    ${String(m.content ?? "").replace(/\n/g, " ").slice(0, 100)}`)
        const reactions = m.reactions && typeof m.reactions === "object" ? Object.entries(m.reactions) : []
        if (reactions.length) console.log(`    ${dim(reactions.map(([e, u]: any) => `${e} ${Array.isArray(u) ? u.length : u}`).join("  "))}`)
      }
      printDivider()
      prompts.outro(dim("iris commons members <program-id>"))
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

// ── add (enroll a member) ──

const AddCmd = cmd({
  command: "add <program-id> <email>",
  aliases: ["enroll"],
  describe: "enroll a member in a program by email",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .positional("email", { describe: "member email", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pid = args["program-id"]
    const email = String(args.email)
    const res = await irisFetch(`/api/v1/programs/enroll`, {
      method: "POST",
      body: JSON.stringify({ program_id: pid, email }),
    })
    if (!(await handleApiError(res, "Enroll member"))) return
    const json = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(json?.data ?? json, null, 2)); return }
    const e = json?.data ?? json?.enrollment ?? json
    console.log("")
    console.log(`${success("✓")} Enrolled ${bold(email)} in program #${pid}`)
    printKV("Enrollment ID", e?.id ?? "-")
    printKV("Status", e?.status ?? "-")
    printKV("Role", e?.role ?? "member")
    console.log(dim(`  iris commons members ${pid}  ·  iris commons remove ${pid} ${e?.id ?? "<enrollment-id>"}`))
  },
})

// ── remove (cancel an enrollment) ──

async function resolveEnrollmentId(pid: number, idOrEmail: string): Promise<{ id: number; who: string } | null> {
  // Accept a raw enrollment id, OR resolve a user_id / email against the roster.
  const res = await irisFetch(`/api/v1/programs/${pid}/enrollments?per_page=500`)
  if (!res.ok) return null
  const json = (await res.json()) as any
  const env = json?.enrollments ?? json?.data ?? json
  const rows: any[] = Array.isArray(env) ? env : (Array.isArray(env?.data) ? env.data : [])
  const needle = String(idOrEmail).toLowerCase()
  const match = rows.find((r: any) =>
    String(r.id) === needle ||
    String(r.user_id) === needle ||
    String(r.email ?? "").toLowerCase() === needle ||
    String(r.user?.email ?? "").toLowerCase() === needle)
  if (!match) return null
  return { id: match.id, who: match.email ?? match.user?.user_name ?? `user #${match.user_id}` }
}

const RemoveCmd = cmd({
  command: "remove <program-id> <member>",
  aliases: ["unenroll", "kick"],
  describe: "remove a member (by enrollment id, user id, or email)",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .positional("member", { describe: "enrollment id, user id, or email", type: "string", demandOption: true })
      .option("yes", { describe: "skip confirmation", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pid = args["program-id"]
    const resolved = await resolveEnrollmentId(pid, String(args.member))
    if (!resolved) { prompts.log.error(`No enrollment found for "${args.member}" in program #${pid}`); process.exitCode = 1; return }

    if (!args.yes) {
      const ok = await prompts.confirm({ message: `Remove ${resolved.who} (enrollment #${resolved.id}) from program #${pid}?` })
      if (!ok || prompts.isCancel(ok)) { prompts.log.info("Cancelled"); return }
    }
    const res = await irisFetch(`/api/v1/enrollments/cancel`, {
      method: "POST",
      body: JSON.stringify({ enrollment_id: resolved.id }),
    })
    if (!(await handleApiError(res, "Remove member"))) return
    const json = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(json?.data ?? json, null, 2)); return }
    console.log(`${success("✓")} Removed ${bold(resolved.who)} (enrollment #${resolved.id}) from program #${pid}`)
  },
})

// ── announce (email members; preview-gated for safety) ──

const AnnounceCmd = cmd({
  command: "announce <program-id>",
  describe: "send an announcement to a program's members (previews unless --send)",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .option("subject", { describe: "announcement subject", type: "string", demandOption: true })
      .option("body", { describe: "announcement body", type: "string", demandOption: true })
      .option("send", { describe: "actually send (default is preview only)", type: "boolean", default: false })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pid = args["program-id"]
    const payload = JSON.stringify({ subject: String(args.subject), body: String(args.body) })

    // Default to a PREVIEW — never email members unless --send is explicit + confirmed.
    if (!args.send) {
      const res = await irisFetch(`/api/v1/programs/${pid}/announcements/preview`, { method: "POST", body: payload })
      if (!(await handleApiError(res, "Preview announcement"))) return
      const json = (await res.json()) as any
      if (args.json) { console.log(JSON.stringify(json?.data ?? json, null, 2)); return }
      const d = json?.data ?? json
      console.log("")
      console.log(`${dim("PREVIEW (not sent)")}  program #${pid}`)
      printDivider()
      printKV("Subject", d?.subject ?? args.subject)
      console.log(dim(String(d?.html ?? d?.body ?? args.body).replace(/<[^>]+>/g, "").slice(0, 400)))
      printDivider()
      console.log(dim(`Re-run with --send to email members: iris commons announce ${pid} --subject "…" --body "…" --send`))
      return
    }

    const ok = await prompts.confirm({ message: `EMAIL all members of program #${pid} with subject "${args.subject}"?` })
    if (!ok || prompts.isCancel(ok)) { prompts.log.info("Cancelled"); return }
    const res = await irisFetch(`/api/v1/programs/${pid}/announcements`, { method: "POST", body: payload })
    if (!(await handleApiError(res, "Send announcement"))) return
    const json = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(json?.data ?? json, null, 2)); return }
    const d = json?.data ?? json
    console.log(`${success("✓")} Announcement sent to program #${pid}` + (d?.recipients ? ` (${d.recipients} recipients)` : ""))
  },
})

// ── role (promote/demote a member) ──

const ROLES = ["owner", "admin", "moderator", "member"]

const RoleCmd = cmd({
  command: "role <program-id> <member> <role>",
  describe: "set a member's role (owner/admin/moderator/member)",
  builder: (yargs) =>
    yargs
      .positional("program-id", { describe: "program ID", type: "number", demandOption: true })
      .positional("member", { describe: "enrollment id, user id, or email", type: "string", demandOption: true })
      .positional("role", { describe: "owner | admin | moderator | member", type: "string", demandOption: true })
      .option("json", { describe: "JSON output", type: "boolean" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pid = args["program-id"]
    const role = String(args.role).toLowerCase()
    if (!ROLES.includes(role)) { prompts.log.error(`Invalid role "${args.role}" — use one of: ${ROLES.join(", ")}`); process.exitCode = 1; return }

    const resolved = await resolveEnrollmentId(pid, String(args.member))
    if (!resolved) { prompts.log.error(`No enrollment found for "${args.member}" in program #${pid}`); process.exitCode = 1; return }

    const res = await irisFetch(`/api/v1/enrollments/role`, {
      method: "POST",
      body: JSON.stringify({ enrollment_id: resolved.id, role }),
    })
    if (!(await handleApiError(res, "Set role"))) return
    const json = (await res.json()) as any
    if (args.json) { console.log(JSON.stringify(json?.data ?? json, null, 2)); return }
    const d = json?.data ?? json
    console.log(`${success("✓")} ${bold(resolved.who)} → ${roleBadge(d?.role ?? role)}` + (d?.previous_role ? dim(` (was ${d.previous_role})`) : ""))
  },
})

export const PlatformCommonsCommand = cmd({
  command: "commons",
  aliases: ["membership"],
  describe: "community & membership management — members, access, community hub",
  builder: (yargs) =>
    yargs
      .command(MembersCmd)
      .command(AccessCmd)
      .command(ChatCmd)
      .command(AddCmd)
      .command(RemoveCmd)
      .command(RoleCmd)
      .command(AnnounceCmd)
      .demandCommand(),
  async handler() {},
})
