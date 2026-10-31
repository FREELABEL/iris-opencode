import { describe, expect, test } from "bun:test"
import { createRequire } from "node:module"

// vite.js sits outside the TypeScript project; load it by URL so the typecheck does not take it in.
const { default: plugins, CSS_TARGETS } = await import(new URL("../vite.js", import.meta.url).href)

// #191625 — the desktop app draws in the system WebKit (Safari 16.6 on an Intel iMac on Ventura),
// which drops CSS it does not know. The build lowers CSS for that WebKit; these fail if it stops.
describe("CSS is built for the oldest WebKit we draw in (#191625)", () => {
  const config = (plugins as { name?: string; config?: () => Record<string, any> }[])
    .find((p) => p.name === "opencode-desktop:config")!
    .config!()

  test("the bundle is minified by Lightning CSS for Safari 16, not for esnext", () => {
    expect(config.build.cssMinify).toBe("lightningcss")
    expect(config.build.cssTarget).toBe("safari16")
    expect(config.css.lightningcss.targets).toEqual(CSS_TARGETS)
  })

  test("light-dark() comes out as color-scheme variables a Safari 16 can read", () => {
    const require = createRequire(import.meta.url)
    const { transform } = require(require.resolve("lightningcss", { paths: [require.resolve("vite")] }))
    const css = ":root{color-scheme:light}[data-color-scheme=dark]{color-scheme:dark}.c{border-color:light-dark(#ddd,#333)}"
    const out = new TextDecoder().decode(transform({ filename: "t.css", code: Buffer.from(css), minify: true, targets: CSS_TARGETS }).code)
    expect(out).not.toContain("light-dark(")
    expect(out).toContain("--lightningcss-dark")
  })
})
