import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, bold, success, highlight } from "./iris-api"

// ============================================================================
// iris onboard <url> — connect existing website → branded Genesis page
// ============================================================================

export const PlatformOnboardCommand = cmd({
  command: "onboard <url>",
  aliases: ["connect-site"],
  describe: "connect an existing website — extract brand identity and auto-generate a branded Genesis page",
  builder: (y) =>
    y
      .positional("url", { describe: "website URL to onboard", type: "string", demandOption: true })
      .option("slug", { describe: "page slug (auto-generated from brand name if omitted)", type: "string" })
      .option("owner-type", { describe: "page owner type", type: "string", default: "bloq" })
      .option("owner-id", { describe: "page owner ID", type: "number", default: 38 })
      .option("no-publish", { describe: "create as draft (don't auto-publish)", type: "boolean", default: false })
      .option("save-to-lead", { describe: "also save brand data to this lead ID", type: "number" })
      .option("extract-only", { describe: "only extract brand identity, don't create page", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    const url = args.url as string
    prompts.intro(`◈  Onboard: ${url}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }

    const sp = prompts.spinner()

    if (args["extract-only"]) {
      // Brand extraction only mode
      sp.start("Extracting brand identity…")
      try {
        const payload: Record<string, unknown> = {
          tool: "websiteBrandExtractor",
          params: {
            url,
            save_to_lead_id: args["save-to-lead"] ?? null,
          },
        }
        const res = await irisFetch("/api/v6/workspace/tools/execute", { method: "POST", body: JSON.stringify(payload) })
        if (!(await handleApiError(res, "Brand extraction"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
        const data = await res.json() as any
        const result = data?.result ? (typeof data.result === "string" ? JSON.parse(data.result) : data.result) : data

        if (!result?.success) {
          sp.stop("Failed", 1)
          prompts.log.error(result?.error ?? "Brand extraction failed")
          prompts.outro("Done")
          return
        }

        sp.stop(success("Brand extracted"))
        const brand = result.brand ?? {}
        printDivider()
        printKV("Brand", brand.brand_name ?? "Unknown")
        printKV("Tagline", brand.tagline ?? "—")
        printKV("Primary", brand.colors?.primary ?? "—")
        printKV("Secondary", brand.colors?.secondary ?? "—")
        printKV("Accent", brand.colors?.accent ?? "—")
        printKV("Background", brand.colors?.background ?? "—")
        printKV("Fonts", (brand.font_families ?? []).join(", ") || "—")
        printKV("Style", brand.design_style ?? "—")
        printKV("Theme", brand.theme_mode ?? "—")

        if (brand.logo_urls?.length) {
          printKV("Logo", brand.logo_urls[0].src ?? "—")
        }

        const socialLinks = Object.entries(brand.social_links ?? {}).filter(([, v]) => v)
        if (socialLinks.length > 0) {
          printKV("Social", socialLinks.map(([k]) => k).join(", "))
        }

        if (result.saved_to_lead_id) {
          printKV("Saved to Lead", `#${result.saved_to_lead_id}`)
        }

        printDivider()
        prompts.outro(dim("Use iris onboard <url> (without --extract-only) to create a page"))
        return
      } catch (err) {
        sp.stop("Error", 1)
        prompts.log.error(err instanceof Error ? err.message : String(err))
        prompts.outro("Done")
        return
      }
    }

    // Full onboarding: extract brand + create page
    sp.start("Scraping brand identity…")

    try {
      // Step 1: Extract brand
      const extractPayload = {
        tool: "websiteBrandExtractor",
        params: { url },
      }
      const extractRes = await irisFetch("/api/v6/workspace/tools/execute", { method: "POST", body: JSON.stringify(extractPayload) })
      if (!(await handleApiError(extractRes, "Brand extraction"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const extractData = await extractRes.json() as any
      const extractResult = extractData?.result ? (typeof extractData.result === "string" ? JSON.parse(extractData.result) : extractData.result) : extractData

      if (!extractResult?.success) {
        sp.stop("Failed", 1)
        prompts.log.error(extractResult?.error ?? "Brand extraction failed")
        prompts.outro("Done")
        return
      }

      const brand = extractResult.brand ?? {}
      const brandName = brand.brand_name ?? new URL(url).hostname
      sp.stop(success(`Brand: ${brandName}`))

      // Show brand summary
      printDivider()
      printKV("Brand", brandName)
      printKV("Primary", brand.colors?.primary ?? "—")
      printKV("Secondary", brand.colors?.secondary ?? "—")
      printKV("Style", brand.design_style ?? "—")
      printKV("Theme", brand.theme_mode ?? "—")
      printDivider()

      // Step 2: Create page
      const pageSlug = args.slug ?? brandName.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
      sp.start(`Creating page: ${pageSlug}…`)

      // Build page JSON from brand data
      const colors = brand.colors ?? {}
      const primary = colors.primary ?? "#3b82f6"
      const secondary = colors.secondary ?? "#8b5cf6"
      const themeMode = brand.theme_mode ?? "dark"
      const background = colors.background ?? (themeMode === "dark" ? "#0a0a0a" : "#ffffff")

      const navLinks = (brand.navigation ?? []).slice(0, 5).map((n: any) => ({
        label: n.label ?? "",
        url: n.href ?? "#",
      }))

      const logoUrl = brand.logo_urls?.[0]?.src
      const logo = logoUrl ? { text: null, url: "/", imageUrl: logoUrl } : { text: brandName, url: "/" }

      const ctaButton = brand.ctas?.[0]
        ? { text: brand.ctas[0].text, url: brand.ctas[0].href ?? "#" }
        : { text: "Get Started", url: "#contact" }

      const socialLinks = Object.entries(brand.social_links ?? {})
        .filter(([, v]) => v)
        .map(([k, v]) => ({ label: k.charAt(0).toUpperCase() + k.slice(1), url: v as string }))

      const jsonContent = {
        version: "1.0",
        type: "landing",
        theme: {
          mode: themeMode,
          backgroundColor: background,
          branding: {
            name: brandName,
            primaryColor: primary,
            secondaryColor: secondary,
          },
        },
        components: [
          {
            type: "SiteNavigation",
            id: "nav-1",
            props: {
              logo,
              links: navLinks.length > 0 ? navLinks : [{ label: "Home", url: "#" }, { label: "About", url: "#about" }],
              ctaButton,
              themeMode,
            },
          },
          {
            type: "Hero",
            id: "hero-1",
            props: {
              title: brandName,
              subtitle: brand.tagline ?? extractResult.page_description ?? "",
              backgroundGradient: `linear-gradient(135deg, ${primary} 0%, ${secondary} 100%)`,
              themeMode,
              textAlign: "center",
              minHeight: "500px",
            },
          },
          {
            type: "TextBlock",
            id: "about-1",
            props: {
              title: `About ${brandName}`,
              content: extractResult.page_description ?? brand.tagline ?? `Welcome to ${brandName}.`,
              themeMode,
            },
          },
          {
            type: "ButtonCTA",
            id: "cta-1",
            props: {
              text: ctaButton.text,
              url: ctaButton.url,
              themeMode,
            },
          },
          {
            type: "SiteFooter",
            id: "footer-1",
            props: {
              logo,
              tagline: brand.tagline ?? brandName,
              columns: [
                { title: "Navigation", links: navLinks.length > 0 ? navLinks : [{ label: "Home", url: "#" }] },
                ...(socialLinks.length > 0 ? [{ title: "Social", links: socialLinks.slice(0, 5) }] : []),
              ],
              themeMode,
            },
          },
        ],
      }

      const pagePayload: Record<string, unknown> = {
        slug: pageSlug,
        title: brandName,
        seo_title: extractResult.page_title ?? brandName,
        seo_description: extractResult.page_description ?? brand.tagline ?? "",
        owner_type: args["owner-type"],
        owner_id: args["owner-id"],
        status: "draft",
        json_content: jsonContent,
        auto_publish: !args["no-publish"],
        ai_source_type: "site_onboarding",
        ai_source_prompt: `Auto-generated from ${url}`,
      }

      const pageRes = await irisFetch("/api/v1/pages", { method: "POST", body: JSON.stringify(pagePayload) })
      if (!(await handleApiError(pageRes, "Create page"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const pageData = (await pageRes.json()) as { data?: any }
      const page = pageData?.data ?? pageData

      sp.stop(success(`Created #${page.id}`))

      // Save brand to lead if requested
      if (args["save-to-lead"]) {
        const leadPayload = {
          tool: "websiteBrandExtractor",
          params: { url, save_to_lead_id: args["save-to-lead"] },
        }
        await irisFetch("/api/v6/workspace/tools/execute", { method: "POST", body: JSON.stringify(leadPayload) }).catch(() => {})
      }

      printDivider()
      printKV("Page ID", page.id)
      printKV("Slug", page.slug ?? pageSlug)
      printKV("Status", args["no-publish"] ? "draft" : "published")

      const env = process.env.IRIS_ENV ?? "production"
      const pageUrl = env === "local"
        ? `http://local.iris.freelabel.net:9300/p/${pageSlug}`
        : `https://heyiris.io/p/${pageSlug}`
      printKV("URL", pageUrl)
      printDivider()

      prompts.log.info(dim(`Edit: iris pages set ${pageSlug} "theme.branding.primaryColor" "${primary}"`))
      prompts.log.info(dim(`View: iris pages view ${pageSlug}`))
      prompts.outro(success("Site onboarded"))

    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})
