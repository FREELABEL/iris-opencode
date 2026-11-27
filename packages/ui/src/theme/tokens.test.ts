import { describe, expect, test } from "bun:test"
import { renderFallback } from "../../script/build-theme-fallback"
import { checkTheme, MIN, TUNED } from "../../script/check-contrast"
import { lintAll } from "../../script/lint-tokens"
import { DEFAULT_THEME_ID, DEFAULT_THEMES, irisTheme } from "./default-themes"
import type { DesktopTheme } from "./types"

// Guardrails for #194375: the design tokens stay defined, legible and generated.
describe("design tokens", () => {
  test("the default theme is IRIS", () => {
    expect(DEFAULT_THEME_ID).toBe("iris")
    expect(DEFAULT_THEMES[DEFAULT_THEME_ID]).toBe(irisTheme)
  })

  test("theme-fallback.css is generated from the default theme and current", async () => {
    const file = await Bun.file(new URL("../styles/theme-fallback.css", import.meta.url)).text()
    expect(file).toBe(await renderFallback())
  })

  test("tuned themes keep body text at 4.5:1 or better", async () => {
    for (const id of TUNED) {
      const theme = (await Bun.file(new URL(`./themes/${id}.json`, import.meta.url)).json()) as DesktopTheme
      const low = checkTheme(theme).findings.filter((f) => f.ratio < MIN)
      expect(low.map((f) => `${id} ${f.mode} ${f.text} on ${f.on} ${f.ratio.toFixed(2)}`)).toEqual([])
    }
  })

  test("every font-size token used in CSS is defined", async () => {
    const theme = await Bun.file(new URL("../styles/theme.css", import.meta.url)).text()
    const defined = new Set([...theme.matchAll(/--(font-size-[\w-]+):/g)].map((m) => m[1]))
    const glob = new Bun.Glob("**/*.css")
    const roots = [new URL("../../", import.meta.url).pathname + "src", new URL("../../../app/src", import.meta.url).pathname]
    const missing = new Set<string>()
    for (const root of roots) {
      for await (const rel of glob.scan(root)) {
        const css = await Bun.file(`${root}/${rel}`).text()
        for (const m of css.matchAll(/var\(--(font-size-[\w-]+)/g)) if (!defined.has(m[1])) missing.add(`${m[1]} (${rel})`)
      }
    }
    expect([...missing]).toEqual([])
  })

  test("no new literal sizes, radii, z-indexes or edge strips beyond the baseline", async () => {
    const baseline = (await Bun.file(new URL("../../script/lint-tokens.baseline.json", import.meta.url)).json()) as Record<string, number>
    const seen = new Map<string, number>()
    const fresh: string[] = []
    for (const v of await lintAll()) {
      const k = `${v.file} | ${v.rule} | ${v.text}`
      const n = (seen.get(k) ?? 0) + 1
      seen.set(k, n)
      if (n > (baseline[k] ?? 0)) fresh.push(`${v.file}:${v.line} ${v.rule} ${v.text}`)
    }
    expect(fresh).toEqual([])
  })
})
