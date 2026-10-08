#!/usr/bin/env bun
// [IRIS] Refresh the vendored v1 platform layer from the branch stable `iris` ships from.
//
// WHY THIS EXISTS. The spike copied v1's source in by hand at ~1.3.301. Stable kept shipping
// (1.3.319 by 2026-10-08, 69 commits later) and iris2 silently fell behind: every command fixed
// on main was still broken in iris2, and nothing said so. A hand copy goes stale the day it is
// made. So the iris2 build pulls the v1 layer from main every time instead (ticket #188596, A4).
//
// What it copies, all verbatim (the spike proved these are byte-identical copies, not forks):
//   packages/opencode/src            -> packages/cli/src/iris-v1           (minus vendor/)
//   packages/opencode/capabilities.json -> iris-v1/, src/, and the package root (3 copies)
//   packages/sdk/js/src              -> iris-v1/vendor/js/src
//   packages/util/src/<x>.ts         -> iris-v1/vendor/<x>.ts              (for each <x> imported)
//
// The ONE deliberate edit: iris-v1/index.ts drops the commands v2 owns (run, models, serve,
// debug, acp, session) — the front door routes those to v2, and registering both would make
// `iris run` ambiguous. Each removal must match exactly once; if main reshapes index.ts the
// script fails loudly rather than shipping a half-patched registry.
//
// Usage: bun script/sync-iris-v1.ts [--ref=origin/main] [--check]
//   --check  exit 1 if the vendored copy differs from <ref> (CI drift guard); writes nothing.

import { $ } from "bun"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const ref = process.argv.find((a) => a.startsWith("--ref="))?.slice("--ref=".length) ?? "origin/main"
const checkOnly = process.argv.includes("--check")

const cliDir = path.resolve(import.meta.dirname, "..")
const repoRoot = (await $`git -C ${cliDir} rev-parse --show-toplevel`.text()).trim()
const v1Dir = path.join(cliDir, "src", "iris-v1")
const vendorDir = path.join(v1Dir, "vendor")

// v2 owns these. Names are the yargs command exports in v1's index.ts.
const V2_OWNED_COMMANDS: [exportName: string, file: string][] = [
  ["RunCommand", "./cli/cmd/run"],
  ["ModelsCommand", "./cli/cmd/models"],
  ["ServeCommand", "./cli/cmd/serve"],
  ["DebugCommand", "./cli/cmd/debug"],
  ["AcpCommand", "./cli/cmd/acp"],
  ["SessionCommand", "./cli/cmd/session"],
]

export function patchIndex(source: string): string {
  let out = source
  for (const [name, file] of V2_OWNED_COMMANDS) {
    const importLine = `import { ${name} } from "${file}"\n`
    const regLine = new RegExp(`^[ \\t]*\\.command\\(reg\\(${name}\\)\\)[ \\t]*\\n`, "m")
    const imports = out.split(importLine).length - 1
    const regs = (out.match(new RegExp(regLine.source, "gm")) ?? []).length
    if (imports !== 1 || regs !== 1) {
      throw new Error(
        `index.ts patch: expected exactly one import and one .command(reg(${name})) — found ${imports} and ${regs}. ` +
          `main's index.ts changed shape; update V2_OWNED_COMMANDS in script/sync-iris-v1.ts.`,
      )
    }
    out = out.replace(importLine, "").replace(regLine, "")
  }
  return out
}

async function extract(treeRef: string, paths: string[], into: string) {
  const tar = path.join(into, "src.tar")
  await $`git -C ${repoRoot} archive --format=tar -o ${tar} ${treeRef} ${paths}`.quiet()
  // Relative name, run from inside the folder: GNU tar on Windows reads "C:\…" as host:path.
  await $`tar -xf src.tar`.cwd(into).quiet()
  await fs.rm(tar)
}

const sha = (await $`git -C ${repoRoot} rev-parse --verify ${ref + "^{commit}"}`.nothrow().quiet().text()).trim()
if (!sha) {
  console.error(`sync-iris-v1: cannot resolve ${ref}. Fetch it first: git fetch origin main`)
  process.exit(2)
}
const version = JSON.parse(
  (await $`git -C ${repoRoot} show ${sha}:packages/opencode/package.json`.quiet().text()).toString(),
).version as string

const staging = await fs.mkdtemp(path.join(os.tmpdir(), "iris-v1-sync-"))
const built = path.join(staging, "iris-v1")
try {
  await extract(sha, ["packages/opencode/src", "packages/opencode/capabilities.json", "packages/sdk/js/src", "packages/util/src"], staging)

  // Assemble the full new iris-v1 tree in staging, then compare or swap.
  await fs.cp(path.join(staging, "packages/opencode/src"), built, { recursive: true })
  const indexFile = path.join(built, "index.ts")
  await fs.writeFile(indexFile, patchIndex(await fs.readFile(indexFile, "utf8")))
  await fs.copyFile(path.join(staging, "packages/opencode/capabilities.json"), path.join(built, "capabilities.json"))

  const vendorOut = path.join(built, "vendor")
  await fs.mkdir(vendorOut, { recursive: true })
  await fs.cp(path.join(staging, "packages/sdk/js/src"), path.join(vendorOut, "js", "src"), { recursive: true })
  // Keep the vendored SDK's non-src files (package.json, tsconfig, openapi.json…) as they are.
  for (const entry of await fs.readdir(path.join(vendorDir, "js"))) {
    if (entry === "src") continue
    await fs.cp(path.join(vendorDir, "js", entry), path.join(vendorOut, "js", entry), { recursive: true })
  }
  for (const entry of await fs.readdir(vendorDir)) {
    if (entry === "js" || entry.endsWith(".ts")) continue
    await fs.cp(path.join(vendorDir, entry), path.join(vendorOut, entry), { recursive: true })
  }
  // util: every @opencode-ai/util/<x> the new code imports, fresh from main.
  const imported = new Set<string>()
  for await (const file of new Bun.Glob("**/*.{ts,tsx}").scan(built)) {
    const text = await fs.readFile(path.join(built, file), "utf8")
    for (const m of text.matchAll(/["']@opencode-ai\/util\/([a-z0-9-]+)["']/g)) imported.add(m[1])
  }
  for (const name of imported) {
    const src = path.join(staging, "packages/util/src", `${name}.ts`)
    if (!(await Bun.file(src).exists())) throw new Error(`v1 code imports @opencode-ai/util/${name}, which ${ref} does not have`)
    await fs.copyFile(src, path.join(vendorOut, `${name}.ts`))
  }

  const diff = await $`diff -rq ${v1Dir} ${built}`.nothrow().quiet()
  const changes = diff.stdout.toString().trim().split("\n").filter(Boolean)

  // Dependencies the new code needs that packages/cli does not declare. Reported, never
  // auto-added: a new dependency changes the lockfile and deserves a human look.
  const v1Pkg = JSON.parse((await $`git -C ${repoRoot} show ${sha}:packages/opencode/package.json`.quiet().text()).toString())
  const cliPkg = JSON.parse(await fs.readFile(path.join(cliDir, "package.json"), "utf8"))
  const declared = new Set([...Object.keys(cliPkg.dependencies ?? {}), ...Object.keys(cliPkg.devDependencies ?? {})])
  // workspace:* packages are resolved through tsconfig paths onto vendor/, not installed.
  const missing = Object.entries<string>({ ...v1Pkg.dependencies })
    .filter(([d, v]) => !declared.has(d) && !v.startsWith("workspace:"))
    .map(([d]) => d)
  const missingUsed: string[] = []
  if (missing.length) {
    const grep = await $`grep -rhoE ${"from [\"'](" + missing.map((m) => m.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")).join("|") + ")[\"'/]"} ${built}`
      .nothrow()
      .quiet()
    for (const m of missing) if (grep.stdout.toString().includes(m)) missingUsed.push(m)
  }

  console.log(`sync-iris-v1: ${ref} = ${sha.slice(0, 10)} (v${version}) — ${changes.length} file(s) differ from the vendored copy`)
  if (checkOnly) for (const line of changes) console.log(`  ${line.replace(v1Dir, "vendored").replace(built, "ref")}`)
  if (missingUsed.length) console.log(`  ⚠ imported by v1 code but not in packages/cli/package.json: ${missingUsed.join(", ")}`)

  if (checkOnly) process.exit(changes.length || missingUsed.length ? 1 : 0)

  await fs.rm(v1Dir, { recursive: true, force: true })
  await fs.cp(built, v1Dir, { recursive: true })
  const caps = path.join(v1Dir, "capabilities.json")
  await fs.copyFile(caps, path.join(cliDir, "src", "capabilities.json"))
  await fs.copyFile(caps, path.join(cliDir, "capabilities.json"))
  await fs.writeFile(path.join(v1Dir, "SYNCED_FROM"), `${sha}\nv${version}\n`)
  if (missingUsed.length) {
    console.error(`sync-iris-v1: add these to packages/cli/package.json at main's versions, then bun install:`)
    for (const m of missingUsed) console.error(`  "${m}": "${v1Pkg.dependencies[m]}"`)
    process.exit(3)
  }
} finally {
  await fs.rm(staging, { recursive: true, force: true })
}
