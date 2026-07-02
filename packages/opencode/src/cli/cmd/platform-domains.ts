import { promises as dnsPromises } from "node:dns"
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight, IRIS_API, FL_API } from "./iris-api"

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
      const domains: any[] = data?.domains ?? []
      const warnings: string[] = Array.isArray(data?.warnings) ? data.warnings : []
      sp.stop(`${domains.length} domain(s)`)

      // Non-fatal per-provider warnings (e.g. one provider down while the other returned data).
      for (const w of warnings) {
        prompts.log.warn(String(w))
      }

      if (args.json) {
        console.log(JSON.stringify(domains, null, 2))
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
        const mappings: any[] = mappingsData?.data ?? []
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
      const domains: any[] = listData?.domains ?? []
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
      const mappings: any[] = listData?.data ?? []
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
      console.log(JSON.stringify(await detectDnsProvider(domain), null, 2))
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
// Parent command
// ============================================================================

export const PlatformDomainsCommand = cmd({
  command: "domains",
  aliases: ["domain"],
  describe: "manage custom client domains (connect, assign, verify, detect, list, remove)",
  builder: (yargs) =>
    yargs
      .command(DomainsListCommand)
      .command(DomainsConnectCommand)
      .command(DomainsAssignCommand)
      .command(DomainsVerifyCommand)
      .command(DomainsDetectCommand)
      .command(DomainsRemoveCommand)
      .command(DomainsStatusCommand)
      .demandCommand(1, "specify a subcommand: list, connect, assign, verify, detect, remove, status"),
  async handler() {},
})
