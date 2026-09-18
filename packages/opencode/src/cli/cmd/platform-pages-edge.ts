/**
 * `iris genesis export` and `iris genesis deploy` — IRIS Edge.
 *
 * The second answer to "can we not be on your servers". The first is a custom domain (`iris domains
 * connect`): our servers, their domain. This one hands over FILES, so the page runs on hardware they
 * control and nothing of ours runs there.
 *
 * What that costs, stated once so nobody has to discover it: a file cannot ask who is reading it.
 * Pages behind a sign-in, rows that differ per viewer, and anything that looks like health
 * information are REFUSED rather than shipped — see edge/export-data.ts for the rules, and
 * FREELABEL #185860 for the decision record.
 */
import { cmd } from "./cmd"
import * as prompts from "./clack"
import { UI } from "../ui"
import { dim, writeJson } from "./iris-api"
import { existsSync, mkdirSync } from "fs"
import { join, resolve } from "path"
import { publicUrl } from "./page-ref"
import { exportPage, writeProvenance, readProvenance, discard } from "./edge/export"
import { exportPageData } from "./edge/export-data"
import { harvest } from "./edge/harvest"
import { verifyExport } from "./edge/verify"
import { startStaticServer, HOST_CONFIG } from "./edge/serve"
import { Remote, loadConfig, newReleaseId, EXAMPLE_CONFIG, type Target } from "./edge/deploy"

const DEFAULT_ORIGIN = "https://freelabel.net"

/** The origin a slug is actually published at, so an export never silently targets the wrong host. */
function originFor(explicit?: string): string {
  if (explicit) return explicit.replace(/\/+$/, "")
  try {
    return new URL(publicUrl("x")).origin
  } catch {
    return DEFAULT_ORIGIN
  }
}

function printChecks(checks: { label: string; ok: boolean; detail: string }[]) {
  for (const c of checks) {
    const line = `  ${c.ok ? "✓" : "✗"} ${c.label}${c.detail ? " — " + c.detail : ""}`
    if (c.ok) prompts.log.info(line)
    else prompts.log.error(line)
  }
}

// ── export ──────────────────────────────────────────────────────────────────────────────────────

export const EdgeExportCmd = cmd({
  command: "export <slug> [out]",
  describe: "export a published page to a folder any static host can serve (IRIS Edge)",
  builder: (y) =>
    y
      .positional("slug", { type: "string", demandOption: true })
      .positional("out", { type: "string", describe: "output directory (default: ./exports/<slug>)" })
      .option("origin", { type: "string", describe: "origin to export from (default: the published host)" })
      // Literal `--no-*` flags: this CLI runs yargs with boolean-negation OFF (index.ts), so a
      // `verify` option defaulting to true could never be turned off — and the refusal text below
      // names `--no-verify`, which would have been a flag that did not exist.
      .option("no-verify", {
        type: "boolean",
        default: false,
        describe: "skip loading the export in a real browser (egress to our servers blocked) — not recommended",
      })
      .option("no-data", { type: "boolean", default: false, describe: "skip exporting bound collections" })
      .option("no-harvest", { type: "boolean", default: false, describe: "skip pulling assets the page injects at runtime" })
      .option("host-config", { type: "boolean", default: false, describe: "print nginx/Caddy/S3 config and exit" })
      .option("json", { type: "boolean", default: false })
      .example("iris genesis export my-page", "export to ./exports/my-page, verified")
      .example("iris genesis export my-page --host-config", "what their web server needs"),
  async handler(args) {
    if (args["host-config"]) {
      UI.println(HOST_CONFIG)
      return
    }

    const slug = String(args.slug)
    const origin = originFor(args.origin as string | undefined)
    const outDir = resolve(String(args.out ?? join("exports", slug)))
    const json = Boolean(args.json)

    if (!json) {
      UI.empty()
      prompts.intro(`◈  Edge export: ${slug}`)
    }
    const sp = json ? null : prompts.spinner()
    sp?.start(`Fetching ${origin}/p/${slug}…`)

    try {
      mkdirSync(outDir, { recursive: true })
      const res = await exportPage(slug, outDir, { origin })

      if (!res.ok) {
        sp?.stop("Refused")
        const f = res.failure!
        // Each of these is a REFUSAL, not a crash — the export could have produced a folder in every
        // one of these cases, and that folder would have looked fine.
        if (f.kind === "gated") {
          discard(outDir)
          process.exitCode = 5
          if (json) return writeJson({ ok: false, reason: "auth-gated", slug })
          prompts.log.error(
            "This page is behind a sign-in, so what exports is the sign-in FORM. The session it " +
              "posts to lives on our servers, so the client would get a lock with no key.",
          )
          prompts.log.info("Give them a custom domain instead: iris domains connect <domain> --page " + slug)
          prompts.outro("Not exported")
          return
        }
        if (f.kind === "torn") {
          process.exitCode = 2
          if (json) return writeJson({ ok: false, reason: "torn", before: f.before, after: f.after })
          prompts.log.error(`A deploy landed mid-export (${f.before} → ${f.after}). The copy is torn and renders blank.`)
          prompts.log.info("Re-run. Do not ship this folder.")
          prompts.outro("Not exported")
          return
        }
        process.exitCode = 3
        if (json) return writeJson({ ok: false, reason: "incomplete", missing: f.missing })
        prompts.log.error(`${f.missing.length} asset(s) missing — one missing chunk renders the page blank.`)
        for (const m of f.missing.slice(0, 5)) prompts.log.info(dim(`  ${m}`))
        prompts.outro("Not exported")
        return
      }

      for (const l of res.log) sp?.message(l)

      if (!args["no-harvest"]) {
        sp?.message("Asking the browser what else it loads…")
        const h = await harvest(res.site, { origin })
        if (!json) for (const l of h.log) prompts.log.info(dim(l))
      }

      let data: Awaited<ReturnType<typeof exportPageData>> | null = null
      if (!args["no-data"]) {
        sp?.message("Exporting bound collections…")
        data = await exportPageData(res.site, { slug, origin })
        if (!json) for (const l of data.log) prompts.log.info(dim(l))
      }

      writeProvenance(outDir, {
        slug,
        origin,
        page_url: `${origin}/p/${slug}`,
        build_entry: res.buildEntry,
        exported_at: new Date().toISOString(),
        files: res.files,
      })

      let verified: Awaited<ReturnType<typeof verifyExport>> | null = null
      if (!args["no-verify"]) {
        sp?.message("Loading it in a browser, with egress to our servers blocked…")
        // Offline is not optional. Without it the independence check reads "zero calls", which
        // cannot tell an independent page from one that had not needed the network yet.
        verified = await verifyExport(res.site, { offline: true, baseline: `${origin}/p/${slug}` })
      }

      sp?.stop(verified && !verified.ok ? "Failed verification" : "Exported")

      if (verified && !verified.ok) process.exitCode = 4
      if (json) {
        return writeJson({
          ok: !verified || verified.ok,
          slug,
          site: res.site,
          files: res.files,
          bytes: res.bytes,
          data: data ? { exported: data.exported.length, refused: data.refused } : null,
          checks: verified?.checks ?? null,
        })
      }

      if (verified) printChecks(verified.checks)
      prompts.log.success(`${res.files} files · ${(res.bytes / 1e6).toFixed(1)}MB → ${res.site}`)
      prompts.log.info(dim(`serve locally: iris genesis serve-edge ${res.site}`))
      prompts.log.info(dim(`deploy:        iris genesis deploy ${res.site} --target <name>`))
      prompts.outro(verified && !verified.ok ? "Exported, but it did NOT verify — do not ship it" : "Done")
    } catch (e: any) {
      sp?.stop("Error")
      process.exitCode = 1
      if (json) return writeJson({ ok: false, error: e?.message ?? String(e) })
      prompts.log.error(e?.message ?? String(e))
      prompts.outro("Failed")
    }
  },
})

// ── serve ───────────────────────────────────────────────────────────────────────────────────────

export const EdgeServeCmd = cmd({
  command: "serve-edge <dir>",
  aliases: ["edge-serve"],
  describe: "serve an exported folder locally, with the SPA fallback a real host must replicate",
  builder: (y) =>
    y.positional("dir", { type: "string", demandOption: true }).option("port", { type: "number", default: 8080 }),
  async handler(args) {
    const dir = resolve(String(args.dir))
    if (!existsSync(join(dir, "index.html"))) {
      UI.error(`${dir} has no index.html — point this at the "site" directory an export produced.`)
      process.exitCode = 1
      return
    }
    const srv = await startStaticServer(dir, Number(args.port))
    UI.println(`serving ${dir} on ${srv.url}  (SPA fallback on, assets 404 honestly)`)
    UI.println(dim("ctrl-c to stop"))
    await new Promise(() => {})
  },
})

// ── deploy ──────────────────────────────────────────────────────────────────────────────────────

export const EdgeDeployCmd = cmd({
  command: "deploy [site]",
  describe: "publish an export to a client's server as a new release, with rollback (IRIS Edge)",
  builder: (y) =>
    y
      .positional("site", { type: "string", describe: "the site/ directory an export produced" })
      .option("target", { type: "string", describe: "target name from the deploy config" })
      .option("config", { type: "string", default: "genesis-deploy.json" })
      .option("list", { type: "boolean", default: false, describe: "list releases on the target" })
      .option("rollback", { type: "boolean", default: false, describe: "point the target at a previous release" })
      .option("to", { type: "string", describe: "with --rollback: which release" })
      .option("force", { type: "boolean", default: false, describe: "allow replacing a DIFFERENT page on this target" })
      .option("dry-run", { type: "boolean", default: false })
      .option("no-verify", { type: "boolean", default: false, describe: "deploy without verifying first — not recommended" })
      .option("min-chars", { type: "number", describe: "render floor when there is no baseline" })
      .option("json", { type: "boolean", default: false })
      .example("iris genesis deploy exports/my-page/site --target production", "ship it")
      .example("iris genesis deploy --target production --rollback", "undo, transferring nothing"),
  async handler(args) {
    const configPath = resolve(String(args.config))
    const json = Boolean(args.json)
    const dryRun = Boolean(args["dry-run"])

    const fail = (msg: string, code = 1) => {
      process.exitCode = code
      if (json) writeJson({ ok: false, error: msg })
      else UI.error(msg)
    }

    let config
    try {
      config = loadConfig(configPath)
    } catch {
      if (json) return fail(`no deploy config at ${configPath}`, 64)
      UI.error(`No deploy config at ${configPath}`)
      UI.println("")
      UI.println("Write one — it is the record of where a client's site actually lives, which is")
      UI.println("otherwise a fact that exists only in whoever set it up:")
      UI.println("")
      UI.println(EXAMPLE_CONFIG)
      process.exitCode = 64
      return
    }

    const names = Object.keys(config.targets ?? {})
    if (!names.length) return fail(`${configPath} defines no targets`, 64)
    // Refuse to guess when there is more than one. Picking the wrong target here publishes a
    // client's page to a different client's server, and it looks like a success.
    const name = (args.target as string | undefined) ?? (names.length === 1 ? names[0]! : "")
    if (!name) return fail(`--target is required; ${configPath} defines: ${names.join(", ")}`, 64)
    const target: Target | undefined = config.targets[name]
    if (!target) return fail(`no target "${name}" in ${configPath} (have: ${names.join(", ")})`, 64)

    try {
      const remote = new Remote(target, dryRun, (s) => UI.println(dim(`    [dry-run] ${s}`)))

      // ── list ──
      if (args.list) {
        const [releases, cur] = [await remote.releases(), await remote.current()]
        if (json) return writeJson({ target: name, root: remote.label, current: cur, releases })
        UI.println(`${name} → ${remote.label}`)
        if (!releases.length) UI.println("  no releases yet")
        for (const r of releases) UI.println(`  ${r === cur ? "→" : " "} ${r}${r === cur ? "  (live)" : ""}`)
        return
      }

      // ── rollback ──
      if (args.rollback) {
        const releases = await remote.releases()
        const cur = await remote.current()
        const to = (args.to as string | undefined) ?? releases.filter((r) => r !== cur).pop()
        if (!to) return fail(`nothing to roll back to on ${remote.label} — ${releases.length} release(s), current is ${cur ?? "unset"}`)
        if (!releases.includes(to)) return fail(`no release "${to}" on ${remote.label} (have: ${releases.join(", ") || "none"})`)
        if (to === cur) return fail(`${to} is already live`)
        await remote.pointAt(to)
        if (json) return writeJson({ ok: true, target: name, from: cur, to })
        UI.println(`✓ rolled back ${name}: ${cur ?? "(none)"} → ${to}`)
        UI.println(dim("  nothing was transferred — the old release never left the machine."))
        return
      }

      // ── deploy ──
      if (!args.site) return fail("usage: iris genesis deploy <site-dir> --target <name>   (or --list / --rollback)", 64)
      const site = resolve(String(args.site))
      if (!existsSync(join(site, "index.html"))) {
        return fail(`${site} has no index.html — point this at the "site" directory an export produced, not the export root`)
      }

      const provenance = readProvenance(site)
      // A BASELINE, when we know it. Without one, verify compares against absolutes and fails a
      // FAITHFUL export of a page whose source is already broken — /p/atlas has 5 images that 404
      // on the live site, and a deploy that refuses those is blaming us for the client's own
      // defect. That is the failure that makes people reach for --no-verify, and then it is off
      // for the real failures too.
      const baseline = target.source ?? provenance?.page_url ?? null

      if (!args["no-verify"]) {
        if (!json) UI.println(`→ verifying ${site} before it goes anywhere${baseline ? dim(` (against ${baseline})`) : ""}`)
        const v = await verifyExport(site, {
          offline: true,
          baseline,
          ...(args["min-chars"] ? { minChars: Number(args["min-chars"]) } : {}),
        })
        if (!json) printChecks(v.checks)
        if (!v.ok) {
          return fail("export failed verification — refusing to deploy it. Re-export; do not use --no-verify to get past this.")
        }
      }

      // One target serves one site. Silently replacing one page with another because someone
      // reused a config is how a client's server ends up showing a different client's page,
      // reported as a success.
      if (provenance?.slug && !dryRun) {
        const prior = await remote.deployedSlug()
        if (prior && prior !== provenance.slug && !args.force) {
          return fail(
            `${remote.label} is currently serving "${prior}", and this export is "${provenance.slug}". ` +
              `Deploying would replace one page with a different one on the same machine. ` +
              `If that is deliberate, re-run with --force.`,
          )
        }
      }

      const release = newReleaseId()
      if ((await remote.releases()).includes(release)) {
        return fail(`a release named ${release} already exists — two deploys in the same second. Re-run.`)
      }
      const dest = `${remote.root}/releases/${release}`
      if (!json) UI.println(`→ deploying to ${remote.label} as ${release}`)

      await remote.sh(`mkdir -p ${remote.root}/releases`)
      await remote.upload(site, dest)
      if (!dryRun && !json) {
        const files = (await remote.sh(`find ${dest} -type f | wc -l`)).trim()
        UI.println(dim(`  uploaded ${files} files`))
      }

      const previous = await remote.current()
      if (provenance?.slug && !dryRun) await remote.recordSlug(provenance.slug)
      await remote.pointAt(release)
      if (!json) UI.println(`✓ live: ${name} → ${release}${previous ? dim(` (was ${previous})`) : ""}`)

      const pruned = await remote.prune(release)
      if (pruned && !json) UI.println(dim(`  pruned ${pruned} old release(s), kept ${remote.keep}`))

      // A post-deploy fetch is the only check that covers the WEB SERVER's own config — the release
      // can be perfect on disk while the vhost still points at the old path, or at releases/ itself.
      let reachable: boolean | null = null
      if (target.url && !dryRun) {
        try {
          const res = await fetch(target.url, { redirect: "follow" })
          const body = await res.text()
          reachable = res.ok && body.includes('<div id="app"')
          if (!json) {
            UI.println(
              `  ${reachable ? "✓" : "✗"} ${target.url} → ${res.status}` +
                (reachable ? "" : " — reachable, but that is not the page we just deployed"),
            )
          }
          if (!reachable) process.exitCode = 1
        } catch (e: any) {
          if (!json) {
            UI.println(`  ! could not reach ${target.url}: ${e?.message ?? e}`)
            UI.println(dim("    The release is live on disk. This is their web server or DNS, not the export."))
          }
        }
      }

      if (json) return writeJson({ ok: true, target: name, release, previous, pruned, reachable })
      UI.println(dim(`  rollback: iris genesis deploy --target ${name} --rollback`))
    } catch (e: any) {
      fail(e?.message ?? String(e))
    }
  },
})
