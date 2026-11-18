/**
 * The list audit, as the CLI shows it (#192095, #192096). The servers decide: fl-iris-api's SendGate
 * for `iris email send` and `iris mailing send`, fl-api's ListAudit for `iris newsroom send`. This
 * module holds what a person sees and the override they type. No I/O except the injected `post`.
 *
 * BULK = a real send to two or more people. A --test and a one-to-one send are never audited here.
 */

export const BULK_MIN = 2

export interface AuditEntry {
  email: string
  status: string
  reason: string
}

export interface AuditReport {
  total: number
  counts?: Record<string, number>
  bounce_risk: number
  flagged: AuditEntry[]
  suppressed?: AuditEntry[]
  unchecked_domains: number
  complete: boolean
  passed: boolean
  unverified: number
  note?: string
}

export interface AuditOverride {
  reason: string
  count?: number
}

/** The flags, shared by every bulk send command. */
export const overrideOptions = {
  "override-audit": { type: "string", describe: "send despite a failed list audit: say why (logged, a person only)" },
  "override-audit-count": { type: "number", describe: "with --override-audit: the flagged count you read" },
} as const

export function isBulk(mode: string, unique: number): boolean {
  return mode === "live" && unique >= BULK_MIN
}

export type OverrideCheck = { ok: true; override?: AuditOverride } | { ok: false; error: string }

/**
 * Read the flags. Not a guarantee on its own (the server checks the reason, the count and the
 * credential), but it stops a script or an agent shell from passing one: an override is a person
 * saying they read the list.
 */
export function readOverride(args: Record<string, unknown>, interactive: boolean): OverrideCheck {
  const raw = args["override-audit"]
  if (raw === undefined || raw === null) return { ok: true }
  const reason = String(raw).trim()
  if (reason === "") return { ok: false, error: "--override-audit needs a reason." }
  if (!interactive) return { ok: false, error: "--override-audit needs a person at a terminal, and there is no one here. Nothing was sent." }
  const count = args["override-audit-count"]
  if (typeof count !== "number" || Number.isNaN(count)) {
    return { ok: false, error: "--override-audit also needs --override-audit-count N: the flagged count you read. Nothing was sent." }
  }
  return { ok: true, override: { reason, count } }
}

/** Every flagged address, with its reason. Never a sample: nothing here is dropped unseen. */
export function auditLines(r: AuditReport): string[] {
  const out = [`List audit: ${r.bounce_risk} of ${r.total} can't receive mail · ${r.unverified} not mailbox-verified`]
  for (const f of r.flagged ?? []) out.push(`  ${f.email}  ${f.status}: ${f.reason}`)
  for (const s of r.suppressed ?? []) out.push(`  ${s.email}  opted out: ${s.reason}`)
  if (r.unchecked_domains > 0) out.push(`  ${r.unchecked_domains} domain(s) could not be checked`)
  if (r.note) out.push(r.note)
  return out
}

export type AuditDecision = { go: true; override?: AuditOverride } | { go: false; code: string; error: string }

export function decide(r: AuditReport, override?: AuditOverride): AuditDecision {
  if ((r.suppressed ?? []).length > 0) {
    return {
      go: false,
      code: "suppressed_recipients",
      error: `${r.suppressed!.length} recipient(s) have opted out of your mail. Take them off the list; this can't be overridden. Nothing was sent.`,
    }
  }
  if (r.passed) return { go: true }
  if (override) return { go: true, override }
  return {
    go: false,
    code: "list_audit_failed",
    error: r.bounce_risk > 0
      ? `Not sent: ${r.bounce_risk} of ${r.total} addresses can't receive mail. Fix the list, or a person overrides: --override-audit "<why>" --override-audit-count ${r.bounce_risk}`
      : `Not sent: the audit could not finish. Try again, or a person overrides: --override-audit "<why>" --override-audit-count 0`,
  }
}

export type AuditFetch = { ok: true; report: AuditReport } | { ok: false; error: string }

/**
 * Ask the server for the audit. Domain answers are remembered there, so a large list finishes
 * across a few asks. A server with no audit endpoint is a refusal: could not check is not a pass.
 */
export async function fetchAudit(
  post: (recipients: string[]) => Promise<{ status: number; body: any }>,
  recipients: string[],
  tries = 3,
): Promise<AuditFetch> {
  for (let i = 0; ; i++) {
    const res = await post(recipients)
    if (res.status === 404) return { ok: false, error: "This server can't audit a list yet, so a bulk send is refused. Nothing was sent." }
    if (res.status < 200 || res.status >= 300) {
      return { ok: false, error: `The list audit failed (${res.body?.message ?? `HTTP ${res.status}`}). Nothing was sent.` }
    }
    const report = res.body?.data as AuditReport
    if (!report || typeof report.passed !== "boolean") return { ok: false, error: "The list audit gave no answer. Nothing was sent." }
    if (report.complete || report.unchecked_domains === 0 || i + 1 >= tries) return { ok: true, report }
  }
}
