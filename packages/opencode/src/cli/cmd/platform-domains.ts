import { promises as dnsPromises } from "node:dns"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, IRIS_API, FL_API, writeJson } from "./iris-api"
import { firstArray } from "../../util/array"

// ============================================================================
// Domains CLI — connect, verify, list, and remove custom client domains
//
// Architecture:
//   iris-api  /api/v1/domains/*            — DNS setup (Cloudflare/GoDaddy) + mapping orchestration
//   fl-api    /api/v1/domain-mappings/*     — mapping storage (domain → page/site)
//
// Flow: `iris domains connect moodybeauty.co --page moodybeauty`
//   1. iris-api sets up DNS (CNAME → Railway, Worker route if Cloudflare)
//   2. iris-api creates DomainMapping in fl-api
//   3. Cloudflare Worker proxies requests → iris-api reads X-Forwarded-Host → resolves mapping
// ============================================================================

function statusBadge(status: string): string {
  if (status === "active") return success("● Active")
  if (status === "pending_verification") return `${UI.Style.TEXT_WARNING}◌ Pending DNS${UI.Style.TEXT_NORMAL}`
  if (status === "inactive") return dim("○ Inactive")
  return status
}

function providerBadge(provider: string): string {
  if (provider === "cloudflare") return highlight("CF")
  if (provider === "godaddy") return highlight("GD")
  return provider
}

// ----------------------------------------------------------------------------
// DNS provider auto-detection (#156550)
//
// Look up the domain's nameservers and map them to a supported DNS provider so the
// user doesn't have to eyeball their registrar and pass --provider manually. Uses
// Node's built-in dns module (no new deps).
// ----------------------------------------------------------------------------
type DetectResult = { provider: "cloudflare" | "godaddy" | null; nameservers: string[]; error?: string }

async function detectDnsProvider(domain: string): Promise<DetectResult> {
  try {
    const ns = (await dnsPromises.resolveNs(domain)).map((n) => n.toLowerCase())
    let provider: DetectResult["provider"] = null
    if (ns.some((n) => n.endsWith(".ns.cloudflare.com") || n.includes("cloudflare"))) {
      provider = "cloudflare"
    } else if (ns.some((n) => n.includes("domaincontrol.com") || n.includes("godaddy"))) {
      provider = "godaddy"
    }
    return { provider, nameservers: ns }
  } catch (e: any) {
    const code = e?.code
    const msg =
      code === "ENOTFOUND" || code === "ENODATA"
        ? "No NS records found — the domain may be unregistered or not yet delegated"
        : (e?.message ?? String(e))
    return { provider: null, nameservers: [], error: msg }
  }
}

// Manual DNS fallback shown when NS points at an unsupported registrar.
function printManualDnsFallback(domain: string): void {
  prompts.log.warn("Auto-provisioning may not apply to this registrar — add these records manually:")
  console.log(`    ${dim("CNAME")}  ${bold("@")}    → ${highlight("sites.heyiris.io")}`)
  console.log(`    ${dim("CNAME")}  ${bold("www")}  → ${highlight("sites.heyiris.io")}`)
  prompts.log.info(`Or switch your nameservers to Cloudflare, then run: ${dim(`iris domains verify ${domain}`)}`)
}

// ----------------------------------------------------------------------------
// domains list
// ----------------------------------------------------------------------------
const DomainsListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list all connected custom domains",
  builder: (yargs) =>
    yargs
      .option("provider", { describe: "filter by provider (cloudflare|godaddy|all)", type: "string", default: "all" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Custom Domains")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Loading domains…")
    try {
      const params = new URLSearchParams()
      if (args.provider && args.provider !== "all") params.set("provider", String(args.provider))

      const res = await irisFetch(`/api/v1/domains?${params}`, {}, IRIS_API)
      if (!res.ok) {
        sp.stop("Failed", 1)
        // #156549: distinguish a server-side 500 (backend/provider down) from an auth/permission
        // failure. handleApiError already special-cases 401/403; add a hint for 5xx so the user
        // knows it's the API/DNS-provider side, not their credentials.
        await handleApiError(res, "List domains")
        if (res.status >= 500) {
          prompts.log.warn("The domains API returned a server error — a DNS provider (Cloudflare/GoDaddy) may be unreachable or missing credentials.")
          prompts.log.info(`Check the iris-api logs: ${dim("railway logs -s fl-iris-api")}`)
        }
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as any
      const domains: any[] = firstArray(data?.domains)
      const warnings: string[] = Array.isArray(data?.warnings) ? data.warnings : []
      sp.stop(`${domains.length} domain(s)`)

      // Non-fatal per-provider warnings (e.g. one provider down while the other returned data).
      for (const w of warnings) {
        prompts.log.warn(String(w))
      }

      if (args.json) {
        await writeJson(domains)
        prompts.outro("Done")
        return
      }

      if (domains.length === 0) {
        prompts.log.warn("No custom domains connected")
        prompts.log.info(`Connect one: ${dim("iris domains connect <domain> --page <slug>")}`)
        prompts.outro("Done")
        return
      }

      for (const d of domains) {
        printDivider()
        const name = bold(d.domain ?? d.name ?? "unknown")
        const prov = providerBadge(d.provider ?? "unknown")
        const status = d.status ? statusBadge(d.status) : ""
        console.log(`  ${name}  ${prov}  ${status}`)
        if (d.zone_id) printKV("Zone ID", dim(d.zone_id))
        if (d.nameservers) printKV("Nameservers", dim(d.nameservers.join(", ")))
      }

      // Also show fl-api domain mappings for richer context
      const mappingsRes = await irisFetch("/api/v1/domain-mappings", {}, FL_API)
      if (mappingsRes.ok) {
        const mappingsData = (await mappingsRes.json()) as any
        const mappings: any[] = firstArray(mappingsData?.data)
        const clientMappings = mappings.filter((m: any) => !m.is_internal)
        if (clientMappings.length > 0) {
          printDivider()
          console.log(`\n  ${bold("Domain Mappings")} ${dim("(fl-api)")}`)
          for (const m of clientMappings) {
            const target = m.page?.slug ? `/p/${m.page.slug}` : m.site?.slug ? `/s/${m.site.slug}` : dim("no target")
            const st = statusBadge(m.status ?? "unknown")
            const dns = m.dns_verified ? success("DNS ✓") : dim("DNS pending")
            console.log(`    ${bold(m.domain)}  →  ${target}  ${st}  ${dns}`)
          }
        }
      }

      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// domains connect
// ----------------------------------------------------------------------------
const DomainsConnectCommand = cmd({
  command: "connect <domain>",
  describe: "connect a custom domain to a page or site",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain to connect (e.g., moodybeauty.co)", type: "string", demandOption: true })
      .option("page", { describe: "page slug to serve on this domain", type: "string" })
      .option("page-id", { describe: "page ID to serve", type: "number" })
      .option("site", { describe: "site slug to serve", type: "string" })
      .option("site-id", { describe: "site ID to serve", type: "number" })
      .option("provider", { describe: "DNS provider: cloudflare | godaddy (default: auto-detect from nameservers)", type: "string" })
      .option("yes", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false })
      .check((argv) => {
        if (!argv.page && !argv["page-id"] && !argv.site && !argv["site-id"]) {
          throw new Error("Provide at least one target: --page <slug>, --page-id <id>, --site <slug>, or --site-id <id>")
        }
        return true
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Connect Domain")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const domain = String(args.domain).toLowerCase().trim()

    // Provider: honor an explicit --provider, otherwise auto-detect from the domain's
    // nameservers so the user doesn't have to look it up at their registrar. (#156550)
    let provider = args.provider ? String(args.provider) : ""
    let unsupportedNs = false
    if (!provider) {
      const dsp = prompts.spinner()
      dsp.start("Detecting DNS provider…")
      const detected = await detectDnsProvider(domain)
      if (detected.provider) {
        provider = detected.provider
        dsp.stop(`Detected provider: ${providerBadge(provider)} ${dim(`(${detected.nameservers.join(", ")})`)}`)
      } else {
        // Unknown/unsupported registrar — default to a Cloudflare zone (universal: the user
        // switches nameservers to CF) but flag it and print the manual fallback records.
        provider = "cloudflare"
        unsupportedNs = true
        if (detected.error) {
          dsp.stop(dim(`Could not detect provider — ${detected.error}`))
        } else {
          dsp.stop(dim(`Unsupported nameservers: ${detected.nameservers.join(", ") || "none"}`))
        }
        prompts.log.warn(`No supported provider auto-detected — defaulting to ${providerBadge("cloudflare")} (you'll switch nameservers to Cloudflare)`)
        printManualDnsFallback(domain)
      }
    }

    // If page slug provided, resolve to page_id first
    let pageId = args["page-id"] as number | undefined
    let pageSlug = args.page as string | undefined
    let siteId = args["site-id"] as number | undefined
    let siteSlug = args.site as string | undefined

    if (pageSlug && !pageId) {
      const sp = prompts.spinner()
      sp.start(`Resolving page "${pageSlug}"…`)
      const pageRes = await irisFetch(`/api/v1/pages/by-slug/${encodeURIComponent(pageSlug)}?include_drafts=1`, {}, IRIS_API)
      if (!pageRes.ok) {
        sp.stop("Page not found")
        prompts.log.error(`Page "${pageSlug}" not found. Create it first: ${dim(`iris pages create ${pageSlug}`)}`)
        prompts.outro("Done")
        return
      }
      const pageData = (await pageRes.json()) as any
      const page = pageData?.data ?? pageData
      pageId = page?.id
      sp.stop(`Found page: ${bold(page?.title ?? pageSlug)} (#${pageId})`)
    }

    // Confirm before proceeding (skip with --yes)
    if (!args.yes) {
      const confirm = await prompts.confirm({
        message: `Connect ${bold(domain)} → ${pageSlug ? `/p/${pageSlug}` : siteSlug ? `/s/${siteSlug}` : `#${pageId ?? siteId}`} via ${provider}?`,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    const sp = prompts.spinner()
    sp.start(`Setting up DNS via ${provider}…`)
    try {
      const body: Record<string, unknown> = { domain, provider }
      if (pageId) body.page_id = pageId
      if (pageSlug) body.page_slug = pageSlug
      if (siteId) body.site_id = siteId
      if (siteSlug) body.site_slug = siteSlug

      const res = await irisFetch("/api/v1/domains/connect", {
        method: "POST",
        body: JSON.stringify(body),
      }, IRIS_API)

      const result = (await res.json().catch(() => ({}))) as any

      if (!res.ok) {
        // A non-2xx here means the page BINDING failed (fl-api unreachable / mapping error),
        // not merely DNS — #157538 makes DNS failures return 200 with dns_ok=false so the page
        // still binds. Surface the real cause.
        sp.stop("Failed")
        prompts.log.error(`Connect failed: ${result?.mapping_error ?? result?.error ?? result?.message ?? res.statusText}`)
        if (result?.dns_error) prompts.log.warn(`  DNS: ${result.dns_error}`)
        if (result?.details) {
          for (const d of Array.isArray(result.details) ? result.details : [result.details]) {
            prompts.log.warn(`  ${String(d)}`)
          }
        }
        prompts.log.info(`Retry (idempotent): ${dim(`iris domains connect ${domain}${pageSlug ? ` --page ${pageSlug}` : ""}`)}`)
        prompts.outro("Done")
        return
      }

      // Page binding is the primary success condition (#157538): DNS may still be pending.
      const dnsOk = result?.dns_ok !== false
      sp.stop(dnsOk ? success("Domain connected") : success("Page bound (DNS pending)"))

      printDivider()
      printKV("Domain", bold(result.domain))
      printKV("Provider", providerBadge(result.provider))
      printKV("Page bound", result.page_bound ? success("Yes") : dim("No"))
      printKV("Status", statusBadge(result.status ?? "pending_verification"))

      if (result.domain_mapping?.id) printKV("Mapping ID", dim(`#${result.domain_mapping.id}`))
      if (result.zone_id) printKV("Zone ID", dim(result.zone_id))
      if (result.nameservers) {
        printKV("Nameservers", "")
        for (const ns of result.nameservers) {
          console.log(`    ${highlight(ns)}`)
        }
      }
      if (result.dns) {
        printKV("DNS Records", "")
        for (const rec of Array.isArray(result.dns) ? result.dns : [result.dns]) {
          console.log(`    ${dim(JSON.stringify(rec))}`)
        }
      }

      // DNS failed but the page is still bound — say so explicitly (the #157538 fix). (#157538)
      if (!dnsOk) {
        printDivider()
        prompts.log.warn(`DNS provisioning did not complete${result.dns_step ? ` (step: ${result.dns_step})` : ""} — the page is bound and will serve once DNS resolves.`)
        if (result.dns_error) prompts.log.warn(`  ${result.dns_error}`)
        if (unsupportedNs) printManualDnsFallback(domain)
      }

      if (result.next_step) {
        printDivider()
        prompts.log.info(result.next_step)
      }

      // Auto-verify (ask 4 / #157536) — only when DNS actually provisioned; pointless if it failed.
      if (provider === "cloudflare" && dnsOk) {
        const vsp = prompts.spinner()
        vsp.start("Verifying DNS…")
        try {
          const vres = await irisFetch("/api/v1/domains/verify", {
            method: "POST",
            body: JSON.stringify({ domain, provider }),
          }, IRIS_API)
          const vjson = (await vres.json().catch(() => ({}))) as any
          if (vres.ok && vjson?.propagated) {
            vsp.stop(success("DNS Verified"))
          } else {
            vsp.stop(dim(`DNS not propagated yet${vjson?.message ? ` — ${vjson.message}` : ""}`))
          }
        } catch {
          vsp.stop(dim("DNS verify skipped"))
        }
      }

      // Provider-specific instructions (only when DNS provisioned).
      if (dnsOk && provider === "cloudflare" && result.nameservers) {
        printDivider()
        prompts.log.warn("Next: Update nameservers at your registrar to the ones above")
        prompts.log.info(`Then verify: ${dim(`iris domains verify ${domain}`)}`)
      } else if (dnsOk && provider === "godaddy") {
        printDivider()
        prompts.log.success("GoDaddy CNAME set — domain should be active within minutes")
        prompts.log.info(`Verify: ${dim(`iris domains verify ${domain}`)}`)
      }

      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// domains verify
// ----------------------------------------------------------------------------
const DomainsVerifyCommand = cmd({
  command: "verify <domain>",
  describe: "check DNS propagation for a connected domain",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain to verify", type: "string", demandOption: true })
      .option("provider", { describe: "DNS provider", type: "string", default: "cloudflare" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Verify Domain DNS")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const domain = String(args.domain).toLowerCase().trim()
    const provider = String(args.provider ?? "cloudflare")

    const sp = prompts.spinner()
    sp.start(`Checking DNS for ${domain}…`)
    try {
      const res = await irisFetch("/api/v1/domains/verify", {
        method: "POST",
        body: JSON.stringify({ domain, provider }),
      }, IRIS_API)

      if (!res.ok) {
        await handleApiError(res, "Verify domain")
        sp.stop("Failed")
        prompts.outro("Done")
        return
      }

      const result = (await res.json()) as any
      if (result.propagated) {
        sp.stop(success("DNS verified"))
        prompts.log.success(`${bold(domain)} is resolving correctly`)
        if (result.records) {
          for (const r of result.records) {
            printKV("Record", `${r.type} → ${r.target ?? r.value}`)
          }
        }
      } else {
        sp.stop("Not propagated yet")
        prompts.log.warn(`DNS for ${bold(domain)} has not propagated yet`)
        if (result.expected) {
          prompts.log.info(`Expected: ${dim(JSON.stringify(result.expected))}`)
        }
        if (result.actual) {
          prompts.log.info(`Found: ${dim(JSON.stringify(result.actual))}`)
        }
        prompts.log.info("DNS propagation can take up to 48 hours. Try again later.")
      }

      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// domains remove
// ----------------------------------------------------------------------------
const DomainsRemoveCommand = cmd({
  command: "remove <domain>",
  aliases: ["rm", "disconnect", "delete"],
  describe: "disconnect a custom domain and remove DNS records",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain to remove", type: "string", demandOption: true })
      .option("yes", { alias: "y", describe: "skip confirmation prompt", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Remove Domain")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const domain = String(args.domain).toLowerCase().trim()

    // Find the zone ID first
    const sp = prompts.spinner()
    sp.start(`Looking up ${domain}…`)
    try {
      const listRes = await irisFetch(`/api/v1/domains?provider=all`, {}, IRIS_API)
      if (!listRes.ok) {
        await handleApiError(listRes, "List domains")
        sp.stop("Failed")
        prompts.outro("Done")
        return
      }

      const listData = (await listRes.json()) as any
      const domains: any[] = firstArray(listData?.domains)
      const match = domains.find((d: any) => (d.domain ?? d.name) === domain)

      if (!match) {
        sp.stop("Not found")
        prompts.log.error(`Domain "${domain}" is not connected`)
        prompts.outro("Done")
        return
      }

      sp.stop(`Found: ${bold(domain)} (${providerBadge(match.provider)})`)

      if (!args.yes) {
        const confirm = await prompts.confirm({
          message: `Remove ${bold(domain)}? This will delete DNS records and the domain mapping.`,
        })
        if (!confirm || prompts.isCancel(confirm)) {
          prompts.outro("Cancelled")
          return
        }
      }

      const sp2 = prompts.spinner()
      sp2.start("Removing domain…")

      const zoneId = match.zone_id ?? match.id
      const res = await irisFetch(`/api/v1/domains/${encodeURIComponent(zoneId)}`, {
        method: "DELETE",
        body: JSON.stringify({ domain }),
      }, IRIS_API)

      if (!res.ok) {
        await handleApiError(res, "Remove domain")
        sp2.stop("Failed")
        prompts.outro("Done")
        return
      }

      sp2.stop(success("Domain removed"))
      prompts.log.success(`${bold(domain)} has been disconnected`)
      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// domains status (quick check — resolves domain via fl-api + HTTP probe)
// ----------------------------------------------------------------------------
const DomainsStatusCommand = cmd({
  command: "status <domain>",
  aliases: ["check"],
  describe: "check resolution status for a domain (DNS + mapping + HTTP)",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain to check", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Domain Status")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const domain = String(args.domain).toLowerCase().trim()

    const sp = prompts.spinner()
    sp.start(`Checking ${domain}…`)
    try {
      // 1. Check fl-api mapping
      const mappingRes = await irisFetch(`/api/v1/domain-mappings/resolve/${encodeURIComponent(domain)}`, {}, FL_API)
      const mappingOk = mappingRes.ok
      const mappingData = mappingOk ? ((await mappingRes.json()) as any)?.data : null

      // 2. HTTP probe
      let httpStatus = 0
      let httpProxy = ""
      try {
        const probe = await fetch(`https://${domain}`, {
          method: "HEAD",
          redirect: "follow",
          signal: AbortSignal.timeout(10000),
        })
        httpStatus = probe.status
        httpProxy = probe.headers.get("x-proxied-by") ?? ""
      } catch {}

      sp.stop("Done")

      printDivider()
      printKV("Domain", bold(domain))

      // Mapping status
      if (mappingData) {
        printKV("Mapping", success("Found"))
        printKV("  Type", mappingData.mapping_type ?? "—")
        if (mappingData.page_slug) printKV("  Page", highlight(`/p/${mappingData.page_slug}`))
        if (mappingData.site_slug) printKV("  Site", highlight(`/s/${mappingData.site_slug}`))
        printKV("  Status", statusBadge(mappingData.status ?? "unknown"))
        printKV("  DNS Verified", mappingData.dns_verified ? success("Yes") : dim("No"))
      } else {
        printKV("Mapping", `${UI.Style.TEXT_WARNING}Not found${UI.Style.TEXT_NORMAL}`)
        prompts.log.warn(`No domain mapping exists. Create one: ${dim(`iris domains connect ${domain} --page <slug>`)}`)
      }

      // HTTP probe
      printDivider()
      if (httpStatus >= 200 && httpStatus < 400) {
        printKV("HTTP", success(`${httpStatus} OK`))
      } else if (httpStatus > 0) {
        printKV("HTTP", `${UI.Style.TEXT_WARNING}${httpStatus}${UI.Style.TEXT_NORMAL}`)
      } else {
        printKV("HTTP", dim("unreachable"))
      }
      if (httpProxy) {
        printKV("Proxy", highlight(httpProxy))
      }

      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// domains assign — bind a page/site to a domain mapping WITHOUT touching DNS (#157538)
//
// The only pre-existing way to point a domain at a page was `connect`, which used to
// 500 at the Cloudflare DNS step *before* persisting the page assignment — so the
// mapping never bound (the domain kept serving the hardcoded fallback). `assign` updates
// only the mapping (mirrors the server-side `php artisan domain:assign`), so a page binds
// even when DNS is broken/pending. Works on INTERNAL mappings too, and is idempotent
// (creates the mapping if one doesn't exist yet).
// ----------------------------------------------------------------------------
const DomainsAssignCommand = cmd({
  command: "assign <domain>",
  describe: "bind a page/site to a domain mapping (no DNS changes — works even when DNS fails)",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain whose mapping to update (e.g. noys.io)", type: "string", demandOption: true })
      .option("page", { describe: "page slug to serve on this domain", type: "string" })
      .option("page-id", { describe: "page ID to serve", type: "number" })
      .option("site", { describe: "site slug to serve", type: "string" })
      .option("site-id", { describe: "site ID to serve", type: "number" })
      .check((argv) => {
        if (!argv.page && !argv["page-id"] && !argv.site && !argv["site-id"]) {
          throw new Error("Provide a target: --page <slug>, --page-id <id>, --site <slug>, or --site-id <id>")
        }
        return true
      }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Assign Domain Mapping")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const domain = String(args.domain).toLowerCase().trim()
    let pageId = args["page-id"] as number | undefined
    const pageSlug = args.page as string | undefined
    const siteId = args["site-id"] as number | undefined
    const siteSlug = args.site as string | undefined
    const isSite = Boolean(siteSlug || siteId)

    // Resolve page slug → id via iris-api (mirrors `connect`).
    if (pageSlug && !pageId) {
      const psp = prompts.spinner()
      psp.start(`Resolving page "${pageSlug}"…`)
      const pageRes = await irisFetch(`/api/v1/pages/by-slug/${encodeURIComponent(pageSlug)}?include_drafts=1`, {}, IRIS_API)
      if (!pageRes.ok) {
        psp.stop("Page not found")
        prompts.log.error(`Page "${pageSlug}" not found. Create it first: ${dim(`iris pages create ${pageSlug}`)}`)
        prompts.outro("Done")
        return
      }
      const pageData = (await pageRes.json()) as any
      const page = pageData?.data ?? pageData
      pageId = page?.id
      psp.stop(`Found page: ${bold(page?.title ?? pageSlug)} (#${pageId})`)
    }

    const sp = prompts.spinner()
    sp.start(`Updating mapping for ${domain}…`)
    try {
      // Find the existing mapping (any status, incl. internal) via fl-api.
      const listRes = await irisFetch("/api/v1/domain-mappings", {}, FL_API)
      if (!listRes.ok) { sp.stop("Failed", 1); await handleApiError(listRes, "List domain mappings"); prompts.outro("Done"); return }
      const listData = (await listRes.json()) as any
      const mappings: any[] = firstArray(listData?.data)
      const existing = mappings.find((m: any) => String(m.domain ?? "").toLowerCase() === domain)

      // status=active so the mapping resolves immediately (resolution uses the active scope).
      const payload: Record<string, unknown> = { mapping_type: isSite ? "site" : "page", status: "active" }
      if (isSite) { payload.site_id = siteId ?? null; payload.page_id = null }
      else { payload.page_id = pageId ?? null; payload.site_id = null }

      const res = existing?.id
        ? await irisFetch(`/api/v1/domain-mappings/${existing.id}`, { method: "PUT", body: JSON.stringify(payload) }, FL_API)
        : await irisFetch("/api/v1/domain-mappings", { method: "POST", body: JSON.stringify({ domain, ...payload }) }, FL_API)
      const action = existing?.id ? (existing.is_internal ? "updated (internal)" : "updated") : "created"

      if (!res.ok) { sp.stop("Failed", 1); await handleApiError(res, "Assign domain"); prompts.outro("Done"); return }

      const out = (await res.json()) as any
      const m = out?.data ?? out
      sp.stop(success(`Mapping ${action}`))

      printDivider()
      printKV("Domain", bold(domain))
      printKV("Target", isSite
        ? highlight(`/s/${siteSlug ?? m?.site?.slug ?? siteId}`)
        : highlight(`/p/${pageSlug ?? m?.page?.slug ?? pageId}`))
      printKV("Status", statusBadge(m?.status ?? "active"))
      if (m?.id) printKV("Mapping ID", dim(`#${m.id}`))

      printDivider()
      prompts.log.info("No DNS records were changed. If the domain still doesn't resolve, fix DNS separately:")
      prompts.log.info(`  ${dim(`iris domains connect ${domain}${pageSlug ? ` --page ${pageSlug}` : ""}`)}  or  ${dim(`iris domains verify ${domain}`)}`)
      prompts.outro("Done")
    } catch (e: any) {
      sp.stop("Error")
      prompts.log.error(e.message ?? String(e))
      prompts.outro("Done")
    }
  },
})

// ----------------------------------------------------------------------------
// domains detect — report the DNS provider + nameservers for a domain (#156550)
// ----------------------------------------------------------------------------
const DomainsDetectCommand = cmd({
  command: "detect <domain>",
  describe: "detect the DNS provider and nameservers for a domain",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain to inspect (e.g. moodybeauty.co)", type: "string", demandOption: true })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    const domain = String(args.domain).toLowerCase().trim()

    if (args.json) {
      await writeJson(await detectDnsProvider(domain))
      return
    }

    UI.empty()
    prompts.intro("◈  Detect DNS Provider")
    const sp = prompts.spinner()
    sp.start(`Looking up nameservers for ${domain}…`)
    const d = await detectDnsProvider(domain)

    if (d.error) {
      sp.stop("Lookup failed")
      prompts.log.error(d.error)
      prompts.outro("Done")
      return
    }

    sp.stop(d.provider ? `Provider: ${providerBadge(d.provider)}` : "Unknown provider")
    printDivider()
    printKV("Domain", bold(domain))
    printKV("Provider", d.provider ? providerBadge(d.provider) : dim("unsupported / unknown"))
    printKV("Nameservers", "")
    for (const ns of d.nameservers) console.log(`    ${highlight(ns)}`)

    if (!d.provider) {
      printDivider()
      printManualDnsFallback(domain)
    }
    prompts.outro("Done")
  },
})


// ============================================================================
// Buying, and leaving (#187563)
//
// Two commands that belong together. `buy` spends money that cannot be refunded; `release`
// hands the domain back. They shipped in the same change on purpose — Cottonwood Creek cannot
// change its own website today because the agency that bought their domain holds the account,
// and that agency never had to refuse anything. It only had to not get round to letting go.
// A service that can take a domain in and not let it out is the thing we are selling against.
// ============================================================================

const DomainsSearchCommand = cmd({
  command: "search <name>",
  aliases: ["find"],
  describe: "check if a domain is available, and what it costs",
  builder: (yargs) =>
    yargs
      .positional("name", { describe: "a domain, or a bare label to try across endings", type: "string" })
      .option("also", { describe: "other endings to try with the same label, e.g. com,co,beer", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Domain Search")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Asking the registrar…")
    try {
      const params = new URLSearchParams({ domain: String(args.name) })
      for (const t of String(args.also || "").split(",").map((x) => x.trim()).filter(Boolean)) {
        params.append("also[]", t)
      }

      const res = await irisFetch(`/api/v1/domains/search?${params}`, {}, IRIS_API)
      if (!res.ok) {
        sp.stop("Failed", 1)
        await handleApiError(res, "Domain search")
        prompts.outro("Done")
        return
      }

      const data = (await res.json()) as any
      const results: any[] = firstArray(data?.results)
      sp.stop(`${results.length} checked`)

      if (args.json) { await writeJson(results); prompts.outro("Done"); return }

      UI.empty()
      for (const r of results) {
        if (!r?.success) {
          prompts.log.warn(`${r?.domain ?? "?"} — ${r?.error ?? "could not check"}`)
          continue
        }
        const price = r.price != null ? `$${Number(r.price).toFixed(2)}` : "—"
        const renew = r.renewal != null ? `$${Number(r.renewal).toFixed(2)}` : "—"
        const line = `${String(r.domain).padEnd(32)} ${r.available ? success("available") : dim("taken")}  ${price.padEnd(9)} renews ${renew}`
        UI.println(`  ${line}`)
        // A promotional first year is a different product from the domain, and the difference
        // is charged every year after. .beer is $1.54 then $26.26, measured.
        if (r.first_year_promo) {
          UI.println(`  ${dim("     first year only — it renews at " + renew + " every year after")}`)
        }
        if (r.premium) UI.println(`  ${dim("     premium name — not buyable through the API")}`)
      }

      UI.empty()
      printKV("Buy one", `iris domains buy <domain> --for <client-email> --max-price 15`)
    } catch (e: any) {
      sp.stop("Failed", 1)
      prompts.log.error(e?.message ?? String(e))
    }
    prompts.outro("Done")
  },
})

const DomainsBuyCommand = cmd({
  command: "buy <domain>",
  describe: "register a domain in the CLIENT's name",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain to register", type: "string" })
      .option("max-price", { describe: "the most you approve paying, in dollars", type: "number" })
      .option("years", { describe: "years to register", type: "number", default: 1 })
      .option("for", { describe: "the client's email — they are the registrant", type: "string" })
      .option("first", { describe: "registrant first name", type: "string" })
      .option("last", { describe: "registrant last name", type: "string" })
      .option("org", { describe: "registrant organisation", type: "string" })
      .option("phone", { describe: "registrant phone", type: "string" })
      .option("address", { describe: "street address", type: "string" })
      .option("city", { describe: "city", type: "string" })
      .option("state", { describe: "state or province", type: "string" })
      .option("zip", { describe: "postal code", type: "string" })
      .option("country", { describe: "two-letter country code", type: "string", default: "US" })
      .option("yes", { describe: "skip the confirmation prompt", type: "boolean", default: false })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Buy a Domain")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const domain = String(args.domain)

    // QUOTE FIRST, ALWAYS. The ceiling is meaningless unless a person sees the live price it is
    // being compared against — and a promotional first year hides the real cost in the renewal.
    const sp = prompts.spinner()
    sp.start("Checking price…")
    let quote: any
    try {
      const res = await irisFetch(`/api/v1/domains/search?domain=${encodeURIComponent(domain)}`, {}, IRIS_API)
      const data = (await res.json()) as any
      quote = firstArray(data?.results)[0]
      if (!res.ok || !quote?.success) {
        sp.stop("Failed", 1)
        prompts.log.error(quote?.error ?? "Could not price that domain.")
        prompts.outro("Done")
        return
      }
    } catch (e: any) {
      sp.stop("Failed", 1)
      prompts.log.error(e?.message ?? String(e))
      prompts.outro("Done")
      return
    }
    sp.stop("Priced")

    if (!quote.available) {
      prompts.log.warn(`${domain} is already registered. Nothing was bought.`)
      prompts.outro("Done")
      return
    }

    const price = Number(quote.price ?? 0)
    const renewal = Number(quote.renewal ?? 0)
    UI.empty()
    printKV("Domain", domain)
    printKV("First year", `$${price.toFixed(2)}`)
    printKV("Renews at", `$${renewal.toFixed(2)} / year`)
    if (quote.first_year_promo) {
      prompts.log.warn(`The $${price.toFixed(2)} is a first-year promotion. Every year after is $${renewal.toFixed(2)}.`)
    }

    const registrant = {
      firstName: args.first, lastName: args.last, organization: args.org,
      email: args.for, phone: args.phone, address1: args.address,
      city: args.city, state: args.state, postalCode: args.zip,
      country: String(args.country || "US").toUpperCase(),
    }

    const missing = (["firstName", "lastName", "email", "address1", "city", "state", "postalCode"] as const)
      .filter((k) => !String((registrant as any)[k] ?? "").trim())
    if (missing.length) {
      UI.empty()
      prompts.log.error(`The registrant is the CLIENT, and is missing: ${missing.join(", ")}`)
      prompts.log.info("Registering in our name and transferring later starts an ICANN trade process and a 60-day lock.")
      prompts.outro("Done")
      return
    }

    const maxPrice = Number(args["max-price"] ?? 0)
    if (!(maxPrice > 0)) {
      UI.empty()
      prompts.log.error("--max-price is required. It is the number you approve paying.")
      prompts.outro("Done")
      return
    }

    if (!args.yes) {
      const ok = await prompts.confirm({
        message: `Register ${domain} for ${args.first} ${args.last} at $${price.toFixed(2)}? This cannot be undone.`,
        initialValue: false,
      })
      if (prompts.isCancel(ok) || !ok) {
        prompts.log.info("Nothing was bought.")
        prompts.outro("Done")
        return
      }
    }

    const sp2 = prompts.spinner()
    sp2.start("Registering…")
    try {
      const res = await irisFetch(`/api/v1/domains/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          domain, years: Number(args.years ?? 1), max_price: maxPrice,
          confirm: true, registrant,
        }),
      }, IRIS_API)

      const data = (await res.json()) as any
      if (!res.ok || !data?.success) {
        sp2.stop("Refused", 1)
        // A 422 from our own validation carries `errors`, not `error`. Printing the generic
        // sentence instead sent someone to debug the registrar for a field-name typo of ours.
        const fieldErrors = data?.errors
          ? Object.values(data.errors as Record<string, string[]>).flat().join(" ")
          : null
        prompts.log.error(data?.error ?? fieldErrors ?? data?.message ?? "The registration was refused.")
        prompts.outro("Done")
        return
      }
      sp2.stop("Registered")

      if (args.json) { await writeJson(data); prompts.outro("Done"); return }

      UI.empty()
      printKV("Registered", `${data.domain} — $${Number(data.price).toFixed(2)}${data.sandbox ? "  (SANDBOX)" : ""}`)

      // The warning must be louder than the success: a registered domain still in OUR name is
      // not a failed purchase, but it is an unfinished one.
      if (data.warning) {
        prompts.log.error(String(data.warning))
      } else if (data.registrant_set) {
        prompts.log.success("Registrant, admin, tech and billing are all the client.")
      }

      UI.empty()
      printKV("Next", `iris domains connect ${data.domain}`)
      printKV("Theirs to take", `iris domains release ${data.domain} --for ${args.for}`)
    } catch (e: any) {
      sp2.stop("Failed", 1)
      prompts.log.error(e?.message ?? String(e))
    }
    prompts.outro("Done")
  },
})

const DomainsReleaseCommand = cmd({
  command: "release <domain>",
  aliases: ["handover"],
  describe: "give a client everything they need to take their domain elsewhere",
  builder: (yargs) =>
    yargs
      .positional("domain", { describe: "the domain to hand over", type: "string" })
      .option("for", { describe: "the client's email — pre-fills their own registrar signup", type: "string" })
      .option("json", { describe: "output as JSON", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Release a Domain")
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()
    sp.start("Preparing the handover…")
    try {
      const res = await irisFetch(`/api/v1/domains/release`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ domain: String(args.domain), email: args.for ?? null }),
      }, IRIS_API)

      const data = (await res.json()) as any
      if (!res.ok || !data?.success) {
        sp.stop("Failed", 1)
        prompts.log.error(data?.error ?? "Could not read that domain.")
        prompts.outro("Done")
        return
      }
      sp.stop("Ready")

      if (args.json) { await writeJson(data); prompts.outro("Done"); return }

      UI.empty()
      printKV("Domain", `${data.domain}   expires ${data.expires_at ?? "—"}`)

      if (!data.transferable_now) {
        prompts.log.warn(`ICANN holds a new registration for 60 days — this one can move from ${data.icann_lock_until}.`)
        prompts.log.info("Not our rule and not one we can waive. Saying it first is the difference between a fact and a stall.")
      } else {
        prompts.log.success("Transferable now — no ICANN hold.")
      }

      if (data.their_account_invite) {
        UI.empty()
        printDivider()
        UI.println(`  ${bold("Their own registrar account")} ${dim("(link expires in 48 hours)")}`)
        UI.println(`  ${data.their_account_invite}`)
        UI.println(`  ${dim("They set their own password. We never hold it — which is the difference")}`)
        UI.println(`  ${dim("between owning a domain and being told that you own one.")}`)
        printDivider()
      }

      UI.empty()
      prompts.log.warn("One step is manual:")
      UI.println(`  ${data.manual_step}`)
      UI.println(`  ${dim("Security lock is currently: " + data.security_lock)}`)
    } catch (e: any) {
      sp.stop("Failed", 1)
      prompts.log.error(e?.message ?? String(e))
    }
    prompts.outro("Done")
  },
})

// ============================================================================
// Parent command
// ============================================================================

export const PlatformDomainsCommand = cmd({
  command: "domains",
  aliases: ["domain"],
  describe: "buy, release and connect client domains (search, buy, release, connect, list, verify)",
  builder: (yargs) =>
    yargs
      .command(DomainsSearchCommand)
      .command(DomainsBuyCommand)
      .command(DomainsReleaseCommand)
      .command(DomainsListCommand)
      .command(DomainsConnectCommand)
      .command(DomainsAssignCommand)
      .command(DomainsVerifyCommand)
      .command(DomainsDetectCommand)
      .command(DomainsRemoveCommand)
      .command(DomainsStatusCommand)
      .demandCommand(1, "specify a subcommand: search, buy, release, list, connect, assign, verify, detect, remove, status"),
  async handler() {},
})
