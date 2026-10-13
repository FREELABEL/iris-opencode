/**
 * Build @heyiris/pulse-core:
 *   dist/index.js, dist/heartbeats.js  — ESM for Desktop / CLI / npm consumers
 *   dist/*.d.ts                        — types (tsc, declarations only)
 *   dist/pulse-core.iife.js            — browser bundle for Genesis pages → window.IrisPulseCore
 */
import { $ } from "bun"
import { rmSync } from "node:fs"
import path from "node:path"

const root = path.resolve(import.meta.dir, "..")
process.chdir(root)
rmSync("dist", { recursive: true, force: true })

const esm = await Bun.build({
  entrypoints: ["src/index.ts", "src/heartbeats.ts"],
  outdir: "dist",
  format: "esm",
  target: "browser",
  splitting: true,
})
if (!esm.success) throw new AggregateError(esm.logs, "ESM build failed")

const iife = await Bun.build({
  entrypoints: ["src/browser.ts"],
  outdir: "dist",
  naming: "pulse-core.iife.js",
  format: "iife",
  target: "browser",
  minify: true,
})
if (!iife.success) throw new AggregateError(iife.logs, "IIFE build failed")

await $`bunx tsc -p tsconfig.build.json`

for (const f of ["dist/index.js", "dist/pulse-core.iife.js"]) {
  const bytes = Bun.file(f).size
  const gz = Bun.gzipSync(new Uint8Array(await Bun.file(f).arrayBuffer())).length
  console.log(`${f}  ${(bytes / 1024).toFixed(1)} KB  (${(gz / 1024).toFixed(1)} KB gzip)`)
}
