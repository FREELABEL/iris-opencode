# Genesis Pages — How-To

Build and manage composable landing pages from the CLI.

## Quick Reference

```bash
iris pages list                    # list all pages
iris pages view <slug>             # view page details + public URL
iris pages create --slug <slug> --title "<title>"   # create + auto-publish
iris pages pull <slug>             # download JSON to pages/<slug>.json
iris pages push <slug>             # upload local JSON back to API
iris pages publish <slug>          # publish a draft page
iris pages unpublish <slug>        # take a page offline
iris pages components <slug>       # list components on a page
iris pages component-registry      # list ALL valid component types
iris pages versions <slug>         # show version history
iris pages rollback <slug> --version <n>  # rollback to previous version
```

## Create a Page

```bash
iris pages create --slug my-page --title "My Page" --seo-description "Page description"
```

This creates a page with a Hero + SiteFooter and auto-publishes it.
The public URL is shown in the output: `main.heyiris.io/p/my-page`

## Add Components

The recommended workflow is pull → edit → push:

```bash
iris pages pull my-page            # creates pages/my-page.json
# edit pages/my-page.json — add components to the "components" array
iris pages push my-page            # uploads changes, creates new version
```

## Valid Component Types

**ONLY use these exact type names.** Invalid types render as blank:

| Type | Description |
|------|-------------|
| Hero | Full-width hero banner with title, subtitle, CTA buttons |
| SiteNavigation | Top navigation bar with logo, links, CTA button |
| SiteFooter | Footer with brand name, links, copyright |
| AnnouncementBanner | Dismissible banner strip at top of page |
| TestimonialsSection | Customer testimonials with avatars and quotes |
| TeamSection | Team member grid with photos and roles |
| ContactSection | Contact form with configurable fields |
| LogoMarquee | Auto-scrolling logo carousel |
| FeatureShowcase | Feature highlights with icons and descriptions |
| ComparisonMatrix | Pricing/feature comparison table |
| ClientGrid | Client/partner logo grid |
| CareersListing | Job listings with department filters |
| PortfolioGallery | Image/project gallery grid with lightbox |
| ProductGrid | E-commerce product cards with prices |
| ServiceMenu | Service/menu items with prices and descriptions |
| EventGrid | Event cards with dates and venues |
| FundingTiers | Pricing/funding tier cards |
| BeforeAfter | Before/after image slider comparison |
| MapSection | Interactive map with location markers |
| NewsletterSignup | Email signup form |
| StepWizard | Multi-step form wizard |
| FileUpload | File upload dropzone |
| ShoppingCart | Shopping cart with line items |
| OrderConfirmation | Order confirmation/receipt page |

## Component JSON Structure

Every component needs `type`, `id`, and `props`:

```json
{
  "type": "Hero",
  "id": "my-hero",
  "props": {
    "themeMode": "dark",
    "title": "Welcome",
    "subtitle": "This is my page",
    "labelText": "NEW",
    "labelColor": "#34d399",
    "primaryButtonText": "Get Started",
    "primaryButtonUrl": "#contact",
    "textAlign": "center"
  }
}
```

## Reference Page

Pull the component showcase for working examples of every component:

```bash
iris pages pull component-showcase
cat pages/component-showcase.json   # 28 components with full props
```

## Common Gotchas

- **Blank page?** You used an invalid component type. Run `iris pages component-registry` to check.
- **Auth error on pages list?** The CLI routes pages through iris-api. If auth fails, the service token may need refreshing.
- **Page URL format:** `main.heyiris.io/p/{slug}` — NOT `heyiris.io/p/{slug}` (that domain doesn't route /p/).
