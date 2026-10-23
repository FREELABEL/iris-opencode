import { describe, expect, test } from "bun:test"
import { asColor, cleanFontStack, colorRole, fetchSite, parseDesignMd, resolveVar, robotsAllows, siteTokens } from "./brand-import"
import { brandContract, MOTION_PRESETS, parseDurationMs, safeEase } from "./brand-contract"

describe("colour roles from names (#188410)", () => {
  test("shadcn's names: on-colours and the muted BACKGROUND are not roles", () => {
    expect(colorRole("--primary")).toBe("primary")
    expect(colorRole("--primary-foreground")).toBeUndefined()
    expect(colorRole("--muted")).toBeUndefined()
    expect(colorRole("--muted-foreground")).toBe("text-muted")
    expect(colorRole("--background")).toBe("background")
    expect(colorRole("--foreground")).toBe("text")
    expect(colorRole("--card")).toBe("surface")
  })
  test("common design-system prefixes", () => {
    expect(colorRole("--color-brand")).toBe("primary")
    expect(colorRole("--color-text-secondary")).toBe("text-muted")
    expect(colorRole("--color-border")).toBe("border")
    expect(colorRole("--primary-hover")).toBeUndefined()
  })
  test("bare HSL triplets are wrapped; words are not colours", () => {
    expect(asColor("221 83% 53%")).toBe("hsl(221 83% 53%)")
    expect(asColor("#2b59ff")).toBe("#2b59ff")
    expect(asColor("inherit")).toBeUndefined()
  })
})

describe("reading a site's CSS", () => {
  const css = `
    /* comment with { braces } */
    :root{--background:0 0% 100%;--foreground:222 84% 5%;--primary:221 83% 53%;--radius:.5rem;
      --font-sans:var(--font-inter);--font-inter:"__Inter_d65c78","__Inter_Fallback_d65c78";
      --ease-out:cubic-bezier(.16, 1, .3, 1)}
    .dark{--background:0 0% 0%}
    @media (prefers-color-scheme: dark){:root{--primary:0 0% 100%}}
    h1{font-family:Georgia,serif}
    .btn{transition:all 150ms ease}`
  const t = siteTokens("<html></html>", [css])

  test("custom properties named for a role become that role; the FIRST definition wins over dark overrides", () => {
    const { values } = brandContract(t)
    expect(values.accent).toBe("hsl(221 83% 53%)")
    expect(values.bg).toBe("hsl(0 0% 100%)")
    expect(values.ink).toBe("hsl(222 84% 5%)")
    expect(values.radius).toBe(".5rem")
  })
  test("next/font's hashed family resolves to the real name, with a generic fallback", () => {
    expect(brandContract(t).values["font-body"]).toBe("Inter, sans-serif")
    expect(brandContract(t).values["font-display"]).toBe("Georgia, serif")
  })
  test("motion comes from a named ease variable and the transitions", () => {
    expect(brandContract(t).values.ease).toBe("cubic-bezier(.16,1,.3,1)")
    expect(brandContract(t).values.duration).toBe("150ms")
  })
  test("with no custom properties, body/h1 rules, theme-color and frequency fill in", () => {
    const html = `<meta name="theme-color" content="#e4572e"><style>body{background:#fbfaf7;color:#1d1b18;font-family:"Söhne",Helvetica,sans-serif}</style>`
    const v = brandContract(siteTokens(html, [".card{border-radius:10px}.x{border-radius:10px}.pill{border-radius:9999px}"])).values
    expect(v.accent).toBe("#e4572e")
    expect(v.bg).toBe("#fbfaf7")
    expect(v.ink).toBe("#1d1b18")
    expect(v["font-body"]).toBe("Söhne, Helvetica, sans-serif")
    expect(v.radius).toBe("10px")
  })
  test("a grey theme-color is not an accent; the most-used saturated colour is", () => {
    const v = brandContract(siteTokens(`<meta name="theme-color" content="#ffffff">`, ["a{color:#0a7d4f}.b{background:#0a7d4f}.c{color:#333}"])).values
    expect(v.accent).toBe("#0a7d4f")
  })
  test("var() falls back, and an unresolvable reference is left visible rather than invented", () => {
    expect(resolveVar("var(--x, #123)", {})).toBe("#123")
    expect(resolveVar("var(--y)", {})).toBe("var(--y)")
  })
  test("a value that could break out of the CSS is refused", () => {
    expect(cleanFontStack("Inter;}</style><script>")).toBeUndefined()
  })
})

describe("DESIGN.md", () => {
  test("front matter tokens, with {references} resolved", () => {
    const md = `---
name: Lumen
colors:
  primary: "#2B59FF"
  background: "#FAFAF7"
  on-primary: "#FFFFFF"
  coral: "#FF6B57"
typography:
  display-lg:
    fontFamily: Fraunces
  body-md:
    fontFamily: Inter
  code:
    fontFamily: JetBrains Mono
rounded:
  sm: 4px
  md: 8px
motion:
  ease: cubic-bezier(.2,.9,.3,1)
  duration: 180ms
components:
  button:
    background: "{colors.primary}"
---
# Lumen
Prose about the brand.`
    const t = parseDesignMd(md)
    const { values } = brandContract(t)
    expect(values.accent).toBe("#2B59FF")
    expect(values.bg).toBe("#FAFAF7")
    expect(values["font-display"]).toBe("Fraunces, sans-serif")
    expect(values["font-body"]).toBe("Inter, sans-serif")
    expect(values["font-mono"]).toBe('"JetBrains Mono", monospace')
    expect(values.radius).toBe("8px")
    expect(values.ease).toBe("cubic-bezier(.2,.9,.3,1)")
    expect(values.duration).toBe("180ms")
    expect((t.colors as Record<string, string>).coral).toBe("#FF6B57")
  })
  test("no front matter: named colours and fonts in prose and tables", () => {
    const md = `## Colours\n| Role | Value |\n|---|---|\n| Primary | \`#0E7C66\` |\n| Background | #F6F4EE |\n- Text: #1A1A1A\n\n## Type\nFont family: "GT America", Helvetica\nMono font: IBM Plex Mono\nCorner radius 6px`
    const v = brandContract(parseDesignMd(md)).values
    expect(v.accent).toBe("#0E7C66")
    expect(v.bg).toBe("#F6F4EE")
    expect(v.ink).toBe("#1A1A1A")
    expect(v["font-body"]).toBe('"GT America", Helvetica, sans-serif')
    expect(v["font-mono"]).toBe('"IBM Plex Mono", monospace')
    expect(v.radius).toBe("6px")
  })
  test("broken front matter falls back to prose instead of crashing", () => {
    expect(brandContract(parseDesignMd("---\ncolors: [unclosed\n---\nPrimary: #123456\n")).values.accent).toBe("#123456")
  })
})

describe("robots.txt", () => {
  const robots = `User-agent: *\nDisallow: /private\nAllow: /private/ok\n\nUser-agent: ClaudeBot\nUser-agent: GPTBot\nDisallow: /`
  test("the * group applies to us; longest match wins", () => {
    expect(robotsAllows(robots, "/")).toBe(true)
    expect(robotsAllows(robots, "/private/x")).toBe(false)
    expect(robotsAllows(robots, "/private/ok")).toBe(true)
  })
  test("a group naming our agent overrides *", () => {
    expect(robotsAllows("User-agent: *\nAllow: /\n\nUser-agent: IRIS-BrandImport\nDisallow: /", "/")).toBe(false)
  })
  test("fetchSite refuses a disallowed path before requesting the page", async () => {
    const asked: string[] = []
    const f = async (u: string) => {
      asked.push(u)
      return new Response(u.endsWith("/robots.txt") ? "User-agent: *\nDisallow: /" : "<html></html>")
    }
    await expect(fetchSite("https://example.com/", f as any)).rejects.toThrow(/robots\.txt disallows/)
    expect(asked).toEqual(["https://example.com/robots.txt"])
  })
  test("fetchSite reads linked stylesheets relative to the page", async () => {
    const f = async (u: string) =>
      u.endsWith("/robots.txt") ? new Response("", { status: 404 })
      : u === "https://example.com/a/" ? new Response(`<link rel="stylesheet" href="../s.css"><link rel="icon" href="/i.png">`)
      : u === "https://example.com/s.css" ? new Response(":root{--primary:#ff0066}")
      : new Response("", { status: 404 })
    const site = await fetchSite("example.com/a/", f as any)
    expect(site.sheets).toEqual([":root{--primary:#ff0066}"])
  })
})

describe("motion token (#188412)", () => {
  test("eases a browser accepts, and nothing else", () => {
    expect(safeEase("cubic-bezier(.45, 0, .15, 1)")).toBe("cubic-bezier(.45,0,.15,1)")
    expect(safeEase("ease-in-out")).toBe("ease-in-out")
    expect(safeEase("cubic-bezier(1.5,0,.2,1)")).toBeUndefined() // x outside [0,1]
    expect(safeEase("bouncy")).toBeUndefined()
    expect(safeEase("ease;}body{")).toBeUndefined()
  })
  test("durations in ms or s, bounded", () => {
    expect(parseDurationMs(320)).toBe(320)
    expect(parseDurationMs("0.32s")).toBe(320)
    expect(parseDurationMs("180ms")).toBe(180)
    expect(parseDurationMs("20s")).toBeUndefined()
    expect(parseDurationMs("fast")).toBeUndefined()
  })
  test("a stored motion token reaches templates as --brand-ease and --brand-duration", () => {
    const { values } = brandContract({ motion: MOTION_PRESETS.smooth })
    expect(values.ease).toBe("cubic-bezier(.45,0,.15,1)")
    expect(values.duration).toBe("320ms")
  })
  test("a brand with no motion reports it missing — the template keeps its own", () => {
    expect(brandContract({}).missing).toEqual(expect.arrayContaining(["ease", "duration"]))
  })
})
