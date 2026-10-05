import { cmd } from "./cmd"
import { irisFetch, requireAuth, handleApiError, FL_API, dim, bold } from "./iris-api"
import { writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync, statSync } from "fs"
import { join, dirname } from "path"

// ============================================================================
// OKF CLI — Open Knowledge Format bundles (producer + serve API + keys)
//
// Maps to fl-api routes:
//   GET    /api/v1/okf/bundles                         (authed: list)
//   POST   /api/v1/okf/bundles                         (authed: register)
//   DELETE /api/v1/okf/bundles/{slug}                  (authed)
//   POST   /api/v1/okf/bundles/{slug}/keys             (authed: issue key)
//   DELETE /api/v1/okf/keys/{prefix}                   (authed: revoke)
//   GET    /api/v1/public/okf/{slug}/manifest.json     (public serve)
//   GET    /api/v1/public/okf/{slug}/query             (public serve)
//   GET    /api/v1/public/okf/{slug}/c/{path}          (public serve)
// ============================================================================

async function publicFetch(path: string): Promise<Response> {
  return fetch(`${FL_API}/api/v1/public/okf/${path}`, { headers: { Accept: "application/json" } })
}

const OkfListCommand = cmd({
  command: "list",
  aliases: ["ls"],
  describe: "list OKF bundles you own",
  async handler() {
    if (!(await requireAuth())) return
    const res = await irisFetch("/api/v1/okf/bundles")
    if (!res.ok) { await handleApiError(res, "list bundles"); return }
    const { bundles } = (await res.json()) as { bundles: any[] }
    if (!bundles?.length) {
      console.log(dim("  No bundles yet. Register one: iris okf register <slug> --source bloq:503 --title ..."))
      return
    }
    for (const b of bundles) {
      console.log(`  ${bold(b.title)}  ${dim(`(${b.slug})`)}  ${dim(`${b.source_type}:${b.source_ref}`)}${b.is_public ? "" : dim(" [private]")}`)
    }
  },
})

const OkfRegisterCommand = cmd({
  command: "register <slug>",
  describe: "register a bloq or atlas dataset as an OKF bundle",
  builder: (y: any) =>
    y
      .positional("slug", { type: "string", describe: "public bundle slug (a-z0-9-)" })
      .option("source", { type: "string", demandOption: true, describe: "bloq:<id> or atlas:<schema-slug>" })
      .option("title", { type: "string", demandOption: true })
      .option("description", { type: "string" })
      .option("public", { type: "boolean", default: false, describe: "enable the public lane" })
      .option("meter", { type: "string", describe: "credit action key to bill metered hits (e.g. okf_query)" })
      .option("price-bps", { type: "number", default: 0, describe: "seller fee basis points" })
      .option("public-fields", { type: "string", describe: "atlas: comma-separated allowlist (PHI-safe; default-deny)" }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const [sourceType, sourceRef] = String(args.source).split(":")
    if (!["bloq", "atlas"].includes(sourceType) || !sourceRef) {
      console.error("  --source must be bloq:<id> or atlas:<schema-slug>")
      return
    }
    const settings: Record<string, unknown> = {}
    if (args["public-fields"]) settings.public_fields = String(args["public-fields"]).split(",").map((s) => s.trim()).filter(Boolean)

    const res = await irisFetch("/api/v1/okf/bundles", {
      method: "POST",
      body: JSON.stringify({
        slug: args.slug,
        source_type: sourceType,
        source_ref: sourceRef,
        title: args.title,
        description: args.description ?? null,
        is_public: args.public,
        meter_action: args.meter ?? null,
        price_bps: args["price-bps"] ?? 0,
        settings,
      }),
    })
    if (!res.ok) { await handleApiError(res, "register bundle"); return }
    console.log(`  ${bold("Registered")} ${args.slug}  ${dim(`(${sourceType}:${sourceRef})`)}`)
  },
})

const OkfQueryCommand = cmd({
  command: "query <slug>",
  describe: "query a bundle's concepts (filter / search / semantic)",
  builder: (y: any) =>
    y
      .positional("slug", { type: "string" })
      .option("q", { type: "string", describe: "text query" })
      .option("semantic", { type: "boolean", default: false })
      .option("type", { type: "string" })
      .option("tags", { type: "string" })
      .option("limit", { type: "number", default: 20 }),
  async handler(args: any) {
    const params = new URLSearchParams()
    for (const k of ["q", "type", "tags", "limit"]) if (args[k] != null && args[k] !== "") params.set(k, String(args[k]))
    if (args.semantic) params.set("semantic", "1")
    const res = await publicFetch(`${args.slug}/query?${params.toString()}`)
    if (!res.ok) { await handleApiError(res, "query bundle"); return }
    const { concepts } = (await res.json()) as { concepts: any[] }
    if (!concepts?.length) {
      console.log(dim("  No matching concepts."))
      return
    }
    for (const c of concepts) {
      console.log(`  ${bold(c.title ?? c.path)}  ${dim(c.type ?? "")}  ${dim(c.path)}`)
    }
  },
})

const OkfExportCommand = cmd({
  command: "export <slug>",
  describe: "download a public OKF bundle to a local directory (dependency-free)",
  builder: (y: any) =>
    y.positional("slug", { type: "string" }).option("out", { type: "string", describe: "output dir (default ./okf/<slug>)" }),
  async handler(args: any) {
    const out = args.out ?? join("okf", args.slug)
    const mres = await publicFetch(`${args.slug}/manifest.json`)
    if (!mres.ok) { await handleApiError(mres, "fetch manifest"); return }
    const manifest = (await mres.json()) as { concepts: any[] }

    // Root index.md
    const idx = await publicFetch(`${args.slug}/index.md`)
    if (idx.ok) writeOut(out, "index.md", await idx.text())

    let n = 0
    for (const c of manifest.concepts ?? []) {
      const path = String(c.path).replace(/^\//, "")
      const r = await publicFetch(`${args.slug}/c/${path}`)
      if (r.ok) {
        writeOut(out, path, await r.text())
        n++
      }
    }
    console.log(`  ${bold("Exported")} ${n} concept(s) → ${out}`)
    console.log(dim("  Validate with: iris okf validate " + out))
  },
})

const OkfValidateCommand = cmd({
  command: "validate <dir>",
  describe: "check a local OKF bundle for v0.1 conformance",
  builder: (y: any) => y.positional("dir", { type: "string" }),
  async handler(args: any) {
    const dir = args.dir
    if (!existsSync(dir)) {
      console.error(`  No such directory: ${dir}`)
      return
    }
    const files = walk(dir).filter((f) => f.endsWith(".md"))
    const errors: string[] = []
    const warnings: string[] = []
    let concepts = 0

    for (const file of files) {
      const rel = file.slice(dir.length).replace(/^\//, "")
      const body = readFileSync(file, "utf8")
      const isIndex = rel === "index.md" || rel.endsWith("/index.md")
      const hasFm = body.trimStart().startsWith("---")

      if (isIndex) {
        const isRoot = rel === "index.md"
        if (hasFm && !isRoot) errors.push(`${rel}: sub-directory index.md must NOT have frontmatter`)
        if (isRoot && hasFm && !/okf_version:/.test(body)) warnings.push(`${rel}: root index.md frontmatter should declare okf_version`)
        continue
      }
      concepts++
      if (!hasFm) {
        errors.push(`${rel}: concept missing YAML frontmatter`)
        continue
      }
      const fm = body.slice(3, body.indexOf("\n---", 3))
      if (!/(^|\n)\s*type:\s*\S/.test(fm)) errors.push(`${rel}: frontmatter missing non-empty 'type'`)
    }

    console.log(`  Scanned ${files.length} file(s), ${concepts} concept(s).`)
    warnings.forEach((w) => console.log(`  ${dim("warn")}  ${w}`))
    if (errors.length) {
      errors.forEach((e) => console.log(`  ${bold("FAIL")}  ${e}`))
      process.exitCode = 1
    } else {
      console.log(`  ${bold("OK")} — conformant OKF v0.1 bundle.`)
    }
  },
})

const OkfKeysIssueCommand = cmd({
  command: "issue <slug>",
  describe: "issue a metered API key for a bundle (token shown once)",
  builder: (y: any) =>
    y
      .positional("slug", { type: "string" })
      .option("label", { type: "string" })
      .option("no-meter", { type: "boolean", default: false, describe: "disable metering for this key" }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/okf/bundles/${args.slug}/keys`, {
      method: "POST",
      body: JSON.stringify({ label: args.label ?? null, metering_enabled: !args["no-meter"] }),
    })
    if (!res.ok) { await handleApiError(res, "issue key"); return }
    const { token } = (await res.json()) as { token: string }
    console.log(`  ${bold("API key issued")} — store it now, it is not retrievable later:`)
    console.log(`\n  ${token}\n`)
  },
})

const OkfKeysRevokeCommand = cmd({
  command: "revoke <prefix>",
  describe: "revoke an API key by its prefix",
  builder: (y: any) => y.positional("prefix", { type: "string" }),
  async handler(args: any) {
    if (!(await requireAuth())) return
    const res = await irisFetch(`/api/v1/okf/keys/${args.prefix}`, { method: "DELETE" })
    if (!res.ok) { await handleApiError(res, "revoke key"); return }
    console.log(`  ${bold("Revoked")} ${args.prefix}`)
  },
})

const OkfKeysGroup = cmd({
  command: "keys",
  describe: "manage OKF API keys",
  builder: (y: any) => y.command(OkfKeysIssueCommand).command(OkfKeysRevokeCommand).demandCommand(),
  handler() {},
})

export const OkfCommand = cmd({
  command: "okf",
  describe: "Open Knowledge Format — export, serve, and license knowledge bundles",
  builder: (y: any) =>
    y
      .command(OkfListCommand)
      .command(OkfRegisterCommand)
      .command(OkfQueryCommand)
      .command(OkfExportCommand)
      .command(OkfValidateCommand)
      .command(OkfKeysGroup)
      .demandCommand(),
  handler() {},
})

// ── helpers ──
function writeOut(root: string, rel: string, contents: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, contents)
}

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}
