import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
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
      if (!res.ok) { await handleApiError(res, "List domains"); sp.stop("Failed", 1); prompts.outro("Done"); return }

      const data = (await res.json()) as any
      const domains: any[] = data?.domains ?? []
      sp.stop(`${domains.length} domain(s)`)

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
      .option("provider", { describe: "DNS provider: cloudflare (full proxy) or godaddy (CNAME only)", type: "string", default: "cloudflare" })
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
    const provider = String(args.provider ?? "cloudflare")

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

      if (!res.ok) {
        const err = await res.json().catch(() => ({})) as any
        sp.stop("Failed")
        prompts.log.error(`DNS setup failed: ${err?.error ?? res.statusText}`)
        if (err?.details) {
          for (const d of Array.isArray(err.details) ? err.details : [err.details]) {
            prompts.log.warn(`  ${String(d)}`)
          }
        }
        prompts.outro("Done")
        return
      }

      const result = (await res.json()) as any
      sp.stop(success("Domain connected"))

      printDivider()
      printKV("Domain", bold(result.domain))
      printKV("Provider", providerBadge(result.provider))
      printKV("Status", statusBadge(result.status ?? "pending_verification"))

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

      if (result.next_step) {
        printDivider()
        prompts.log.info(result.next_step)
      }

      if (result.domain_mapping) {
        printKV("Mapping ID", dim(`#${result.domain_mapping.id}`))
      }

      // Provider-specific instructions
      if (provider === "cloudflare" && result.nameservers) {
        printDivider()
        prompts.log.warn("Next: Update nameservers at your registrar to the ones above")
        prompts.log.info(`Then verify: ${dim(`iris domains verify ${domain}`)}`)
      } else if (provider === "godaddy") {
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

// ============================================================================
// Parent command
// ============================================================================

export const PlatformDomainsCommand = cmd({
  command: "domains",
  aliases: ["domain"],
  describe: "manage custom client domains (connect, verify, list, remove)",
  builder: (yargs) =>
    yargs
      .command(DomainsListCommand)
      .command(DomainsConnectCommand)
      .command(DomainsVerifyCommand)
      .command(DomainsRemoveCommand)
      .command(DomainsStatusCommand)
      .demandCommand(1, "specify a subcommand: list, connect, verify, remove, status"),
  async handler() {},
})
