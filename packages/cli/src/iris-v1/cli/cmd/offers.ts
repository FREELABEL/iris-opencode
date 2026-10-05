import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, handleApiError, printDivider, dim, writeJson } from "./iris-api"
import { productCommand } from "./product-command"
import { auditOffers, effortModeOf, priceOf, type OfferPackage } from "./offers-audit"

/**
 * `iris reachr offers` — what you are actually selling, before anyone reaches out about it.
 *
 * WHY THIS LIVES UNDER REACHR. Reachr sequences steps toward a lead, but a sequence is only as
 * good as the thing it carries. The acquisition arc is one product with three parts:
 *
 *     offers    what you are selling
 *     list/apply how it reaches somebody
 *     licence   what a yes produces
 *
 * Keeping the offer outside that arc is what let the catalogue drift into a menu nobody audited.
 *
 * WHAT THE AUDIT MEASURES AGAINST. Hormozi's $100M Offers Ch. 9-10 — the Value Equation, the
 * Sales-to-Fulfilment continuum, and the trim/stack pass. Every finding is named with the failure
 * mode the source names, so the output argues rather than asserts. The rules are pure and live in
 * offers-audit.ts; this file only fetches and renders.
 *
 * IT REPORTS WHAT IT COULD NOT MEASURE. Several checks need per-component cost and value that the
 * catalogue does not carry. Those print under "could not measure" with the field that would
 * unlock them, because a short findings list and a blind one look identical otherwise — the
 * distinction this codebase keeps having to relearn.
 */

const PLATFORM_PACKAGES = "/api/v1/platform/packages"

async function fetchPlatformOffers(): Promise<OfferPackage[] | null> {
  const res = await irisFetch(PLATFORM_PACKAGES)
  if (!res.ok) {
    await handleApiError(res, "List packages")
    return null
  }
  const body = (await res.json()) as { data?: OfferPackage[] }
  return body?.data ?? ((body as unknown) as OfferPackage[]) ?? []
}

async function fetchBloqOffers(bloqId: string): Promise<OfferPackage[] | null> {
  const res = await irisFetch(`/api/v1/bloqs/${encodeURIComponent(bloqId)}/service-packages`)
  if (!res.ok) {
    await handleApiError(res, "List service packages")
    return null
  }
  const body = (await res.json()) as { data?: OfferPackage[] }
  return body?.data ?? ((body as unknown) as OfferPackage[]) ?? []
}

const SEVERITY_LABEL: Record<string, string> = {
  high: "HIGH  ",
  medium: "MEDIUM",
  low: "LOW   ",
}

export const OffersAuditCommand = cmd({
  command: "audit",
  describe: "score an offer catalogue against the Value Equation — stack, ladder, anchor, guarantee",
  builder: (y: any) =>
    y
      .option("bloq", { describe: "audit a board's service packages instead of the platform catalogue", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args: any) {
    UI.empty()
    prompts.intro("◈  Offer audit")

    const pkgs = args.bloq ? await fetchBloqOffers(String(args.bloq)) : await fetchPlatformOffers()
    if (!pkgs) return

    // An empty catalogue is a RESULT, not a clean audit. Saying "no findings" over zero packages
    // is the exact instrument failure the checks below exist to name.
    if (pkgs.length === 0) {
      prompts.log.warn(
        args.bloq
          ? `No service packages on board ${args.bloq} — nothing to audit, which is not the same as nothing wrong.`
          : "No packages returned — nothing to audit, which is not the same as nothing wrong.",
      )
      prompts.outro(dim("Add an offer first, then re-run."))
      return
    }

    const audit = auditOffers(pkgs)

    if (args.json) {
      writeJson(audit)
      return
    }

    // ── The ladder, read from the catalogue's own data ────────────────────────
    const byMode = { DFY: [] as string[], DIY: [] as string[], unknown: [] as string[] }
    for (const p of pkgs) byMode[effortModeOf(p)].push(`${p.title} $${priceOf(p) ?? "—"}`)

    printDivider()
    UI.println(`  ${audit.packageCount} package(s)`)
    UI.empty()
    UI.println(dim("  self-serve   ") + (byMode.DIY.length ? `${byMode.DIY.length}` : dim("none")))
    UI.println(dim("  sales-led    ") + (byMode.DFY.length ? `${byMode.DFY.length}` : dim("none")))
    if (byMode.unknown.length) UI.println(dim("  unclassified ") + byMode.unknown.length)
    printDivider()

    for (const f of audit.findings) {
      UI.empty()
      UI.println(`  ${SEVERITY_LABEL[f.severity] ?? f.severity}  ${f.failureMode}`)
      UI.println(dim(`          ${f.what}`))
      UI.println(dim(`          → ${f.fix}`))
      if (f.evidence.length) UI.println(dim(`          ${f.evidence.slice(0, 6).join(" · ")}`))
    }

    if (audit.findings.length === 0) {
      UI.empty()
      UI.println("  Nothing flagged by the checks that could run.")
    }

    // Always printed, even when findings exist. This is the half of the report that stops a short
    // list reading as a good score.
    UI.empty()
    printDivider()
    UI.println(dim("  could not measure"))
    for (const u of audit.unmeasured) {
      UI.println(dim(`    ${u.question}`))
      UI.println(dim(`      blocked by: ${u.blockedBy}`))
    }

    prompts.outro(dim("iris reachr offers audit --json for the machine-readable form"))
  },
})

/** The subcommand group, so `iris reachr offers …` and `iris offers …` are the same thing. */
export const OffersGroup = cmd({
  command: "offers",
  aliases: ["offer"],
  describe: "the offer you are taking to market — audit it before you sequence it",
  builder: (y: any) => y.command(OffersAuditCommand).demandCommand(),
  async handler() {},
})

/**
 * Top-level sibling. Mounted as well as nested, deliberately: someone doing pricing work should
 * not have to know it lives inside the outreach product, and someone inside Reachr should not
 * have to leave it. One definition, two doors.
 */
export const OffersCommand = productCommand({
  name: "offers",
  aliases: ["offer"],
  purpose: "Offers — audit what you are selling: stack, ladder, price anchor, guarantee",
  keywords: ["offer", "offers", "pricing", "package", "stack", "trim", "audit", "value", "ladder"],
  howtos: [],
  playbooks: [],
  builder: (yargs: any) => yargs.command(OffersAuditCommand).demandCommand(),
})
