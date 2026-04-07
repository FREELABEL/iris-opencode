import { cmd } from "./cmd"
import * as prompts from "@clack/prompts"
import { UI } from "../ui"
import { irisFetch, requireAuth, handleApiError, printDivider, printKV, dim, success } from "./iris-api"
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { join } from "path"

// ============================================================================
// Helpers
// ============================================================================

const BASE = "/api/v1/platform/packages"

async function listPackages(platform?: string): Promise<any[]> {
  const params = new URLSearchParams()
  if (platform) params.set("platform", platform)
  const res = await irisFetch(`${BASE}?${params}`)
  if (!res.ok) {
    await handleApiError(res, "List packages")
    return []
  }
  const data = (await res.json()) as { data?: any[] }
  return data?.data ?? (data as any) ?? []
}

async function getPackage(slug: string): Promise<any | null> {
  const res = await irisFetch(`${BASE}/${encodeURIComponent(slug)}`)
  if (!res.ok) return null
  const data = (await res.json()) as { data?: any }
  return data?.data ?? data
}

function parseValue(raw: string): unknown {
  try { return JSON.parse(raw) } catch { return raw }
}

function pkgsDir(custom?: string): string {
  return custom ?? join(process.cwd(), "packages-data")
}

// ============================================================================
// Subcommands
// ============================================================================

const ListCmd = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list packages",
  builder: (y) =>
    y
      .option("platform", { describe: "filter by platform", type: "string" })
      .option("json", { describe: "JSON output", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Platform Packages")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Loading…")
    const pkgs = await listPackages(args.platform)
    sp.stop(`${pkgs.length} package(s)`)
    if (args.json) {
      console.log(JSON.stringify(pkgs, null, 2))
      prompts.outro("Done")
      return
    }
    if (pkgs.length === 0) { prompts.outro("None"); return }
    printDivider()
    for (const p of pkgs) {
      console.log(`  ${p.slug ?? "?"}  ${dim(`#${p.id ?? "?"}`)}  $${p.price ?? "0"}/${p.billing_period ?? "mo"}`)
      console.log(`    ${dim(p.title ?? "")}${p.popular ? "  ★" : ""}${p.public ? "  (public)" : ""}`)
    }
    printDivider()
    prompts.outro(dim("iris packages get <slug>"))
  },
})

const GetCmd = cmd({
  command: "get <slug> [path]",
  describe: "get package or value at dot-notation path",
  builder: (y) =>
    y
      .positional("slug", { describe: "package slug", type: "string", demandOption: true })
      .positional("path", { describe: "dot notation path", type: "string" }),
  async handler(args) {
    if (!(await requireAuth())) return
    const pkg = await getPackage(args.slug)
    if (!pkg) { console.error(`Package not found: ${args.slug}`); process.exit(1) }
    if (!args.path) {
      console.log(JSON.stringify(pkg, null, 2))
      return
    }
    const parts = args.path.split(".")
    let cur: any = pkg
    for (const p of parts) {
      const k = /^\d+$/.test(p) ? Number(p) : p
      if (cur == null || cur[k] === undefined) {
        console.error(`Path not found: ${args.path}`)
        process.exit(1)
      }
      cur = cur[k]
    }
    if (typeof cur === "object") console.log(JSON.stringify(cur, null, 2))
    else console.log(String(cur))
  },
})

const SetCmd = cmd({
  command: "set <slug> <field> <value>",
  describe: "set a field or dot-notation path on a package",
  builder: (y) =>
    y
      .positional("slug", { describe: "package slug", type: "string", demandOption: true })
      .positional("field", { describe: "field name or dot path", type: "string", demandOption: true })
      .positional("value", { describe: "new value (JSON or string)", type: "string", demandOption: true })
      .option("with-stripe", { describe: "sync to Stripe", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Set ${args.slug}.${args.field}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Updating…")
    try {
      const parsed = parseValue(args.value)
      if (args.field.includes(".")) {
        const res = await irisFetch(`${BASE}/${encodeURIComponent(args.slug)}/set-path`, {
          method: "POST",
          body: JSON.stringify({ path: args.field, value: parsed }),
        })
        if (!(await handleApiError(res, "Set path"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      } else {
        const res = await irisFetch(`${BASE}/sync`, {
          method: "POST",
          body: JSON.stringify({
            packages: [{ slug: args.slug, [args.field]: parsed }],
            with_stripe: args["with-stripe"],
          }),
        })
        if (!(await handleApiError(res, "Sync"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      }
      sp.stop(success(`Updated ${args.field}`))
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const PullCmd = cmd({
  command: "pull",
  describe: "pull packages to local packages.json",
  builder: (y) =>
    y
      .option("platform", { describe: "filter by platform", type: "string" })
      .option("dir", { describe: "output directory", type: "string" }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Pull Packages")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const sp = prompts.spinner()
    sp.start("Fetching…")
    const pkgs = await listPackages(args.platform)
    if (pkgs.length === 0) { sp.stop("None"); prompts.outro("Done"); return }
    const dir = pkgsDir(args.dir)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const fp = join(dir, "packages.json")
    writeFileSync(fp, JSON.stringify(pkgs, null, 2))
    sp.stop(success(`Pulled ${pkgs.length} → ${fp}`))
    prompts.outro("Done")
  },
})

const PushCmd = cmd({
  command: "push",
  describe: "push local packages.json to API",
  builder: (y) =>
    y
      .option("dir", { describe: "input directory", type: "string" })
      .option("with-stripe", { describe: "sync to Stripe", type: "boolean", default: false }),
  async handler(args) {
    UI.empty()
    prompts.intro("◈  Push Packages")
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const fp = join(pkgsDir(args.dir), "packages.json")
    if (!existsSync(fp)) {
      prompts.log.error(`File not found: ${fp}`)
      prompts.outro("Done")
      return
    }
    const sp = prompts.spinner()
    sp.start("Pushing…")
    try {
      const pkgs = JSON.parse(readFileSync(fp, "utf-8"))
      const res = await irisFetch(`${BASE}/sync`, {
        method: "POST",
        body: JSON.stringify({ packages: pkgs, with_stripe: args["with-stripe"] }),
      })
      if (!(await handleApiError(res, "Push"))) { sp.stop("Failed", 1); prompts.outro("Done"); return }
      const data = (await res.json()) as { data?: any }
      const d = data?.data ?? data
      sp.stop(success(`${d?.created ?? 0} created, ${d?.updated ?? 0} updated`))
      prompts.outro("Done")
    } catch (err) {
      sp.stop("Error", 1)
      prompts.log.error(err instanceof Error ? err.message : String(err))
      prompts.outro("Done")
    }
  },
})

const FeaturesCmd = cmd({
  command: "features <slug>",
  describe: "show package features in a readable format",
  builder: (y) => y.positional("slug", { describe: "package slug", type: "string", demandOption: true }),
  async handler(args) {
    UI.empty()
    prompts.intro(`◈  Features: ${args.slug}`)
    if (!(await requireAuth())) { prompts.outro("Done"); return }
    const pkg = await getPackage(args.slug)
    if (!pkg) { prompts.log.error("Not found"); prompts.outro("Done"); return }
    const f = pkg.features ?? {}
    printDivider()
    printKV("Title", pkg.title)
    printKV("Price", `$${pkg.price ?? "?"}/${pkg.billing_period ?? "mo"}`)
    if (Array.isArray(f.displayFeatures)) {
      console.log()
      console.log(`  ${dim("Display Features:")}`)
      f.displayFeatures.forEach((feat: string, i: number) => console.log(`    [${i}] ${feat}`))
    }
    const limitKeys = ["workflows", "contacts", "bloqBoards", "bloqItems"]
    const limits = limitKeys.filter((k) => f[k] != null)
    if (limits.length > 0) {
      console.log()
      console.log(`  ${dim("Limits:")}`)
      for (const k of limits) console.log(`    ${k}: ${f[k] === -1 ? "Unlimited" : f[k]}`)
    }
    printDivider()
    prompts.outro("Done")
  },
})

// ============================================================================
// Root
// ============================================================================

export const PlatformPackagesCommand = cmd({
  command: "packages",
  describe: "manage platform pricing packages — list, get/set, pull/push, features",
  builder: (y) =>
    y
      .command(ListCmd)
      .command(GetCmd)
      .command(SetCmd)
      .command(PullCmd)
      .command(PushCmd)
      .command(FeaturesCmd)
      .demandCommand(),
  async handler() {},
})
